import { fetchSwapLogs } from "../../dex/swapLogs";
import { TokenService } from "../../services/token";
import type { ChainSlug } from "../../types";
import { boundedNumber, boundedNumberForChain, DEFAULT_MARKET_DETAIL_CACHE_MS, DEFAULT_MARKET_DETAIL_LOOKBACK_BLOCKS, DEFAULT_NEW_PAIRS_CACHE_MS, DEFAULT_NEW_PAIRS_LOOKBACK_BLOCKS, DEFAULT_NEW_PAIRS_MAX_POOLS, DEFAULT_TRENDING_CACHE_MS, DEFAULT_TRENDING_MAX_POOLS, defaultTrendingLookbackBlocks, ensureEvmMarketChain, MAX_MARKET_DETAIL_LOOKBACK_BLOCKS, MAX_NEW_PAIRS_LOOKBACK_BLOCKS, MAX_NEW_PAIRS_POOLS, MAX_TRENDING_LOOKBACK_BLOCKS, MAX_TRENDING_POOLS } from "./config";
import { buildMarketForPool, buildNewPairs, buildTrendingMarkets } from "./builders";
import { withTimedMarketBuild, throwIfAborted } from "./runtime";
import { getRegisteredMarketPool, getRememberedMarketSummary, rememberMarketSummary } from "./state";
import type { MarketSummary, NewPairsPayload, TrendingMarketDeps, TrendingMarketsPayload } from "./types";
import { errorMessage, MarketArchiveUnavailableError } from "./utils";

interface MarketCacheEntry {
  expiresAt: number;
  payload: Promise<TrendingMarketsPayload>;
}

const marketCache = new Map<string, MarketCacheEntry>();
const marketDetailCache = new Map<string, { expiresAt: number; payload: Promise<MarketSummary | undefined> }>();
const newPairsCache = new Map<string, { expiresAt: number; payload: Promise<NewPairsPayload> }>();
const archiveTrendingCache = new Map<string, { expiresAt: number; payload: Promise<TrendingMarketsPayload | undefined> }>();
const archiveMarketDetailCache = new Map<string, { expiresAt: number; payload: Promise<MarketSummary | undefined> }>();
const archiveNewPairsCache = new Map<string, { expiresAt: number; payload: Promise<NewPairsPayload | undefined> }>();

// Stale-while-revalidate: keep the last successful payload so visitors get
// instant data even when the upstream RPC scan is slow, and we kick a fresh
// build in the background. This keeps the UX usable without R2 fronting.
const lastGoodTrending = new Map<string, { generatedAt: number; payload: TrendingMarketsPayload }>();
const lastGoodNewPairs = new Map<string, { generatedAt: number; payload: NewPairsPayload }>();
const inflightTrending = new Map<string, Promise<TrendingMarketsPayload>>();
const inflightNewPairs = new Map<string, Promise<NewPairsPayload>>();

export async function getTrendingMarkets(deps: TrendingMarketDeps, chain: ChainSlug = "base"): Promise<TrendingMarketsPayload> {
  ensureEvmMarketChain(chain);
  const cacheMs = boundedNumber("TRENDING_CACHE_MS", DEFAULT_TRENDING_CACHE_MS, 5_000, 300_000);
  const lookbackBlocks = boundedNumberForChain(chain, "TRENDING_LOOKBACK_BLOCKS", defaultTrendingLookbackBlocks(chain), 250, MAX_TRENDING_LOOKBACK_BLOCKS);
  const maxPools = boundedNumberForChain(chain, "TRENDING_MAX_POOLS", DEFAULT_TRENDING_MAX_POOLS, 4, MAX_TRENDING_POOLS);
  const cacheKey = `${chain}:${lookbackBlocks}:${maxPools}`;
  const now = Date.now();

  const archived = await loadArchivedTrending(deps, chain, lookbackBlocks, maxPools, cacheMs, cacheKey, now);
  if (archived) return archived;
  if (archiveRequired(deps)) throw new MarketArchiveUnavailableError("trending", chain);

  // 1. Fresh cache: return immediately.
  const cached = marketCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    deps.logger?.debug({ chain, route: "trending", source: "cache" }, "rpc: trending cache hit");
    return cached.payload;
  }

  // 2. Single-flight: if a scan is already running for this key, reuse it.
  const existing = inflightTrending.get(cacheKey);
  const lastGood = lastGoodTrending.get(cacheKey);

  // 3. Stale-while-revalidate: return last-good and kick off a background refresh.
  if (lastGood && !existing) {
    deps.logger?.info(
      { chain, route: "trending", staleAgeMs: now - lastGood.generatedAt, lookbackBlocks, maxPools },
      "rpc: trending stale-while-revalidate (background scan)"
    );
    const refresh = launchTrendingScan(deps, chain, lookbackBlocks, maxPools, cacheMs, cacheKey);
    // Suppress unhandled rejection — error already logged inside launchTrendingScan.
    refresh.catch(() => undefined);
    return lastGood.payload;
  }

  if (existing) {
    deps.logger?.debug({ chain, route: "trending", source: "inflight" }, "rpc: trending coalesced into inflight scan");
    return existing;
  }

  // 4. Cold path: no cache, no inflight, no last-good. The caller has to wait.
  deps.logger?.info({ chain, route: "trending", lookbackBlocks, maxPools }, "rpc: trending cold scan");
  return launchTrendingScan(deps, chain, lookbackBlocks, maxPools, cacheMs, cacheKey);
}

