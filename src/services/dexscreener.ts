import type { ChainSlug } from "../types";

/** Market data for a single token, as reported by Dexscreener. */
export interface DexscreenerMarket {
  /** Pair the numbers were read from. */
  pairId?: string;
  /** Base token of that pair; every value below describes this token. */
  tokenAddress?: string;
  priceUsd?: number;
  marketCapUsd?: number;
  fdvUsd?: number;
  liquidityUsd?: number;
}

interface DexscreenerPair {
  chainId?: string;
  pairAddress?: string;
  baseToken?: { address?: string };
  priceUsd?: string | number;
  liquidity?: { usd?: number };
  marketCap?: number;
  fdv?: number;
}

const DEXSCREENER_API_BASE = "https://api.dexscreener.com/latest/dex";
const DEFAULT_TIMEOUT_MS = 4_000;
/** Dexscreener refreshes pair stats every few seconds; a minute keeps alerts fresh without hammering it. */
const HIT_CACHE_MS = 60_000;
/** Tokens without a Dexscreener pair stay unlisted for a while, so cache the miss too. */
const MISS_CACHE_MS = 5 * 60_000;
/** Retry sooner after a transport error than after a genuine "not listed" answer. */
const ERROR_CACHE_MS = 30_000;
const MAX_CACHE_ENTRIES = 2_000;
/** Below this, a pair's price is too thin to trust for valuing a buy in USD. */
const DEFAULT_MIN_PRICE_LIQUIDITY_USD = 1_000;

const DEXSCREENER_CHAIN_SLUGS: Record<ChainSlug, string> = {
  ethereum: "ethereum",
  bsc: "bsc",
  base: "base",
  arbitrum: "arbitrum",
  optimism: "optimism",
  monad: "monad",
  megaeth: "megaeth",
  robinhood: "robinhood",
  polygon: "polygon",
  avalanche: "avalanche",
  solana: "solana"
};

export function dexscreenerChainSlug(chain: string): string {
  return DEXSCREENER_CHAIN_SLUGS[chain as ChainSlug] ?? chain;
}

interface CachedMarket {
  value?: DexscreenerMarket;
  expiresAt: number;
}

export class DexscreenerClient {
  private cache = new Map<string, CachedMarket>();
  private inflight = new Map<string, Promise<DexscreenerMarket | undefined>>();

  constructor(
    private readonly opts: {
      enabled: boolean;
      timeoutMs?: number;
      minPriceLiquidityUsd?: number;
    }
  ) {}

  isEnabled(): boolean {
    return this.opts.enabled;
  }

  /**
   * USD price for a token, taken from its deepest Dexscreener pair. Used to price
   * quote tokens that are neither stablecoins nor the chain's native asset.
   */
  async getTokenUsdPrice(chain: ChainSlug, tokenAddress: string): Promise<number | undefined> {
    const market = await this.getTokenMarket(chain, tokenAddress);
    if (market?.priceUsd === undefined) return undefined;
    const minLiquidityUsd = this.opts.minPriceLiquidityUsd ?? DEFAULT_MIN_PRICE_LIQUIDITY_USD;
    if ((market.liquidityUsd ?? 0) < minLiquidityUsd) return undefined;
    return market.priceUsd;
  }

  /**
   * Market data for a tracked pool: the pool's own pair when Dexscreener indexes it
   * with `tokenAddress` as the base token, otherwise the token's deepest pair.
   */
  async getMarketForPool(
    chain: ChainSlug,
    opts: { tokenAddress: string; pairId?: string }
  ): Promise<DexscreenerMarket | undefined> {
    if (opts.pairId && looksLikePairId(opts.pairId)) {
      const pairMarket = await this.getPairMarket(chain, opts.pairId);
      if (pairMarket && sameAddress(pairMarket.tokenAddress, opts.tokenAddress)) return pairMarket;
    }
    return this.getTokenMarket(chain, opts.tokenAddress);
  }

