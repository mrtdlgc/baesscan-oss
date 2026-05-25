import type { Log } from "ethers";
import { getChain } from "../../chains/registry";
import { dexLabel, poolDex, poolVersionLabel } from "../../dex/discovery";
import { fetchSwapLogs } from "../../dex/swapLogs";
import { TokenService } from "../../services/token";
import type { ChainSlug, PoolKey } from "../../types";
import { blockSecondsFor } from "./config";
import { discoverRecentPools, resolveMarketPools } from "./discovery";
import { chooseMarketSide, groupLogsByPool, uniquePools } from "./poolUtils";
import { throwIfAborted } from "./runtime";
import { buildMarketSummary, marketToken, marketTradeToEvent } from "./summary";
import { registerMarketPool, rememberMarketSummary } from "./state";
import { parseMarketTrades } from "./tradeParsing";
import type { MarketSummary, NewPairSummary, NewPairsPayload, TrendingMarketDeps, TrendingMarketsPayload } from "./types";
import { rpcHealthSummary } from "./utils";

export async function buildTrendingMarkets(
  deps: TrendingMarketDeps,
  chain: ChainSlug,
  lookbackBlocks: number,
  maxPools: number,
  cacheMs: number,
  signal: AbortSignal
): Promise<TrendingMarketsPayload> {
  throwIfAborted(signal, `trending:${chain}`);
  const rpc = deps.rpcs.get(chain);
  if (!rpc) throw new Error(`No RPC pool configured for ${chain}`);

  const log = deps.logger?.child({ chain, route: "trending" });
  const tStart = Date.now();
  const toBlock = await rpc.getBlockNumber();
  throwIfAborted(signal, `trending:${chain}`);
  log?.debug({ toBlock, durationMs: Date.now() - tStart }, "rpc: getBlockNumber");
  const fromBlock = Math.max(0, toBlock - lookbackBlocks);
  const tokenService = new TokenService(rpc, chain);
  const dynamicLimit = Math.max(2, Math.floor(maxPools / 2));
  const tDiscover = Date.now();
  const dynamicPools = await discoverRecentPools(chain, rpc, fromBlock, toBlock, dynamicLimit, deps.env.logChunkSize);
  throwIfAborted(signal, `trending:${chain}`);
  log?.info(
    { dynamicPools: dynamicPools.length, blocks: toBlock - fromBlock, durationMs: Date.now() - tDiscover },
    "rpc: dynamic pool discovery"
  );
  const seedPools = await resolveMarketPools(chain, rpc, maxPools - dynamicPools.length);
  throwIfAborted(signal, `trending:${chain}`);
  const pools = uniquePools([...dynamicPools, ...seedPools]).slice(0, maxPools);
  const tLogs = Date.now();
  const logs = await fetchSwapLogs(rpc, deps.env, chain, pools, fromBlock, toBlock);
  throwIfAborted(signal, `trending:${chain}`);
  log?.info(
    { pools: pools.length, swapLogs: logs.length, fromBlock, toBlock, durationMs: Date.now() - tLogs },
    "rpc: fetchSwapLogs"
  );
  const logsByPool = groupLogsByPool(logs, pools, deps.env, chain);
  const markets: MarketSummary[] = [];

  for (const pool of pools) {
    throwIfAborted(signal, `trending:${chain}`);
    registerMarketPool(chain, pool);
    const market = await buildMarketForPool(deps, tokenService, chain, pool, logsByPool.get(pool.id.toLowerCase()) ?? [], toBlock);
    throwIfAborted(signal, `trending:${chain}`);
    if (market && market.score > 0) {
      rememberMarketSummary(market, cacheMs);
      markets.push(market);
    }
  }

  markets.sort((a, b) => b.score - a.score);
  log?.info(
    { markets: markets.length, totalDurationMs: Date.now() - tStart, rpcHealth: rpcHealthSummary(rpc) },
    "rpc: trending build complete"
  );
  return {
    chain,
    generatedAt: new Date().toISOString(),
    fromBlock,
    toBlock,
    lookbackBlocks,
    cacheMs,
    source: "raw-rpc",
    markets
  };
}