function launchTrendingScan(
  deps: TrendingMarketDeps,
  chain: ChainSlug,
  lookbackBlocks: number,
  maxPools: number,
  cacheMs: number,
  cacheKey: string
): Promise<TrendingMarketsPayload> {
  const payload = withTimedMarketBuild(deps, chain, `trending:${chain}`, (signal) =>
    buildTrendingMarkets(deps, chain, lookbackBlocks, maxPools, cacheMs, signal)
  );
  inflightTrending.set(cacheKey, payload);
  marketCache.set(cacheKey, { expiresAt: Date.now() + cacheMs, payload });
  payload
    .then((result) => {
      lastGoodTrending.set(cacheKey, { generatedAt: Date.now(), payload: result });
    })
    .catch((error) => {
      // Failed refresh shouldn't poison the cache; drop the in-flight entry so the next
      // request retries. Last-good (if any) stays served until a scan succeeds.
      if (marketCache.get(cacheKey)?.payload === payload) marketCache.delete(cacheKey);
      deps.logger?.warn(
        { chain, route: "trending", error: errorMessage(error) },
        "rpc: trending scan failed; keeping last-good payload (if any)"
      );
    })
    .finally(() => {
      if (inflightTrending.get(cacheKey) === payload) inflightTrending.delete(cacheKey);
    });
  return payload;
}

async function loadArchivedTrending(
  deps: TrendingMarketDeps,
  chain: ChainSlug,
  lookbackBlocks: number,
  maxPools: number,
  cacheMs: number,
  cacheKey: string,
  now: number
): Promise<TrendingMarketsPayload | undefined> {
  if (!deps.snapshotStore || !deps.env.marketArchiveEnabled) return undefined;
  const archiveKey = `archive:${cacheKey}`;
  const cached = archiveTrendingCache.get(archiveKey);
  if (cached && cached.expiresAt > now) {
    deps.logger?.debug({ chain, route: "trending", source: "r2-archive-cache" }, "r2 archive: trending cache hit");
    return cached.payload;
  }
  const payload = deps.snapshotStore.getTrendingSnapshot(chain)
    .catch((error) => {
      deps.logger?.warn(
        { chain, route: "trending", error: errorMessage(error) },
        "r2 snapshot: trending read failed"
      );
      return undefined;
    });
  archiveTrendingCache.set(archiveKey, { expiresAt: now + cacheMs, payload });
  const result = await payload;
  if (result) {
    deps.logger?.info({ chain, route: "trending", markets: result.markets.length }, "r2 snapshot: trending payload served");
    lastGoodTrending.set(cacheKey, { generatedAt: Date.now(), payload: result });
  }
  return result;
}

