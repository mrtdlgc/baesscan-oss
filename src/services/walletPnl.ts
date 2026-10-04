import type { Log } from "ethers";
import type { Logger } from "pino";
import type { Telegraf } from "telegraf";
import { getChain } from "../chains/registry";
import type { Env } from "../config/env";
import { fetchSwapLogs } from "../dex/swapLogs";
import { poolProtocol } from "../dex/uniswap";
import type { BlockscoutClient, BlockscoutLogFilter } from "./blockscout";
import type { PriceService } from "./price";
import type { RpcPool } from "./rpcPool";
import { TokenService } from "./token";
import { isWalletPnlIgnoredToken } from "./walletPnlFilters";
import type {
  Storage,
  WalletPnlAnalyticsPnlLeader,
  WalletPnlAnalyticsPoolSummary,
  WalletPnlAnalyticsSnapshot,
  WalletPnlAnalyticsTokenSummary,
  WalletPnlAnalyticsWalletSummary,
  WalletPnlNewTokensSnapshot,
  WalletPnlProfileSink,
  WalletPnlProfileStage,
  WalletPnlPoolRecord,
  WalletPnlSnapshot,
  WalletPnlTokenRef,
  WalletPnlTradeRecord,
  WalletPnlWalletSummary
} from "../store/storage";
import type { ChainSlug, PoolKey, TokenMetadata } from "../types";
import { addressToTopic, isSameAddress, normalizeAddress, shortAddress } from "../utils/address";
import { discoverTrackedPoolsInRange, parseTrackedPoolDiscoveryLog, resolveMarketPools, trackedPoolSources } from "../web/markets/discovery";
import { blockSecondsFor } from "../web/markets/config";
import { chooseMarketSide, groupLogsByPool, uniquePools } from "../web/markets/poolUtils";
import { parseMarketTrades } from "../web/markets/tradeParsing";
import type { MarketTrade } from "../web/markets/types";
import { FLAUNCH_HOOK_SWAP_TOPIC, INITIALIZE_TOPIC, SWAP_TOPIC } from "../uniswap/abis";
import { BASE_FLAUNCH_HOOKS } from "../uniswap/constants";
import { poolV4Hook, trustedV4Hook, untrustedV4Hook, untrustedV4HookRiskScore } from "./v4HookRisk";
import { isUniswapV4Pool, walletPnlBaseV4HookPolicy, walletPnlTradeHookPolicy } from "./walletPnlHookPolicy";
import { enrichWalletPnlAnalyticsTokenCreators, enrichWalletPnlTokenSummaries } from "./walletPnlCreatorDenylist";
import { buildWalletPnlGoodSignalWallets } from "./walletPnlGoodSignal";

const WALLET_TRADE_NORMALIZE_CONCURRENCY = 8;
const WALLET_TRADE_NORMALIZE_LOG_EVERY = 50;
const WALLET_TRADE_NORMALIZE_LOG_INTERVAL_MS = 30_000;
const WALLET_BLOCK_ATTRIBUTION_LOG_EVERY = 100;
const WALLET_TX_ATTRIBUTION_LOG_EVERY = 1_000;
const WALLET_TX_ATTRIBUTION_LOG_INTERVAL_MS = 30_000;
const WALLET_PNL_TOKEN_BOOTSTRAP_COOLDOWN_MS = 30 * 60_000;
const WALLET_PNL_TOKEN_BOOTSTRAP_LOG_CHUNK_BLOCKS = 250_000;
const WALLET_PNL_INITIALIZE_LOOKUP_CHUNK_BLOCKS = 100_000_000;
const WALLET_PNL_NEW_TOKENS_LIMIT = 250;
const WALLET_PNL_ANALYTICS_CREATOR_LOOKUP_DEADLINE_MS = 2 * 60_000;
const WALLET_PNL_NEW_TOKENS_CREATOR_LOOKUP_DEADLINE_MS = 45_000;
export const WALLET_PNL_HOOK_POLICY_VERSION = 1;
const EXCLUDED_WALLET_PNL_PROTOCOLS = new Set(["balancer", "curve"]);

interface WalletPnlFlatAnalyticsStore {
  buildWalletPnlSnapshotFromFlatTrades?: (options: {
    chain: ChainSlug;
    toBlock: number;
    windowBlocks: number;
    retentionBlocks: number;
    positionBlocks: number;
    windowHours: number;
    positionWindowHours: number;
    retentionDays: number;
    snapshotLimit: number;
    minProfitUsd: number;
    partial: boolean;
    trustedV4Hooks?: string[];
    profile?: WalletPnlProfileSink;
  }) => WalletPnlSnapshot | undefined;
  buildWalletPnlSnapshotFromFlatTradesInWorker?: (options: {
    chain: ChainSlug;
    toBlock: number;
    windowBlocks: number;
    retentionBlocks: number;
    positionBlocks: number;
    windowHours: number;
    positionWindowHours: number;
    retentionDays: number;
    snapshotLimit: number;
    minProfitUsd: number;
    partial: boolean;
    trustedV4Hooks?: string[];
    profile?: WalletPnlProfileSink;
  }) => Promise<WalletPnlSnapshot | undefined>;
  buildWalletPnlAnalyticsSnapshotFromFlatTrades?: (options: {
    chain: ChainSlug;
    fromBlock: number;
    positionFromBlock: number;
    toBlock: number;
    windowHours: number;
    positionWindowHours: number;
    trustedV4Hooks?: string[];
    profile?: WalletPnlProfileSink;
  }) => WalletPnlAnalyticsSnapshot | undefined;
  buildWalletPnlAnalyticsSnapshotFromFlatTradesInWorker?: (options: {
    chain: ChainSlug;
    fromBlock: number;
    positionFromBlock: number;
    toBlock: number;
    windowHours: number;
    positionWindowHours: number;
    trustedV4Hooks?: string[];
    profile?: WalletPnlProfileSink;
  }) => Promise<WalletPnlAnalyticsSnapshot | undefined>;
  buildWalletPnlNewTokensSnapshotFromFlatTrades?: (options: {
    chain: ChainSlug;
    fromBlock: number;
    toBlock: number;
    windowHours: number;
    limit: number;
    trustedV4Hooks?: string[];
    profile?: WalletPnlProfileSink;
  }) => WalletPnlNewTokensSnapshot | undefined;
  buildWalletPnlNewTokensSnapshotFromFlatTradesInWorker?: (options: {
    chain: ChainSlug;
    fromBlock: number;
    toBlock: number;
    windowHours: number;
    limit: number;
    trustedV4Hooks?: string[];
    profile?: WalletPnlProfileSink;
  }) => Promise<WalletPnlNewTokensSnapshot | undefined>;
}

type WalletPnlRebuildKind = "newTokens" | "snapshot" | "analytics";

interface WalletPnlRebuildBounds {
  chain: ChainSlug;
  scannedToBlock: number;
  retentionFromBlock: number;
  positionFromBlock: number;
  analyticsFromBlock: number;
  retentionBlocks: number;
  windowBlocks: number;
  positionBlocks: number;
  partial: boolean;
}

interface WalletPnlPoolPolicyFilter {
  pools: PoolKey[];
  total: number;
  rejected: number;
  rejectedExcludedProtocol: number;
  rejectedBaseV4NoHook: number;
  rejectedBaseV4UntrustedHook: number;
  rejectedFactoryV4UntrustedHook: number;
  rejectedHooks: string[];
}

interface WalletPosition {
  quantity: number;
  costUsd: number;
}

interface MutableWalletSummary {
  wallet: string;
  realizedPnlUsd: number;
  realizedCostUsd: number;
  realizedProceedsUsd: number;
  buyCount: number;
  sellCount: number;
  profitableExitCount: number;
  losingExitCount: number;
  tradedTokens: Set<string>;
  tradedTokenRefs: Map<string, WalletPnlTokenRef>;
  volumeUsd: number;
  lastBlock: number;
  lastTxHash: string;
}

interface MutableAnalyticsSummary {
  tradeCount: number;
  txs: Set<string>;
  wallets: Set<string>;
  pools: Set<string>;
  buyCount: number;
  sellCount: number;
  volumeUsd: number;
  buyVolumeUsd: number;
  sellVolumeUsd: number;
  firstBlock: number;
  lastBlock: number;
}

interface MutableTokenAnalytics extends MutableAnalyticsSummary {
  tokenAddress: string;
  tokenSymbol: string;
  dexes: Set<string>;
  protocols: Set<string>;
  walletVolumes: Map<string, number>;
  untrustedV4Hooks: Set<string>;
  minPriceUsd?: number;
  maxPriceUsd?: number;
  latestPriceUsd?: number;
  latestPriceSortKey: number;
}

interface MutableWalletAnalytics extends MutableAnalyticsSummary {
  wallet: string;
  tokenVolumes: Map<string, { address: string; symbol: string; volumeUsd: number }>;
  poolVolumes: Map<string, number>;
}

interface MutablePoolAnalytics extends MutableAnalyticsSummary {
  poolId: string;
  poolAddress?: string;
  dex: string;
  protocol: string;
  tokenAddress: string;
  tokenSymbol: string;
  quoteAddress: string;
  quoteSymbol: string;
  walletVolumes: Map<string, number>;
  v4Hook?: string;
  untrustedV4Hook?: boolean;
}

interface MutablePnlLeader {
  wallet: string;
  tokenAddress: string;
  tokenSymbol: string;
  realizedPnlUsd: number;
  realizedCostUsd: number;
  realizedProceedsUsd: number;
  buyCount: number;
  sellCount: number;
  profitableExitCount: number;
  losingExitCount: number;
  trustedV4HookTradeCount: number;
  volumeUsd: number;
  firstBlock: number;
  lastBlock: number;
}

interface ParsedWalletTradeInput {
  pool: PoolKey;
  baseToken: TokenMetadata;
  quoteToken: TokenMetadata;
  trade: MarketTrade;
}

interface TxSenderRequest {
  txHash: string;
  blockNumber: number;
}

interface RpcBlockWithTransactions {
  transactions?: Array<{
    hash?: string;
    from?: string;
  } | string>;
}

export class WalletPnlIndexer {
  private scanTimer?: NodeJS.Timeout;
  private readonly rebuildTimers = new Map<WalletPnlRebuildKind, NodeJS.Timeout>();
  private running = false;
  private rebuildHeartbeatsActive = false;
  private rebuildQueue: Promise<void> = Promise.resolve();
  private readonly tokenServices = new Map<ChainSlug, TokenService>();
  private readonly tokenBootstraps = new Set<string>();
  private readonly tokenBootstrapLastAttempt = new Map<string, number>();

  constructor(
    private readonly deps: {
      env: Env;
      rpcs: Map<ChainSlug, RpcPool>;
      store: Storage;
      priceService: PriceService;
      blockscoutClient?: BlockscoutClient;
      bot?: Telegraf;
      logger: Logger;
    }
  ) {}

  start(): void {
    if (this.scanTimer || !this.deps.env.walletPnlEnabled) return;
    this.runSafely("startup");
    this.scanTimer = setInterval(() => this.runSafely("interval"), this.deps.env.walletPnlScanIntervalMs);
    this.scanTimer.unref?.();
    this.rebuildHeartbeatsActive = true;
    this.startRebuildHeartbeat("newTokens", this.deps.env.walletPnlNewTokensIntervalMs, 10_000);
    this.startRebuildHeartbeat("snapshot", this.deps.env.walletPnlSnapshotIntervalMs, 20_000);
    this.startRebuildHeartbeat("analytics", this.deps.env.walletPnlAnalyticsIntervalMs, 30_000);
  }