  /** Market data read from one specific pair, whichever token is its base asset. */
  async getPairMarket(chain: ChainSlug, pairId: string): Promise<DexscreenerMarket | undefined> {
    const network = dexscreenerChainSlug(chain);
    return this.cached(`pair:${network}:${pairId.toLowerCase()}`, async () => {
      const pairs = await this.fetchPairs(
        `${DEXSCREENER_API_BASE}/pairs/${encodeURIComponent(network)}/${encodeURIComponent(pairId)}`
      );
      if (!pairs) return { failed: true };
      const pair = pairs.find((candidate) => onNetwork(candidate, network));
      return { value: pair ? toMarket(pair) : undefined };
    });
  }

  /** Market data for a token, from the deepest pair where it is the base asset. */
  async getTokenMarket(chain: ChainSlug, tokenAddress: string): Promise<DexscreenerMarket | undefined> {
    const network = dexscreenerChainSlug(chain);
    return this.cached(`token:${network}:${tokenAddress.toLowerCase()}`, async () => {
      const pairs = await this.fetchPairs(
        `${DEXSCREENER_API_BASE}/tokens/${encodeURIComponent(tokenAddress)}`
      );
      if (!pairs) return { failed: true };
      // Dexscreener reports price, market cap and FDV for a pair's *base* token, so
      // pairs that merely quote in this token describe something else entirely.
      const candidates = pairs.filter(
        (pair) => onNetwork(pair, network) && sameAddress(pair.baseToken?.address, tokenAddress)
      );
      const best = candidates.reduce<DexscreenerPair | undefined>((deepest, pair) => {
        if (!deepest) return pair;
        return (pair.liquidity?.usd ?? 0) > (deepest.liquidity?.usd ?? 0) ? pair : deepest;
      }, undefined);
      return { value: best ? toMarket(best) : undefined };
    });
  }

  private async cached(
    cacheKey: string,
    load: () => Promise<{ value?: DexscreenerMarket; failed?: boolean }>
  ): Promise<DexscreenerMarket | undefined> {
    if (!this.opts.enabled) return undefined;
    const now = Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.value;

    const pending = this.inflight.get(cacheKey);
    if (pending) return pending;

    const request = load()
      .then((result) => {
        const ttl = result.value ? HIT_CACHE_MS : result.failed ? ERROR_CACHE_MS : MISS_CACHE_MS;
        this.remember(cacheKey, { value: result.value, expiresAt: Date.now() + ttl });
        return result.value;
      })
      .catch(() => {
        this.remember(cacheKey, { expiresAt: Date.now() + ERROR_CACHE_MS });
        return undefined;
      })
      .finally(() => {
        this.inflight.delete(cacheKey);
      });

    this.inflight.set(cacheKey, request);
    return request;
  }

  private remember(cacheKey: string, entry: CachedMarket): void {
    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, entry);
    if (this.cache.size <= MAX_CACHE_ENTRIES) return;
    for (const key of this.cache.keys()) {
      if (this.cache.size <= MAX_CACHE_ENTRIES) break;
      if (key === cacheKey) continue;
      this.cache.delete(key);
    }
  }

  /** Returns the pair list, or undefined when the request itself failed. */
  private async fetchPairs(url: string): Promise<DexscreenerPair[] | undefined> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) return undefined;
      const json = (await response.json()) as { pairs?: DexscreenerPair[] | null };
      return Array.isArray(json.pairs) ? json.pairs : [];
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function toMarket(pair: DexscreenerPair): DexscreenerMarket {
  return {
    pairId: pair.pairAddress,
    tokenAddress: pair.baseToken?.address,
    priceUsd: positiveNumber(pair.priceUsd),
    marketCapUsd: positiveNumber(pair.marketCap),
    fdvUsd: positiveNumber(pair.fdv),
    liquidityUsd: positiveNumber(pair.liquidity?.usd)
  };
}

function onNetwork(pair: DexscreenerPair, network: string): boolean {
  return (pair.chainId ?? "").toLowerCase() === network.toLowerCase();
}

function sameAddress(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  return left.toLowerCase() === right.toLowerCase();
}

/** Solana pools are tracked under a synthetic `mint:<address>` id that Dexscreener cannot resolve. */
function looksLikePairId(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value) || /^0x[0-9a-fA-F]{64}$/.test(value);
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
