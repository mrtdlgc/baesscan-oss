import type { Log } from "ethers";
import type { Logger } from "pino";
import { getChain } from "../chains/registry";
import type { Env } from "../config/env";
import { AERODROME_SWAP_TOPIC } from "../dex/aerodrome";
import { BALANCER_SWAP_TOPIC } from "../dex/balancer";
import { CURVE_TOKEN_EXCHANGE_TOPICS } from "../dex/curve";
import { HYDREX_SWAP_TOPIC } from "../dex/hydrex";
import { LB_SWAP_TOPIC } from "../dex/liquidityBook";
import { fetchSwapLogs, poolIdForSwapLog } from "../dex/swapLogs";
import type { LogFilter, RpcPool } from "./rpcPool";
import type { ChainSlug, PoolKey } from "../types";
import type { MarketPoolSource, Storage, SwapArchiveChunkRecord, TrackedMarketPoolRecord } from "../store/storage";
import { shouldRefreshTokenMetadata, TokenService } from "./token";
import type { PriceService } from "./price";
import type { BlockscoutClient } from "./blockscout";
import { R2SnapshotStore, type ArchivedPoolInfo, type ArchivedSwapTrade, type CompactSwapEvent, type R2SwapArchiveManifest, type R2SwapArchiveObject, type SwapEventArchiveChunk } from "./r2Snapshots";
import { boundedNumber, boundedNumberForChain, DEFAULT_MARKET_DETAIL_CACHE_MS, DEFAULT_MARKET_DETAIL_LOOKBACK_BLOCKS, DEFAULT_NEW_PAIRS_CACHE_MS, DEFAULT_NEW_PAIRS_LOOKBACK_BLOCKS, DEFAULT_NEW_PAIRS_MAX_POOLS, DEFAULT_TRENDING_CACHE_MS, DEFAULT_TRENDING_MAX_POOLS, defaultTrendingLookbackBlocks, MARKET_SEEDS_BY_CHAIN, MAX_MARKET_DETAIL_LOOKBACK_BLOCKS, MAX_NEW_PAIRS_LOOKBACK_BLOCKS, MAX_NEW_PAIRS_POOLS, MAX_TRENDING_LOOKBACK_BLOCKS, MAX_TRENDING_POOLS } from "../web/markets/config";
import { discoverTrackedPoolsInRange, resolveMarketPools } from "../web/markets/discovery";
import { chooseMarketSide, groupLogsByPool, uniquePools } from "../web/markets/poolUtils";
import { parseMarketTrades } from "../web/markets/tradeParsing";
import { getArchivedMarketByPoolId, getArchivedNewPairs, getArchivedTrendingMarkets } from "../web/markets/archive";
import type { MarketTrade } from "../web/markets/types";
import { errorMessage } from "../web/markets/utils";
import { FLAUNCH_HOOK_SWAP_TOPIC, PANCAKE_V3_SWAP_TOPIC, SWAP_TOPIC, V2_SWAP_TOPIC, V3_SWAP_TOPIC } from "../uniswap/abis";
import { BASE_FLAUNCH_HOOKS } from "../uniswap/constants";

const ARCHIVE_DETAIL_WRITE_CONCURRENCY = 3;

export interface MarketArchiveBackfillOptions {
  chain: ChainSlug;
  fromBlock: number;
  toBlock: number;
  factoryStepBlocks?: number;
  swapStepBlocks?: number;
  maxPools?: number;
  resume?: boolean;
  publishDerived?: boolean;
  onProgress?: (progress: MarketArchiveBackfillProgress) => void;
}

export interface MarketArchiveBackfillProgress {
  chain: ChainSlug;
  stage: "seed" | "factory" | "swap" | "manifest" | "derived";
  fromBlock?: number;
  toBlock?: number;
  discoveredPools?: number;
  candidatePools?: number;
  registryWrites?: number;
  activePools?: number;
  pools?: number;
  swapLogs?: number;
  archivedEvents?: number;
  archivedTrades?: number;
  chunks?: number;
  pruned?: number;
  message?: string;
}

export interface MarketArchiveBackfillSummary {
  chain: ChainSlug;
  fromBlock: number;
  toBlock: number;
  factoryFromBlock: number;
  swapFromBlock: number;
  seedPools: number;
  discoveredPools: number;
  registryWrites: number;
  scannedPools: number;
  swapLogs: number;
  archivedEvents: number;
  archivedTrades: number;
  chunks: number;
  pruned: number;
}

export class MarketArchiveIndexer {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly pendingPoolsByChain = new Map<ChainSlug, Map<string, PoolKey>>();
  private readonly pendingSourcesByChain = new Map<ChainSlug, Map<string, MarketPoolSource>>();
  private readonly tokenServicesByChain = new Map<ChainSlug, TokenService>();
  private readonly archivedPoolInfoByChain = new Map<ChainSlug, Map<string, ArchivedPoolInfo>>();

  constructor(
    private readonly deps: {
      env: Env;
      rpcs: Map<ChainSlug, RpcPool>;
      store: Storage;
      snapshotStore?: R2SnapshotStore;
      blockscoutClient?: BlockscoutClient;
      priceService: PriceService;
      logger: Logger;
    }
  ) {}