  stop(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = undefined;
    }
    this.rebuildHeartbeatsActive = false;
    for (const timer of this.rebuildTimers.values()) clearTimeout(timer);
    this.rebuildTimers.clear();
  }

  async runOnce(reason = "manual"): Promise<void> {
    if (this.running) {
      this.deps.logger.debug({ reason }, "wallet pnl tick skipped; previous tick still running");
      return;
    }
    this.running = true;
    try {
      await this.runChain(this.deps.env.walletPnlChain, reason);
    } finally {
      this.running = false;
    }
  }

  scheduleTokenBootstrap(chain: ChainSlug, tokenAddress: string, reason = "request", force = false): void {
    if (!this.deps.env.walletPnlEnabled || !this.deps.env.walletPnlTokenBootstrapEnabled || !this.deps.env.walletPnlBlockscoutTokenBootstrapEnabled) return;
    if (!this.deps.blockscoutClient) return;
    let token: string;
    try {
      token = normalizeAddress(tokenAddress).toLowerCase();
    } catch {
      return;
    }
    const key = `${chain}:${token}`;
    if (this.tokenBootstraps.has(key)) return;
    const lastAttempt = this.tokenBootstrapLastAttempt.get(key) ?? 0;
    if (!force && Date.now() - lastAttempt < WALLET_PNL_TOKEN_BOOTSTRAP_COOLDOWN_MS) return;
    this.tokenBootstrapLastAttempt.set(key, Date.now());
    this.tokenBootstraps.add(key);
    void this.bootstrapTokenCoverage(chain, token, reason)
      .catch((error) => {
        this.deps.logger.warn({ chain, tokenAddress: token, reason, error: (error as Error).message }, "wallet pnl token bootstrap failed");
      })
      .finally(() => {
        this.tokenBootstraps.delete(key);
      });
  }

  private runSafely(reason: string): void {
    void this.runOnce(reason).catch((error) => {
      this.deps.logger.warn({ reason, error: (error as Error).message }, "wallet pnl tick failed");
    });
  }

  private startRebuildHeartbeat(kind: WalletPnlRebuildKind, intervalMs: number, startupDelayMs: number): void {
    this.scheduleRebuildHeartbeat(kind, intervalMs, startupDelayMs, "startup");
  }

  private scheduleRebuildHeartbeat(kind: WalletPnlRebuildKind, intervalMs: number, delayMs: number, reason: string): void {
    if (!this.rebuildHeartbeatsActive || !this.deps.env.walletPnlEnabled) return;
    const existing = this.rebuildTimers.get(kind);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.rebuildTimers.delete(kind);
      void this.runRebuildHeartbeat(kind, intervalMs, reason).catch((error) => {
        this.deps.logger.warn({ kind, reason, error: (error as Error).message }, "wallet pnl rebuild heartbeat failed");
      });
    }, delayMs);
    timer.unref?.();
    this.rebuildTimers.set(kind, timer);
  }

  private async runRebuildHeartbeat(kind: WalletPnlRebuildKind, intervalMs: number, reason: string): Promise<void> {
    try {
      await this.queueRebuild(kind, reason);
    } finally {
      this.scheduleRebuildHeartbeat(kind, intervalMs, intervalMs, "interval");
    }
  }

  private queueRebuild(kind: WalletPnlRebuildKind, reason: string): Promise<void> {
    if (!this.deps.env.walletPnlEnabled) return Promise.resolve();
    this.deps.logger.info({ kind, reason }, "wallet pnl scheduled rebuild queued");
    const run = () => this.runScheduledRebuild(kind, reason);
    const queued = this.rebuildQueue.then(run, run);
    this.rebuildQueue = queued.catch(() => undefined);
    return queued;
  }

  private async runScheduledRebuild(kind: WalletPnlRebuildKind, reason: string): Promise<void> {
    try {
      if (kind === "snapshot") {
        await this.rebuildSnapshotInWorker(reason);
      } else if (kind === "analytics") {
        await this.rebuildAnalyticsInWorker(reason);
      } else {
        await this.rebuildNewTokensInWorker(reason);
      }
    } catch (error) {
      this.deps.logger.warn({ kind, reason, error: (error as Error).message }, "wallet pnl scheduled rebuild failed");
    }
  }

  private async walletPnlRebuildBounds(chain: ChainSlug, kind: WalletPnlRebuildKind, reason: string): Promise<WalletPnlRebuildBounds | undefined> {
    const rpc = this.deps.rpcs.get(chain);
    if (!rpc) {
      this.deps.logger.warn({ chain, kind, reason }, "wallet pnl scheduled rebuild skipped; no RPC is configured");
      return undefined;
    }
    const cursor = this.deps.store.getWalletPnlCursor(chain);
    const snapshot = this.deps.store.getWalletPnlSnapshot(chain);
    const analytics = this.deps.store.getWalletPnlAnalyticsSnapshot(chain);
    const scannedToBlock = cursor?.lastBlock ?? snapshot?.toBlock ?? analytics?.toBlock;
    if (scannedToBlock === undefined) {
      this.deps.logger.debug({ chain, kind, reason }, "wallet pnl scheduled rebuild skipped; no scanned block yet");
      return undefined;
    }
    const latestBlock = await rpc.getBlockNumber();
    const headBlock = Math.max(0, latestBlock - this.deps.env.walletPnlHeadLagBlocks);
    const blockSeconds = blockSecondsFor(chain);
    const retentionBlocks = Math.max(1, Math.ceil(this.deps.env.walletPnlRetentionDays * 24 * 60 * 60 / blockSeconds));
    const windowBlocks = Math.max(1, Math.ceil(this.deps.env.walletPnlWindowHours * 60 * 60 / blockSeconds));
    const positionBlocks = Math.max(1, Math.ceil(this.deps.env.walletPnlPositionWindowHours * 60 * 60 / blockSeconds));
    const analyticsWindowBlocks = Math.max(1, Math.ceil(this.deps.env.walletPnlAnalyticsWindowHours * 60 * 60 / blockSeconds));
    const retentionFromBlock = Math.max(0, scannedToBlock - retentionBlocks + 1);
    const positionFromBlock = Math.max(retentionFromBlock, scannedToBlock - positionBlocks + 1);
    const analyticsFromBlock = Math.max(retentionFromBlock, scannedToBlock - analyticsWindowBlocks + 1);
    const lagBlocks = Math.max(0, headBlock - scannedToBlock);
    return {
      chain,
      scannedToBlock,
      retentionFromBlock,
      positionFromBlock,
      analyticsFromBlock,
      retentionBlocks,
      windowBlocks,
      positionBlocks,
      partial: lagBlocks > this.deps.env.walletPnlMaxPostLagBlocks
    };
  }

  private async rebuildSnapshotInWorker(reason: string): Promise<void> {
    const chain = this.deps.env.walletPnlChain;
    const bounds = await this.walletPnlRebuildBounds(chain, "snapshot", reason);
    if (!bounds) return;
    const logger = this.deps.logger.child({ chain, component: "wallet-pnl-rebuild", kind: "snapshot", reason });
    const snapshot = this.deps.store.getWalletPnlSnapshot(chain);
    const shouldRebuild = shouldRebuildWalletPnlSnapshot(snapshot, {
      retentionFromBlock: bounds.retentionFromBlock,
      positionFromBlock: bounds.positionFromBlock,
      toBlock: bounds.scannedToBlock,
      windowHours: this.deps.env.walletPnlWindowHours,
      positionWindowHours: this.deps.env.walletPnlPositionWindowHours,
      retentionDays: this.deps.env.walletPnlRetentionDays,
      partial: bounds.partial,
      intervalMs: this.deps.env.walletPnlSnapshotIntervalMs,
      now: Date.now()
    }) || (reason === "interval" && (!snapshot || snapshot.toBlock < bounds.scannedToBlock));
    if (!shouldRebuild) {
      logger.info(
        {
          fromBlock: snapshot?.retentionFromBlock,
          positionFromBlock: snapshot?.positionFromBlock,
          toBlock: snapshot?.toBlock,
          scannedToBlock: bounds.scannedToBlock,
          generatedAt: snapshot?.generatedAt,
          ageMs: walletPnlAgeMs(snapshot?.generatedAt),
          intervalMs: this.deps.env.walletPnlSnapshotIntervalMs,
          decision: "skip"
        },
        "wallet pnl snapshot rebuild skipped"
      );
      return;
    }
    const flatStore = walletPnlFlatAnalyticsStore(this.deps.store);
    if (!flatStore.buildWalletPnlSnapshotFromFlatTradesInWorker) {
      logger.warn({ toBlock: bounds.scannedToBlock }, "wallet pnl snapshot rebuild skipped; worker unavailable");
      return;
    }
    const startedAt = Date.now();
    const profile = walletPnlCreateProfile(this.deps.env.walletPnlProfileRebuilds);
    logger.info(
      {
        fromBlock: bounds.retentionFromBlock,
        positionFromBlock: bounds.positionFromBlock,
        toBlock: bounds.scannedToBlock,
        intervalMs: this.deps.env.walletPnlSnapshotIntervalMs
      },
      "wallet pnl snapshot rebuild queued"
    );
    const rebuilt = await flatStore.buildWalletPnlSnapshotFromFlatTradesInWorker({
      chain,
      toBlock: bounds.scannedToBlock,
      windowBlocks: bounds.windowBlocks,
      retentionBlocks: bounds.retentionBlocks,
      positionBlocks: bounds.positionBlocks,
      windowHours: this.deps.env.walletPnlWindowHours,
      positionWindowHours: this.deps.env.walletPnlPositionWindowHours,
      retentionDays: this.deps.env.walletPnlRetentionDays,
      snapshotLimit: this.deps.env.walletPnlSnapshotLimit,
      minProfitUsd: this.deps.env.walletPnlMinProfitUsd,
      partial: bounds.partial,
      trustedV4Hooks: this.deps.env.walletPnlTrustedV4Hooks,
      profile: profile.sink
    });
    if (!rebuilt) {
      logger.warn(
        { fromBlock: bounds.retentionFromBlock, toBlock: bounds.scannedToBlock },
        "wallet pnl snapshot rebuild skipped; flat trade columns are not ready"
      );
      return;
    }
    this.deps.store.setWalletPnlSnapshot(rebuilt);
    await this.deps.store.save();
    logger.info(
      {
        fromBlock: bounds.retentionFromBlock,
        positionFromBlock: bounds.positionFromBlock,
        toBlock: bounds.scannedToBlock,
        intervalMs: this.deps.env.walletPnlSnapshotIntervalMs,
        elapsedMs: Date.now() - startedAt,
        source: "flat-sql-worker",
        ...walletPnlProfileLogField(profile)
      },
      "wallet pnl snapshot rebuilt"
    );
  }

  private async rebuildAnalyticsInWorker(reason: string): Promise<void> {
    const chain = this.deps.env.walletPnlChain;
    const bounds = await this.walletPnlRebuildBounds(chain, "analytics", reason);
    if (!bounds) return;
    const logger = this.deps.logger.child({ chain, component: "wallet-pnl-rebuild", kind: "analytics", reason });
    const analytics = this.deps.store.getWalletPnlAnalyticsSnapshot(chain);
    const shouldRebuild = shouldRebuildWalletPnlAnalytics(analytics, {
      fromBlock: bounds.analyticsFromBlock,
      positionFromBlock: bounds.positionFromBlock,
      toBlock: bounds.scannedToBlock,
      windowHours: this.deps.env.walletPnlAnalyticsWindowHours,
      positionWindowHours: this.deps.env.walletPnlPositionWindowHours,
      intervalMs: this.deps.env.walletPnlAnalyticsIntervalMs,
      now: Date.now()
    }) || (reason === "interval" && (!analytics || analytics.toBlock < bounds.scannedToBlock));
    if (!shouldRebuild) {
      logger.info(
        {
          fromBlock: analytics?.fromBlock,
          positionFromBlock: analytics?.positionFromBlock,
          toBlock: analytics?.toBlock,
          scannedToBlock: bounds.scannedToBlock,
          generatedAt: analytics?.generatedAt,
          ageMs: walletPnlAgeMs(analytics?.generatedAt),
          intervalMs: this.deps.env.walletPnlAnalyticsIntervalMs,
          decision: "skip"
        },
        "wallet pnl analytics snapshot rebuild skipped"
      );
      return;
    }
    const flatStore = walletPnlFlatAnalyticsStore(this.deps.store);
    if (!flatStore.buildWalletPnlAnalyticsSnapshotFromFlatTradesInWorker) {
      logger.warn({ toBlock: bounds.scannedToBlock }, "wallet pnl analytics snapshot rebuild skipped; worker unavailable");
      return;
    }
    const startedAt = Date.now();
    const profile = walletPnlCreateProfile(this.deps.env.walletPnlProfileRebuilds);
    logger.info(
      {
        fromBlock: bounds.retentionFromBlock,
        analyticsFromBlock: bounds.analyticsFromBlock,
        positionFromBlock: bounds.positionFromBlock,
        toBlock: bounds.scannedToBlock,
        intervalMs: this.deps.env.walletPnlAnalyticsIntervalMs
      },
      "wallet pnl analytics snapshot rebuild queued"
    );
    let rebuilt = await flatStore.buildWalletPnlAnalyticsSnapshotFromFlatTradesInWorker({
      chain,
      fromBlock: bounds.analyticsFromBlock,
      positionFromBlock: bounds.positionFromBlock,
      toBlock: bounds.scannedToBlock,
      windowHours: this.deps.env.walletPnlAnalyticsWindowHours,
      positionWindowHours: this.deps.env.walletPnlPositionWindowHours,
      trustedV4Hooks: this.deps.env.walletPnlTrustedV4Hooks,
      profile: profile.sink
    });
    if (!rebuilt) {
      logger.warn(
        { fromBlock: bounds.analyticsFromBlock, positionFromBlock: bounds.positionFromBlock, toBlock: bounds.scannedToBlock },
        "wallet pnl analytics snapshot rebuild skipped; flat trade columns are not ready"
      );
      return;
    }
    rebuilt = await enrichWalletPnlAnalyticsTokenCreators({
      snapshot: rebuilt,
      blockscoutClient: this.walletPnlCreatorBlockscoutClient(),
      rpc: this.deps.rpcs.get(chain),
      store: this.deps.store,
      deniedTokenFactoryContracts: this.deps.env.walletPnlDeniedTokenFactoryContracts,
      lookupDeadlineMs: WALLET_PNL_ANALYTICS_CREATOR_LOOKUP_DEADLINE_MS,
      logger
    });
    this.deps.store.setWalletPnlAnalyticsSnapshot(rebuilt);
    await this.deps.store.save();
    logger.info(
      {
        fromBlock: bounds.retentionFromBlock,
        analyticsFromBlock: bounds.analyticsFromBlock,
        positionFromBlock: bounds.positionFromBlock,
        toBlock: bounds.scannedToBlock,
        intervalMs: this.deps.env.walletPnlAnalyticsIntervalMs,
        elapsedMs: Date.now() - startedAt,
        source: "flat-sql-worker",
        ...walletPnlProfileLogField(profile)
      },
      "wallet pnl analytics snapshot rebuilt"
    );
  }

  private async rebuildNewTokensInWorker(reason: string): Promise<void> {
    const chain = this.deps.env.walletPnlChain;
    const bounds = await this.walletPnlRebuildBounds(chain, "newTokens", reason);
    if (!bounds) return;
    const logger = this.deps.logger.child({ chain, component: "wallet-pnl-rebuild", kind: "newTokens", reason });
    const newTokens = this.deps.store.getWalletPnlNewTokensSnapshot(chain);
    const shouldRebuild = shouldRebuildWalletPnlNewTokens(newTokens, {
      fromBlock: bounds.analyticsFromBlock,
      toBlock: bounds.scannedToBlock,
      windowHours: this.deps.env.walletPnlAnalyticsWindowHours,
      intervalMs: this.deps.env.walletPnlNewTokensIntervalMs,
      now: Date.now()
    }) || (reason === "interval" && (!newTokens || newTokens.toBlock < bounds.scannedToBlock));
    if (!shouldRebuild) {
      logger.info(
        {
          fromBlock: newTokens?.fromBlock,
          toBlock: newTokens?.toBlock,
          scannedToBlock: bounds.scannedToBlock,
          generatedAt: newTokens?.generatedAt,
          ageMs: walletPnlAgeMs(newTokens?.generatedAt),
          intervalMs: this.deps.env.walletPnlNewTokensIntervalMs,
          decision: "skip"
        },
        "wallet pnl new tokens snapshot rebuild skipped"
      );
      return;
    }
    const flatStore = walletPnlFlatAnalyticsStore(this.deps.store);
    const startedAt = Date.now();
    const profile = walletPnlCreateProfile(this.deps.env.walletPnlProfileRebuilds);
    logger.info(
      {
        fromBlock: bounds.analyticsFromBlock,
        toBlock: bounds.scannedToBlock,
        intervalMs: this.deps.env.walletPnlNewTokensIntervalMs
      },
      "wallet pnl new tokens snapshot rebuild queued"
    );
    let rebuilt: WalletPnlNewTokensSnapshot | undefined;
    let source = "flat-sql-worker";
    if (flatStore.buildWalletPnlNewTokensSnapshotFromFlatTradesInWorker) {
      rebuilt = await flatStore.buildWalletPnlNewTokensSnapshotFromFlatTradesInWorker({
        chain,
        fromBlock: bounds.analyticsFromBlock,
        toBlock: bounds.scannedToBlock,
        windowHours: this.deps.env.walletPnlAnalyticsWindowHours,
        limit: WALLET_PNL_NEW_TOKENS_LIMIT,
        trustedV4Hooks: this.deps.env.walletPnlTrustedV4Hooks,
        profile: profile.sink
      });
    } else {
      logger.warn({ toBlock: bounds.scannedToBlock }, "wallet pnl new tokens snapshot rebuild skipped; worker unavailable");
    }
    if (!rebuilt) {
      const analytics = this.deps.store.getWalletPnlAnalyticsSnapshot(chain);
      if (!analytics) {
        logger.warn(
          { fromBlock: bounds.analyticsFromBlock, toBlock: bounds.scannedToBlock },
          "wallet pnl new tokens snapshot rebuild skipped; flat trade columns are not ready"
        );
        return;
      }
      rebuilt = walletPnlNewTokensSnapshotFromAnalytics(analytics, WALLET_PNL_NEW_TOKENS_LIMIT);
      source = "analytics-snapshot";
    }
    rebuilt = {
      ...rebuilt,
      tokens: await enrichWalletPnlTokenSummaries({
        chain,
        tokens: rebuilt.tokens,
        blockscoutClient: this.walletPnlCreatorBlockscoutClient(),
        rpc: this.deps.rpcs.get(chain),
        store: this.deps.store,
        deniedTokenFactoryContracts: this.deps.env.walletPnlDeniedTokenFactoryContracts,
        lookupDeadlineMs: WALLET_PNL_NEW_TOKENS_CREATOR_LOOKUP_DEADLINE_MS,
        logger
      })
    };
    this.deps.store.setWalletPnlNewTokensSnapshot(rebuilt);
    await this.deps.store.save();
    logger.info(
      {
        fromBlock: rebuilt.fromBlock,
        toBlock: rebuilt.toBlock,
        intervalMs: this.deps.env.walletPnlNewTokensIntervalMs,
        tokens: rebuilt.tokenCount,
        elapsedMs: Date.now() - startedAt,
        source,
        ...walletPnlProfileLogField(profile)
      },
      "wallet pnl new tokens snapshot rebuilt"
    );
  }

  private async runChain(chain: ChainSlug, reason: string): Promise<void> {
    const rpc = this.deps.rpcs.get(chain);
    if (!rpc) {
      this.deps.logger.warn({ chain }, "wallet pnl enabled but no RPC is configured for chain");
      return;
    }
    const logger = this.deps.logger.child({ chain, component: "wallet-pnl", reason });
    const latestBlock = await rpc.getBlockNumber();
    const headBlock = Math.max(0, latestBlock - this.deps.env.walletPnlHeadLagBlocks);
    const blockSeconds = blockSecondsFor(chain);
    const retentionBlocks = Math.max(1, Math.ceil(this.deps.env.walletPnlRetentionDays * 24 * 60 * 60 / blockSeconds));
    const bootstrapBlocks = Math.max(1, Math.ceil(this.deps.env.walletPnlBootstrapHours * 60 * 60 / blockSeconds));
    const retentionFromBlock = Math.max(0, headBlock - retentionBlocks + 1);
    const cursor = this.deps.store.getWalletPnlCursor(chain);
    const fromBlock = cursor?.lastBlock !== undefined
      ? cursor.lastBlock + 1
      : Math.max(0, headBlock - bootstrapBlocks + 1);
    const toBlock = Math.min(headBlock, fromBlock + this.deps.env.walletPnlMaxBlocksPerTick - 1);
    const now = new Date().toISOString();
    let scannedToBlock = cursor?.lastBlock ?? Math.max(0, fromBlock - 1);

    await this.ensureSeedPools(chain, rpc, now, logger);

    if (fromBlock <= toBlock) {
      const discovered = await discoverTrackedPoolsInRange(
        chain,
        rpc,
        fromBlock,
        toBlock,
        this.deps.env.logChunkSize,
        this.deps.env.walletPnlMaxFactoryDiscoveries
      );
      const discoveredPoolPolicy = this.upsertPools(chain, discovered, "factory", now);
      const activeDiscovered = await this.discoverActiveBlockscoutPools(chain, fromBlock, toBlock, logger);
      const activeDiscoveredPoolPolicy = this.upsertPools(chain, activeDiscovered, "blockscout", now);
      const pools = this.scanPools(chain, retentionFromBlock);
      if (pools.length > 0) {
        const logs = await this.fetchLogs(chain, rpc, pools, fromBlock, toBlock, logger);
        const trades = await this.normalizeTrades(chain, rpc, pools, logs, logger);
        this.deps.store.upsertWalletPnlTrades(trades);
        logger.info(
          {
            fromBlock,
            toBlock,
            pools: pools.length,
            discoveredPools: discovered.length,
            registeredDiscoveredPools: discoveredPoolPolicy.pools.length,
            rejectedDiscoveredPools: discoveredPoolPolicy.rejected,
            rejectedDiscoveredBaseV4NoHook: discoveredPoolPolicy.rejectedBaseV4NoHook,
            rejectedDiscoveredBaseV4UntrustedHook: discoveredPoolPolicy.rejectedBaseV4UntrustedHook,
            activeDiscoveredPools: activeDiscovered.length,
            registeredActiveDiscoveredPools: activeDiscoveredPoolPolicy.pools.length,
            rejectedActiveDiscoveredPools: activeDiscoveredPoolPolicy.rejected,
            rejectedActiveBaseV4NoHook: activeDiscoveredPoolPolicy.rejectedBaseV4NoHook,
            rejectedActiveBaseV4UntrustedHook: activeDiscoveredPoolPolicy.rejectedBaseV4UntrustedHook,
            swapLogs: logs.length,
            walletTrades: trades.length
          },
          "wallet pnl range processed"
        );
      } else {
        logger.info(
          {
            fromBlock,
            toBlock,
            discoveredPools: discovered.length,
            registeredDiscoveredPools: discoveredPoolPolicy.pools.length,
            rejectedDiscoveredPools: discoveredPoolPolicy.rejected,
            activeDiscoveredPools: activeDiscovered.length,
            registeredActiveDiscoveredPools: activeDiscoveredPoolPolicy.pools.length,
            rejectedActiveDiscoveredPools: activeDiscoveredPoolPolicy.rejected
          },
          "wallet pnl range skipped; no pools registered"
        );
      }
      scannedToBlock = toBlock;
    }

    const pruned = this.deps.store.pruneWalletPnlTradesBeforeBlock(chain, retentionFromBlock);
    if (pruned > 0) logger.info({ pruned, retentionFromBlock }, "wallet pnl old trades pruned");

    const snapshot = this.deps.store.getWalletPnlSnapshot(chain);
    let lastPostedAt = cursor?.lastPostedAt;
    if (snapshot && snapshot.toBlock >= scannedToBlock) {
      lastPostedAt = await this.maybePostSnapshot(snapshot, lastPostedAt, logger);
    } else {
      logger.debug({ snapshotToBlock: snapshot?.toBlock, scannedToBlock }, "wallet pnl digest post skipped; cached snapshot is stale");
    }
    this.deps.store.setWalletPnlCursor({
      chain,
      lastBlock: Math.max(cursor?.lastBlock ?? 0, scannedToBlock),
      lastPostedAt,
      updatedAt: new Date().toISOString()
    });
    await this.deps.store.save();
  }

  private async bootstrapTokenCoverage(chain: ChainSlug, tokenAddress: string, reason: string): Promise<void> {
    const rpc = this.deps.rpcs.get(chain);
    const blockscout = this.deps.blockscoutClient;
    if (!rpc || !blockscout) return;
    const logger = this.deps.logger.child({ chain, component: "wallet-pnl-token-bootstrap", tokenAddress, reason });
    const latestBlock = await rpc.getBlockNumber();
    const headBlock = Math.max(0, latestBlock - this.deps.env.walletPnlHeadLagBlocks);
    const blockSeconds = blockSecondsFor(chain);
    const discoveryBlocks = Math.max(1, Math.ceil(this.deps.env.walletPnlTokenBootstrapDiscoveryDays * 24 * 60 * 60 / blockSeconds));
    const replayBlocks = Math.max(1, Math.ceil(this.deps.env.walletPnlTokenBootstrapReplayHours * 60 * 60 / blockSeconds));
    const discoveryFromBlock = Math.max(0, headBlock - discoveryBlocks + 1);
    const replayFromBlock = Math.max(0, headBlock - replayBlocks + 1);
    const filters = walletPnlTokenPoolDiscoveryFilters(chain, tokenAddress);
    if (filters.length === 0) return;

    const discoveryLogs = await blockscout.fetchLogs(
      chain,
      filters,
      discoveryFromBlock,
      headBlock,
      Math.max(this.deps.env.blockscoutLogChunkSize, WALLET_PNL_TOKEN_BOOTSTRAP_LOG_CHUNK_BLOCKS)
    );
    const discoveredPools = walletPnlPoolsFromDiscoveryLogs(chain, tokenAddress, discoveryLogs);
    const poolPolicy = filterWalletPnlPoolsByPolicy(chain, discoveredPools, "blockscout", this.deps.env.walletPnlTrustedV4Hooks);
    const pools = poolPolicy.pools.slice(0, this.deps.env.walletPnlTokenBootstrapMaxPools);
    if (pools.length === 0) {
      logger.info(
        {
          fromBlock: discoveryFromBlock,
          toBlock: headBlock,
          discoveryLogs: discoveryLogs.length,
          discoveredPools: discoveredPools.length,
          rejectedPools: poolPolicy.rejected,
          rejectedBaseV4NoHook: poolPolicy.rejectedBaseV4NoHook,
          rejectedBaseV4UntrustedHook: poolPolicy.rejectedBaseV4UntrustedHook,
          rejectedHooks: poolPolicy.rejectedHooks
        },
        "wallet pnl token bootstrap found no eligible pools"
      );
      return;
    }

    const now = new Date().toISOString();
    const existingPoolIds = new Set(
      pools
        .filter((pool) => this.deps.store.getWalletPnlPool(chain, pool.id.toLowerCase()))
        .map((pool) => pool.id.toLowerCase())
    );
    const newlySeeded = pools.filter((pool) => !existingPoolIds.has(pool.id.toLowerCase()));
    this.upsertPools(chain, newlySeeded, "blockscout", now);
    const swapLogs = await blockscout.fetchSwapLogs(
      this.deps.env,
      chain,
      pools,
      replayFromBlock,
      headBlock,
      Math.max(this.deps.env.blockscoutLogChunkSize, 50_000)
    );
    const trades = await this.normalizeTrades(chain, rpc, pools, swapLogs, logger);
    this.deps.store.upsertWalletPnlTrades(trades);
    await this.deps.store.save();
    logger.info(
      {
        discoveryFromBlock,
        replayFromBlock,
        toBlock: headBlock,
        discoveryLogs: discoveryLogs.length,
        discoveredPools: discoveredPools.length,
        pools: pools.length,
        rejectedPools: poolPolicy.rejected,
        rejectedBaseV4NoHook: poolPolicy.rejectedBaseV4NoHook,
        rejectedBaseV4UntrustedHook: poolPolicy.rejectedBaseV4UntrustedHook,
        newlySeededPools: newlySeeded.length,
        swapLogs: swapLogs.length,
        walletTrades: trades.length
      },
      "wallet pnl token bootstrap completed"
    );
  }

  private walletPnlCreatorBlockscoutClient(): BlockscoutClient | undefined {
    return this.deps.env.walletPnlBlockscoutCreatorLookupEnabled ? this.deps.blockscoutClient : undefined;
  }

  private async discoverActiveBlockscoutPools(
    chain: ChainSlug,
    fromBlock: number,
    toBlock: number,
    logger: Logger
  ): Promise<PoolKey[]> {
    if (!this.deps.env.walletPnlActivePoolDiscoveryEnabled) return [];
    const blockscout = this.deps.blockscoutClient;
    if (!blockscout) return [];
    const source = walletPnlPoolManagerSource(chain);
    if (!source) return [];

    try {
      const swapLogs = await blockscout.fetchLogs(
        chain,
        walletPnlActiveV4SwapFilters(chain, source.address),
        fromBlock,
        toBlock,
        Math.max(this.deps.env.blockscoutLogChunkSize, this.deps.env.walletPnlMaxBlocksPerTick)
      );
      const unknownPoolIds = walletPnlUnknownV4PoolIds(
        swapLogs,
        (poolId) => Boolean(this.deps.store.getWalletPnlPool(chain, poolId)),
        this.deps.env.walletPnlActivePoolDiscoveryMaxPools
      );
      if (unknownPoolIds.length === 0) {
        logger.debug({ fromBlock, toBlock, activeV4SwapLogs: swapLogs.length }, "wallet pnl active v4 pool discovery found no missing pools");
        return [];
      }

      const initializeLogs = await blockscout.fetchLogs(
        chain,
        unknownPoolIds.map((poolId) => ({ address: source.address.toLowerCase(), topic0: INITIALIZE_TOPIC, topic1: poolId })),
        0,
        toBlock,
        Math.max(WALLET_PNL_INITIALIZE_LOOKUP_CHUNK_BLOCKS, toBlock + 1)
      );
      const resolvedPools = uniquePools(initializeLogs
        .map((log) => parseTrackedPoolDiscoveryLog(source, log, chain))
        .filter((pool): pool is PoolKey => Boolean(pool && isWalletPnlPool(pool))))
        .filter((pool) => !this.deps.store.getWalletPnlPool(chain, pool.id.toLowerCase()));
      const poolPolicy = filterWalletPnlPoolsByPolicy(chain, resolvedPools, "blockscout", this.deps.env.walletPnlTrustedV4Hooks);
      logger.info(
        {
          fromBlock,
          toBlock,
          activeV4SwapLogs: swapLogs.length,
          unknownPoolIds: unknownPoolIds.length,
          initializeLogs: initializeLogs.length,
          resolvedPools: resolvedPools.length,
          activeDiscoveredPools: poolPolicy.pools.length,
          rejectedPools: poolPolicy.rejected,
          rejectedBaseV4NoHook: poolPolicy.rejectedBaseV4NoHook,
          rejectedBaseV4UntrustedHook: poolPolicy.rejectedBaseV4UntrustedHook,
          rejectedHooks: poolPolicy.rejectedHooks
        },
        "wallet pnl active v4 pools resolved from Blockscout"
      );
      return poolPolicy.pools;
    } catch (error) {
      logger.warn({ fromBlock, toBlock, error: (error as Error).message }, "wallet pnl active v4 pool discovery failed");
      return [];
    }
  }

  private async ensureSeedPools(chain: ChainSlug, rpc: RpcPool, now: string, logger: Logger): Promise<void> {
    const limit = this.deps.env.walletPnlSeedPoolLimit;
    if (limit <= 0) return;
    const existing = this.deps.store.getWalletPnlPools(chain, limit);
    if (existing.length >= limit) return;
    const seeds = await resolveMarketPools(chain, rpc, limit);
    if (seeds.length === 0) return;
    const poolPolicy = this.upsertPools(chain, seeds, "seed", now);
    logger.info(
      {
        seedPools: seeds.length,
        registeredSeedPools: poolPolicy.pools.length,
        rejectedSeedPools: poolPolicy.rejected,
        rejectedBaseV4NoHook: poolPolicy.rejectedBaseV4NoHook,
        rejectedBaseV4UntrustedHook: poolPolicy.rejectedBaseV4UntrustedHook
      },
      "wallet pnl seed pools registered"
    );
  }

  private upsertPools(chain: ChainSlug, pools: PoolKey[], source: WalletPnlPoolRecord["source"], now: string): WalletPnlPoolPolicyFilter {
    const poolPolicy = filterWalletPnlPoolsByPolicy(chain, uniquePools(pools), source, this.deps.env.walletPnlTrustedV4Hooks);
    const records = poolPolicy.pools
      .map((pool): WalletPnlPoolRecord => ({
        chain,
        poolId: pool.id.toLowerCase(),
        pool: { ...pool, chain },
        source,
        firstSeenBlock: pool.createdBlock,
        lastSeenBlock: pool.createdBlock,
        createdAt: now,
        updatedAt: now
      }));
    this.deps.store.upsertWalletPnlPools(records);
    return poolPolicy;
  }

  private scanPools(chain: ChainSlug, activeFromBlock: number): PoolKey[] {
    const limit = this.deps.env.walletPnlMaxPoolsPerTick;
    const records = this.deps.store
      .getWalletPnlScanPools(chain, {
        activeFromBlock,
        limit: limit > 0 ? limit : undefined,
        sources: this.deps.env.walletPnlScanPoolSources,
        trustedV4Hooks: this.deps.env.walletPnlTrustedV4Hooks
      });
    return records
      .filter((record) => shouldUseWalletPnlPool(chain, record.pool, record.source, this.deps.env.walletPnlTrustedV4Hooks))
      .map((record) => record.pool);
  }

  private async fetchLogs(
    chain: ChainSlug,
    rpc: RpcPool,
    pools: PoolKey[],
    fromBlock: number,
    toBlock: number,
    logger: Logger
  ): Promise<Log[]> {
    const poolPolicy = filterWalletPnlPoolsByPolicy(chain, pools, "blockscout", this.deps.env.walletPnlTrustedV4Hooks);
    if (poolPolicy.rejected > 0) {
      logger.warn(
        {
          fromBlock,
          toBlock,
          requestedPools: pools.length,
          eligiblePools: poolPolicy.pools.length,
          rejectedPools: poolPolicy.rejected,
          rejectedBaseV4NoHook: poolPolicy.rejectedBaseV4NoHook,
          rejectedBaseV4UntrustedHook: poolPolicy.rejectedBaseV4UntrustedHook,
          rejectedHooks: poolPolicy.rejectedHooks
        },
        "wallet pnl trade-log fetch skipped ineligible pools"
      );
    }
    pools = poolPolicy.pools;
    if (pools.length === 0) return [];
    const blockscout = this.deps.blockscoutClient;
    const source = this.deps.env.blockscoutLogSource;
    if (source === "preferred" && blockscout) {
      try {
        const logs = await blockscout.fetchSwapLogs(this.deps.env, chain, pools, fromBlock, toBlock);
        logger.info({ fromBlock, toBlock, pools: pools.length, swapLogs: logs.length }, "wallet pnl swap logs fetched from Blockscout");
        return logs;
      } catch (error) {
        logger.warn({ fromBlock, toBlock, error: (error as Error).message }, "wallet pnl Blockscout fetch failed; falling back to RPC");
      }
    }
    try {
      const logs = await fetchSwapLogs(rpc, this.deps.env, chain, pools, fromBlock, toBlock);
      logger.info({ fromBlock, toBlock, pools: pools.length, swapLogs: logs.length }, "wallet pnl swap logs fetched from RPC");
      return logs;
    } catch (error) {
      if (source === "fallback" && blockscout) {
        logger.warn({ fromBlock, toBlock, error: (error as Error).message }, "wallet pnl RPC fetch failed; falling back to Blockscout");
        return blockscout.fetchSwapLogs(this.deps.env, chain, pools, fromBlock, toBlock);
      }
      throw error;
    }
  }

  private async normalizeTrades(
    chain: ChainSlug,
    rpc: RpcPool,
    pools: PoolKey[],
    logs: Log[],
    logger: Logger
  ): Promise<WalletPnlTradeRecord[]> {
    if (logs.length === 0) return [];
    const tokenService = this.tokenServiceFor(chain, rpc);
    const logsByPool = groupLogsByPool(logs, pools, this.deps.env, chain);
    const now = new Date().toISOString();
    const poolsWithLogs = pools.map((pool) => ({ pool, logs: logsByPool.get(pool.id.toLowerCase()) ?? [] })).filter((item) => item.logs.length > 0);
    logger.info({ poolsWithLogs: poolsWithLogs.length, swapLogs: logs.length }, "wallet pnl trade normalization started");
    let completedPools = 0;
    let skippedPools = 0;
    let parsedTradeCount = 0;
    let lastLogAt = Date.now();
    const parsedByPool = await mapWithConcurrency(
      poolsWithLogs,
      WALLET_TRADE_NORMALIZE_CONCURRENCY,
      async ({ pool, logs: poolLogs }) => {
        try {
          const side = chooseMarketSide(pool, chain);
          if (!side) return [];
          const metadataTimeoutMs = this.deps.env.walletPnlMetadataTimeoutMs;
          const [baseToken, quoteToken, quoteUsd] = await Promise.all([
            withTimeout(tokenService.getToken(side.base), metadataTimeoutMs, `base token metadata ${side.base}`),
            withTimeout(tokenService.getToken(side.quote), metadataTimeoutMs, `quote token metadata ${side.quote}`),
            withTimeout(this.deps.priceService.quoteUsdMultiplier(side.quote, chain), metadataTimeoutMs, `quote USD multiplier ${side.quote}`)
          ]);
          const trades = parseMarketTrades(pool, side, baseToken, quoteToken, quoteUsd, poolLogs);
          parsedTradeCount += trades.length;
          return trades.map((trade): ParsedWalletTradeInput => ({ pool, baseToken, quoteToken, trade }));
        } catch (error) {
          skippedPools += 1;
          logger.warn(
            { poolId: pool.id, dex: pool.dex, protocol: poolProtocol(pool), logs: poolLogs.length, error: (error as Error).message },
            "wallet pnl trade normalization skipped pool"
          );
          return [];
        } finally {
          completedPools += 1;
          const progressNow = Date.now();
          if (
            completedPools === poolsWithLogs.length ||
            completedPools % WALLET_TRADE_NORMALIZE_LOG_EVERY === 0 ||
            progressNow - lastLogAt >= WALLET_TRADE_NORMALIZE_LOG_INTERVAL_MS
          ) {
            lastLogAt = progressNow;
            logger.info(
              { completedPools, totalPools: poolsWithLogs.length, skippedPools, parsedTrades: parsedTradeCount },
              "wallet pnl trade normalization progress"
            );
          }
        }
      }
    );
    const parsedTrades = parsedByPool.flat();
    const txRequests = uniqueTxSenderRequests(parsedTrades);
    logger.info(
      { parsedTrades: parsedTrades.length, uniqueTransactions: txRequests.length, blocks: uniqueBlockCount(txRequests) },
      "wallet pnl trades parsed; resolving transaction senders"
    );
    const txWallets = await this.resolveTxWallets(rpc, txRequests, logger);
    const records: WalletPnlTradeRecord[] = [];
    for (const item of parsedTrades) {
      const wallet = txWallets.get(item.trade.txHash.toLowerCase());
      if (!wallet) continue;
      records.push({
        chain,
        wallet,
        poolId: item.pool.id.toLowerCase(),
        poolAddress: item.pool.poolAddress ?? (item.pool.id.startsWith("0x") && item.pool.id.length === 42 ? item.pool.id.toLowerCase() : undefined),
        dex: item.pool.dex ?? "uniswap",
        protocol: poolProtocol(item.pool),
        tokenAddress: tokenAddress(item.baseToken),
        tokenSymbol: tokenSymbol(item.baseToken),
        quoteAddress: tokenAddress(item.quoteToken),
        quoteSymbol: tokenSymbol(item.quoteToken),
        side: item.trade.side,
        baseAmount: item.trade.targetAmount,
        quoteAmount: item.trade.quoteAmount,
        priceUsd: finiteOrUndefined(item.trade.priceUsd),
        volumeUsd: finiteOrUndefined(item.trade.volumeUsd),
        txHash: item.trade.txHash.toLowerCase(),
        logIndex: item.trade.logIndex,
        blockNumber: item.trade.blockNumber,
        createdAt: now
      });
    }
    logger.info({ parsedTrades: parsedTrades.length, walletTrades: records.length }, "wallet pnl trade normalization finished");
    return records;
  }

  private tokenServiceFor(chain: ChainSlug, rpc: RpcPool): TokenService {
    let service = this.tokenServices.get(chain);
    if (!service) {
      service = new TokenService(rpc, chain, { fastMetadata: true });
      this.tokenServices.set(chain, service);
    }
    return service;
  }

  private async resolveTxWallets(rpc: RpcPool, txRequests: TxSenderRequest[], logger: Logger): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (txRequests.length === 0) return out;

    const hashesByBlock = new Map<number, string[]>();
    for (const request of txRequests) {
      const bucket = hashesByBlock.get(request.blockNumber);
      if (bucket) {
        bucket.push(request.txHash);
      } else {
        hashesByBlock.set(request.blockNumber, [request.txHash]);
      }
    }

    const blockEntries = [...hashesByBlock.entries()].sort((a, b) => a[0] - b[0]);
    let completedBlocks = 0;
    let blockFound = 0;
    let lastBlockLogAt = Date.now();
    logger.info(
      { blocks: blockEntries.length, uniqueTransactions: txRequests.length },
      "wallet pnl transaction sender block attribution started"
    );
    await mapWithConcurrency(blockEntries, this.deps.env.walletPnlBlockLookupConcurrency, async ([blockNumber, txHashes]) => {
      const blockSenders = await this.walletsForBlockTxs(rpc, blockNumber, txHashes);
      for (const [txHash, wallet] of blockSenders) {
        if (!out.has(txHash)) {
          out.set(txHash, wallet);
          blockFound += 1;
        }
      }
      completedBlocks += 1;
      const now = Date.now();
      if (
        completedBlocks === blockEntries.length ||
        completedBlocks % WALLET_BLOCK_ATTRIBUTION_LOG_EVERY === 0 ||
        now - lastBlockLogAt >= WALLET_TX_ATTRIBUTION_LOG_INTERVAL_MS
      ) {
        lastBlockLogAt = now;
        logger.info(
          { completedBlocks, totalBlocks: blockEntries.length, found: blockFound, missing: txRequests.length - out.size },
          "wallet pnl transaction sender block attribution progress"
        );
      }
    });

    const missing = txRequests.map((request) => request.txHash).filter((txHash) => !out.has(txHash));
    if (missing.length === 0) return out;

    logger.info(
      { missingTransactions: missing.length, foundFromBlocks: out.size },
      "wallet pnl transaction sender attribution fallback started"
    );
    let completed = 0;
    let found = out.size;
    let lastLogAt = Date.now();
    await mapWithConcurrency(missing, this.deps.env.walletPnlTxLookupConcurrency, async (txHash) => {
      const wallet = await this.walletForTx(rpc, txHash);
      completed += 1;
      if (wallet) {
        out.set(txHash, wallet);
        found += 1;
      }
      const now = Date.now();
      if (
        completed === missing.length ||
        completed % WALLET_TX_ATTRIBUTION_LOG_EVERY === 0 ||
        now - lastLogAt >= WALLET_TX_ATTRIBUTION_LOG_INTERVAL_MS
      ) {
        lastLogAt = now;
        logger.info(
          { completed, total: missing.length, found, missing: txRequests.length - out.size },
          "wallet pnl transaction sender attribution progress"
        );
      }
    });
    return out;
  }

  private async walletsForBlockTxs(rpc: RpcPool, blockNumber: number, txHashes: string[]): Promise<Map<string, string>> {
    const wanted = new Set(txHashes.map((txHash) => txHash.toLowerCase()));
    const out = new Map<string, string>();
    try {
      const block = await withTimeout(
        rpc.send<RpcBlockWithTransactions>("eth_getBlockByNumber", [toRpcQuantity(blockNumber), true], { blockNumber, note: "wallet pnl sender block" }),
        this.deps.env.walletPnlTxLookupTimeoutMs,
        `block transaction lookup ${blockNumber}`
      );
      for (const tx of block.transactions ?? []) {
        if (typeof tx === "string") continue;
        const txHash = typeof tx.hash === "string" ? tx.hash.toLowerCase() : undefined;
        if (!txHash || !wanted.has(txHash) || typeof tx.from !== "string") continue;
        out.set(txHash, normalizeAddress(tx.from).toLowerCase());
      }
    } catch {
      return out;
    }
    return out;
  }

  private walletForTx(rpc: RpcPool, txHash: string): Promise<string | undefined> {
    return withTimeout(rpc.getTransaction(txHash), this.deps.env.walletPnlTxLookupTimeoutMs, `transaction lookup ${txHash}`)
      .then((tx) => tx?.from ? normalizeAddress(tx.from).toLowerCase() : undefined)
      .catch(() => undefined);
  }

  private async maybePostSnapshot(
    snapshot: WalletPnlSnapshot,
    lastPostedAt: string | undefined,
    logger: Logger
  ): Promise<string | undefined> {
    const chatId = this.deps.env.walletPnlPostChatId;
    if (!chatId) return lastPostedAt;
    const nowMs = Date.now();
    const lastMs = lastPostedAt ? Date.parse(lastPostedAt) : 0;
    if (Number.isFinite(lastMs) && lastMs > 0 && nowMs - lastMs < this.deps.env.walletPnlPostIntervalMs) return lastPostedAt;
    const postedAt = new Date(nowMs).toISOString();
    if (snapshot.partial) {
      logger.info({ toBlock: snapshot.toBlock }, "wallet pnl digest not posted; indexer is still catching up");
      return lastPostedAt;
    }
    if (snapshot.top.length === 0) {
      logger.info({ toBlock: snapshot.toBlock }, "wallet pnl digest not posted; no profitable realized exits");
      return postedAt;
    }
    if (!this.deps.bot) {
      logger.warn({ chatId }, "wallet pnl post chat configured but Telegram runtime is disabled");
      return lastPostedAt;
    }
    const extra: { message_thread_id?: number; disable_web_page_preview: boolean } = { disable_web_page_preview: true };
    if (this.deps.env.walletPnlPostThreadId && this.deps.env.walletPnlPostThreadId > 0) {
      extra.message_thread_id = this.deps.env.walletPnlPostThreadId;
    }
    await this.deps.bot.telegram.sendMessage(chatId, formatWalletPnlSnapshot(snapshot, 10), extra);
    logger.info({ chatId, toBlock: snapshot.toBlock, wallets: snapshot.top.length }, "wallet pnl digest posted");
    return postedAt;
  }
}

