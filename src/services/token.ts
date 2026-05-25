import type { Address, ChainSlug, TokenMetadata } from "../types";
import { ERC20_ABI } from "../uniswap/abis";
import { getChain, ZERO_ADDRESS } from "../chains/registry";
import { normalizeAddress, shortAddress } from "../utils/address";
import type { RpcPool } from "./rpcPool";

interface SafeStringResult {
  value: string;
  fallbackUsed: boolean;
  retryableFallback: boolean;
}

interface SafeNumberResult {
  value: number;
  fallbackUsed: boolean;
  retryableFallback: boolean;
}

export class TokenService {
  private readonly cache = new Map<string, TokenMetadata>();
  private readonly tokenInFlight = new Map<string, Promise<TokenMetadata>>();
  private readonly deployBlockCache = new Map<string, number>();
  private readonly deployBlockInFlight = new Map<string, Promise<number | undefined>>();

  constructor(
    private readonly rpc: RpcPool,
    private readonly chain: ChainSlug = "base",
    private readonly options: { fastMetadata?: boolean } = {}
  ) {}

  /**
   * Binary-search the contract's deployment block via eth_getCode.
   * Returns undefined for the native asset or if the RPC can't serve historical state.
   * Result is cached forever in process memory.
   */
  async findDeploymentBlock(addressInput: string): Promise<number | undefined> {
    const address = normalizeAddress(addressInput);
    const key = `${this.chain}:${address.toLowerCase()}`;
    if (address.toLowerCase() === ZERO_ADDRESS.toLowerCase()) return undefined;
    const cached = this.deployBlockCache.get(key);
    if (cached !== undefined) return cached;
    const inFlight = this.deployBlockInFlight.get(key);
    if (inFlight) return inFlight;

    const task = (async (): Promise<number | undefined> => {
      try {
        const latest = await this.rpc.getBlockNumber();
        const headHasCode = await this.hasCodeAt(address, latest);
        if (!headHasCode) return undefined; // contract doesn't exist at head; nothing to find

        let low = 0;
        let high = latest;
        while (low < high) {
          const mid = Math.floor((low + high) / 2);
          if (await this.hasCodeAt(address, mid)) {
            high = mid;
          } else {
            low = mid + 1;
          }
        }
        this.deployBlockCache.set(key, low);
        const cached = this.cache.get(key);
        if (cached) cached.deployBlock = low;
        return low;
      } catch {
        // Non-archive RPC, rate limit, etc. - fall back to undefined and let the caller
        // use the configured lookback range.
        return undefined;
      } finally {
        this.deployBlockInFlight.delete(key);
      }
    })();
    this.deployBlockInFlight.set(key, task);
    return task;
  }

  private async hasCodeAt(address: string, blockNumber: number): Promise<boolean> {
    const code = await this.rpc.getCode(address, blockNumber);
    return !!code && code !== "0x" && code !== "0x0";
  }

