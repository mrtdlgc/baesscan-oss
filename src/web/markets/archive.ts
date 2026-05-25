import type { ArchivedPoolInfo, ArchivedSwapTrade, R2SwapArchiveObject, SwapEventArchiveChunk } from "../../services/r2Snapshots";
import { getChain } from "../../chains/registry";
import { dexLabel, poolDex, poolVersionLabel } from "../../dex/discovery";
import { shouldRefreshTokenMetadata, TokenService } from "../../services/token";
import type { ChainSlug, TokenMetadata } from "../../types";
import { blockSecondsFor } from "./config";
import { buildMarketSummary, marketToken, marketTradeToEvent } from "./summary";
import { registerMarketPool, rememberMarketSummary } from "./state";
import type { MarketSummary, MarketTrade, NewPairSummary, NewPairsPayload, TrendingMarketDeps, TrendingMarketsPayload } from "./types";
import { errorMessage } from "./utils";

const MAX_ARCHIVE_CHUNKS_PER_REQUEST = 512;
const ARCHIVE_CHUNK_READ_CONCURRENCY = 4;

interface ArchiveWindow {
  fromBlock: number;
  toBlock: number;
  pools: Map<string, ArchivedPoolInfo>;
  trades: ArchivedSwapTrade[];
}

export async function getArchivedTrendingMarkets(
  deps: TrendingMarketDeps,
  chain: ChainSlug,
  lookbackBlocks: number,
  maxPools: number,
  cacheMs: number
): Promise<TrendingMarketsPayload | undefined> {
  const window = await loadArchiveWindow(deps, chain, lookbackBlocks);
  if (!window || window.trades.length === 0) return undefined;

  const tradesByPool = groupArchivedTradesByPool(window.trades);
  const markets: MarketSummary[] = [];
  for (const [poolId, trades] of tradesByPool.entries()) {
    const info = window.pools.get(poolId);
    if (!info) continue;
    const market = buildArchivedMarketSummary(chain, info, trades, window.toBlock);
    if (!market || market.score <= 0) continue;
    rememberMarketSummary(market, cacheMs);
    markets.push(market);
  }
  markets.sort((a, b) => b.score - a.score);
  const selected = markets.slice(0, maxPools);
  if (selected.length === 0) return undefined;

  return {
    chain,
    generatedAt: new Date().toISOString(),
    fromBlock: window.fromBlock,
    toBlock: window.toBlock,
    lookbackBlocks,
    cacheMs,
    source: "r2-archive",
    markets: selected
  };
}

export async function getArchivedNewPairs(
  deps: TrendingMarketDeps,
  chain: ChainSlug,
  lookbackBlocks: number,
  maxPools: number,
  cacheMs: number
): Promise<NewPairsPayload | undefined> {
  const window = await loadArchiveWindow(deps, chain, lookbackBlocks);
  if (!window) return undefined;

  const tradesByPool = groupArchivedTradesByPool(window.trades);
  const blockSeconds = blockSecondsFor(chain);
  const pairs: NewPairSummary[] = [];

  for (const info of window.pools.values()) {
    const poolId = info.poolId.toLowerCase();
    const trades = tradesByPool.get(poolId) ?? [];
    const createdBlock = info.pool.createdBlock;
    if (createdBlock === undefined || createdBlock < window.fromBlock || createdBlock > window.toBlock) continue;
    const marketTrades = trades.map(archivedTradeToMarketTrade);
    const firstSwap = marketTrades[0] ? marketTradeToEvent(marketTrades[0], chain, window.toBlock) : undefined;
    const firstBuyTrade = marketTrades.find((trade) => trade.side === "buy");
    const firstBuy = firstBuyTrade ? marketTradeToEvent(firstBuyTrade, chain, window.toBlock) : undefined;
    const poolAddress = info.pool.poolAddress ?? (info.pool.id.startsWith("0x") && info.pool.id.length === 42 ? info.pool.id : undefined);
    pairs.push({
      chain,
      poolId: info.pool.id,
      poolAddress,
      dex: dexLabel(poolDex(info.pool)),
      protocol: poolVersionLabel(info.pool),
      pairLabel: `${info.baseToken.symbol}/${info.quoteToken.symbol}`,
      baseToken: marketToken(info.baseToken),
      quoteToken: marketToken(info.quoteToken),
      createdBlock,
      ageMinutes: Math.max(0, (window.toBlock - createdBlock) * blockSeconds) / 60,
      swapCount: trades.length,
      firstSwap,
      firstBuy,
      explorerUrl: poolAddress ? `${getChain(chain).explorerBaseUrl}/address/${poolAddress}` : undefined,
      chartPath: `/chart/${chain}/${encodeURIComponent(info.pool.id)}`
    });
  }

  pairs.sort((a, b) => {
    const byCreated = b.createdBlock - a.createdBlock;
    if (byCreated !== 0) return byCreated;
    return (b.firstBuy?.blockNumber ?? b.firstSwap?.blockNumber ?? 0) - (a.firstBuy?.blockNumber ?? a.firstSwap?.blockNumber ?? 0);
  });
  const selected = pairs.slice(0, maxPools);
  if (selected.length === 0) return undefined;

  return {
    chain,
    generatedAt: new Date().toISOString(),
    fromBlock: window.fromBlock,
    toBlock: window.toBlock,
    lookbackBlocks,
    cacheMs,
    source: "r2-archive",
    pairs: selected
  };
}