export async function buildNewPairs(
  deps: TrendingMarketDeps,
  chain: ChainSlug,
  lookbackBlocks: number,
  maxPools: number,
  cacheMs: number,
  signal: AbortSignal
): Promise<NewPairsPayload> {
  throwIfAborted(signal, `new-pairs:${chain}`);
  const rpc = deps.rpcs.get(chain);
  if (!rpc) throw new Error(`No RPC pool configured for ${chain}`);

  const log = deps.logger?.child({ chain, route: "new-pairs" });
  const tStart = Date.now();
  const toBlock = await rpc.getBlockNumber();
  throwIfAborted(signal, `new-pairs:${chain}`);
  log?.debug({ toBlock }, "rpc: getBlockNumber");
  const fromBlock = Math.max(0, toBlock - lookbackBlocks);
  const tokenService = new TokenService(rpc, chain);
  const tDiscover = Date.now();
  const pools = uniquePools(await discoverRecentPools(chain, rpc, fromBlock, toBlock, maxPools, deps.env.logChunkSize)).slice(0, maxPools);
  throwIfAborted(signal, `new-pairs:${chain}`);
  log?.info({ pools: pools.length, blocks: toBlock - fromBlock, durationMs: Date.now() - tDiscover }, "rpc: factory log discovery");
  const tLogs = Date.now();
  const logs = pools.length ? await fetchSwapLogs(rpc, deps.env, chain, pools, fromBlock, toBlock) : [];
  throwIfAborted(signal, `new-pairs:${chain}`);
  log?.info({ pools: pools.length, swapLogs: logs.length, durationMs: Date.now() - tLogs }, "rpc: fetchSwapLogs (new-pairs)");
  const logsByPool = groupLogsByPool(logs, pools, deps.env, chain);
  const pairs: NewPairSummary[] = [];

  for (const pool of pools) {
    throwIfAborted(signal, `new-pairs:${chain}`);
    registerMarketPool(chain, pool);
    try {
      const pair = await buildNewPairForPool(deps, tokenService, chain, pool, logsByPool.get(pool.id.toLowerCase()) ?? [], toBlock, cacheMs);
      throwIfAborted(signal, `new-pairs:${chain}`);
      if (pair) pairs.push(pair);
    } catch {
      // A single illiquid or non-standard pool should not block the new-pairs feed.
    }
  }

  pairs.sort((a, b) => {
    const byCreated = b.createdBlock - a.createdBlock;
    if (byCreated !== 0) return byCreated;
    return (b.firstBuy?.blockNumber ?? b.firstSwap?.blockNumber ?? 0) - (a.firstBuy?.blockNumber ?? a.firstSwap?.blockNumber ?? 0);
  });
  log?.info(
    { pairs: pairs.length, totalDurationMs: Date.now() - tStart, rpcHealth: rpcHealthSummary(rpc) },
    "rpc: new-pairs build complete"
  );

  return {
    chain,
    generatedAt: new Date().toISOString(),
    fromBlock,
    toBlock,
    lookbackBlocks,
    cacheMs,
    source: "raw-rpc",
    pairs
  };
}

async function buildNewPairForPool(
  deps: TrendingMarketDeps,
  tokenService: TokenService,
  chain: ChainSlug,
  pool: PoolKey,
  poolLogs: Log[],
  toBlock: number,
  cacheMs: number
): Promise<NewPairSummary | undefined> {
  const side = chooseMarketSide(pool, chain);
  if (!side) return undefined;
  const [baseToken, quoteToken] = await Promise.all([
    tokenService.getToken(side.base),
    tokenService.getToken(side.quote)
  ]);
  const quoteUsd = await deps.priceService.quoteUsdMultiplier(side.quote, chain);
  const createdBlock = pool.createdBlock ?? poolLogs[0]?.blockNumber ?? toBlock;
  const trades = parseMarketTrades(
    pool,
    side,
    baseToken,
    quoteToken,
    quoteUsd,
    poolLogs.filter((log) => log.blockNumber >= createdBlock)
  );
  const firstSwap = trades[0] ? marketTradeToEvent(trades[0], chain, toBlock) : undefined;
  const firstBuyTrade = trades.find((trade) => trade.side === "buy");
  const firstBuy = firstBuyTrade ? marketTradeToEvent(firstBuyTrade, chain, toBlock) : undefined;
  const poolAddress = pool.poolAddress ?? (pool.id.startsWith("0x") && pool.id.length === 42 ? pool.id : undefined);
  if (trades.length > 0) {
    rememberMarketSummary(buildMarketSummary(pool, chain, baseToken, quoteToken, trades, quoteUsd, toBlock), cacheMs);
  }

  return {
    chain,
    poolId: pool.id,
    poolAddress,
    dex: dexLabel(poolDex(pool)),
    protocol: poolVersionLabel(pool),
    pairLabel: `${baseToken.symbol}/${quoteToken.symbol}`,
    baseToken: marketToken(baseToken),
    quoteToken: marketToken(quoteToken),
    createdBlock,
    ageMinutes: Math.max(0, (toBlock - createdBlock) * blockSecondsFor(chain)) / 60,
    swapCount: trades.length,
    firstSwap,
    firstBuy,
    explorerUrl: poolAddress ? `${getChain(chain).explorerBaseUrl}/address/${poolAddress}` : undefined,
    chartPath: `/chart/${chain}/${encodeURIComponent(pool.id)}`
  };
}

export async function buildMarketForPool(
  deps: TrendingMarketDeps,
  tokenService: TokenService,
  chain: ChainSlug,
  pool: PoolKey,
  poolLogs: Log[],
  toBlock: number
): Promise<MarketSummary | undefined> {
  if (poolLogs.length === 0) return undefined;
  const side = chooseMarketSide(pool, chain);
  if (!side) return undefined;
  const [baseToken, quoteToken] = await Promise.all([
    tokenService.getToken(side.base),
    tokenService.getToken(side.quote)
  ]);
  const quoteUsd = await deps.priceService.quoteUsdMultiplier(side.quote, chain);
  const trades = parseMarketTrades(pool, side, baseToken, quoteToken, quoteUsd, poolLogs);
  if (trades.length === 0) return undefined;
  return buildMarketSummary(pool, chain, baseToken, quoteToken, trades, quoteUsd, toBlock);
}