  start(): void {
    if (this.timer || !this.deps.env.marketArchiveEnabled) return;
    this.runSafely("startup");
    this.timer = setInterval(() => {
      this.runSafely("interval");
    }, this.deps.env.marketArchiveIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async runOnce(reason = "manual"): Promise<void> {
    if (this.running) {
      this.deps.logger.debug({ reason }, "market archive tick skipped; previous tick still running");
      return;
    }
    this.running = true;
    try {
      this.deps.blockscoutClient?.resetBudget();
      for (const chain of this.deps.env.marketArchiveChains) {
        try {
          await this.runChain(chain, reason);
        } catch (error) {
          this.deps.logger.warn({ chain, reason, error: (error as Error).message }, "market archive chain tick failed");
        }
      }
    } finally {
      this.running = false;
    }
  }

  private runSafely(reason: string): void {
    void this.runOnce(reason).catch((error) => {
      this.deps.logger.warn({ reason, error: (error as Error).message }, "market archive tick failed");
    });
  }

  private async pruneSwapArchiveRecords(chain: ChainSlug, logger: Logger): Promise<number> {
    const cutoffIso = retentionCutoffIso(this.deps.env.marketHistoryRetentionDays);
    const expired = this.deps.store.getSwapArchiveChunks(chain).filter((record) => record.generatedAt < cutoffIso);
    if (expired.length === 0) return 0;
    if (this.deps.snapshotStore) {
      const failedDeletes: Array<{ objectKey: string; error: string }> = [];
      let deletedObjects = 0;
      for (const record of expired) {
        try {
          if (await this.deps.snapshotStore.deleteObjectByKey(record.objectKey)) deletedObjects += 1;
        } catch (error) {
          failedDeletes.push({ objectKey: record.objectKey, error: (error as Error).message });
        }
      }
      if (failedDeletes.length > 0) {
        logger.warn({ expired: expired.length, deletedObjects, failedDeletes: failedDeletes.slice(0, 5) }, "market archive R2 chunk pruning partially failed; local records kept for retry");
        return 0;
      }
      logger.info({ expired: expired.length, deletedObjects }, "market archive expired R2 chunk objects pruned by retention");
    }
    const pruned = this.deps.store.pruneSwapArchiveChunks(chain, cutoffIso);
    if (pruned > 0) logger.info({ pruned }, "market archive local chunk records pruned by retention");
    return pruned;
  }

  private async bootstrapPoolRegistryFromR2(chain: ChainSlug, logger: Logger): Promise<number> {
    if (!this.deps.snapshotStore) return 0;
    if (this.deps.store.getMarketPools(chain).some(isPublishedPoolRecord)) return 0;
    const registry = await this.deps.snapshotStore.getMarketPoolRegistry(chain);
    if (!registry || registry.pools.length === 0) return 0;
    this.deps.store.upsertMarketPools(registry.pools);
    await this.deps.store.save();
    logger.info({ pools: registry.pools.length, generatedAt: registry.generatedAt }, "market archive pool registry bootstrapped from R2");
    return registry.pools.length;
  }

  private async publishPoolRegistry(chain: ChainSlug, generatedAt: string): Promise<void> {
    if (!this.deps.snapshotStore) return;
    const pools = this.deps.store.getMarketPools(chain).filter(isPublishedPoolRecord);
    await this.deps.snapshotStore.publishMarketPoolRegistry({
      schemaVersion: 1,
      generatedAt,
      source: "raw-rpc",
      chain,
      poolCount: pools.length,
      pools
    });
  }

  private pendingCandidates(chain: ChainSlug): { pools: Map<string, PoolKey>; sources: Map<string, MarketPoolSource> } {
    let pools = this.pendingPoolsByChain.get(chain);
    if (!pools) {
      pools = new Map<string, PoolKey>();
      this.pendingPoolsByChain.set(chain, pools);
    }
    let sources = this.pendingSourcesByChain.get(chain);
    if (!sources) {
      sources = new Map<string, MarketPoolSource>();
      this.pendingSourcesByChain.set(chain, sources);
    }
    return { pools, sources };
  }

  private tokenServiceFor(chain: ChainSlug, rpc: RpcPool): TokenService {
    let service = this.tokenServicesByChain.get(chain);
    if (!service) {
      service = new TokenService(rpc, chain, {
        fastMetadata: this.deps.env.marketArchiveFastTokenMetadata
      });
      this.tokenServicesByChain.set(chain, service);
    }
    return service;
  }

  private archivedPoolInfoFor(chain: ChainSlug): Map<string, ArchivedPoolInfo> {
    let cache = this.archivedPoolInfoByChain.get(chain);
    if (!cache) {
      cache = new Map<string, ArchivedPoolInfo>();
      this.archivedPoolInfoByChain.set(chain, cache);
    }
    return cache;
  }

  private async bootstrapSwapArchiveManifestFromR2(chain: ChainSlug, logger: Logger): Promise<number> {
    if (!this.deps.snapshotStore) return 0;
    const localCount = this.deps.store.getSwapArchiveChunks(chain).length;
    const manifest = await this.deps.snapshotStore.getSwapArchiveManifest(chain);
    if (!manifest || manifest.objects.length === 0 || manifest.objects.length <= localCount) return 0;
    this.deps.store.recordSwapArchiveChunks(manifest.objects.map(swapObjectToRecord));
    const cursor = this.deps.store.getMarketArchiveCursor(chain);
    if (cursor?.swapLastBlock === undefined && manifest.latestToBlock !== undefined) {
      this.deps.store.setMarketArchiveCursor({
        chain,
        factoryLastBlock: cursor?.factoryLastBlock,
        swapLastBlock: manifest.latestToBlock,
        updatedAt: new Date().toISOString()
      });
    }
    await this.deps.store.save();
    logger.info({ manifestObjects: manifest.objects.length, localCount }, "market archive swap manifest bootstrapped from R2");
    return manifest.objects.length;
  }

  async runBackfillRange(options: MarketArchiveBackfillOptions): Promise<MarketArchiveBackfillSummary> {
    const rpc = this.deps.rpcs.get(options.chain);
    if (!rpc) throw new Error(`No RPC configured for ${options.chain}`);
    if (!this.deps.snapshotStore) throw new Error("Archive backfill requires R2 snapshot credentials");
    const chain = options.chain;
    const logger = this.deps.logger.child({ chain, component: "market-archive-backfill" });
    await this.bootstrapPoolRegistryFromR2(chain, logger);
    await this.bootstrapSwapArchiveManifestFromR2(chain, logger);
    const fromBlock = Math.max(0, Math.floor(options.fromBlock));
    const toBlock = Math.max(fromBlock, Math.floor(options.toBlock));
    const factoryStepBlocks = Math.max(1, Math.floor(options.factoryStepBlocks ?? this.deps.env.marketArchiveFactoryLookbackBlocks));
    const swapStepBlocks = Math.max(1, Math.floor(options.swapStepBlocks ?? this.deps.env.marketArchiveSwapLookbackBlocks));
    const resume = options.resume ?? true;
    const publishDerived = options.publishDerived ?? true;
    const summary: MarketArchiveBackfillSummary = {
      chain,
      fromBlock,
      toBlock,
      factoryFromBlock: fromBlock,
      swapFromBlock: fromBlock,
      seedPools: 0,
      discoveredPools: 0,
      registryWrites: 0,
      scannedPools: 0,
      swapLogs: 0,
      archivedEvents: 0,
      archivedTrades: 0,
      chunks: 0,
      pruned: 0
    };

    const now = new Date().toISOString();
    const seedPools = await resolveMarketPools(chain, rpc, MARKET_SEEDS_BY_CHAIN[chain]?.length ?? 0);
    const candidatePools = new Map<string, PoolKey>();
    const candidateSources = new Map<string, MarketPoolSource>();
    rememberCandidatePools(candidatePools, candidateSources, uniquePools(seedPools), "pending-seed");
    summary.seedPools = seedPools.length;
    options.onProgress?.({ chain, stage: "seed", discoveredPools: seedPools.length, candidatePools: candidatePools.size, message: "seed pool candidates queued" });
    logger.info({ seedPools: seedPools.length, candidates: candidatePools.size }, "market archive backfill seed pool candidates queued");

    const initialCursor = this.deps.store.getMarketArchiveCursor(chain);
    const resumeBlock = resume
      ? Math.min(initialCursor?.factoryLastBlock ?? fromBlock - 1, initialCursor?.swapLastBlock ?? fromBlock - 1) + 1
      : fromBlock;
    const rangeFromBlock = Math.max(fromBlock, resumeBlock);
    const stepBlocks = Math.max(1, Math.min(factoryStepBlocks, swapStepBlocks));
    summary.factoryFromBlock = rangeFromBlock;
    summary.swapFromBlock = rangeFromBlock;

    for (let start = rangeFromBlock; start <= toBlock; start += stepBlocks) {
      const end = Math.min(toBlock, start + stepBlocks - 1);
      this.deps.blockscoutClient?.resetBudget();
      const rangeLogger = logger.child({ fromBlock: start, toBlock: end });
      const discovered = await discoverTrackedPoolsInRange(
        chain,
        rpc,
        start,
        end,
        this.deps.env.logChunkSize,
        this.deps.env.marketArchiveMaxFactoryDiscoveries
      );
      const candidateWrites = rememberCandidatePools(candidatePools, candidateSources, uniquePools(discovered), "pending-factory");
      const prunedCandidates = prunePendingCandidates(candidatePools, candidateSources, end - this.deps.env.marketArchivePendingPoolTtlBlocks);
      summary.discoveredPools += discovered.length;
      options.onProgress?.({ chain, stage: "factory", fromBlock: start, toBlock: end, discoveredPools: discovered.length, candidatePools: candidateWrites });
      logger.info({ fromBlock: start, toBlock: end, discoveredPools: discovered.length, candidates: candidatePools.size, candidateWrites, prunedCandidates }, "market archive backfill factory range processed");

      const maxPools = Math.max(0, Math.floor(options.maxPools ?? this.deps.env.marketArchiveMaxPoolsPerTick));
      const storedPoolRecords = this.deps.store.getMarketPools(chain).filter(isPublishedPoolRecord);
      const poolRecords = mergePoolRecords([
        ...storedPoolRecords,
        ...poolRecordsFor(chain, [...candidatePools.values()], "pending-factory", new Date().toISOString(), (pool) => {
          const existing = this.deps.store.getMarketPool(chain, pool.id);
          if (existing) return existing;
          const source = candidateSources.get(pool.id.toLowerCase()) ?? "pending-factory";
          return candidateRecordFor(chain, pool, source, now);
        })
      ]).slice(0, maxPools > 0 ? maxPools + 1 : undefined);
      const poolLimitHit = maxPools > 0 && poolRecords.length > maxPools;
      const pools = poolRecords
        .slice(0, maxPools > 0 ? maxPools : poolRecords.length)
        .map((record) => record.pool);
      summary.scannedPools = Math.max(summary.scannedPools, pools.length);
      if (poolLimitHit) {
        logger.warn({ configuredLimit: maxPools, loadedPools: poolRecords.length }, "market archive backfill pool scan is limited");
      }

      if (pools.length === 0) {
        const cursor = this.deps.store.getMarketArchiveCursor(chain);
        this.deps.store.setMarketArchiveCursor({
          chain,
          factoryLastBlock: Math.max(cursor?.factoryLastBlock ?? -1, end),
          swapLastBlock: Math.max(cursor?.swapLastBlock ?? -1, end),
          updatedAt: new Date().toISOString()
        });
        await this.deps.store.save();
        continue;
      }

      const logs = await this.fetchObservedArchiveSwapLogs(chain, rpc, pools, start, end, rangeLogger);
      const events = compactSwapEvents(chain, logs, this.deps.env);
      const { pools: archivedPools, trades } = await this.normalizeArchiveTrades(chain, rpc, pools, logs, rangeLogger);
      const activated = activatePoolRecordsFromBuyTrades(chain, pools, trades, new Date().toISOString(), (pool) => {
        const existing = this.deps.store.getMarketPool(chain, pool.id);
        if (existing) return existing;
        const source = candidateSources.get(pool.id.toLowerCase()) ?? "pending-factory";
        return candidateRecordFor(chain, pool, source, now);
      });
      if (activated.length > 0) {
        this.deps.store.upsertMarketPools(activated);
        forgetCandidates(candidatePools, candidateSources, activated.map((record) => record.poolId));
        summary.registryWrites += activated.length;
        await this.publishPoolRegistry(chain, new Date().toISOString());
      }
      const written = await this.publishSwapChunks(chain, start, end, events, archivedPools, trades, new Date().toISOString());
      if (written.length > 0) {
        this.deps.store.recordSwapArchiveChunks(written.map(swapObjectToRecord));
      }
      const pruned = await this.pruneSwapArchiveRecords(chain, rangeLogger);
      if (written.length > 0 || pruned > 0) await this.publishSwapManifest(chain, new Date().toISOString());
      const cursor = this.deps.store.getMarketArchiveCursor(chain);
      this.deps.store.setMarketArchiveCursor({
        chain,
        factoryLastBlock: Math.max(cursor?.factoryLastBlock ?? -1, end),
        swapLastBlock: Math.max(cursor?.swapLastBlock ?? -1, end),
        updatedAt: new Date().toISOString()
      });
      await this.deps.store.save();
      summary.swapLogs += logs.length;
      summary.archivedEvents += events.length;
      summary.archivedTrades += trades.length;
      summary.chunks += written.length;
      summary.pruned += pruned;
      options.onProgress?.({
        chain,
        stage: "swap",
        fromBlock: start,
        toBlock: end,
        pools: pools.length,
        swapLogs: logs.length,
        archivedEvents: events.length,
        archivedTrades: trades.length,
        chunks: written.length,
        pruned,
        activePools: activated.length,
        registryWrites: activated.length
      });
      logger.info({ pools: pools.length, swapLogs: logs.length, archivedEvents: events.length, archivedTrades: trades.length, chunks: written.length, pruned }, "market archive backfill swap range processed");
    }

    await this.publishSwapManifest(chain, new Date().toISOString());
    options.onProgress?.({ chain, stage: "manifest", chunks: summary.chunks, pruned: summary.pruned, message: "swap manifest published" });
    if (publishDerived) {
      await this.publishDerivedMarketSnapshots(chain, logger);
      options.onProgress?.({ chain, stage: "derived", message: "derived market snapshots published" });
    }
    await this.deps.store.save();
    return summary;
  }

  private async runChain(chain: ChainSlug, reason: string): Promise<void> {
    const rpc = this.deps.rpcs.get(chain);
    if (!rpc) return;
    const logger = this.deps.logger.child({ chain, component: "market-archive", reason });
    await this.bootstrapPoolRegistryFromR2(chain, logger);
    await this.bootstrapSwapArchiveManifestFromR2(chain, logger);
    const latestBlock = await rpc.getBlockNumber();
    const toBlock = Math.max(0, latestBlock - this.deps.env.marketArchiveHeadLagBlocks);
    const cursor = this.deps.store.getMarketArchiveCursor(chain);
    const now = new Date().toISOString();
    const pending = this.pendingCandidates(chain);

    const factoryFromBlock = cursor?.factoryLastBlock !== undefined
      ? cursor.factoryLastBlock + 1
      : Math.max(0, toBlock - this.deps.env.marketArchiveFactoryLookbackBlocks + 1);
    if (factoryFromBlock <= toBlock) {
      const discovered = await discoverTrackedPoolsInRange(
        chain,
        rpc,
        factoryFromBlock,
        toBlock,
        this.deps.env.logChunkSize,
        this.deps.env.marketArchiveMaxFactoryDiscoveries
      );
      const seeds = await resolveMarketPools(chain, rpc, MARKET_SEEDS_BY_CHAIN[chain]?.length ?? 0);
      const seedWrites = rememberCandidatePools(pending.pools, pending.sources, uniquePools(seeds), "pending-seed");
      const factoryWrites = rememberCandidatePools(pending.pools, pending.sources, uniquePools(discovered), "pending-factory");
      const prunedCandidates = prunePendingCandidates(pending.pools, pending.sources, toBlock - this.deps.env.marketArchivePendingPoolTtlBlocks);
      this.deps.store.setMarketArchiveCursor({
        chain,
        factoryLastBlock: toBlock,
        swapLastBlock: cursor?.swapLastBlock,
        updatedAt: now
      });
      await this.deps.store.save();
      logger.info(
        { fromBlock: factoryFromBlock, toBlock, discoveredPools: discovered.length, seedPools: seeds.length, candidates: pending.pools.size, seedWrites, factoryWrites, prunedCandidates },
        "market archive in-memory pool candidates updated"
      );
    }

    const refreshedCursor = this.deps.store.getMarketArchiveCursor(chain);
    const swapFromBlock = refreshedCursor?.swapLastBlock !== undefined
      ? refreshedCursor.swapLastBlock + 1
      : Math.max(0, toBlock - this.deps.env.marketArchiveSwapLookbackBlocks + 1);
    if (swapFromBlock > toBlock) {
      const pruned = await this.pruneSwapArchiveRecords(chain, logger);
      if (pruned > 0) await this.publishSwapManifest(chain, now);
      await this.deps.store.save();
      return;
    }

    if (!this.deps.snapshotStore) {
      await this.pruneSwapArchiveRecords(chain, logger);
      logger.warn({ fromBlock: swapFromBlock, toBlock }, "market archive swap cursor not advanced; R2 snapshot store is not configured");
      await this.deps.store.save();
      return;
    }

    const poolRecords = mergePoolRecords([
      ...this.deps.store.getMarketPools(chain).filter(isPublishedPoolRecord),
      ...poolRecordsFor(chain, [...pending.pools.values()], "pending-factory", now, (pool) => {
        const existing = this.deps.store.getMarketPool(chain, pool.id);
        if (existing) return existing;
        const source = pending.sources.get(pool.id.toLowerCase()) ?? "pending-factory";
        return candidateRecordFor(chain, pool, source, now);
      })
    ]).slice(0, this.deps.env.marketArchiveMaxPoolsPerTick > 0 ? this.deps.env.marketArchiveMaxPoolsPerTick + 1 : undefined);
    const poolLimitHit = this.deps.env.marketArchiveMaxPoolsPerTick > 0 && poolRecords.length > this.deps.env.marketArchiveMaxPoolsPerTick;
    const pools = poolRecords
      .slice(0, this.deps.env.marketArchiveMaxPoolsPerTick > 0 ? this.deps.env.marketArchiveMaxPoolsPerTick : poolRecords.length)
      .map((record) => record.pool);
    if (pools.length === 0) {
      const pruned = await this.pruneSwapArchiveRecords(chain, logger);
      if (pruned > 0) await this.publishSwapManifest(chain, now);
      // With no registered tracked pools there is no swap source to scan, so the swap cursor can advance.
      this.deps.store.setMarketArchiveCursor({ chain, factoryLastBlock: refreshedCursor?.factoryLastBlock, swapLastBlock: toBlock, updatedAt: now });
      await this.deps.store.save();
      return;
    }
    if (poolLimitHit) {
      logger.warn(
        { configuredLimit: this.deps.env.marketArchiveMaxPoolsPerTick, loadedPools: poolRecords.length },
        "market archive pool scan is limited; raise MARKET_ARCHIVE_MAX_POOLS_PER_TICK for complete coverage"
      );
    }

    const logs = await this.fetchObservedArchiveSwapLogs(chain, rpc, pools, swapFromBlock, toBlock, logger);
    const events = compactSwapEvents(chain, logs, this.deps.env);
    const { pools: archivedPools, trades } = await this.normalizeArchiveTrades(chain, rpc, pools, logs, logger);
    const activated = activatePoolRecordsFromBuyTrades(chain, pools, trades, now, (pool) => {
      const existing = this.deps.store.getMarketPool(chain, pool.id);
      if (existing) return existing;
      const source = pending.sources.get(pool.id.toLowerCase()) ?? "pending-factory";
      return candidateRecordFor(chain, pool, source, now);
    });
    if (activated.length > 0) {
      this.deps.store.upsertMarketPools(activated);
      forgetCandidates(pending.pools, pending.sources, activated.map((record) => record.poolId));
      await this.publishPoolRegistry(chain, now);
    }
    const written = await this.publishSwapChunks(chain, swapFromBlock, toBlock, events, archivedPools, trades, now);
    if (written.length > 0) {
      this.deps.store.recordSwapArchiveChunks(written.map(swapObjectToRecord));
    }
    const pruned = await this.pruneSwapArchiveRecords(chain, logger);
    if (written.length > 0 || pruned > 0) {
      await this.publishSwapManifest(chain, now);
    }
    if (written.length > 0) await this.publishDerivedMarketSnapshots(chain, logger);
    this.deps.store.setMarketArchiveCursor({
      chain,
      factoryLastBlock: refreshedCursor?.factoryLastBlock,
      swapLastBlock: toBlock,
      updatedAt: now
    });
    await this.deps.store.save();
    logger.info(
      { fromBlock: swapFromBlock, toBlock, pools: pools.length, activePools: activated.length, swapLogs: logs.length, archivedEvents: events.length, archivedTrades: trades.length, chunks: written.length },
      "market archive swap range processed"
    );
  }

  private async fetchArchiveSwapLogs(
    chain: ChainSlug,
    rpc: RpcPool,
    pools: PoolKey[],
    fromBlock: number,
    toBlock: number,
    logger: Logger
  ): Promise<Log[]> {
    const blockscout = this.deps.blockscoutClient;
    const source = this.deps.env.blockscoutLogSource;
    if (source === "preferred" && blockscout) {
      try {
        const logs = await blockscout.fetchSwapLogs(this.deps.env, chain, pools, fromBlock, toBlock);
        logger.info({ fromBlock, toBlock, pools: pools.length, swapLogs: logs.length }, "market archive swap logs fetched from Blockscout");
        return logs;
      } catch (error) {
        logger.warn({ fromBlock, toBlock, error: (error as Error).message }, "Blockscout swap log fetch failed; falling back to RPC");
      }
    }

    try {
      const logs = await fetchSwapLogs(rpc, this.deps.env, chain, pools, fromBlock, toBlock);
      logger.info({ fromBlock, toBlock, pools: pools.length, swapLogs: logs.length }, "market archive swap logs fetched from RPC");
      return logs;
    } catch (error) {
      if (source === "fallback" && blockscout) {
        logger.warn({ fromBlock, toBlock, error: (error as Error).message }, "RPC swap log fetch failed; falling back to Blockscout");
        const logs = await blockscout.fetchSwapLogs(this.deps.env, chain, pools, fromBlock, toBlock);
        logger.info({ fromBlock, toBlock, pools: pools.length, swapLogs: logs.length }, "market archive swap logs fetched from Blockscout fallback");
        return logs;
      }
      throw error;
    }
  }

  private async fetchObservedArchiveSwapLogs(
    chain: ChainSlug,
    rpc: RpcPool,
    pools: PoolKey[],
    fromBlock: number,
    toBlock: number,
    logger: Logger
  ): Promise<Log[]> {
    const poolIds = new Set(pools.map((pool) => pool.id.toLowerCase()));
    const logsByKey = new Map<string, Log>();
    let observedLogs = 0;
    const filterLogs = await mapWithConcurrency(
      observedSwapFilters(chain, this.deps.env),
      this.deps.env.marketArchiveLogFilterConcurrency,
      (filter) => this.fetchObservedFilterLogs(rpc, filter, fromBlock, toBlock)
    );
    for (const logs of filterLogs) {
      observedLogs += logs.length;
      for (const log of logs) {
        const poolId = poolIdForSwapLog(log, this.deps.env, chain)?.toLowerCase();
        if (!poolId || !poolIds.has(poolId)) continue;
        logsByKey.set(`${log.transactionHash.toLowerCase()}:${log.index}`, log);
      }
    }
    const matched = [...logsByKey.values()].sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
    logger.info({ fromBlock, toBlock, pools: pools.length, observedLogs, swapLogs: matched.length }, "market archive observed swap logs fetched from RPC");
    return matched;
  }

  private async fetchObservedFilterLogs(
    rpc: RpcPool,
    filter: Pick<LogFilter, "address" | "topics">,
    fromBlock: number,
    toBlock: number
  ): Promise<Log[]> {
    const logs: Log[] = [];
    let start = fromBlock;
    let chunkSize = Math.max(1, this.deps.env.logChunkSize);
    while (start <= toBlock) {
      const end = Math.min(toBlock, start + chunkSize - 1);
      try {
        logs.push(...await rpc.getLogs({ ...filter, fromBlock: start, toBlock: end }));
        start = end + 1;
      } catch (error) {
        if (chunkSize <= 1) throw error;
        chunkSize = Math.max(1, Math.floor(chunkSize / 2));
      }
    }
    return logs;
  }

  private async normalizeArchiveTrades(
    chain: ChainSlug,
    rpc: RpcPool,
    pools: PoolKey[],
    logs: Log[],
    logger: Logger
  ): Promise<{ pools: Record<string, ArchivedPoolInfo>; trades: ArchivedSwapTrade[] }> {
    const tokenService = this.tokenServiceFor(chain, rpc);
    const poolInfoCache = this.archivedPoolInfoFor(chain);
    const logsByPool = groupLogsByPool(logs, pools, this.deps.env, chain);
    const archivedPools: Record<string, ArchivedPoolInfo> = {};
    const archivedTrades: ArchivedSwapTrade[] = [];
    const poolsWithLogs = pools
      .map((pool) => ({ pool, logs: logsByPool.get(pool.id.toLowerCase()) ?? [] }))
      .filter((item) => item.logs.length > 0);
    const normalized = await mapWithConcurrency(
      poolsWithLogs,
      this.deps.env.marketArchiveNormalizeConcurrency,
      async ({ pool, logs: poolLogs }) => {
        const poolId = pool.id.toLowerCase();
        try {
          const side = chooseMarketSide(pool, chain);
          if (!side) return undefined;
          let poolInfo = poolInfoCache.get(poolId);
          if (poolInfo && (shouldRefreshTokenMetadata(poolInfo.baseToken) || shouldRefreshTokenMetadata(poolInfo.quoteToken))) {
            poolInfoCache.delete(poolId);
            poolInfo = undefined;
          }
          if (!poolInfo) {
            const [baseToken, quoteToken] = await Promise.all([
              tokenService.getToken(side.base),
              tokenService.getToken(side.quote)
            ]);
            const quoteUsd = await this.deps.priceService.quoteUsdMultiplier(side.quote, chain);
            poolInfo = {
              poolId,
              pool: { ...pool, chain },
              baseToken,
              quoteToken,
              quoteUsd
            };
            if (!shouldRefreshTokenMetadata(baseToken) && !shouldRefreshTokenMetadata(quoteToken)) {
              poolInfoCache.set(poolId, poolInfo);
            }
          }
          const trades = parseMarketTrades(pool, side, poolInfo.baseToken, poolInfo.quoteToken, poolInfo.quoteUsd, poolLogs);
          if (trades.length === 0) return undefined;
          return { poolId, poolInfo: { ...poolInfo, pool: { ...pool, chain } }, trades };
        } catch (error) {
          logger.warn({ poolId, error: (error as Error).message }, "market archive trade normalization skipped pool");
          return undefined;
        }
      }
    );

    for (const item of normalized) {
      if (!item) continue;
      archivedPools[item.poolId] = item.poolInfo;
      archivedTrades.push(...item.trades.map((trade) => archivedSwapTrade(item.poolId, trade)));
    }

    archivedTrades.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    return { pools: archivedPools, trades: archivedTrades };
  }

  private async publishSwapChunks(
    chain: ChainSlug,
    fromBlock: number,
    toBlock: number,
    events: CompactSwapEvent[],
    archivedPools: Record<string, ArchivedPoolInfo>,
    trades: ArchivedSwapTrade[],
    generatedAt: string
  ): Promise<R2SwapArchiveObject[]> {
    if (trades.length === 0 || !this.deps.snapshotStore) return [];
    const limit = this.deps.env.marketArchiveChunkTradeLimit;
    const parts = chunk(trades, limit);
    const eventsByKey = new Map(events.map((event) => [swapArchiveEventKey(event.poolId, event.txHash, event.logIndex), event]));
    const written: R2SwapArchiveObject[] = [];
    for (let index = 0; index < parts.length; index++) {
      const partTrades = parts[index]!;
      const partEvents = partTrades
        .map((trade) => eventsByKey.get(swapArchiveEventKey(trade.poolId, trade.txHash, trade.logIndex)))
        .filter((event): event is CompactSwapEvent => Boolean(event));
      const partPoolIds = new Set(partTrades.map((trade) => trade.poolId));
      const partPools = Object.fromEntries(
        [...partPoolIds]
          .map((poolId) => [poolId, archivedPools[poolId]] as const)
          .filter((entry): entry is readonly [string, ArchivedPoolInfo] => Boolean(entry[1]))
      );
      const payload: SwapEventArchiveChunk = {
        schemaVersion: 1,
        generatedAt,
        retainedForDays: this.deps.env.marketHistoryRetentionDays,
        source: "raw-rpc",
        chain,
        fromBlock,
        toBlock,
        partIndex: index + 1,
        partCount: parts.length,
        eventCount: partEvents.length,
        tradeCount: partTrades.length,
        poolCount: Object.keys(partPools).length,
        pools: partPools,
        trades: partTrades,
        events: partEvents
      };
      written.push(await this.deps.snapshotStore.publishSwapEventChunk(payload));
    }
    return written;
  }

  private async publishSwapManifest(chain: ChainSlug, generatedAt: string): Promise<void> {
    if (!this.deps.snapshotStore) return;
    const objects = this.deps.store.getSwapArchiveChunks(chain).map((record): R2SwapArchiveObject => ({
      key: record.key,
      objectKey: record.objectKey,
      chain: record.chain,
      fromBlock: record.fromBlock,
      toBlock: record.toBlock,
      partIndex: record.partIndex,
      partCount: record.partCount,
      eventCount: record.eventCount,
      tradeCount: record.tradeCount,
      poolCount: record.poolCount,
      compressedBytes: record.compressedBytes,
      uncompressedBytes: record.uncompressedBytes,
      generatedAt: record.generatedAt
    }));
    const manifest: R2SwapArchiveManifest = {
      schemaVersion: 1,
      generatedAt,
      source: "raw-rpc",
      retentionDays: this.deps.env.marketHistoryRetentionDays,
      objectCount: objects.length,
      eventCount: objects.reduce((sum, item) => sum + item.eventCount, 0),
      tradeCount: objects.reduce((sum, item) => sum + item.tradeCount, 0),
      totalCompressedBytes: objects.reduce((sum, item) => sum + item.compressedBytes, 0),
      totalUncompressedBytes: objects.reduce((sum, item) => sum + item.uncompressedBytes, 0),
      latestToBlock: objects[0]?.toBlock,
      objects
    };
    await this.deps.snapshotStore.publishSwapArchiveManifest(manifest, chain);
  }

  private async publishDerivedMarketSnapshots(chain: ChainSlug, logger: Logger): Promise<void> {
    const snapshotStore = this.deps.snapshotStore;
    if (!snapshotStore) return;
    const deps = {
      env: this.deps.env,
      rpcs: this.deps.rpcs,
      priceService: this.deps.priceService,
      snapshotStore,
      logger
    };
    const trendingCacheMs = boundedNumber("TRENDING_CACHE_MS", DEFAULT_TRENDING_CACHE_MS, 5_000, 300_000);
    const trendingLookbackBlocks = boundedNumberForChain(chain, "TRENDING_LOOKBACK_BLOCKS", defaultTrendingLookbackBlocks(chain), 250, MAX_TRENDING_LOOKBACK_BLOCKS);
    const trendingMaxPools = boundedNumberForChain(chain, "TRENDING_MAX_POOLS", DEFAULT_TRENDING_MAX_POOLS, 4, MAX_TRENDING_POOLS);
    const newPairsCacheMs = boundedNumber("NEW_PAIRS_CACHE_MS", DEFAULT_NEW_PAIRS_CACHE_MS, 5_000, 300_000);
    const newPairsLookbackBlocks = boundedNumberForChain(chain, "NEW_PAIRS_LOOKBACK_BLOCKS", DEFAULT_NEW_PAIRS_LOOKBACK_BLOCKS, 250, MAX_NEW_PAIRS_LOOKBACK_BLOCKS);
    const newPairsMaxPools = boundedNumberForChain(chain, "NEW_PAIRS_MAX_POOLS", DEFAULT_NEW_PAIRS_MAX_POOLS, 4, MAX_NEW_PAIRS_POOLS);
    const detailCacheMs = boundedNumber("MARKET_DETAIL_CACHE_MS", DEFAULT_MARKET_DETAIL_CACHE_MS, 2_000, 60_000);
    const detailLookbackBlocks = boundedNumberForChain(chain, "MARKET_DETAIL_LOOKBACK_BLOCKS", DEFAULT_MARKET_DETAIL_LOOKBACK_BLOCKS, 250, MAX_MARKET_DETAIL_LOOKBACK_BLOCKS);

    const trending = await getArchivedTrendingMarkets(deps, chain, trendingLookbackBlocks, trendingMaxPools, trendingCacheMs);
    if (trending) {
      await snapshotStore.publishTrending(trending);
    }

    const newPairs = await getArchivedNewPairs(deps, chain, newPairsLookbackBlocks, newPairsMaxPools, newPairsCacheMs);
    if (newPairs) {
      await snapshotStore.publishNewPairs(newPairs);
      const trendingPoolIds = new Set(trending?.markets.map((market) => market.poolId.toLowerCase()) ?? []);
      const detailPairs = newPairs.pairs
        .filter((pair) => !trendingPoolIds.has(pair.poolId.toLowerCase()));
      const detailWrites = await mapWithConcurrency(
        detailPairs,
        ARCHIVE_DETAIL_WRITE_CONCURRENCY,
        async (pair) => {
          try {
            const market = await getArchivedMarketByPoolId(deps, pair.poolId, chain, detailLookbackBlocks, detailCacheMs);
            if (market) await snapshotStore.publishMarket(market);
            return true;
          } catch (error) {
            logger.warn({ chain, poolId: pair.poolId, error: errorMessage(error) }, "market archive derived market detail snapshot failed");
            return false;
          }
        }
      );
      const failedDetails = detailWrites.filter((ok) => ok === false).length;
      if (failedDetails > 0) {
        logger.warn({ chain, failedDetails }, "market archive derived market detail snapshots partially failed");
      }
    }

    logger.info(
      { chain, trendingMarkets: trending?.markets.length ?? 0, newPairs: newPairs?.pairs.length ?? 0 },
      "market archive derived R2 snapshots published"
    );
  }
}

function poolRecordsFor(
  chain: ChainSlug,
  pools: PoolKey[],
  fallbackSource: TrackedMarketPoolRecord["source"],
  now: string,
  existingFor: (pool: PoolKey) => TrackedMarketPoolRecord | undefined
): TrackedMarketPoolRecord[] {
  const byId = new Map<string, TrackedMarketPoolRecord>();
  for (const pool of pools) {
    const poolId = pool.id.toLowerCase();
    const existing = existingFor(pool);
    byId.set(poolId, {
      chain,
      poolId,
      pool: { ...pool, chain },
      source: mergedPoolSource(existing?.source, fallbackSource),
      firstSeenBlock: existing?.firstSeenBlock ?? pool.createdBlock,
      lastSeenBlock: pool.createdBlock ?? existing?.lastSeenBlock,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    });
  }
  return [...byId.values()];
}

function rememberCandidatePools(
  candidates: Map<string, PoolKey>,
  sources: Map<string, MarketPoolSource>,
  pools: PoolKey[],
  source: MarketPoolSource
): number {
  let added = 0;
  for (const pool of pools) {
    const poolId = pool.id.toLowerCase();
    if (!candidates.has(poolId)) {
      candidates.set(poolId, pool);
      added++;
    }
    if (!sources.has(poolId)) sources.set(poolId, source);
  }
  return added;
}

function prunePendingCandidates(
  candidates: Map<string, PoolKey>,
  sources: Map<string, MarketPoolSource>,
  olderThanBlock: number
): number {
  let pruned = 0;
  for (const [poolId, pool] of candidates.entries()) {
    const source = sources.get(poolId);
    if (source === "pending-seed") continue;
    const createdBlock = pool.createdBlock;
    if (createdBlock !== undefined && createdBlock >= olderThanBlock) continue;
    candidates.delete(poolId);
    sources.delete(poolId);
    pruned++;
  }
  return pruned;
}

function forgetCandidates(
  candidates: Map<string, PoolKey>,
  sources: Map<string, MarketPoolSource>,
  poolIds: string[]
): void {
  for (const poolId of poolIds) {
    const key = poolId.toLowerCase();
    candidates.delete(key);
    sources.delete(key);
  }
}

function candidateRecordFor(
  chain: ChainSlug,
  pool: PoolKey,
  source: MarketPoolSource,
  now: string
): TrackedMarketPoolRecord {
  return {
    chain,
    poolId: pool.id.toLowerCase(),
    pool: { ...pool, chain },
    source,
    firstSeenBlock: pool.createdBlock,
    lastSeenBlock: pool.createdBlock,
    createdAt: now,
    updatedAt: now
  };
}

function observedSwapFilters(chain: ChainSlug, env: Env): Array<Pick<LogFilter, "address" | "topics">> {
  const filters: Array<Pick<LogFilter, "address" | "topics">> = [
    { topics: [V2_SWAP_TOPIC] },
    { topics: [V3_SWAP_TOPIC] },
    { topics: [PANCAKE_V3_SWAP_TOPIC] },
    { topics: [AERODROME_SWAP_TOPIC] },
    { topics: [HYDREX_SWAP_TOPIC] },
    { topics: [LB_SWAP_TOPIC] },
    { topics: [CURVE_TOKEN_EXCHANGE_TOPICS] }
  ];
  const poolManager = env.poolManagerAddresses[chain];
  if (poolManager) filters.push({ address: poolManager, topics: [SWAP_TOPIC] });
  if (chain === "base" && BASE_FLAUNCH_HOOKS.size > 0) {
    filters.push({ address: [...BASE_FLAUNCH_HOOKS], topics: [FLAUNCH_HOOK_SWAP_TOPIC] });
  }
  const balancerVault = getChain(chain).dexes.find((deployment) => deployment.dex === "balancer")?.balancerVaultAddress;
  if (balancerVault) filters.push({ address: balancerVault, topics: [BALANCER_SWAP_TOPIC] });
  return filters;
}

function activatePoolRecordsFromBuyTrades(
  chain: ChainSlug,
  pools: PoolKey[],
  trades: ArchivedSwapTrade[],
  now: string,
  existingFor: (pool: PoolKey) => TrackedMarketPoolRecord | undefined
): TrackedMarketPoolRecord[] {
  const boughtPoolIds = new Set(trades.filter((trade) => trade.side === "buy").map((trade) => trade.poolId.toLowerCase()));
  if (boughtPoolIds.size === 0) return [];
  const activePools = pools.filter((pool) => boughtPoolIds.has(pool.id.toLowerCase()));
  return poolRecordsFor(chain, activePools, "factory", now, existingFor).map((record) => ({
    ...record,
    source: activePoolSource(record.source)
  }));
}

function isPublishedPoolRecord(record: TrackedMarketPoolRecord): boolean {
  return !isPendingPoolSource(record.source);
}

function mergedPoolSource(existing: MarketPoolSource | undefined, fallback: MarketPoolSource): MarketPoolSource {
  if (!existing) return fallback;
  if (isPendingPoolSource(fallback)) return existing;
  return activePoolSource(existing);
}

function activePoolSource(source: MarketPoolSource): "factory" | "seed" {
  return source === "seed" || source === "pending-seed" ? "seed" : "factory";
}

function isPendingPoolSource(source: MarketPoolSource): boolean {
  return source === "pending-factory" || source === "pending-seed";
}

function mergePoolRecords(records: TrackedMarketPoolRecord[]): TrackedMarketPoolRecord[] {
  const byId = new Map<string, TrackedMarketPoolRecord>();
  for (const record of records) byId.set(record.poolId, record);
  return [...byId.values()];
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function archivedSwapTrade(poolId: string, trade: MarketTrade): ArchivedSwapTrade {
  return {
    poolId,
    blockNumber: trade.blockNumber,
    logIndex: trade.logIndex,
    txHash: trade.txHash,
    side: trade.side,
    price: trade.price,
    priceUsd: trade.priceUsd,
    baseAmount: trade.targetAmount,
    quoteAmount: trade.quoteAmount,
    volumeUsd: trade.volumeUsd
  };
}

function compactSwapEvents(chain: ChainSlug, logs: Log[], env: Env): CompactSwapEvent[] {
  return logs
    .map((log) => {
      const poolId = poolIdForSwapLog(log, env, chain);
      if (!poolId) return undefined;
      return {
        poolId: poolId.toLowerCase(),
        blockNumber: log.blockNumber,
        logIndex: log.index,
        txHash: log.transactionHash,
        address: log.address.toLowerCase(),
        topics: log.topics.map((topic) => topic.toLowerCase()),
        data: log.data
      };
    })
    .filter((event): event is CompactSwapEvent => Boolean(event))
    .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
}

function swapArchiveEventKey(poolId: string, txHash: string, logIndex: number): string {
  return `${poolId.toLowerCase()}:${txHash.toLowerCase()}:${logIndex}`;
}

function swapObjectToRecord(object: R2SwapArchiveObject): SwapArchiveChunkRecord {
  return {
    chain: object.chain,
    key: object.key,
    objectKey: object.objectKey,
    fromBlock: object.fromBlock,
    toBlock: object.toBlock,
    partIndex: object.partIndex,
    partCount: object.partCount,
    eventCount: object.eventCount,
    tradeCount: object.tradeCount ?? object.eventCount,
    poolCount: object.poolCount ?? 0,
    compressedBytes: object.compressedBytes,
    uncompressedBytes: object.uncompressedBytes,
    generatedAt: object.generatedAt
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function retentionCutoffIso(retentionDays: number): string {
  const retentionMs = Math.max(1, retentionDays) * 24 * 60 * 60 * 1000;
  return new Date(Date.now() - retentionMs).toISOString();
}
