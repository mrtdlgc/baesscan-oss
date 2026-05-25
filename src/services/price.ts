import { formatUnits } from "ethers";
import type { ChainSlug, TokenId } from "../types";
import { getChain } from "../chains/registry";
import type { RpcPool } from "./rpcPool";

const NATIVE_COINGECKO_IDS: Partial<Record<ChainSlug, string>> = {
  ethereum: "ethereum",
  base: "ethereum",
  arbitrum: "ethereum",
  optimism: "ethereum",
  megaeth: "ethereum",
  bsc: "binancecoin",
  polygon: "matic-network",
  avalanche: "avalanche-2",
  solana: "solana"
};

const CHAINLINK_NATIVE_USD_FEEDS: Partial<Record<ChainSlug, string>> = {
  ethereum: "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419",
  base: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
  arbitrum: "0x639fe6ab55c921f74e7fac1ee960c0b6293ba612",
  optimism: "0x13e3ee699d1909e989722e753853ae30b17e08c5",
  bsc: "0x0567f2323251f0aab15c8dfb1967e4e8a7d42aee",
  polygon: "0xab594600376ec9fd91f8e885dadf0ce036862de0",
  avalanche: "0x0a77230d17318075983913bc2145db16c7366156"
};

const CHAINLINK_FEED_ABI = [
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)"
] as const;

const NATIVE_PRICE_CACHE_MS = 60_000;
const DEFAULT_STALE_NATIVE_PRICE_MS = 60 * 60_000;
const MAX_CHAINLINK_PRICE_AGE_MS = 24 * 60 * 60_000;
const TOKEN_PRICE_CACHE_MS = 60_000;
const BASE_VIRTUAL = "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b";

interface CachedNativeUsd {
  value: number;
  expiresAt: number;
  staleUntil: number;
}

export class PriceService {
  private nativeUsdCache = new Map<ChainSlug, CachedNativeUsd>();
  private tokenUsdCache = new Map<string, CachedNativeUsd>();
  private chainlinkDecimalsCache = new Map<ChainSlug, number>();

  constructor(private readonly opts: {
    ethUsdOverride?: number;
    disableCoinGecko: boolean;
    rpcs?: Map<ChainSlug, RpcPool>;
    staleNativeUsdMs?: number;
  }) {}

  async quoteUsdMultiplier(quoteAddress: TokenId, chain: ChainSlug = "base"): Promise<number | undefined> {
    const chainConfig = getChain(chain);
    const key = quoteAddress.toLowerCase();
    if (chainConfig.usdLikeQuotes.map((value) => value.toLowerCase()).includes(key)) return 1;
    if (chainConfig.nativeLikeQuotes.map((value) => value.toLowerCase()).includes(key)) return this.getNativeUsd(chain);
    if (chain === "base" && key === BASE_VIRTUAL) return this.getTokenUsd(chain, key);
    return undefined;
  }

  private async getTokenUsd(chain: ChainSlug, address: string): Promise<number | undefined> {
    const cacheKey = `${chain}:${address.toLowerCase()}`;
    const now = Date.now();
    const cached = this.tokenUsdCache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.value;
    if (!this.opts.disableCoinGecko) {
      const coingeckoValue = await this.fetchCoinGeckoTokenUsd(chain, address);
      if (coingeckoValue !== undefined) {
        this.tokenUsdCache.set(cacheKey, {
          value: coingeckoValue,
          expiresAt: now + TOKEN_PRICE_CACHE_MS,
          staleUntil: now + (this.opts.staleNativeUsdMs ?? DEFAULT_STALE_NATIVE_PRICE_MS)
        });
        return coingeckoValue;
      }
    }
    if (cached && cached.staleUntil > now) return cached.value;
    return undefined;
  }