export function formatWalletPnlSnapshot(snapshot: WalletPnlSnapshot, maxRows = 20): string {
  const chain = getChain(snapshot.chain).name;
  const status = snapshot.partial ? " (catching up)" : "";
  const lines = [
    `Top realized ${chain} DEX PnL, last ${snapshot.windowHours}h${status}`,
    `Scanned to block ${snapshot.toBlock.toLocaleString()} | trades: ${snapshot.tradeCount.toLocaleString()} | wallets: ${snapshot.walletCount.toLocaleString()}`
  ];
  const selected = snapshot.top.slice(0, maxRows);
  if (selected.length === 0) {
    lines.push("", "No profitable realized exits in the current window.");
    return lines.join("\n");
  }
  lines.push("");
  selected.forEach((wallet, index) => {
    const roi = wallet.roiPct !== undefined ? ` | ROI ${formatPct(wallet.roiPct)}` : "";
    const tokens = wallet.tradedTokens.slice(0, 4).join(", ") || "-";
    lines.push(
      `${index + 1}. ${shortAddress(wallet.wallet)} +${formatUsd(wallet.realizedPnlUsd)}${roi} | sells ${wallet.sellCount} | ${tokens}`
    );
  });
  return lines.join("\n");
}

export function buildWalletPnlAnalyticsSnapshot(options: {
  chain: ChainSlug;
  trades: WalletPnlTradeRecord[];
  poolRecords?: WalletPnlPoolRecord[];
  trustedV4Hooks?: string[];
  fromBlock: number;
  positionFromBlock?: number;
  toBlock: number;
  windowHours?: number;
  positionWindowHours?: number;
}): WalletPnlAnalyticsSnapshot {
  const tokens = new Map<string, MutableTokenAnalytics>();
  const wallets = new Map<string, MutableWalletAnalytics>();
  const pools = new Map<string, MutablePoolAnalytics>();
  const poolsById = new Map((options.poolRecords ?? []).map((record) => [record.poolId.toLowerCase(), record.pool]));
  const orderedTrades = options.trades
    .filter((trade) => trade.chain === options.chain && trade.blockNumber >= options.fromBlock && trade.blockNumber <= options.toBlock)
    .filter((trade) => walletPnlAnalyticsTradeAllowed(options.chain, trade, poolsById, options.trustedV4Hooks))
    .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

  for (const trade of orderedTrades) {
    const valueUsd = finiteOrZero(trade.volumeUsd);
    const ignoredToken = isWalletPnlIgnoredToken(options.chain, trade.tokenAddress, trade.tokenSymbol);
    if (!ignoredToken) {
      const token = tokenAnalyticsFor(tokens, trade);
      applyAnalyticsBase(token, trade, valueUsd);
      token.dexes.add(trade.dex);
      token.protocols.add(trade.protocol);
      addMapNumber(token.walletVolumes, trade.wallet.toLowerCase(), valueUsd);
      const hook = untrustedV4Hook(poolsById.get(trade.poolId.toLowerCase()), options.trustedV4Hooks);
      if (hook) token.untrustedV4Hooks.add(hook);
      const priceUsd = finiteOrUndefined(trade.priceUsd);
      if (priceUsd !== undefined && priceUsd > 0) {
        token.minPriceUsd = token.minPriceUsd === undefined ? priceUsd : Math.min(token.minPriceUsd, priceUsd);
        token.maxPriceUsd = token.maxPriceUsd === undefined ? priceUsd : Math.max(token.maxPriceUsd, priceUsd);
        const latestKey = trade.blockNumber * 1_000_000 + trade.logIndex;
        if (latestKey >= token.latestPriceSortKey) {
          token.latestPriceSortKey = latestKey;
          token.latestPriceUsd = priceUsd;
        }
      }
    }

    const wallet = walletAnalyticsFor(wallets, trade);
    applyAnalyticsBase(wallet, trade, valueUsd);
    if (!ignoredToken) {
      const tokenBucket = wallet.tokenVolumes.get(trade.tokenAddress.toLowerCase()) ?? {
        address: trade.tokenAddress.toLowerCase(),
        symbol: trade.tokenSymbol,
        volumeUsd: 0
      };
      tokenBucket.volumeUsd += valueUsd;
      wallet.tokenVolumes.set(tokenBucket.address, tokenBucket);
    }
    addMapNumber(wallet.poolVolumes, trade.poolId.toLowerCase(), valueUsd);

    if (!ignoredToken) {
      const pool = poolAnalyticsFor(pools, trade);
      applyAnalyticsBase(pool, trade, valueUsd);
      addMapNumber(pool.walletVolumes, trade.wallet.toLowerCase(), valueUsd);
      const poolKey = poolsById.get(trade.poolId.toLowerCase());
      const v4Hook = poolV4Hook(poolKey);
      if (v4Hook) pool.v4Hook = v4Hook;
      const hook = untrustedV4Hook(poolKey, options.trustedV4Hooks);
      if (hook) {
        pool.untrustedV4Hook = true;
      }
    }
  }

  const tokenSummaries = [...tokens.values()]
    .map(finalizeTokenAnalytics)
    .sort((a, b) => b.volumeUsd - a.volumeUsd || b.tradeCount - a.tradeCount);
  const walletSummaries = [...wallets.values()].map(finalizeWalletAnalytics);
  const riskWallets = walletSummaries
    .slice()
    .filter((wallet) => wallet.tradeCount >= 10 || wallet.volumeUsd >= 1_000)
    .sort((a, b) => b.suspiciousScore - a.suspiciousScore || b.volumeUsd - a.volumeUsd)
    .slice(0, 1_000);
  const volumeWallets = walletSummaries
    .slice()
    .sort((a, b) => b.volumeUsd - a.volumeUsd || b.tradeCount - a.tradeCount)
    .slice(0, 1_000);
  const poolSummaries = [...pools.values()]
    .map(finalizePoolAnalytics)
    .sort((a, b) => b.volumeUsd - a.volumeUsd || b.tradeCount - a.tradeCount)
    .slice(0, 5_000);
  const pnlPositionTrades = options.positionFromBlock !== undefined && options.positionFromBlock < options.fromBlock
    ? options.trades
      .filter((trade) => trade.chain === options.chain && trade.blockNumber >= options.positionFromBlock! && trade.blockNumber <= options.toBlock)
      .filter((trade) => walletPnlAnalyticsTradeAllowed(options.chain, trade, poolsById, options.trustedV4Hooks))
      .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
    : orderedTrades;
  const trustedV4HookPoolIds = walletPnlTrustedV4HookPoolIds(options.poolRecords ?? [], options.trustedV4Hooks);
  const pnlRows = buildAnalyticsPnlLeaders(pnlPositionTrades, options.fromBlock, trustedV4HookPoolIds);
  const pnlLeaders = pnlRows
    .filter((row) => row.realizedPnlUsd > 0 && row.realizedCostUsd > 0)
    .sort((a, b) => b.realizedPnlUsd - a.realizedPnlUsd || (b.roiPct ?? 0) - (a.roiPct ?? 0))
    .slice(0, 1_000);
  const roiLeaders = pnlRows
    .filter((row) => row.realizedPnlUsd > 0 && row.realizedCostUsd >= 25 && row.realizedProceedsUsd >= 50 && row.roiPct !== undefined)
    .sort((a, b) => (b.roiPct ?? 0) - (a.roiPct ?? 0) || b.realizedPnlUsd - a.realizedPnlUsd)
    .slice(0, 1_000);
  const goodSignalWallets = buildWalletPnlGoodSignalWallets({
    chain: options.chain,
    pnlRows,
    walletSummaries,
    tokenSummaries
  });

  return {
    schemaVersion: 1,
    hookPolicyVersion: WALLET_PNL_HOOK_POLICY_VERSION,
    chain: options.chain,
    generatedAt: new Date().toISOString(),
    windowHours: options.windowHours,
    positionWindowHours: options.positionWindowHours,
    positionFromBlock: options.positionFromBlock,
    fromBlock: options.fromBlock,
    toBlock: options.toBlock,
    tradeCount: orderedTrades.length,
    tokenCount: tokenSummaries.length,
    walletCount: wallets.size,
    poolCount: pools.size,
    tokens: tokenSummaries,
    riskWallets,
    pools: poolSummaries,
    pnlLeaders,
    roiLeaders,
    volumeWallets,
    goodSignalWallets
  };
}