  async getToken(addressInput: string): Promise<TokenMetadata> {
    const chainConfig = getChain(this.chain);
    const address = normalizeAddress(addressInput);
    const key = `${this.chain}:${address.toLowerCase()}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const inFlight = this.tokenInFlight.get(key);
    if (inFlight) return inFlight;

    const task = (async (): Promise<TokenMetadata> => {
      if (address.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
        const native: TokenMetadata = {
          address,
          chain: this.chain,
          name: chainConfig.nativeSymbol === "ETH" ? "Ether" : chainConfig.nativeSymbol,
          symbol: chainConfig.nativeSymbol,
          decimals: 18,
          isNative: true,
          metadataFallback: false
        };
        this.cache.set(key, native);
        return native;
      }

      const wrappedNative = typeof chainConfig.wrappedNative === "string" && chainConfig.wrappedNative.startsWith("0x")
        ? chainConfig.wrappedNative.toLowerCase()
        : "";
      const known = knownTokenFallback(this.chain, address);
      const knownOrWrapped = Boolean(known) || address.toLowerCase() === wrappedNative;
      const symbolFallback = known?.symbol ?? (address.toLowerCase() === wrappedNative ? `W${chainConfig.nativeSymbol}` : shortAddress(address));
      const nameFallback = known?.name ?? (address.toLowerCase() === wrappedNative ? `Wrapped ${chainConfig.nativeSymbol}` : `Token ${shortAddress(address)}`);
      const decimalsFallback = known?.decimals ?? 18;
      if (this.options.fastMetadata && knownOrWrapped) {
        const meta: TokenMetadata = {
          address,
          chain: this.chain,
          name: nameFallback,
          symbol: symbolFallback,
          decimals: decimalsFallback,
          metadataFallback: false
        };
        this.cache.set(key, meta);
        return meta;
      }

      if (this.options.fastMetadata) {
        const [symbol, decimals] = await Promise.all([
          safeString(this.rpc, address, "symbol", symbolFallback),
          safeDecimals(this.rpc, address, decimalsFallback)
        ]);
        const meta: TokenMetadata = {
          address,
          chain: this.chain,
          name: known?.name ?? symbol.value,
          symbol: symbol.value,
          decimals: decimals.value,
          metadataFallback: !knownOrWrapped && (symbol.retryableFallback || decimals.retryableFallback)
        };
        if (!shouldRefreshTokenMetadata(meta)) this.cache.set(key, meta);
        return meta;
      }

      const [name, symbol, decimals, totalSupply] = await Promise.all([
        safeString(this.rpc, address, "name", nameFallback),
        safeString(this.rpc, address, "symbol", symbolFallback),
        safeDecimals(this.rpc, address, decimalsFallback),
        safeTotalSupply(this.rpc, address)
      ]);
      const symbolValue = symbol.fallbackUsed && !name.fallbackUsed
        ? symbolFromName(name.value, address)
        : symbol.value;

      const meta: TokenMetadata = {
        address,
        chain: this.chain,
        name: name.value,
        symbol: symbolValue,
        decimals: decimals.value,
        totalSupply: totalSupply?.toString(),
        metadataFallback: !knownOrWrapped && (name.retryableFallback || symbol.retryableFallback || decimals.retryableFallback)
      };
      if (!shouldRefreshTokenMetadata(meta)) this.cache.set(key, meta);
      return meta;
    })().finally(() => {
      this.tokenInFlight.delete(key);
    });
    this.tokenInFlight.set(key, task);
    return task;
  }

  async getTotalSupply(addressInput: string): Promise<string | undefined> {
    const address = normalizeAddress(addressInput);
    const key = `${this.chain}:${address.toLowerCase()}`;
    if (address.toLowerCase() === ZERO_ADDRESS.toLowerCase()) return undefined;
    const totalSupply = await safeTotalSupply(this.rpc, address) ?? await fetchExplorerTotalSupply(this.chain, address);
    if (totalSupply === undefined) return undefined;
    const value = totalSupply.toString();
    const cached = this.cache.get(key);
    if (cached) cached.totalSupply = value;
    return value;
  }
}

function knownTokenFallback(chain: ChainSlug, address: Address): Pick<TokenMetadata, "name" | "symbol" | "decimals"> | undefined {
  const key = `${chain}:${address.toLowerCase()}`;
  const known: Record<string, Pick<TokenMetadata, "name" | "symbol" | "decimals">> = {
    "base:0x000000000d564d5be76f7f0d28fe52605afc7cf8": { name: "Flaunch ETH", symbol: "flETH", decimals: 18 },
    "base:0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b": { name: "Virtuals Protocol", symbol: "VIRTUAL", decimals: 18 },
    "base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { name: "USD Coin", symbol: "USDC", decimals: 6 },
    "base:0xfde4c96c8593536e31f229ea8f37b2adca2699bb2": { name: "Tether USD", symbol: "USDT", decimals: 6 },
    "base:0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca": { name: "USD Base Coin", symbol: "USDbC", decimals: 6 },
    "base:0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42": { name: "EURC", symbol: "EURC", decimals: 6 },
    "ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { name: "USD Coin", symbol: "USDC", decimals: 6 },
    "ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7": { name: "Tether USD", symbol: "USDT", decimals: 6 },
    "ethereum:0x6b175474e89094c44da98b954eedeac495271d0f": { name: "Dai Stablecoin", symbol: "DAI", decimals: 18 },
    "arbitrum:0xaf88d065e77c8cc2239327c5edb3a432268e5831": { name: "USD Coin", symbol: "USDC", decimals: 6 },
    "arbitrum:0xff970a61a04b1ca14834a43f5de4533ebddb5cc8": { name: "Bridged USDC", symbol: "USDC.e", decimals: 6 },
    "optimism:0x0b2c639c533813f4aa9d7837caf62653d097ff85": { name: "USD Coin", symbol: "USDC", decimals: 6 },
    "optimism:0x7f5c764cbc14f9669b88837ca1490cca17c31607": { name: "Bridged USDC", symbol: "USDC.e", decimals: 6 },
    "polygon:0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": { name: "USD Coin", symbol: "USDC", decimals: 6 },
    "polygon:0x2791bca1f2de4661ed88a30c99a7a9449aa84174": { name: "Bridged USDC", symbol: "USDC.e", decimals: 6 },
    "avalanche:0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e": { name: "USD Coin", symbol: "USDC", decimals: 6 },
    "avalanche:0x9702230a8ea53601f5cd2dc00fdbc13d4f4a8c7": { name: "Tether USD", symbol: "USDT", decimals: 6 },
    "bsc:0x55d398326f99059ff775485246999027b3197955": { name: "Tether USD", symbol: "USDT", decimals: 18 },
    "bsc:0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": { name: "USD Coin", symbol: "USDC", decimals: 18 }
  };
  return known[key];
}

export function shouldRefreshTokenMetadata(token: Pick<TokenMetadata, "address" | "name" | "symbol" | "metadataFallback">): boolean {
  if (token.metadataFallback === true) return true;
  if (token.metadataFallback === false) return false;
  return token.symbol.trim().toUpperCase() === "TOKEN" && token.name.trim().toLowerCase() === "token";
}

function symbolFromName(name: string, address: string): string {
  const cleaned = name.trim().replace(/[^a-zA-Z0-9]+/g, " ").trim();
  if (!cleaned || cleaned.toLowerCase() === "token") return shortAddress(address);
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    const initials = words.map((word) => word[0]).join("").toUpperCase();
    if (initials.length >= 2) return initials.slice(0, 12);
  }
  const first = words[0] ?? cleaned;
  return first.slice(0, 12).toUpperCase();
}

async function safeString(rpc: RpcPool, address: string, fn: "name" | "symbol", fallback: string): Promise<SafeStringResult> {
  try {
    const value = await rpc.callContract<string>(address, ERC20_ABI, fn);
    if (typeof value === "string" && value.trim().length > 0) return { value: value.trim(), fallbackUsed: false, retryableFallback: false };
    return { value: fallback, fallbackUsed: true, retryableFallback: false };
  } catch {
    return { value: fallback, fallbackUsed: true, retryableFallback: true };
  }
}

async function safeDecimals(rpc: RpcPool, address: string, fallback: number): Promise<SafeNumberResult> {
  try {
    const value = await rpc.callContract<number | bigint>(address, ERC20_ABI, "decimals");
    const parsed = Number(value);
    return Number.isFinite(parsed)
      ? { value: parsed, fallbackUsed: false, retryableFallback: false }
      : { value: fallback, fallbackUsed: true, retryableFallback: true };
  } catch {
    return { value: fallback, fallbackUsed: true, retryableFallback: true };
  }
}

async function safeTotalSupply(rpc: RpcPool, address: string): Promise<bigint | undefined> {
  try {
    return BigInt(await rpc.callContract<bigint>(address, ERC20_ABI, "totalSupply"));
  } catch {
    return undefined;
  }
}

async function fetchExplorerTotalSupply(chain: ChainSlug, address: Address): Promise<bigint | undefined> {
  const explorerBaseUrl = getChain(chain).explorerBaseUrl;
  if (!explorerBaseUrl) return undefined;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(`${explorerBaseUrl.replace(/\/+$/g, "")}/api/v2/tokens/${address}`, {
      signal: controller.signal,
      headers: { accept: "application/json" }
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as Record<string, unknown>;
    const raw = payload.total_supply;
    if (typeof raw !== "string" && typeof raw !== "number") return undefined;
    const text = String(raw).trim();
    if (!/^\d+$/.test(text)) return undefined;
    return BigInt(text);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}
