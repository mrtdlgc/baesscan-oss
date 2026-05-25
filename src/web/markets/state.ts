import type { ChainSlug, PoolKey } from "../../types";
import type { MarketSummary } from "./types";

const marketPoolRegistry = new Map<string, PoolKey>();
const marketSummaryCache = new Map<string, { expiresAt: number; market: MarketSummary }>();

export function registerMarketPool(chain: ChainSlug, pool: PoolKey): void {
  marketPoolRegistry.set(marketPoolRegistryKey(chain, pool.id), pool);
}

export function getRegisteredMarketPool(chain: ChainSlug, poolId: string): PoolKey | undefined {
  return marketPoolRegistry.get(marketPoolRegistryKey(chain, poolId));
}

export function rememberMarketSummary(market: MarketSummary, cacheMs: number): void {
  marketSummaryCache.set(marketSummaryCacheKey(market.chain, market.poolId), {
    expiresAt: Date.now() + Math.max(10_000, cacheMs),
    market
  });
}

export function getRememberedMarketSummary(chain: ChainSlug, poolId: string): MarketSummary | undefined {
  const key = marketSummaryCacheKey(chain, poolId);
  const cached = marketSummaryCache.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    marketSummaryCache.delete(key);
    return undefined;
  }
  return cached.market;
}

function marketSummaryCacheKey(chain: ChainSlug, poolId: string): string {
  return `${chain}:${poolId.toLowerCase()}`;
}

function marketPoolRegistryKey(chain: ChainSlug, poolId: string): string {
  return `${chain}:${poolId.toLowerCase()}`;
}