function shouldRebuildWalletPnlAnalytics(
  snapshot: WalletPnlAnalyticsSnapshot | undefined,
  options: {
    fromBlock: number;
    positionFromBlock: number;
    toBlock: number;
    windowHours: number;
    positionWindowHours: number;
    intervalMs: number;
    now: number;
  }
): boolean {
  if (!snapshot) return true;
  if ((snapshot.hookPolicyVersion ?? 0) < WALLET_PNL_HOOK_POLICY_VERSION) return true;
  if (snapshot.windowHours !== options.windowHours) return true;
  if (snapshot.positionWindowHours !== options.positionWindowHours) return true;
  if ((snapshot.positionFromBlock ?? snapshot.fromBlock) > options.positionFromBlock) return true;
  if (snapshot.fromBlock > options.fromBlock) return true;
  if (walletPnlAnalyticsHasIgnoredToken(snapshot)) return true;
  if (walletPnlAnalyticsMissingV4HookRisk(snapshot)) return true;
  if (walletPnlAnalyticsHasIneligibleBaseV4Pool(snapshot)) return true;
  if (walletPnlAnalyticsMissingGoodSignal(snapshot)) return true;
  if (walletPnlAnalyticsMissingTokenCreators(snapshot)) return true;
  if (snapshot.toBlock > options.toBlock) return false;
  const generatedAt = Date.parse(snapshot.generatedAt);
  if (!Number.isFinite(generatedAt)) return true;
  return options.now - generatedAt >= options.intervalMs;
}