export async function getNewPairs(deps: TrendingMarketDeps, chain: ChainSlug = "base"): Promise<NewPairsPayload> {
  ensureEvmMarketChain(chain);
  const cacheMs = boundedNumber("NEW_PAIRS_CACHE_MS", DEFAULT_NEW_PAIRS_CACHE_MS, 5_000, 300_000);
  const lookbackBlocks = boundedNumberForChain(chain, "NEW_PAIRS_LOOKBACK_BLOCKS", DEFAULT_NEW_PAIRS_LOOKBACK_BLOCKS, 250, MAX_NEW_PAIRS_LOOKBACK_BLOCKS);
  const maxPools = boundedNumberForChain(chain, "NEW_PAIRS_MAX_POOLS", DEFAULT_NEW_PAIRS_MAX_POOLS, 4, MAX_NEW_PAIRS_POOLS);
  const cacheKey = `${chain}:${lookbackBlocks}:${maxPools}`;
  const now = Date.now();
  const archived = await loadArchivedNewPairs(deps, chain, lookbackBlocks, maxPools, cacheMs, cacheKey, now);
  if (archived) return archived;
  if (archiveRequired(deps)) throw new MarketArchiveUnavailableError("new-pairs", chain);

  const cached = newPairsCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    deps.logger?.debug({ chain, route: "new-pairs", source: "cache" }, "rpc: new-pairs cache hit");
    return cached.payload;
  }

  const existing = inflightNewPairs.get(cacheKey);
  const lastGood = lastGoodNewPairs.get(cacheKey);
  if (lastGood && !existing) {
    deps.logger?.info(
      { chain, route: "new-pairs", staleAgeMs: now - lastGood.generatedAt, lookbackBlocks, maxPools },
      "rpc: new-pairs stale-while-revalidate (background scan)"
    );
    launchNewPairsScan(deps, chain, lookbackBlocks, maxPools, cacheMs, cacheKey).catch(() => undefined);
    return lastGood.payload;
  }
  if (existing) {
    deps.logger?.debug({ chain, route: "new-pairs", source: "inflight" }, "rpc: new-pairs coalesced into inflight scan");
    return existing;
  }

  deps.logger?.info({ chain, route: "new-pairs", lookbackBlocks, maxPools }, "rpc: new-pairs cold scan");
  return launchNewPairsScan(deps, chain, lookbackBlocks, maxPools, cacheMs, cacheKey);
}

function launchNewPairsScan(
  deps: TrendingMarketDeps,
  chain: ChainSlug,
  lookbackBlocks: number,
  maxPools: number,
  cacheMs: number,
  cacheKey: string
): Promise<NewPairsPayload> {
  const payload = withTimedMarketBuild(deps, chain, `new-pairs:${chain}`, (signal) =>
    buildNewPairs(deps, chain, lookbackBlocks, maxPools, cacheMs, signal)
  );
  inflightNewPairs.set(cacheKey, payload);
  newPairsCache.set(cacheKey, { expiresAt: Date.now() + cacheMs, payload });
  payload
    .then((result) => {
      lastGoodNewPairs.set(cacheKey, { generatedAt: Date.now(), payload: result });
    })
    .catch((error) => {
      if (newPairsCache.get(cacheKey)?.payload === payload) newPairsCache.delete(cacheKey);
      deps.logger?.warn(
        { chain, route: "new-pairs", error: errorMessage(error) },
        "rpc: new-pairs scan failed; keeping last-good payload (if any)"
      );
    })
    .finally(() => {
      if (inflightNewPairs.get(cacheKey) === payload) inflightNewPairs.delete(cacheKey);
    });
  return payload;
}

async function loadArchivedNewPairs(
  deps: TrendingMarketDeps,
  chain: ChainSlug,
  lookbackBlocks: number,
  maxPools: number,
  cacheMs: number,
  cacheKey: string,
  now: number
): Promise<NewPairsPayload | undefined> {
  if (!deps.snapshotStore || !deps.env.marketArchiveEnabled) return undefined;
  const archiveKey = `archive:${cacheKey}`;
  const cached = archiveNewPairsCache.get(archiveKey);
  if (cached && cached.expiresAt > now) {
    deps.logger?.debug({ chain, route: "new-pairs", source: "r2-archive-cache" }, "r2 archive: new-pairs cache hit");
    return cached.payload;
  }
  const payload = deps.snapshotStore.getNewPairsSnapshot(chain)
    .catch((error) => {
      deps.logger?.warn(
        { chain, route: "new-pairs", error: errorMessage(error) },
        "r2 snapshot: new-pairs read failed"
      );
      return undefined;
    });
  archiveNewPairsCache.set(archiveKey, { expiresAt: now + cacheMs, payload });
  const result = await payload;
  if (result) {
    deps.logger?.info({ chain, route: "new-pairs", pairs: result.pairs.length }, "r2 snapshot: new-pairs payload served");
    lastGoodNewPairs.set(cacheKey, { generatedAt: Date.now(), payload: result });
  }
  return result;
}

export async function getTrendingMarketByPoolId(
  deps: TrendingMarketDeps,
  poolId: string,
  chain: ChainSlug = "base"
): Promise<MarketSummary | undefined> {
  return getMarketDetailByPoolId(deps, poolId, chain);
}