export async function getArchivedMarketByPoolId(
  deps: TrendingMarketDeps,
  poolId: string,
  chain: ChainSlug,
  lookbackBlocks: number,
  cacheMs: number
): Promise<MarketSummary | undefined> {
  const normalizedPoolId = poolId.toLowerCase();
  const window = await loadArchiveWindow(deps, chain, lookbackBlocks, normalizedPoolId);
  if (!window) return undefined;
  const info = window.pools.get(normalizedPoolId);
  if (!info) return undefined;
  const trades = window.trades.filter((trade) => trade.poolId.toLowerCase() === normalizedPoolId);
  const market = buildArchivedMarketSummary(chain, info, trades, window.toBlock);
  if (market) rememberMarketSummary(market, cacheMs);
  return market;
}

async function loadArchiveWindow(
  deps: TrendingMarketDeps,
  chain: ChainSlug,
  lookbackBlocks: number,
  poolId?: string
): Promise<ArchiveWindow | undefined> {
  const snapshotStore = deps.snapshotStore;
  if (!snapshotStore || !deps.env.marketArchiveEnabled) return undefined;
  const manifest = await snapshotStore.getSwapArchiveManifest(chain);
  if (!manifest || manifest.objects.length === 0) return undefined;
  const toBlock = manifest.latestToBlock ?? manifest.objects.reduce((max, object) => Math.max(max, object.toBlock), 0);
  if (!Number.isFinite(toBlock)) return undefined;
  const fromBlock = Math.max(0, toBlock - lookbackBlocks);
  const objects = selectArchiveObjects(manifest.objects, fromBlock, toBlock);
  if (objects.length === 0) return undefined;

  const pools = new Map<string, ArchivedPoolInfo>();
  const tradeByKey = new Map<string, ArchivedSwapTrade>();
  await forEachWithConcurrency(
    objects,
    ARCHIVE_CHUNK_READ_CONCURRENCY,
    async (object) => {
      let chunk: SwapEventArchiveChunk | undefined;
      try {
        chunk = await snapshotStore.getSwapEventChunk(object.objectKey);
      } catch (error) {
        deps.logger?.warn(
          { chain, objectKey: object.objectKey, error: errorMessage(error) },
          "r2 archive chunk read failed"
        );
        return;
      }
      if (!chunk || chunk.chain !== chain) return;
      for (const [id, info] of Object.entries(chunk.pools ?? {})) {
        const normalizedId = id.toLowerCase();
        if (poolId && normalizedId !== poolId) continue;
        pools.set(normalizedId, { ...info, poolId: normalizedId });
      }
      for (const trade of chunk.trades ?? []) {
        const tradePoolId = trade.poolId.toLowerCase();
        if (poolId && tradePoolId !== poolId) continue;
        if (trade.blockNumber < fromBlock || trade.blockNumber > toBlock) continue;
        if (!isUsableArchivedTrade(trade)) continue;
        tradeByKey.set(archivedTradeKey(trade), { ...trade, poolId: tradePoolId });
      }
    }
  );

  const trades = [...tradeByKey.values()].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  if (trades.length === 0) return undefined;
  await refreshArchivePoolMetadata(deps, chain, pools);
  return { fromBlock, toBlock, pools, trades };
}