function shouldRebuildWalletPnlNewTokens(
  snapshot: WalletPnlNewTokensSnapshot | undefined,
  options: {
    fromBlock: number;
    toBlock: number;
    windowHours: number;
    intervalMs: number;
    now: number;
  }
): boolean {
  if (!snapshot) return true;
  if ((snapshot.hookPolicyVersion ?? 0) < WALLET_PNL_HOOK_POLICY_VERSION) return true;
  if (snapshot.windowHours !== options.windowHours) return true;
  if (snapshot.fromBlock > options.fromBlock) return true;
  if (walletPnlTokenSummariesMissingCreators(snapshot.tokens)) return true;
  if (snapshot.toBlock > options.toBlock) return false;
  const generatedAt = Date.parse(snapshot.generatedAt);
  if (!Number.isFinite(generatedAt)) return true;
  return options.now - generatedAt >= options.intervalMs;
}

function walletPnlNewTokensSnapshotFromAnalytics(
  analytics: WalletPnlAnalyticsSnapshot,
  limit: number
): WalletPnlNewTokensSnapshot {
  const tokens = analytics.tokens
    .filter((token) => !isWalletPnlIgnoredToken(analytics.chain, token.tokenAddress, token.tokenSymbol))
    .slice()
    .sort((a, b) => b.firstBlock - a.firstBlock || b.lastBlock - a.lastBlock || b.volumeUsd - a.volumeUsd)
    .slice(0, Math.max(1, Math.floor(limit)));
  return {
    schemaVersion: 1,
    hookPolicyVersion: WALLET_PNL_HOOK_POLICY_VERSION,
    chain: analytics.chain,
    generatedAt: analytics.generatedAt,
    windowHours: analytics.windowHours,
    fromBlock: analytics.fromBlock,
    toBlock: analytics.toBlock,
    tokenCount: tokens.length,
    tokens
  };
}