export async function getMarketDetailByPoolId(
  deps: TrendingMarketDeps,
  poolId: string,
  chain: ChainSlug = "base"
): Promise<MarketSummary | undefined> {
  ensureEvmMarketChain(chain);
  const cacheMs = boundedNumber("MARKET_DETAIL_CACHE_MS", DEFAULT_MARKET_DETAIL_CACHE_MS, 2_000, 60_000);
  const lookbackBlocks = boundedNumberForChain(chain, "MARKET_DETAIL_LOOKBACK_BLOCKS", DEFAULT_MARKET_DETAIL_LOOKBACK_BLOCKS, 250, MAX_MARKET_DETAIL_LOOKBACK_BLOCKS);
  const key = `${chain}:${poolId.toLowerCase()}:${lookbackBlocks}`;
  const now = Date.now();
  if (archiveRequired(deps) && !deps.snapshotStore) throw new MarketArchiveUnavailableError("market", chain);
  const archived = await loadArchivedMarketDetail(deps, poolId, chain, lookbackBlocks, cacheMs, key, now);
  if (archived) return archived;
  if (archiveRequired(deps)) return undefined;
  const cached = marketDetailCache.get(key);
  if (cached && cached.expiresAt > now) {
    deps.logger?.debug({ chain, route: "market", source: "cache", poolId }, "rpc: market detail cache hit");
    return cached.payload;
  }
  const remembered = getRememberedMarketSummary(chain, poolId);
  if (remembered) {
    deps.logger?.debug({ chain, route: "market", source: "trending-warm", poolId }, "rpc: market detail warm-cache hit");
    return remembered;
  }
  deps.logger?.info({ chain, route: "market", poolId, lookbackBlocks }, "rpc: market detail cache miss → scan");

  const payload = withTimedMarketBuild(deps, chain, `market:${chain}`, (signal) =>
    buildMarketDetail(deps, poolId, chain, lookbackBlocks, signal)
  );
  marketDetailCache.set(key, { expiresAt: now + cacheMs, payload });
  try {
    return await payload;
  } catch (error) {
    if (marketDetailCache.get(key)?.payload === payload) marketDetailCache.delete(key);
    throw error;
  }
}

async function loadArchivedMarketDetail(
  deps: TrendingMarketDeps,
  poolId: string,
  chain: ChainSlug,
  lookbackBlocks: number,
  cacheMs: number,
  cacheKey: string,
  now: number
): Promise<MarketSummary | undefined> {
  if (!deps.snapshotStore || !deps.env.marketArchiveEnabled) return undefined;
  const archiveKey = `archive:${cacheKey}`;
  const cached = archiveMarketDetailCache.get(archiveKey);
  if (cached && cached.expiresAt > now) {
    deps.logger?.debug({ chain, route: "market", source: "r2-archive-cache", poolId }, "r2 archive: market detail cache hit");
    return cached.payload;
  }
  const payload = deps.snapshotStore.getMarketSnapshot(chain, poolId)
    .catch((error) => {
      deps.logger?.warn(
        { chain, route: "market", poolId, error: errorMessage(error) },
        "r2 snapshot: market detail read failed"
      );
      return undefined;
    });
  archiveMarketDetailCache.set(archiveKey, { expiresAt: now + cacheMs, payload });
  const result = await payload;
  if (result) deps.logger?.info({ chain, route: "market", poolId }, "r2 snapshot: market detail served");
  return result;
}

function archiveRequired(deps: TrendingMarketDeps): boolean {
  return deps.env.marketArchiveEnabled;
}

async function buildMarketDetail(
  deps: TrendingMarketDeps,
  poolId: string,
  chain: ChainSlug,
  lookbackBlocks: number,
  signal: AbortSignal
): Promise<MarketSummary | undefined> {
  throwIfAborted(signal, `market:${chain}`);
  const rpc = deps.rpcs.get(chain);
  if (!rpc) throw new Error(`No RPC pool configured for ${chain}`);
  let pool = getRegisteredMarketPool(chain, poolId);
  if (!pool) {
    const trending = await getTrendingMarkets(deps, chain);
    throwIfAborted(signal, `market:${chain}`);
    pool = getRegisteredMarketPool(chain, poolId);
    if (!pool && !trending.markets.some((market) => market.poolId.toLowerCase() === poolId.toLowerCase())) return undefined;
  }
  if (!pool) return undefined;
  const toBlock = await rpc.getBlockNumber();
  throwIfAborted(signal, `market:${chain}`);
  const fromBlock = Math.max(0, toBlock - lookbackBlocks);
  const tokenService = new TokenService(rpc, chain);
  const logs = await fetchSwapLogs(rpc, deps.env, chain, [pool], fromBlock, toBlock);
  throwIfAborted(signal, `market:${chain}`);
  const market = await buildMarketForPool(deps, tokenService, chain, pool, logs, toBlock);
  throwIfAborted(signal, `market:${chain}`);
  if (market) rememberMarketSummary(market, boundedNumber("MARKET_DETAIL_CACHE_MS", DEFAULT_MARKET_DETAIL_CACHE_MS, 2_000, 60_000));
  return market;
}