  private async getNativeUsd(chain: ChainSlug): Promise<number | undefined> {
    if (this.opts.ethUsdOverride !== undefined) return this.opts.ethUsdOverride;

    const now = Date.now();
    const cached = this.nativeUsdCache.get(chain);
    if (cached && cached.expiresAt > now) return cached.value;

    if (!this.opts.disableCoinGecko) {
      const coingeckoValue = await this.fetchCoinGeckoNativeUsd(chain);
      if (coingeckoValue !== undefined) return this.cacheNativeUsd(chain, coingeckoValue, now);
    }

    const chainlinkValue = await this.fetchChainlinkNativeUsd(chain);
    if (chainlinkValue !== undefined) return this.cacheNativeUsd(chain, chainlinkValue, now);

    if (cached && cached.staleUntil > now) return cached.value;
    return undefined;
  }

  private async fetchCoinGeckoNativeUsd(chain: ChainSlug): Promise<number | undefined> {
    const coingeckoId = NATIVE_COINGECKO_IDS[chain];
    if (!coingeckoId) return undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4_000);
    try {
      const response = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoId}&vs_currencies=usd`, {
        signal: controller.signal
      });
      if (!response.ok) return undefined;
      const json = (await response.json()) as Record<string, { usd?: number }>;
      const value = json[coingeckoId]?.usd;
      if (value && Number.isFinite(value)) {
        return value;
      }
      return undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchCoinGeckoTokenUsd(chain: ChainSlug, address: string): Promise<number | undefined> {
    const network = getChain(chain).geckoNetwork;
    if (!network) return undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4_000);
    try {
      const response = await fetch(
        `https://api.coingecko.com/api/v3/simple/token_price/${encodeURIComponent(network)}?contract_addresses=${encodeURIComponent(address)}&vs_currencies=usd`,
        { signal: controller.signal }
      );
      if (!response.ok) return undefined;
      const json = (await response.json()) as Record<string, { usd?: number }>;
      const value = json[address.toLowerCase()]?.usd;
      return value && Number.isFinite(value) ? value : undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchChainlinkNativeUsd(chain: ChainSlug): Promise<number | undefined> {
    const rpc = this.opts.rpcs?.get(chain);
    const feed = CHAINLINK_NATIVE_USD_FEEDS[chain];
    if (!rpc || !feed) return undefined;
    try {
      const [decimals, round] = await Promise.all([
        this.chainlinkDecimals(chain, rpc, feed),
        rpc.callContract<readonly unknown[]>(feed, CHAINLINK_FEED_ABI, "latestRoundData")
      ]);
      const answer = roundValue(round, 1);
      const updatedAt = roundValue(round, 3);
      if (answer === undefined || answer <= 0n) return undefined;
      if (updatedAt === undefined || updatedAt <= 0n) return undefined;
      const ageMs = Date.now() - Number(updatedAt) * 1000;
      if (!Number.isFinite(ageMs) || ageMs > MAX_CHAINLINK_PRICE_AGE_MS) return undefined;
      const value = Number(formatUnits(answer, decimals));
      return Number.isFinite(value) && value > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private async chainlinkDecimals(chain: ChainSlug, rpc: RpcPool, feed: string): Promise<number> {
    const cached = this.chainlinkDecimalsCache.get(chain);
    if (cached !== undefined) return cached;
    const value = Number(await rpc.callContract<number | bigint>(feed, CHAINLINK_FEED_ABI, "decimals"));
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid Chainlink decimals for ${chain}: ${value}`);
    this.chainlinkDecimalsCache.set(chain, value);
    return value;
  }

  private cacheNativeUsd(chain: ChainSlug, value: number, now: number): number {
    this.nativeUsdCache.set(chain, {
      value,
      expiresAt: now + NATIVE_PRICE_CACHE_MS,
      staleUntil: now + (this.opts.staleNativeUsdMs ?? DEFAULT_STALE_NATIVE_PRICE_MS)
    });
    return value;
  }
}

function roundValue(values: readonly unknown[], index: number): bigint | undefined {
  const value = values[index];
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.floor(value));
  if (typeof value === "string" && value.trim() !== "") {
    try {
      return BigInt(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}