export function walletPnlAnalyticsHasIgnoredToken(snapshot: WalletPnlAnalyticsSnapshot): boolean {
  const chain = snapshot.chain;
  return Boolean(
    snapshot.tokens.some((token) => isWalletPnlIgnoredToken(chain, token.tokenAddress, token.tokenSymbol)) ||
    snapshot.pools.some((pool) => isWalletPnlIgnoredToken(chain, pool.tokenAddress, pool.tokenSymbol)) ||
    (snapshot.pnlLeaders ?? []).some((row) => isWalletPnlIgnoredToken(chain, row.tokenAddress, row.tokenSymbol)) ||
    (snapshot.roiLeaders ?? []).some((row) => isWalletPnlIgnoredToken(chain, row.tokenAddress, row.tokenSymbol)) ||
    (snapshot.goodSignalWallets ?? []).some((wallet) =>
      wallet.topTokens.some((token) => isWalletPnlIgnoredToken(chain, token.tokenAddress, token.tokenSymbol))
    ) ||
    snapshot.riskWallets.some((wallet) => wallet.topTokenAddress && isWalletPnlIgnoredToken(chain, wallet.topTokenAddress, wallet.topTokenSymbol)) ||
    (snapshot.volumeWallets ?? []).some((wallet) => wallet.topTokenAddress && isWalletPnlIgnoredToken(chain, wallet.topTokenAddress, wallet.topTokenSymbol))
  );
}

function walletPnlAnalyticsMissingV4HookRisk(snapshot: WalletPnlAnalyticsSnapshot): boolean {
  return Boolean(
    snapshot.tokens.some((token) => token.protocols.includes("v4") && token.untrustedV4HookCount === undefined) ||
    snapshot.pools.some((pool) => pool.protocol === "v4" && pool.untrustedV4Hook === undefined)
  );
}

export function walletPnlAnalyticsHasIneligibleBaseV4Pool(snapshot: WalletPnlAnalyticsSnapshot): boolean {
  if ((snapshot.hookPolicyVersion ?? 0) < WALLET_PNL_HOOK_POLICY_VERSION) return true;
  return snapshot.pools.some((pool) =>
    pool.dex === "uniswap" &&
    pool.protocol === "v4" &&
    (!pool.v4Hook || pool.untrustedV4Hook === true)
  ) || snapshot.tokens.some((token) =>
    token.protocols.includes("v4") &&
    (token.untrustedV4HookCount ?? 0) > 0
  );
}

function walletPnlAnalyticsMissingGoodSignal(snapshot: WalletPnlAnalyticsSnapshot): boolean {
  return !Array.isArray(snapshot.goodSignalWallets) ||
    snapshot.goodSignalWallets.some((wallet) =>
      wallet.trustedV4HookTradeCount === undefined ||
      !Array.isArray(wallet.tokenAddresses)
    );
}

export function walletPnlAnalyticsMissingTokenCreators(snapshot: WalletPnlAnalyticsSnapshot): boolean {
  return walletPnlTokenSummariesMissingCreators(snapshot.tokens);
}

function walletPnlTokenSummariesMissingCreators(tokens: WalletPnlAnalyticsTokenSummary[]): boolean {
  return tokens.some((token) => token.creatorLookupStatus === undefined || token.createdThroughDeniedFactory === undefined);
}

function shouldRebuildWalletPnlSnapshot(
  snapshot: WalletPnlSnapshot | undefined,
  options: {
    retentionFromBlock: number;
    positionFromBlock: number;
    toBlock: number;
    windowHours: number;
    positionWindowHours: number;
    retentionDays: number;
    partial: boolean;
    intervalMs: number;
    now: number;
  }
): boolean {
  if (!snapshot) return true;
  if ((snapshot.hookPolicyVersion ?? 0) < WALLET_PNL_HOOK_POLICY_VERSION) return true;
  if (snapshot.positionWindowHours !== options.positionWindowHours) return true;
  if (snapshot.windowHours !== options.windowHours || snapshot.retentionDays !== options.retentionDays) return true;
  if ((snapshot.positionFromBlock ?? snapshot.retentionFromBlock) > options.positionFromBlock) return true;
  if (snapshot.retentionFromBlock > options.retentionFromBlock) return true;
  if (snapshot.toBlock > options.toBlock) return false;
  if (snapshot.partial && !options.partial) return true;
  const generatedAt = Date.parse(snapshot.generatedAt);
  if (!Number.isFinite(generatedAt)) return true;
  return options.now - generatedAt >= options.intervalMs;
}

function walletPnlFlatAnalyticsStore(store: Storage): WalletPnlFlatAnalyticsStore {
  return store as Storage & WalletPnlFlatAnalyticsStore;
}

function walletPnlCreateProfile(enabled: boolean): { stages: WalletPnlProfileStage[]; sink?: WalletPnlProfileSink } {
  const stages: WalletPnlProfileStage[] = [];
  return {
    stages,
    sink: enabled ? (stage) => stages.push(stage) : undefined
  };
}

function walletPnlProfileLogField(profile: { stages: WalletPnlProfileStage[] }): { profile?: WalletPnlProfileStage[] } {
  return profile.stages.length > 0 ? { profile: profile.stages } : {};
}

function walletPnlAgeMs(generatedAt?: string): number | undefined {
  if (!generatedAt) return undefined;
  const ms = Date.parse(generatedAt);
  if (!Number.isFinite(ms)) return undefined;
  return Math.max(0, Date.now() - ms);
}

function walletPnlPoolManagerSource(chain: ChainSlug) {
  return trackedPoolSources(chain).find((source) => source.kind === "poolManager");
}

function walletPnlActiveV4SwapFilters(chain: ChainSlug, poolManagerAddress: string): BlockscoutLogFilter[] {
  const filters: BlockscoutLogFilter[] = [
    { address: poolManagerAddress.toLowerCase(), topic0: SWAP_TOPIC }
  ];
  if (chain === "base") {
    for (const hookAddress of BASE_FLAUNCH_HOOKS) {
      filters.push({ address: hookAddress.toLowerCase(), topic0: FLAUNCH_HOOK_SWAP_TOPIC });
    }
  }
  return filters;
}

function walletPnlUnknownV4PoolIds(logs: Log[], isKnown: (poolId: string) => boolean, limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const log of logs) {
    const topic0 = log.topics[0]?.toLowerCase();
    if (topic0 !== SWAP_TOPIC.toLowerCase() && topic0 !== FLAUNCH_HOOK_SWAP_TOPIC.toLowerCase()) continue;
    const poolId = log.topics[1]?.toLowerCase();
    if (!poolId || seen.has(poolId) || isKnown(poolId)) continue;
    seen.add(poolId);
    out.push(poolId);
    if (out.length >= limit) break;
  }
  return out;
}

function walletPnlTokenPoolDiscoveryFilters(chain: ChainSlug, tokenAddress: string): BlockscoutLogFilter[] {
  const tokenTopic = addressToTopic(tokenAddress).toLowerCase();
  const filters: BlockscoutLogFilter[] = [];
  for (const source of trackedPoolSources(chain)) {
    if (source.kind === "poolManager") {
      filters.push(
        { address: source.address.toLowerCase(), topic0: source.topic, topic2: tokenTopic },
        { address: source.address.toLowerCase(), topic0: source.topic, topic3: tokenTopic }
      );
      continue;
    }
    filters.push(
      { address: source.address.toLowerCase(), topic0: source.topic, topic1: tokenTopic },
      { address: source.address.toLowerCase(), topic0: source.topic, topic2: tokenTopic }
    );
  }
  return filters;
}

function walletPnlPoolsFromDiscoveryLogs(chain: ChainSlug, tokenAddress: string, logs: Log[]): PoolKey[] {
  const sources = trackedPoolSources(chain);
  const pools: PoolKey[] = [];
  for (const log of logs) {
    const topic0 = log.topics[0]?.toLowerCase();
    const source = sources.find((candidate) => {
      if (!topic0 || candidate.topic.toLowerCase() !== topic0) return false;
      return isSameAddress(candidate.address, log.address);
    });
    if (!source) continue;
    const pool = parseTrackedPoolDiscoveryLog(source, log, chain);
    if (!pool || !walletPnlPoolContainsToken(pool, tokenAddress)) continue;
    pools.push(pool);
  }
  return uniquePools(pools)
    .sort((a, b) => (b.createdBlock ?? 0) - (a.createdBlock ?? 0) || a.id.localeCompare(b.id));
}

function walletPnlPoolContainsToken(pool: PoolKey, tokenAddress: string): boolean {
  const tokens = [pool.currency0, pool.currency1, ...(pool.poolTokens ?? [])];
  return tokens.some((token) => typeof token === "string" && token.startsWith("0x") && isSameAddress(token, tokenAddress));
}