async function refreshArchivePoolMetadata(
  deps: TrendingMarketDeps,
  chain: ChainSlug,
  pools: Map<string, ArchivedPoolInfo>
): Promise<void> {
  const rpc = deps.rpcs.get(chain);
  if (!rpc || pools.size === 0) return;
  const tokenService = new TokenService(rpc, chain);
  const candidates = new Map<string, TokenMetadata>();
  for (const info of pools.values()) {
    if (shouldRefreshTokenMetadata(info.baseToken)) candidates.set(String(info.baseToken.address).toLowerCase(), info.baseToken);
    if (shouldRefreshTokenMetadata(info.quoteToken)) candidates.set(String(info.quoteToken.address).toLowerCase(), info.quoteToken);
  }
  if (candidates.size === 0) return;

  const refreshed = new Map<string, TokenMetadata>();
  await forEachWithConcurrency([...candidates.values()], 4, async (token) => {
    try {
      const resolved = await tokenService.getToken(String(token.address));
      refreshed.set(String(token.address).toLowerCase(), resolved);
    } catch (error) {
      deps.logger?.warn(
        { chain, token: token.address, error: errorMessage(error) },
        "r2 archive token metadata refresh failed"
      );
    }
  });

  if (refreshed.size === 0) return;
  for (const [poolId, info] of pools.entries()) {
    const base = refreshed.get(String(info.baseToken.address).toLowerCase()) ?? info.baseToken;
    const quote = refreshed.get(String(info.quoteToken.address).toLowerCase()) ?? info.quoteToken;
    if (base !== info.baseToken || quote !== info.quoteToken) {
      pools.set(poolId, { ...info, baseToken: base, quoteToken: quote });
    }
  }
}

function selectArchiveObjects(objects: R2SwapArchiveObject[], fromBlock: number, toBlock: number): R2SwapArchiveObject[] {
  return objects
    .filter((object) => object.toBlock >= fromBlock && object.fromBlock <= toBlock)
    .sort((a, b) => b.toBlock - a.toBlock || b.partIndex - a.partIndex)
    .slice(0, MAX_ARCHIVE_CHUNKS_PER_REQUEST)
    .sort((a, b) => a.fromBlock - b.fromBlock || a.partIndex - b.partIndex);
}

function groupArchivedTradesByPool(trades: ArchivedSwapTrade[]): Map<string, ArchivedSwapTrade[]> {
  const out = new Map<string, ArchivedSwapTrade[]>();
  for (const trade of trades) {
    const poolId = trade.poolId.toLowerCase();
    const bucket = out.get(poolId);
    if (bucket) {
      bucket.push(trade);
    } else {
      out.set(poolId, [trade]);
    }
  }
  return out;
}

function buildArchivedMarketSummary(
  chain: ChainSlug,
  info: ArchivedPoolInfo,
  trades: ArchivedSwapTrade[],
  toBlock: number
): MarketSummary | undefined {
  if (trades.length === 0) return undefined;
  registerMarketPool(chain, info.pool);
  const marketTrades = trades.map(archivedTradeToMarketTrade);
  const market = buildMarketSummary(info.pool, chain, info.baseToken, info.quoteToken, marketTrades, info.quoteUsd, toBlock);
  market.source = "r2-archive";
  market.priceUsd ??= marketTrades[marketTrades.length - 1]?.priceUsd;
  return market;
}

function archivedTradeToMarketTrade(trade: ArchivedSwapTrade): MarketTrade {
  return {
    blockNumber: trade.blockNumber,
    logIndex: trade.logIndex,
    txHash: trade.txHash,
    side: trade.side,
    price: trade.price,
    priceUsd: trade.priceUsd,
    targetAmount: trade.baseAmount,
    quoteAmount: trade.quoteAmount,
    volumeUsd: trade.volumeUsd
  };
}

function isUsableArchivedTrade(trade: ArchivedSwapTrade): boolean {
  return Number.isFinite(trade.price)
    && trade.price > 0
    && Number.isFinite(trade.baseAmount)
    && trade.baseAmount > 0
    && Number.isFinite(trade.quoteAmount)
    && trade.quoteAmount > 0;
}

function archivedTradeKey(trade: ArchivedSwapTrade): string {
  return `${trade.poolId.toLowerCase()}:${trade.txHash.toLowerCase()}:${trade.logIndex}`;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await fn(items[index]!);
      } catch {
        results[index] = undefined as R;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function forEachWithConcurrency<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  await mapWithConcurrency(items, concurrency, fn);
}