function walletPnlTrustedV4HookPoolIds(
  poolRecords: WalletPnlPoolRecord[],
  trustedV4Hooks?: string[]
): Set<string> {
  const out = new Set<string>();
  for (const record of poolRecords) {
    if (!trustedV4Hook(record.pool, trustedV4Hooks)) continue;
    out.add(record.poolId.toLowerCase());
  }
  return out;
}

function walletPnlAnalyticsTradeAllowed(
  chain: ChainSlug,
  trade: WalletPnlTradeRecord,
  poolsById: ReadonlyMap<string, PoolKey>,
  trustedV4Hooks?: readonly string[]
): boolean {
  const pool = poolsById.get(trade.poolId.toLowerCase());
  return walletPnlTradeHookPolicy(chain, trade, pool, trustedV4Hooks).allowed;
}

function buildAnalyticsPnlLeaders(
  trades: WalletPnlTradeRecord[],
  summaryFromBlock?: number,
  trustedV4HookPoolIds?: ReadonlySet<string>
): WalletPnlAnalyticsPnlLeader[] {
  const positions = new Map<string, WalletPosition>();
  const summaries = new Map<string, MutablePnlLeader>();
  for (const trade of trades) {
    if (isWalletPnlIgnoredToken(trade.chain, trade.tokenAddress, trade.tokenSymbol)) continue;
    const valueUsd = finiteOrUndefined(trade.volumeUsd);
    if (valueUsd === undefined || trade.baseAmount <= 0) continue;
    const key = `${trade.wallet.toLowerCase()}:${trade.tokenAddress.toLowerCase()}`;
    const position = positions.get(key) ?? { quantity: 0, costUsd: 0 };
    const inSummaryWindow = summaryFromBlock === undefined || trade.blockNumber >= summaryFromBlock;
    const summary = inSummaryWindow ? pnlLeaderFor(summaries, trade) : undefined;
    if (summary) {
      summary.volumeUsd += valueUsd;
      summary.firstBlock = Math.min(summary.firstBlock, trade.blockNumber);
      summary.lastBlock = Math.max(summary.lastBlock, trade.blockNumber);
      if (trustedV4HookPoolIds?.has(trade.poolId.toLowerCase())) {
        summary.trustedV4HookTradeCount += 1;
      }
    }

    if (trade.side === "buy") {
      if (summary) summary.buyCount += 1;
      position.quantity += trade.baseAmount;
      position.costUsd += valueUsd;
      positions.set(key, position);
      continue;
    }

    if (summary) summary.sellCount += 1;
    if (position.quantity <= 0 || position.costUsd <= 0) continue;
    const soldQuantity = Math.min(position.quantity, trade.baseAmount);
    if (soldQuantity <= 0) continue;
    const soldRatio = soldQuantity / trade.baseAmount;
    const proceedsUsd = valueUsd * soldRatio;
    const costBasisUsd = (position.costUsd / position.quantity) * soldQuantity;
    const pnlUsd = proceedsUsd - costBasisUsd;
    position.quantity -= soldQuantity;
    position.costUsd = Math.max(0, position.costUsd - costBasisUsd);
    positions.set(key, position);

    if (!summary) continue;
    summary.realizedPnlUsd += pnlUsd;
    summary.realizedCostUsd += costBasisUsd;
    summary.realizedProceedsUsd += proceedsUsd;
    if (pnlUsd >= 0) summary.profitableExitCount += 1;
    else summary.losingExitCount += 1;
  }

  return [...summaries.values()]
    .filter((row) => row.sellCount > 0 && row.realizedCostUsd > 0)
    .map((row) => ({
      wallet: row.wallet,
      tokenAddress: row.tokenAddress,
      tokenSymbol: row.tokenSymbol,
      realizedPnlUsd: roundMoney(row.realizedPnlUsd),
      realizedCostUsd: roundMoney(row.realizedCostUsd),
      realizedProceedsUsd: roundMoney(row.realizedProceedsUsd),
      roiPct: row.realizedCostUsd > 0 ? roundPct((row.realizedPnlUsd / row.realizedCostUsd) * 100) : undefined,
      buyCount: row.buyCount,
      sellCount: row.sellCount,
      profitableExitCount: row.profitableExitCount,
      losingExitCount: row.losingExitCount,
      trustedV4HookTradeCount: row.trustedV4HookTradeCount,
      volumeUsd: roundMoney(row.volumeUsd),
      firstBlock: blockOrZero(row.firstBlock),
      lastBlock: row.lastBlock
    }));
}

function pnlLeaderFor(summaries: Map<string, MutablePnlLeader>, trade: WalletPnlTradeRecord): MutablePnlLeader {
  const key = `${trade.wallet.toLowerCase()}:${trade.tokenAddress.toLowerCase()}`;
  let summary = summaries.get(key);
  if (!summary) {
    summary = {
      wallet: trade.wallet.toLowerCase(),
      tokenAddress: trade.tokenAddress.toLowerCase(),
      tokenSymbol: trade.tokenSymbol,
      realizedPnlUsd: 0,
      realizedCostUsd: 0,
      realizedProceedsUsd: 0,
      buyCount: 0,
      sellCount: 0,
      profitableExitCount: 0,
      losingExitCount: 0,
      trustedV4HookTradeCount: 0,
      volumeUsd: 0,
      firstBlock: Number.POSITIVE_INFINITY,
      lastBlock: 0
    };
    summaries.set(key, summary);
  }
  return summary;
}

function analyticsBase(): MutableAnalyticsSummary {
  return {
    tradeCount: 0,
    txs: new Set(),
    wallets: new Set(),
    pools: new Set(),
    buyCount: 0,
    sellCount: 0,
    volumeUsd: 0,
    buyVolumeUsd: 0,
    sellVolumeUsd: 0,
    firstBlock: Number.POSITIVE_INFINITY,
    lastBlock: 0
  };
}

function tokenAnalyticsFor(summaries: Map<string, MutableTokenAnalytics>, trade: WalletPnlTradeRecord): MutableTokenAnalytics {
  const key = trade.tokenAddress.toLowerCase();
  let summary = summaries.get(key);
  if (!summary) {
    summary = {
      ...analyticsBase(),
      tokenAddress: key,
      tokenSymbol: trade.tokenSymbol,
      dexes: new Set(),
      protocols: new Set(),
      walletVolumes: new Map(),
      untrustedV4Hooks: new Set(),
      latestPriceSortKey: 0
    };
    summaries.set(key, summary);
  }
  return summary;
}

function walletAnalyticsFor(summaries: Map<string, MutableWalletAnalytics>, trade: WalletPnlTradeRecord): MutableWalletAnalytics {
  const key = trade.wallet.toLowerCase();
  let summary = summaries.get(key);
  if (!summary) {
    summary = {
      ...analyticsBase(),
      wallet: key,
      tokenVolumes: new Map(),
      poolVolumes: new Map()
    };
    summaries.set(key, summary);
  }
  return summary;
}

function poolAnalyticsFor(summaries: Map<string, MutablePoolAnalytics>, trade: WalletPnlTradeRecord): MutablePoolAnalytics {
  const key = trade.poolId.toLowerCase();
  let summary = summaries.get(key);
  if (!summary) {
    summary = {
      ...analyticsBase(),
      poolId: key,
      poolAddress: trade.poolAddress,
      dex: trade.dex,
      protocol: trade.protocol,
      tokenAddress: trade.tokenAddress.toLowerCase(),
      tokenSymbol: trade.tokenSymbol,
      quoteAddress: trade.quoteAddress.toLowerCase(),
      quoteSymbol: trade.quoteSymbol,
      walletVolumes: new Map()
    };
    summaries.set(key, summary);
  }
  return summary;
}

function applyAnalyticsBase(summary: MutableAnalyticsSummary, trade: WalletPnlTradeRecord, valueUsd: number): void {
  summary.tradeCount += 1;
  summary.txs.add(trade.txHash.toLowerCase());
  summary.wallets.add(trade.wallet.toLowerCase());
  summary.pools.add(trade.poolId.toLowerCase());
  summary.volumeUsd += valueUsd;
  summary.firstBlock = Math.min(summary.firstBlock, trade.blockNumber);
  summary.lastBlock = Math.max(summary.lastBlock, trade.blockNumber);
  if (trade.side === "buy") {
    summary.buyCount += 1;
    summary.buyVolumeUsd += valueUsd;
  } else {
    summary.sellCount += 1;
    summary.sellVolumeUsd += valueUsd;
  }
}

function addMapNumber(map: Map<string, number>, key: string, value: number): void {
  map.set(key, (map.get(key) ?? 0) + value);
}

function topMapEntry(map: Map<string, number>): [string, number] | undefined {
  let top: [string, number] | undefined;
  for (const entry of map.entries()) {
    if (!top || entry[1] > top[1]) top = entry;
  }
  return top;
}

function topTokenVolumeEntry(
  map: Map<string, { address: string; symbol: string; volumeUsd: number }>
): { address: string; symbol: string; volumeUsd: number } | undefined {
  let top: { address: string; symbol: string; volumeUsd: number } | undefined;
  for (const entry of map.values()) {
    if (!top || entry.volumeUsd > top.volumeUsd) top = entry;
  }
  return top;
}

function blockOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function ratio(value: number, denominator: number): number {
  return denominator > 0 ? value / denominator : 0;
}

function percentage(value: number, denominator: number): number {
  return roundPct(ratio(value, denominator) * 100);
}

function symmetryPct(left: number, right: number): number {
  const total = left + right;
  if (total <= 0) return 0;
  return roundPct((1 - Math.abs(left - right) / total) * 100);
}

function pressureScore(value: number, fullScoreAt: number): number {
  if (fullScoreAt <= 0) return 0;
  return clampScore((value / fullScoreAt) * 100);
}

function clampScore(value: number): number {
  return roundPct(Math.max(0, Math.min(100, value)));
}

function roundRatio(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundPrice(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (value >= 1) return Math.round(value * 1_000_000) / 1_000_000;
  return Number(value.toPrecision(6));
}

function finalizeTokenAnalytics(summary: MutableTokenAnalytics): WalletPnlAnalyticsTokenSummary {
  const topWalletVolumeUsd = topMapEntry(summary.walletVolumes)?.[1] ?? 0;
  const walletCount = summary.wallets.size;
  const txCount = summary.txs.size;
  const avgTradesPerWallet = ratio(summary.tradeCount, walletCount);
  const tradesPerTx = ratio(summary.tradeCount, txCount);
  const concentrationPct = percentage(topWalletVolumeUsd, summary.volumeUsd);
  const buySellSymmetryPct = symmetryPct(summary.buyCount, summary.sellCount);
  const untrustedV4HookCount = summary.untrustedV4Hooks.size;
  const lowWalletHighVolumeScore =
    summary.volumeUsd >= 1_000_000 && walletCount <= 150
      ? 90
      : summary.volumeUsd >= 100_000 && walletCount <= 50
        ? 80
        : 0;
  const baseSuspiciousScore = clampScore(
    concentrationPct * 0.26 +
    buySellSymmetryPct * 0.20 +
    pressureScore(avgTradesPerWallet, 40) * 0.17 +
    pressureScore(tradesPerTx, 4) * 0.10 +
    lowWalletHighVolumeScore * 0.10 +
    untrustedV4HookRiskScore(untrustedV4HookCount) * 0.17
  );
  const suspiciousScore = clampScore(Math.max(baseSuspiciousScore, untrustedV4HookRiskScore(untrustedV4HookCount)));

  return {
    tokenAddress: summary.tokenAddress,
    tokenSymbol: summary.tokenSymbol,
    tradeCount: summary.tradeCount,
    txCount,
    walletCount,
    poolCount: summary.pools.size,
    buyCount: summary.buyCount,
    sellCount: summary.sellCount,
    volumeUsd: roundMoney(summary.volumeUsd),
    buyVolumeUsd: roundMoney(summary.buyVolumeUsd),
    sellVolumeUsd: roundMoney(summary.sellVolumeUsd),
    firstBlock: blockOrZero(summary.firstBlock),
    lastBlock: summary.lastBlock,
    latestPriceUsd: roundPrice(summary.latestPriceUsd),
    minPriceUsd: roundPrice(summary.minPriceUsd),
    maxPriceUsd: roundPrice(summary.maxPriceUsd),
    topWalletVolumeUsd: roundMoney(topWalletVolumeUsd),
    topWalletConcentrationPct: concentrationPct,
    avgTradesPerWallet: roundRatio(avgTradesPerWallet),
    tradesPerTx: roundRatio(tradesPerTx),
    buySellSymmetryPct,
    untrustedV4HookCount,
    untrustedV4Hooks: [...summary.untrustedV4Hooks].sort().slice(0, 8),
    suspiciousScore,
    dexes: [...summary.dexes].sort().slice(0, 8),
    protocols: [...summary.protocols].sort().slice(0, 8)
  };
}

function finalizeWalletAnalytics(summary: MutableWalletAnalytics): WalletPnlAnalyticsWalletSummary {
  const topToken = topTokenVolumeEntry(summary.tokenVolumes);
  const topPool = topMapEntry(summary.poolVolumes);
  const tokenCount = summary.tokenVolumes.size;
  const poolCount = summary.pools.size;
  const buySellSymmetryPct = symmetryPct(summary.buyCount, summary.sellCount);
  const avgTradesPerToken = ratio(summary.tradeCount, tokenCount);
  const avgTradeUsd = ratio(summary.volumeUsd, summary.tradeCount);
  const tokenConcentrationPct = percentage(topToken?.volumeUsd ?? 0, summary.volumeUsd);
  const poolConcentrationPct = percentage(topPool?.[1] ?? 0, summary.volumeUsd);
  const suspiciousScore = clampScore(
    tokenConcentrationPct * 0.31 +
    poolConcentrationPct * 0.22 +
    buySellSymmetryPct * 0.19 +
    pressureScore(avgTradesPerToken, 200) * 0.16 +
    pressureScore(summary.volumeUsd, 1_000_000) * 0.12
  );

  return {
    wallet: summary.wallet,
    tradeCount: summary.tradeCount,
    txCount: summary.txs.size,
    tokenCount,
    poolCount,
    buyCount: summary.buyCount,
    sellCount: summary.sellCount,
    volumeUsd: roundMoney(summary.volumeUsd),
    firstBlock: blockOrZero(summary.firstBlock),
    lastBlock: summary.lastBlock,
    topTokenAddress: topToken?.address,
    topTokenSymbol: topToken?.symbol,
    topTokenVolumeUsd: roundMoney(topToken?.volumeUsd ?? 0),
    tokenConcentrationPct,
    topPoolId: topPool?.[0],
    topPoolVolumeUsd: roundMoney(topPool?.[1] ?? 0),
    poolConcentrationPct,
    buySellSymmetryPct,
    avgTradesPerToken: roundRatio(avgTradesPerToken),
    avgTradeUsd: roundMoney(avgTradeUsd),
    suspiciousScore
  };
}

function finalizePoolAnalytics(summary: MutablePoolAnalytics): WalletPnlAnalyticsPoolSummary {
  const topWalletVolumeUsd = topMapEntry(summary.walletVolumes)?.[1] ?? 0;
  const walletCount = summary.wallets.size;
  const buySellSymmetryPct = symmetryPct(summary.buyCount, summary.sellCount);
  const topWalletConcentrationPct = percentage(topWalletVolumeUsd, summary.volumeUsd);
  const hookRiskScore = untrustedV4HookRiskScore(summary.untrustedV4Hook ? 1 : 0);
  const baseSuspiciousScore = clampScore(
    topWalletConcentrationPct * 0.28 +
    buySellSymmetryPct * 0.20 +
    pressureScore(ratio(summary.tradeCount, walletCount), 45) * 0.20 +
    pressureScore(ratio(summary.tradeCount, summary.txs.size), 4) * 0.14 +
    hookRiskScore * 0.18
  );
  const suspiciousScore = clampScore(Math.max(baseSuspiciousScore, hookRiskScore));

  return {
    poolId: summary.poolId,
    poolAddress: summary.poolAddress,
    dex: summary.dex,
    protocol: summary.protocol,
    tokenAddress: summary.tokenAddress,
    tokenSymbol: summary.tokenSymbol,
    quoteAddress: summary.quoteAddress,
    quoteSymbol: summary.quoteSymbol,
    tradeCount: summary.tradeCount,
    txCount: summary.txs.size,
    walletCount,
    buyCount: summary.buyCount,
    sellCount: summary.sellCount,
    volumeUsd: roundMoney(summary.volumeUsd),
    firstBlock: blockOrZero(summary.firstBlock),
    lastBlock: summary.lastBlock,
    topWalletVolumeUsd: roundMoney(topWalletVolumeUsd),
    topWalletConcentrationPct,
    buySellSymmetryPct,
    v4Hook: summary.v4Hook,
    untrustedV4Hook: Boolean(summary.untrustedV4Hook),
    suspiciousScore
  };
}

function buildWalletPnlSnapshot(options: {
  chain: ChainSlug;
  trades: WalletPnlTradeRecord[];
  toBlock: number;
  windowBlocks: number;
  retentionBlocks: number;
  positionBlocks: number;
  windowHours: number;
  positionWindowHours: number;
  retentionDays: number;
  snapshotLimit: number;
  minProfitUsd: number;
  partial: boolean;
}): WalletPnlSnapshot {
  const windowFromBlock = Math.max(0, options.toBlock - options.windowBlocks + 1);
  const retentionFromBlock = Math.max(0, options.toBlock - options.retentionBlocks + 1);
  const positionFromBlock = Math.max(retentionFromBlock, options.toBlock - options.positionBlocks + 1);
  const positions = new Map<string, WalletPosition>();
  const summaries = new Map<string, MutableWalletSummary>();
  const orderedTrades = options.trades
    .filter((trade) => trade.blockNumber >= retentionFromBlock && trade.blockNumber <= options.toBlock)
    .filter((trade) => trade.blockNumber >= positionFromBlock)
    .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

  for (const trade of orderedTrades) {
    if (isWalletPnlIgnoredToken(options.chain, trade.tokenAddress, trade.tokenSymbol)) continue;
    const valueUsd = finiteOrUndefined(trade.volumeUsd);
    if (valueUsd === undefined || trade.baseAmount <= 0) continue;
    const positionKey = `${trade.wallet}:${trade.tokenAddress}`;
    const position = positions.get(positionKey) ?? { quantity: 0, costUsd: 0 };
    const inWindow = trade.blockNumber >= windowFromBlock;
    const summary = inWindow ? summaryFor(summaries, trade.wallet) : undefined;
    if (summary) {
      summary.volumeUsd += valueUsd;
      summary.tradedTokens.add(trade.tokenSymbol);
      summary.tradedTokenRefs.set(trade.tokenAddress.toLowerCase(), {
        symbol: trade.tokenSymbol,
        address: trade.tokenAddress.toLowerCase()
      });
      if (trade.blockNumber >= summary.lastBlock) {
        summary.lastBlock = trade.blockNumber;
        summary.lastTxHash = trade.txHash;
      }
    }

    if (trade.side === "buy") {
      position.quantity += trade.baseAmount;
      position.costUsd += valueUsd;
      positions.set(positionKey, position);
      if (summary) summary.buyCount += 1;
      continue;
    }

    if (summary) summary.sellCount += 1;
    if (position.quantity <= 0 || position.costUsd <= 0) continue;
    const soldQuantity = Math.min(position.quantity, trade.baseAmount);
    if (soldQuantity <= 0) continue;
    const soldRatio = soldQuantity / trade.baseAmount;
    const proceedsUsd = valueUsd * soldRatio;
    const costBasisUsd = (position.costUsd / position.quantity) * soldQuantity;
    const pnlUsd = proceedsUsd - costBasisUsd;
    position.quantity -= soldQuantity;
    position.costUsd = Math.max(0, position.costUsd - costBasisUsd);
    positions.set(positionKey, position);

    if (!summary) continue;
    summary.realizedPnlUsd += pnlUsd;
    summary.realizedCostUsd += costBasisUsd;
    summary.realizedProceedsUsd += proceedsUsd;
    if (pnlUsd >= 0) {
      summary.profitableExitCount += 1;
    } else {
      summary.losingExitCount += 1;
    }
  }

  const top = [...summaries.values()]
    .filter((item) => item.realizedPnlUsd > options.minProfitUsd && item.realizedCostUsd > 0)
    .map((item): WalletPnlWalletSummary => ({
      wallet: item.wallet,
      realizedPnlUsd: roundMoney(item.realizedPnlUsd),
      realizedCostUsd: roundMoney(item.realizedCostUsd),
      realizedProceedsUsd: roundMoney(item.realizedProceedsUsd),
      roiPct: item.realizedCostUsd > 0 ? roundPct((item.realizedPnlUsd / item.realizedCostUsd) * 100) : undefined,
      buyCount: item.buyCount,
      sellCount: item.sellCount,
      profitableExitCount: item.profitableExitCount,
      losingExitCount: item.losingExitCount,
      tradedTokens: [...item.tradedTokens].sort().slice(0, 12),
      tradedTokenRefs: [...item.tradedTokenRefs.values()]
        .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.address.localeCompare(b.address))
        .slice(0, 12),
      volumeUsd: roundMoney(item.volumeUsd),
      lastBlock: item.lastBlock,
      lastTxHash: item.lastTxHash
    }))
    .sort((a, b) => b.realizedPnlUsd - a.realizedPnlUsd || (b.roiPct ?? 0) - (a.roiPct ?? 0))
    .slice(0, options.snapshotLimit);

  return {
    schemaVersion: 1,
    hookPolicyVersion: WALLET_PNL_HOOK_POLICY_VERSION,
    chain: options.chain,
    generatedAt: new Date().toISOString(),
    windowHours: options.windowHours,
    positionWindowHours: options.positionWindowHours,
    retentionDays: options.retentionDays,
    windowFromBlock,
    positionFromBlock,
    retentionFromBlock,
    toBlock: options.toBlock,
    tradeCount: orderedTrades.filter((trade) => trade.blockNumber >= windowFromBlock).length,
    walletCount: summaries.size,
    top,
    partial: options.partial
  };
}

function summaryFor(summaries: Map<string, MutableWalletSummary>, wallet: string): MutableWalletSummary {
  let summary = summaries.get(wallet);
  if (!summary) {
    summary = {
      wallet,
      realizedPnlUsd: 0,
      realizedCostUsd: 0,
      realizedProceedsUsd: 0,
      buyCount: 0,
      sellCount: 0,
      profitableExitCount: 0,
      losingExitCount: 0,
      tradedTokens: new Set(),
      tradedTokenRefs: new Map(),
      volumeUsd: 0,
      lastBlock: 0,
      lastTxHash: ""
    };
    summaries.set(wallet, summary);
  }
  return summary;
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

function uniqueTxSenderRequests(parsedTrades: ParsedWalletTradeInput[]): TxSenderRequest[] {
  const byHash = new Map<string, TxSenderRequest>();
  for (const item of parsedTrades) {
    const txHash = item.trade.txHash.toLowerCase();
    if (!byHash.has(txHash)) byHash.set(txHash, { txHash, blockNumber: item.trade.blockNumber });
  }
  return [...byHash.values()];
}

function uniqueBlockCount(txRequests: TxSenderRequest[]): number {
  return new Set(txRequests.map((request) => request.blockNumber)).size;
}

function toRpcQuantity(value: number): string {
  return `0x${Math.max(0, Math.floor(value)).toString(16)}`;
}

async function withTimeout<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function tokenAddress(token: TokenMetadata): string {
  return String(token.address).toLowerCase();
}

function isWalletPnlPool(pool: PoolKey): boolean {
  return !EXCLUDED_WALLET_PNL_PROTOCOLS.has(poolProtocol(pool));
}

function filterWalletPnlPoolsByPolicy(
  chain: ChainSlug,
  pools: PoolKey[],
  source: WalletPnlPoolRecord["source"],
  trustedV4Hooks?: readonly string[]
): WalletPnlPoolPolicyFilter {
  const rejectedHooks = new Set<string>();
  const out: WalletPnlPoolPolicyFilter = {
    pools: [],
    total: pools.length,
    rejected: 0,
    rejectedExcludedProtocol: 0,
    rejectedBaseV4NoHook: 0,
    rejectedBaseV4UntrustedHook: 0,
    rejectedFactoryV4UntrustedHook: 0,
    rejectedHooks: []
  };
  for (const pool of pools) {
    const decision = walletPnlBaseV4HookPolicy(chain, pool, trustedV4Hooks);
    if (!isWalletPnlPool(pool)) {
      out.rejected += 1;
      out.rejectedExcludedProtocol += 1;
      continue;
    }
    if (!decision.allowed) {
      out.rejected += 1;
      if (decision.reason === "missing-base-v4-hook") out.rejectedBaseV4NoHook += 1;
      if (decision.reason === "untrusted-base-v4-hook") out.rejectedBaseV4UntrustedHook += 1;
      if (decision.hook) rejectedHooks.add(decision.hook);
      continue;
    }
    if (source === "factory" && isUniswapV4Pool(pool) && !trustedV4Hook(pool, trustedV4Hooks)) {
      out.rejected += 1;
      out.rejectedFactoryV4UntrustedHook += 1;
      const hook = poolV4Hook(pool);
      if (hook) rejectedHooks.add(hook);
      continue;
    }
    out.pools.push(pool);
  }
  out.rejectedHooks = [...rejectedHooks].sort().slice(0, 8);
  return out;
}

function shouldUseWalletPnlPool(
  chain: ChainSlug,
  pool: PoolKey,
  source: WalletPnlPoolRecord["source"],
  trustedV4Hooks?: readonly string[]
): boolean {
  if (!isWalletPnlPool(pool)) return false;
  if (!walletPnlBaseV4HookPolicy(chain, pool, trustedV4Hooks).allowed) return false;
  if (source !== "factory") return true;
  if (!isUniswapV4Pool(pool)) return true;
  return Boolean(trustedV4Hook(pool, trustedV4Hooks));
}

function tokenSymbol(token: TokenMetadata): string {
  return token.symbol || shortAddress(String(token.address));
}

function finiteOrUndefined(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

function finiteOrZero(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundPct(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatUsd(value: number): string {
  return `$${Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function formatPct(value: number): string {
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}
