import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAddress, parseUnits, verifyMessage } from "ethers";
import type { Logger } from "pino";
import type { Env } from "../config/env";
import type { RpcPool } from "../services/rpcPool";
import type { PriceService } from "../services/price";
import type { R2SnapshotStore } from "../services/r2Snapshots";
import type { BlockscoutClient, BlockscoutTokenTransferRecord } from "../services/blockscout";
import {
  ContractCreatorLookupError,
  contractCreatorPublicError,
  lookupContractCreator,
  type ContractCreatorResult
} from "../services/contractCreator";
import { buildCopyShadowSnapshotFromConfig, copyShadowConfigFromEnv } from "../services/copyShadow";
import {
  buildWalletPnlAnalyticsSnapshot,
  WALLET_PNL_HOOK_POLICY_VERSION,
  walletPnlAnalyticsHasIneligibleBaseV4Pool,
  walletPnlAnalyticsHasIgnoredToken,
  walletPnlAnalyticsMissingTokenCreators,
  type WalletPnlIndexer
} from "../services/walletPnl";
import { enrichWalletPnlAnalyticsTokenCreators, enrichWalletPnlTokenSummaries } from "../services/walletPnlCreatorDenylist";
import { isWalletPnlIgnoredToken } from "../services/walletPnlFilters";
import { walletPnlBaseV4HookPolicy } from "../services/walletPnlHookPolicy";
import type {
  CopyShadowConfig,
  Storage,
  WalletPnlAnalyticsSnapshot,
  WalletPnlAnalyticsTokenSummary,
  WalletPnlClusterRecord,
  WalletPnlHistoricalTokenBuys,
  WalletPnlNewTokensSnapshot,
  WalletPnlProfileSink,
  WalletPnlProfileStage,
  WalletPnlTradeRecord
} from "../store/storage";
import type { ChainSlug, PoolKey } from "../types";
import { chainLabel, getChain, isChainSlug } from "../chains/registry";
import { fetchSwapLogs } from "../dex/swapLogs";
import type { SolanaRpcClient } from "../solana/activity";
import { getNewPairs, getTrendingMarketByPoolId, getTrendingMarkets } from "./markets";
import { blockSecondsFor } from "./markets/config";
import { isMarketBoardChain } from "./marketChains";
import {
  chartPage,
  copyShadowAdminLoginPage,
  copyShadowAdminPage,
  intelHomePage,
  landingPage,
  walletPnlAdminGatePage,
  walletPnlAdminPage,
  walletPnlCohortPage,
  walletPnlLeaderboardsPage,
  walletPnlNewTokensPage,
  walletPnlOverlapPage,
  walletPnlPoolDetailPage,
  walletPnlPoolsPage,
  walletPnlPersistableClustersFromAnalytics,
  walletPnlPersistableClustersFromTokenTrades,
  walletPnlRiskTokensPage,
  walletPnlRiskWalletsPage,
  walletPnlSignalsPage,
  walletPnlStatusPage,
  walletPnlTokenDetailPage,
  walletPnlTokenWalletsPage,
  walletPnlTokensPage,
  walletPnlWalletDetailPage
} from "./pages";
import type { LeaderboardKind, TokenWalletSort } from "./pages";
import type { WalletPnlSort, WalletPnlSortDir, WalletPnlSortKey } from "./pages/walletPnlAdmin";
import { publicChains } from "./publicChains";
import { generateRobotsTxt, generateSitemapXml, siteOriginFromEnv } from "./sitemap";

const CONTRACT_CREATOR_BATCH_LIMIT = 5;
const ADMIN_SESSION_COOKIE = "baes_wallet_admin";
const WALLET_PNL_GATE_CHALLENGE_COOKIE = "baes_wallet_gate_challenge";
const WALLET_PNL_GATE_SESSION_COOKIE = "baes_wallet_gate";
const WALLET_PNL_GATE_CHALLENGE_TTL_MS = 5 * 60_000;
const ADMIN_FORM_LIMIT_BYTES = 4096;
const WALLET_PNL_HISTORICAL_LOOKBACK_DAYS = 30;
const WALLET_PNL_HISTORICAL_CACHE_TTL_MS = 24 * 60 * 60_000;
const WALLET_PNL_HISTORICAL_PENDING_TTL_MS = 10 * 60_000;
const WALLET_PNL_HISTORICAL_TRANSFERS_PER_WALLET = 200;
const WALLET_PNL_HISTORICAL_DEFAULT_OVERLAP_WALLET_LIMIT = 250;
const WALLET_PNL_HISTORICAL_PRECOMPUTE_START_DELAY_MS = 20_000;
const WALLET_PNL_CLUSTER_HIGH_ROI_PCT = 200;
const WALLET_PNL_CLUSTER_HIGH_ROI_MIN_COST_USD = 25;
const WALLET_PNL_CLUSTER_HIGH_ROI_MIN_PROCEEDS_USD = 50;
const WALLET_PNL_CLUSTER_HIGH_ROI_ENTRY_WINDOW_MS = 5 * 60_000;
const WALLET_PNL_CLUSTER_HIGH_ROI_ENTRY_MIN_WALLETS = 2;
const WALLET_PNL_ANALYTICS_CREATOR_LOOKUP_DEADLINE_MS = 2 * 60_000;
const WALLET_PNL_NEW_TOKENS_CREATOR_LOOKUP_DEADLINE_MS = 45_000;
const ERC20_GATE_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

interface WalletPnlNewTokenStore {
  getWalletPnlNewTokenSummaries?: (options: {
    chain: ChainSlug;
    fromBlock: number;
    toBlock: number;
    trustedV4Hooks?: string[];
    limit: number;
  }) => WalletPnlAnalyticsTokenSummary[] | undefined;
}

type TelegramWebhookHandler = (
  req: http.IncomingMessage & { body?: any },
  res: http.ServerResponse,
  next?: () => void
) => Promise<void>;

interface WebDeps {
  env: Env;
  store: Storage;
  rpcs: Map<ChainSlug, RpcPool>;
  solanaClient?: SolanaRpcClient;
  priceService: PriceService;
  snapshotStore?: R2SnapshotStore;
  blockscoutClient?: BlockscoutClient;
  walletPnlIndexer?: Pick<WalletPnlIndexer, "scheduleTokenBootstrap">;
  logger: Logger;
  telegramWebhookPath?: string;
  telegramWebhook?: TelegramWebhookHandler;
}

interface WalletPnlFlatAnalyticsStore {
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
}

// Lazily filled at boot to avoid sync disk I/O per request.
let stylesheetBundle: Buffer | undefined;
let stylesheetBundleMissing = false;
let sitemapBundle: Buffer | undefined;

// HTML responses are deterministic per (env, store snapshot view); cache them briefly
// so every hit doesn't re-concatenate the embedded client JS.
const HTML_CACHE_TTL_MS = 30_000;
const htmlCache = new Map<string, { expiresAt: number; body: string }>();
const SITEMAP_CACHE_TTL_MS = 5 * 60_000;
let generatedSitemapCache: { expiresAt: number; intelEnabled: boolean; body: Buffer } | undefined;
const walletPnlHistoricalBackfills = new Set<string>();
const walletPnlHistoricalPrecomputes = new Set<string>();
const walletPnlAnalyticsMaterializations = new Set<string>();

export function startWebServer(deps: WebDeps): { stop: () => Promise<void> } {
  preloadStylesheetBundle(deps);
  preloadGeneratedSeoFiles(deps);
  if (deps.env.intelEnabled) {
    walletPnlScheduleAnalyticsMaterialization(deps, deps.env.walletPnlChain, { reason: "startup", delayMs: 5_000 });
  }
  const historicalPrecomputeTimers = deps.env.intelEnabled ? startWalletPnlHistoricalPrecomputeHeartbeat(deps) : [];
  const healthInterval = startRpcHealthHeartbeat(deps);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (deps.telegramWebhook && deps.telegramWebhookPath && url.pathname === deps.telegramWebhookPath) {
      void deps.telegramWebhook(req, res).catch((error) => {
        deps.logger.error({ err: serializeError(error), path: url.pathname }, "telegram webhook request failed");
        json(res, 500, { error: "telegram webhook failed" });
      });
      return;
    }
    void handleRequest(deps, req, res).catch((error) => {
      const status = httpStatusForError(error);
      deps.logger.error({ err: serializeError(error), method: req.method, path: url.pathname, status }, "web request failed");
      json(res, status, {
        error: (error as Error).message ?? "internal error",
        code: errorCode(error)
      });
    });
  });
  server.listen(deps.env.webPort, () => {
    deps.logger.info({ port: deps.env.webPort }, "web preview server started");
    void prewarmTrending(deps);
  });
  return {
    stop: () =>
      new Promise((resolve) => {
        if (healthInterval) clearInterval(healthInterval);
        for (const timer of historicalPrecomputeTimers) clearInterval(timer);
        server.close(() => resolve());
      })
  };
}

async function prewarmTrending(deps: WebDeps): Promise<void> {
  if (process.env.PREWARM_DISABLED === "1") return;
  if (!deps.env.marketsEnabled) {
    deps.logger.debug("markets disabled; skipping startup market prewarm");
    return;
  }
  if (deps.env.marketArchiveEnabled) {
    deps.logger.debug({ chains: deps.env.marketArchiveChains }, "r2 archive: skipping startup prewarm; archive producer owns public snapshots");
    return;
  }
  const chains: ChainSlug[] = [];
  for (const slug of deps.env.enabledChains) {
    if (!isMarketBoardChain(slug)) continue;
    if (!deps.rpcs.has(slug)) continue;
    chains.push(slug);
  }
  if (!chains.length) return;
  deps.logger.info({ chains }, "rpc: prewarming trending cache at startup");
  await Promise.allSettled(
    chains.map((chain) =>
      getTrendingMarkets(
        { env: deps.env, rpcs: deps.rpcs, priceService: deps.priceService, snapshotStore: deps.snapshotStore, logger: deps.logger },
        chain
      ).then(
        (payload) => deps.logger.info({ chain, markets: payload.markets.length }, "rpc: prewarm complete"),
        (error) => deps.logger.warn({ chain, err: serializeError(error) }, "rpc: prewarm failed (cache stays cold; first visitor will trigger scan)")
      )
    )
  );
}

function startRpcHealthHeartbeat(deps: WebDeps): NodeJS.Timeout | undefined {
  const raw = process.env.RPC_HEALTH_LOG_MS;
  const parsed = raw && raw.trim() !== "" ? Number(raw) : 60_000;
  const intervalMs = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 60_000;
  if (intervalMs === 0) return undefined; // explicit opt-out
  const timer = setInterval(() => {
    for (const [chain, rpc] of deps.rpcs.entries()) {
      const health = rpc.healthSnapshot();
      deps.logger.info(
        {
          chain,
          activeIndex: health.activeIndex,
          providers: health.providers.map((p) => ({
            url: p.label,
            active: p.active,
            attempts: p.attempts,
            failures: p.failures,
            failurePct: Number(p.failurePct.toFixed(1)),
            cooldownUntil: p.cooldownUntil,
            logBlockLimit: p.logBlockLimit,
            lastError: p.lastError
          })),
          recommendations: health.recommendations
        },
        "rpc: health heartbeat"
      );
    }
  }, intervalMs);
  // Don't keep the event loop alive just for logging.
  timer.unref?.();
  return timer;
}

async function handleRequest(deps: WebDeps, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.pathname === "/health") return json(res, 200, { ok: true, chains: deps.env.enabledChains });
  if (url.pathname === "/sitemap.xml") return handleSitemap(res, deps.env.intelEnabled);
  if (url.pathname === "/robots.txt") return handleRobots(res, deps.env.intelEnabled);
  if (!deps.env.intelEnabled && isIntelRoute(url.pathname)) return notFound(res);
  if (url.pathname === "/api/chains") return json(res, 200, publicChains(deps));
  if (parts[0] === "api" && (parts[1] === "contract-creator" || parts[1] === "contract-creation") && isChainSlug(parts[2])) {
    return handleContractCreator(deps, url, res, parts[2], parts[3]);
  }
  if (parts[0] === "api" && (parts[1] === "trending" || parts[1] === "markets") && isMarketBoardChain(parts[2])) {
    if (!deps.env.marketsEnabled) return marketDisabledJson(res);
    return handleTrending(deps, res, parts[2]);
  }
  if (parts[0] === "api" && (parts[1] === "new-pairs" || parts[1] === "pairs") && isMarketBoardChain(parts[2])) {
    if (!deps.env.marketsEnabled) return marketDisabledJson(res);
    return handleNewPairs(deps, res, parts[2]);
  }
  if (parts[0] === "api" && parts[1] === "market" && isMarketBoardChain(parts[2])) {
    if (!deps.env.marketsEnabled) return marketDisabledJson(res);
    return handleMarket(deps, url, res, parts[2]);
  }
  if (parts[0] === "admin" && parts[1] === "wallet-pnl") {
    return redirect(res, walletPnlLegacyRedirectPath(url));
  }
  if (url.pathname === "/intel" || url.pathname === "/intel/") {
    return handleIntelHome(deps, req, url, res);
  }
  if (url.pathname === "/intel/wallet-pnl" || url.pathname === "/intel/wallet-pnl/") {
    return handleWalletPnlAdmin(deps, req, url, res);
  }
  if (parts[0] === "intel" && parts[1] === "wallet-pnl" && parts.length > 2) {
    return handleWalletPnlAnalytics(deps, req, url, res, parts.slice(2));
  }
  if (url.pathname === "/admin/copy-shadow" || url.pathname === "/admin/copy-shadow/") {
    return handleCopyShadowAdmin(deps, req, url, res);
  }
  if (url.pathname === "/styles.css") return handleStylesheet(res);
  if (url.pathname.startsWith("/og/")) return handleWebAsset(url.pathname, res);
  if (url.pathname.startsWith("/api/raw/")) return handleRaw(deps, url, res);
  if (url.pathname.startsWith("/api/solana/")) return solanaNotSupportedJson(res);
  if (url.pathname.startsWith("/chart/")) {
    if (!deps.env.marketsEnabled) return marketDisabledHtml(res);
    return html(res, chartPage(url, deps.env.publicMarketApiBase));
  }
  return html(res, cachedHtml("landing", () => landingPage(deps)));
}

function isIntelRoute(pathname: string): boolean {
  const normalized = pathname.replace(/\/+$/g, "") || "/";
  return normalized === "/intel"
    || normalized.startsWith("/intel/")
    || normalized === "/admin/wallet-pnl"
    || normalized.startsWith("/admin/wallet-pnl/")
    || normalized === "/admin/copy-shadow"
    || normalized.startsWith("/admin/copy-shadow/");
}

interface WalletPnlGateConfig {
  chain: ChainSlug;
  tokenAddress: string;
  minBalance: string;
  sessionHours: number;
}

interface WalletPnlGateChallenge {
  address: string;
  chain: ChainSlug;
  tokenAddress: string;
  message: string;
  expiresAt: string;
}

interface WalletPnlGateSession {
  address: string;
  chain: ChainSlug;
  tokenAddress: string;
  minBalance: string;
  expiresAt: string;
}

async function handleTrending(deps: WebDeps, res: http.ServerResponse, chain: ChainSlug): Promise<void> {
  const t0 = Date.now();
  deps.logger.info({ chain, route: "trending" }, "web: trending request");
  const payload = await getTrendingMarkets({
    env: deps.env,
    rpcs: deps.rpcs,
    priceService: deps.priceService,
    snapshotStore: deps.snapshotStore,
    logger: deps.logger
  }, chain);
  deps.logger.info(
    { chain, route: "trending", markets: payload.markets.length, fromBlock: payload.fromBlock, toBlock: payload.toBlock, durationMs: Date.now() - t0 },
    "web: trending response"
  );
  publishSnapshot(deps, "trending", async () => {
    const store = deps.snapshotStore!;
    const writes = await store.publishTrending(payload);
    // Also archive immutable per-market history snapshots so retention/manifests aren't
    // dependent on the manual backfill script. Identical payloads no-op via the lastPublished guard.
    if (deps.env.marketSnapshotsEnabled && deps.env.marketHistoryRetentionDays > 0) {
      const generatedAt = new Date(payload.generatedAt);
      await Promise.all(
        payload.markets.map((market) =>
          store.publishMarketHistory(market, generatedAt, deps.env.marketHistoryRetentionDays).catch((error) => {
            deps.logger.warn(
              { chain, poolId: market.poolId, error: (error as Error).message },
              "publishMarketHistory failed"
            );
            return undefined;
          })
        )
      );
    }
    return writes;
  });
  return json(res, 200, payload, Math.max(5, Math.floor(payload.cacheMs / 1000)));
}

async function handleNewPairs(deps: WebDeps, res: http.ServerResponse, chain: ChainSlug): Promise<void> {
  const t0 = Date.now();
  deps.logger.info({ chain, route: "new-pairs" }, "web: new-pairs request");
  const payload = await getNewPairs({
    env: deps.env,
    rpcs: deps.rpcs,
    priceService: deps.priceService,
    snapshotStore: deps.snapshotStore,
    logger: deps.logger
  }, chain);
  deps.logger.info(
    { chain, route: "new-pairs", pairs: payload.pairs.length, fromBlock: payload.fromBlock, toBlock: payload.toBlock, durationMs: Date.now() - t0 },
    "web: new-pairs response"
  );
  publishSnapshot(deps, "new-pairs", () => deps.snapshotStore!.publishNewPairs(payload));
  return json(res, 200, payload, Math.max(5, Math.floor(payload.cacheMs / 1000)));
}

async function handleMarket(deps: WebDeps, url: URL, res: http.ServerResponse, chain: ChainSlug): Promise<void> {
  const poolId = decodeURIComponent(url.pathname.split("/").slice(4).join("/"));
  const t0 = Date.now();
  deps.logger.info({ chain, route: "market", poolId }, "web: market detail request");
  const market = await getTrendingMarketByPoolId(
    {
      env: deps.env,
      rpcs: deps.rpcs,
      priceService: deps.priceService,
      snapshotStore: deps.snapshotStore,
      logger: deps.logger
    },
    poolId,
    chain
  );
  deps.logger.info(
    { chain, route: "market", poolId, found: Boolean(market), durationMs: Date.now() - t0 },
    "web: market detail response"
  );
  if (!market) return json(res, 404, { error: `market is not active in the current ${chainLabel(chain)} trending window`, chain, poolId });
  if (market.source !== "r2-archive") {
    publishSnapshot(deps, "market", () => deps.snapshotStore!.publishMarket(market));
  }
  return json(res, 200, { chain, source: market.source ?? "raw-rpc", market });
}

async function handleIntelHome(
  deps: WebDeps,
  req: http.IncomingMessage,
  url: URL,
  res: http.ServerResponse
): Promise<void> {
  if (url.searchParams.get("logout") === "1") {
    res.writeHead(303, {
      location: "/intel",
      "set-cookie": clearWalletPnlAdminCookies(),
      "cache-control": "no-store"
    });
    res.end();
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("allow", "GET");
    return htmlStatus(res, 405, walletPnlIntelGatePage(deps, "/intel", "Unsupported method."));
  }
  const accessFailure = walletPnlIntelAccessFailure(deps, req, "/intel");
  if (accessFailure) return htmlStatus(res, accessFailure.status, accessFailure.body);
  return htmlStatus(res, 200, intelHomePage({
    walletPnlChain: deps.env.walletPnlChain,
    walletPnlEnabled: deps.env.walletPnlEnabled
  }));
}

async function handleWalletPnlAdmin(
  deps: WebDeps,
  req: http.IncomingMessage,
  url: URL,
  res: http.ServerResponse
): Promise<void> {
  if (url.searchParams.get("logout") === "1") {
    res.writeHead(303, {
      location: "/intel",
      "set-cookie": clearWalletPnlAdminCookies(),
      "cache-control": "no-store"
    });
    res.end();
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("allow", "GET");
    return htmlStatus(res, 405, walletPnlIntelGatePage(deps, "/intel/wallet-pnl", "Unsupported method."));
  }
  const accessFailure = walletPnlIntelAccessFailure(deps, req, "/intel/wallet-pnl");
  if (accessFailure) return htmlStatus(res, accessFailure.status, accessFailure.body);

  const chain = deps.env.walletPnlChain;
  const snapshot = deps.store.getWalletPnlSnapshot(chain);
  return htmlStatus(res, 200, walletPnlAdminPage({
    env: deps.env,
    snapshot,
    cursor: deps.store.getWalletPnlCursor(chain),
    sort: walletPnlSortFromUrl(url)
  }));
}

async function handleWalletPnlAnalytics(
  deps: WebDeps,
  req: http.IncomingMessage,
  url: URL,
  res: http.ServerResponse,
  parts: string[]
): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("allow", "GET");
    return htmlStatus(res, 405, walletPnlIntelGatePage(deps, "/intel/wallet-pnl", "Unsupported method."));
  }

  const accessFailure = walletPnlIntelAccessFailure(deps, req, url.pathname);
  if (accessFailure) return htmlStatus(res, accessFailure.status, accessFailure.body);

  const chain = deps.env.walletPnlChain;
  const cursor = deps.store.getWalletPnlCursor(chain);
  const snapshot = deps.store.getWalletPnlSnapshot(chain);
  const storedAnalytics = deps.store.getWalletPnlAnalyticsSnapshot(chain);
  const staleHookAnalytics = storedAnalytics ? walletPnlAnalyticsHasIneligibleBaseV4Pool(storedAnalytics) : false;
  const analytics = staleHookAnalytics ? undefined : storedAnalytics;
  const forceAnalyticsMaterialize = walletPnlForceAnalyticsMaterialization(url);
  const staleIgnoredTokenAnalytics = analytics ? walletPnlAnalyticsHasIgnoredToken(analytics) : false;
  const staleCreatorAnalytics = analytics ? walletPnlAnalyticsMissingTokenCreators(analytics) : false;
  if (!analytics || forceAnalyticsMaterialize || staleIgnoredTokenAnalytics || staleCreatorAnalytics || staleHookAnalytics) {
    walletPnlScheduleAnalyticsMaterialization(deps, chain, {
      force: forceAnalyticsMaterialize || staleIgnoredTokenAnalytics || staleCreatorAnalytics || staleHookAnalytics,
      reason: forceAnalyticsMaterialize
        ? "request-force"
        : staleIgnoredTokenAnalytics
          ? "ignored-token-cache"
          : staleHookAnalytics
            ? "ineligible-hook-cache"
            : staleCreatorAnalytics
              ? "token-creator-cache"
              : "missing-cache"
    });
  }
  const fromBlock = snapshot?.retentionFromBlock ?? analytics?.fromBlock;
  let persistedClusters = await walletPnlPersistDetectedClusters(
    deps,
    chain,
    walletPnlPersistableClustersFromAnalytics(chain, analytics)
  );
  const common = { env: deps.env, analytics, snapshot, cursor, persistedClusters };
  const tradeReadOptions = { trustedV4Hooks: deps.env.walletPnlTrustedV4Hooks };

  if (parts[0] === "tokens" && parts.length === 1) {
    return htmlStatus(res, 200, walletPnlTokensPage(common));
  }

  if (parts[0] === "tokens" && parts[1] === "new" && parts.length === 2) {
    const liveNewTokens = walletPnlLiveNewTokenQueryRequested(url);
    const newTokens = liveNewTokens
      ? await walletPnlNewTokenSummaries(deps, chain, analytics)
      : staleHookAnalytics
        ? undefined
        : walletPnlCachedNewTokenSummaries(deps, chain);
    return htmlStatus(res, 200, walletPnlNewTokensPage({
      ...common,
      newTokens: newTokens?.tokens,
      newTokensToBlock: newTokens?.toBlock,
      newTokensGeneratedAt: newTokens?.generatedAt,
      newTokensSource: newTokens ? (liveNewTokens ? "live" : "cache") : undefined
    }));
  }

  if (parts[0] === "pools" && parts.length === 1) {
    return htmlStatus(res, 200, walletPnlPoolsPage(common));
  }

  if (parts[0] === "status" && parts.length === 1) {
    return htmlStatus(res, 200, walletPnlStatusPage(common));
  }

  if (parts[0] === "signals" && parts.length === 1) {
    return htmlStatus(res, 200, walletPnlSignalsPage(common));
  }

  if (parts[0] === "leaderboards" && parts[1] === "signal") {
    return htmlStatus(res, 200, walletPnlSignalsPage(common));
  }

  if (parts[0] === "leaderboards" && parts[1]) {
    return htmlStatus(res, 200, walletPnlLeaderboardsPage({
      ...common,
      kind: walletPnlLeaderboardKind(parts[1])
    }));
  }

  if (parts[0] === "overlap" && parts.length === 1) {
    const tokenAddress = parseWalletAddress(url.searchParams.get("token"));
    const walletLimit = walletPnlQueryLimit(url, "limit", 250, 25, 1_000);
    const tokenTrades = tokenAddress ? deps.store.getWalletPnlTradesForToken(chain, tokenAddress, fromBlock, tradeReadOptions) : undefined;
    if (tokenAddress && tokenTrades) walletPnlMaybeScheduleTokenBootstrap(deps, chain, tokenAddress, tokenTrades, "overlap-token", walletPnlForceTokenBootstrap(url));
    if (tokenAddress && tokenTrades && walletPnlMissingCachedTokenWithWindowTrades(analytics, chain, tokenAddress, tokenTrades)) {
      walletPnlScheduleAnalyticsMaterialization(deps, chain, { force: true, reason: "missing-token-cache" });
    }
    if (tokenAddress && tokenTrades) {
      persistedClusters = await walletPnlPersistDetectedClusters(
        deps,
        chain,
        walletPnlPersistableClustersFromTokenTrades(chain, analytics, tokenAddress, tokenTrades),
        persistedClusters
      );
    }
    const highRoiWallets = tokenTrades ? highRoiWalletsFromSingleTokenTrades(chain, tokenTrades) : [];
    const wallets = tokenTrades ? mergeWalletSamples(highRoiWallets, topWalletsFromTrades(tokenTrades, walletLimit), walletLimit) : [];
    const cohortTrades = wallets.length > 0 ? walletPnlTradesForWallets(deps.store, chain, wallets, fromBlock, tradeReadOptions) : undefined;
    const sampleWallets = historicalWalletSample(cohortTrades ?? [], wallets, url, highRoiWallets, deps.env.walletPnlHistoricalPrecomputeWalletLimit);
    const clusterKey = tokenAddress ? walletPnlHistoricalClusterKey(chain, "overlap", [tokenAddress, ...sampleWallets]) : undefined;
    return htmlStatus(res, 200, walletPnlOverlapPage({
      ...common,
      persistedClusters,
      tokenAddress,
      tokenTrades,
      cohortTrades,
      historicalBuys: tokenAddress && clusterKey
        ? await walletPnlHistoricalTokenBuysCache(deps, chain, {
          clusterKey,
          clusterLabel: `overlap:${tokenAddress.toLowerCase()}`,
          wallets: sampleWallets,
          toBlock: analytics?.toBlock ?? snapshot?.toBlock ?? cursor?.lastBlock,
          excludeTokenAddress: tokenAddress,
          forceBackfill: walletPnlForceHistoricalBackfill(url),
          shouldBackfill: walletPnlForceHistoricalBackfill(url) || shouldBackfillOverlapCluster(analytics, chain, tokenAddress, tokenTrades ?? [], cohortTrades ?? [])
        })
        : undefined,
      walletLimit,
      walletCount: tokenTrades ? new Set(tokenTrades.map((trade) => trade.wallet.toLowerCase())).size : 0
    }));
  }

  if (parts[0] === "cohort" && parts.length === 1) {
    const wallets = parseWalletPnlCohortWallets(url.searchParams.get("wallets") ?? "");
    const clusterLabel = parseWalletPnlClusterLabel(url.searchParams.get("cluster"));
    const trades = wallets.length > 0 ? walletPnlTradesForWallets(deps.store, chain, wallets, fromBlock, tradeReadOptions) : [];
    const sampleWallets = historicalWalletSample(trades, wallets, url, [], deps.env.walletPnlHistoricalPrecomputeWalletLimit);
    const clusterKey = sampleWallets.length > 0 ? walletPnlHistoricalClusterKey(chain, "cohort", sampleWallets) : undefined;
    return htmlStatus(res, 200, walletPnlCohortPage({
      ...common,
      wallets,
      trades,
      clusterLabel,
      historicalBuys: clusterKey
        ? await walletPnlHistoricalTokenBuysCache(deps, chain, {
          clusterKey,
          clusterLabel: `cohort:${sampleWallets.slice(0, 3).join(",")}${sampleWallets.length > 3 ? `+${sampleWallets.length - 3}` : ""}`,
          wallets: sampleWallets,
          toBlock: analytics?.toBlock ?? snapshot?.toBlock ?? cursor?.lastBlock,
          forceBackfill: walletPnlForceHistoricalBackfill(url),
          shouldBackfill: walletPnlForceHistoricalBackfill(url) || shouldBackfillCohortCluster(chain, wallets, trades)
        })
        : undefined
    }));
  }

  if (parts[0] === "risk" && parts[1] === "tokens" && parts.length === 2) {
    return htmlStatus(res, 200, walletPnlRiskTokensPage(common));
  }

  if (parts[0] === "risk" && parts[1] === "wallets" && parts.length === 2) {
    return htmlStatus(res, 200, walletPnlRiskWalletsPage(common));
  }

  if (parts[0] === "token" && parts[1]) {
    const tokenAddress = parseWalletAddress(parts[1]);
    if (!tokenAddress) return htmlStatus(res, 400, walletPnlTokensPage(common));
    const tokenTrades = deps.store.getWalletPnlTradesForToken(chain, tokenAddress, fromBlock, tradeReadOptions);
    walletPnlMaybeScheduleTokenBootstrap(deps, chain, tokenAddress, tokenTrades, "token-page", walletPnlForceTokenBootstrap(url));
    if (walletPnlMissingCachedTokenWithWindowTrades(analytics, chain, tokenAddress, tokenTrades)) {
      walletPnlScheduleAnalyticsMaterialization(deps, chain, { force: true, reason: "missing-token-cache" });
    }
    persistedClusters = await walletPnlPersistDetectedClusters(
      deps,
      chain,
      walletPnlPersistableClustersFromTokenTrades(chain, analytics, tokenAddress, tokenTrades),
      persistedClusters
    );
    const tokenCommon = { ...common, persistedClusters };
    if (parts[2] === "overlap") {
      return redirect(res, `/intel/wallet-pnl/overlap?token=${encodeURIComponent(tokenAddress)}`);
    }
    if (parts[2] === "wallets") {
      return htmlStatus(res, 200, walletPnlTokenWalletsPage({
        ...tokenCommon,
        tokenAddress,
        trades: tokenTrades,
        sort: walletPnlTokenWalletSort(url.searchParams.get("sort"))
      }));
    }
    return htmlStatus(res, 200, walletPnlTokenDetailPage({
      ...tokenCommon,
      tokenAddress,
      trades: tokenTrades
    }));
  }

  if (parts[0] === "wallet" && parts[1]) {
    const wallet = parseWalletAddress(parts[1]);
    if (!wallet) return htmlStatus(res, 400, walletPnlRiskWalletsPage(common));
    return htmlStatus(res, 200, walletPnlWalletDetailPage({
      ...common,
      wallet,
      trades: deps.store.getWalletPnlTradesForWallet(chain, wallet, fromBlock, tradeReadOptions)
    }));
  }

  if (parts[0] === "pool" && parts[1]) {
    const poolId = decodeURIComponent(parts.slice(1).join("/")).toLowerCase();
    const pool = deps.store.getWalletPnlPool(chain, poolId);
    if (pool && !walletPnlBaseV4HookPolicy(chain, pool.pool, deps.env.walletPnlTrustedV4Hooks).allowed) {
      return htmlStatus(res, 404, walletPnlPoolsPage(common));
    }
    return htmlStatus(res, 200, walletPnlPoolDetailPage({
      ...common,
      poolId,
      pool,
      trades: deps.store.getWalletPnlTradesForPool(chain, poolId, fromBlock, tradeReadOptions)
    }));
  }

  return redirect(res, "/intel/wallet-pnl/tokens");
}

async function walletPnlPersistDetectedClusters(
  deps: WebDeps,
  chain: ChainSlug,
  records: WalletPnlClusterRecord[],
  current?: WalletPnlClusterRecord[]
): Promise<WalletPnlClusterRecord[]> {
  if (records.length === 0) return current ?? deps.store.getWalletPnlClusters(chain);
  const changed = deps.store.upsertWalletPnlClusters(records);
  if (changed > 0) {
    await deps.store.save();
    return deps.store.getWalletPnlClusters(chain);
  }
  return current ?? deps.store.getWalletPnlClusters(chain);
}

function walletPnlLeaderboardKind(value: string): LeaderboardKind {
  if (value === "roi" || value === "volume") return value;
  return "pnl";
}

function walletPnlTokenWalletSort(value: string | null): TokenWalletSort {
  if (value === "roi" || value === "losers" || value === "volume" || value === "earliest" || value === "roundtrip") return value;
  return "pnl";
}

function walletPnlQueryLimit(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function parseWalletPnlCohortWallets(raw: string): string[] {
  const out: string[] = [];
  for (const value of raw.split(/[\s,;]+/g)) {
    const wallet = parseWalletAddress(value);
    if (wallet && !out.includes(wallet.toLowerCase())) out.push(wallet.toLowerCase());
    if (out.length >= 250) break;
  }
  return out;
}

function parseWalletPnlClusterLabel(raw: string | null): string | undefined {
  const label = raw?.replace(/\s+/g, " ").trim();
  return label ? label.slice(0, 96) : undefined;
}

function topWalletsFromTrades(trades: WalletPnlTradeRecord[], limit: number): string[] {
  const volumes = new Map<string, { wallet: string; volumeUsd: number; tradeCount: number }>();
  for (const trade of trades) {
    const key = trade.wallet.toLowerCase();
    const item = volumes.get(key) ?? { wallet: key, volumeUsd: 0, tradeCount: 0 };
    item.volumeUsd += trade.volumeUsd !== undefined && Number.isFinite(trade.volumeUsd) ? trade.volumeUsd : 0;
    item.tradeCount += 1;
    volumes.set(key, item);
  }
  return [...volumes.values()]
    .sort((a, b) => b.volumeUsd - a.volumeUsd || b.tradeCount - a.tradeCount)
    .slice(0, limit)
    .map((item) => item.wallet);
}

function mergeWalletSamples(primary: string[], secondary: string[], limit: number): string[] {
  const out: string[] = [];
  for (const wallet of [...primary, ...secondary]) {
    const normalized = parseWalletAddress(wallet)?.toLowerCase();
    if (normalized && !out.includes(normalized)) out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function highRoiWalletsFromSingleTokenTrades(chain: ChainSlug, trades: WalletPnlTradeRecord[]): string[] {
  const rows = buildWalletTokenPnlRows(chain, trades);
  const coordinated = coordinatedHighRoiEntryWallets(chain, rows);
  return mergeWalletSamples(
    coordinated,
    rows
    .filter(isHighRoiWalletTokenCluster)
    .sort((a, b) => (b.roiPct ?? 0) - (a.roiPct ?? 0) || b.realizedPnlUsd - a.realizedPnlUsd || b.volumeUsd - a.volumeUsd)
      .map((row) => row.wallet),
    50
  );
}

function walletPnlTradesForWallets(
  store: Storage,
  chain: ChainSlug,
  wallets: string[],
  fromBlock?: number,
  options?: { trustedV4Hooks?: readonly string[] }
): WalletPnlTradeRecord[] {
  const byKey = new Map<string, WalletPnlTradeRecord>();
  for (const wallet of wallets) {
    for (const trade of store.getWalletPnlTradesForWallet(chain, wallet, fromBlock, options)) {
      byKey.set(`${trade.chain}:${trade.txHash}:${trade.logIndex}:${trade.poolId}`, trade);
    }
  }
  return [...byKey.values()].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
}

function walletPnlForceAnalyticsMaterialization(url: URL): boolean {
  return url.searchParams.get("materialize") === "1" || url.searchParams.get("refreshAnalytics") === "1";
}

function walletPnlForceTokenBootstrap(url: URL): boolean {
  return url.searchParams.get("bootstrap") === "1" || url.searchParams.get("poolBootstrap") === "1";
}

function walletPnlLegacyRedirectPath(url: URL): string {
  const pathname = url.pathname.replace(/^\/admin\/wallet-pnl\b/, "/intel/wallet-pnl");
  return `${pathname}${url.search}`;
}

function walletPnlScheduleAnalyticsMaterialization(
  deps: WebDeps,
  chain: ChainSlug,
  options: { force?: boolean; reason: string; delayMs?: number }
): void {
  if (!deps.env.intelEnabled) return;
  const existing = deps.store.getWalletPnlAnalyticsSnapshot(chain);
  const staleIgnoredTokenAnalytics = existing ? walletPnlAnalyticsHasIgnoredToken(existing) : false;
  if (existing && !options.force && !staleIgnoredTokenAnalytics) return;
  const key = chain;
  if (walletPnlAnalyticsMaterializations.has(key)) return;
  const bounds = walletPnlAnalyticsBounds(deps, chain, existing);
  if (!bounds) return;

  walletPnlAnalyticsMaterializations.add(key);
  setTimeout(() => {
    void walletPnlMaterializeAnalyticsSnapshot(deps, chain, {
      force: options.force || staleIgnoredTokenAnalytics,
      reason: staleIgnoredTokenAnalytics && !options.force ? "ignored-token-cache" : options.reason,
      fromBlock: bounds.fromBlock,
      positionFromBlock: bounds.positionFromBlock,
      toBlock: bounds.toBlock
    }).finally(() => {
      walletPnlAnalyticsMaterializations.delete(key);
    });
  }, options.delayMs ?? 0);
}

function walletPnlAnalyticsBounds(
  deps: WebDeps,
  chain: ChainSlug,
  existing?: WalletPnlAnalyticsSnapshot
): { fromBlock: number; positionFromBlock: number; toBlock: number } | undefined {
  const snapshot = deps.store.getWalletPnlSnapshot(chain);
  const cursor = deps.store.getWalletPnlCursor(chain);
  const toBlock = cursor?.lastBlock ?? snapshot?.toBlock ?? existing?.toBlock;
  if (toBlock === undefined) return undefined;
  const retentionBlocks = Math.ceil((deps.env.walletPnlRetentionDays * 24 * 60 * 60) / blockSecondsFor(chain));
  const analyticsBlocks = Math.ceil((deps.env.walletPnlAnalyticsWindowHours * 60 * 60) / blockSecondsFor(chain));
  const positionBlocks = Math.ceil((deps.env.walletPnlPositionWindowHours * 60 * 60) / blockSecondsFor(chain));
  const retentionFromBlock = Math.max(snapshot?.retentionFromBlock ?? 0, toBlock - retentionBlocks + 1);
  const fromBlock = Math.max(retentionFromBlock, toBlock - analyticsBlocks + 1);
  const positionFromBlock = Math.max(retentionFromBlock, toBlock - positionBlocks + 1);
  return { fromBlock, positionFromBlock, toBlock };
}

function walletPnlNewTokenSummaries(
  deps: WebDeps,
  chain: ChainSlug,
  analytics?: WalletPnlAnalyticsSnapshot
): Promise<{ tokens: WalletPnlAnalyticsTokenSummary[]; toBlock: number; generatedAt: string } | undefined> {
  const bounds = walletPnlAnalyticsBounds(deps, chain, analytics);
  if (!bounds) return Promise.resolve(undefined);
  const store = deps.store as Storage & WalletPnlNewTokenStore;
  const tokens = store.getWalletPnlNewTokenSummaries?.({
    chain,
    fromBlock: bounds.fromBlock,
    toBlock: bounds.toBlock,
    trustedV4Hooks: deps.env.walletPnlTrustedV4Hooks,
    limit: 250
  });
  if (!tokens) return Promise.resolve(undefined);
  return enrichWalletPnlTokenSummaries({
    chain,
    tokens,
    blockscoutClient: walletPnlCreatorBlockscoutClient(deps),
    rpc: deps.rpcs.get(chain),
    store: deps.store,
    deniedTokenFactoryContracts: deps.env.walletPnlDeniedTokenFactoryContracts,
    lookupDeadlineMs: WALLET_PNL_NEW_TOKENS_CREATOR_LOOKUP_DEADLINE_MS,
    logger: deps.logger
  }).then(async (enrichedTokens) => {
    await deps.store.save();
    return {
      tokens: enrichedTokens,
      toBlock: bounds.toBlock,
      generatedAt: new Date().toISOString()
    };
  });
}

function walletPnlCreatorBlockscoutClient(deps: WebDeps): BlockscoutClient | undefined {
  if (!deps.env.intelEnabled) return undefined;
  return deps.env.walletPnlBlockscoutCreatorLookupEnabled ? deps.blockscoutClient : undefined;
}

function walletPnlCachedNewTokenSummaries(
  deps: WebDeps,
  chain: ChainSlug
): { tokens: WalletPnlAnalyticsTokenSummary[]; toBlock: number; generatedAt: string } | undefined {
  const snapshot = deps.store.getWalletPnlNewTokensSnapshot(chain);
  if (!snapshot) return undefined;
  if ((snapshot.hookPolicyVersion ?? 0) < WALLET_PNL_HOOK_POLICY_VERSION) return undefined;
  return { tokens: snapshot.tokens, toBlock: snapshot.toBlock, generatedAt: snapshot.generatedAt };
}

function walletPnlNewTokensSnapshotFromAnalytics(
  analytics: WalletPnlAnalyticsSnapshot,
  limit = 250
): WalletPnlNewTokensSnapshot {
  const tokens = analytics.tokens
    .filter((token) => !isWalletPnlIgnoredToken(analytics.chain, token.tokenAddress, token.tokenSymbol))
    .slice()
    .sort((a, b) => b.firstBlock - a.firstBlock || b.lastBlock - a.lastBlock || b.volumeUsd - a.volumeUsd)
    .slice(0, Math.max(1, Math.floor(limit)));
  return {
    schemaVersion: 1,
    chain: analytics.chain,
    generatedAt: analytics.generatedAt,
    windowHours: analytics.windowHours,
    fromBlock: analytics.fromBlock,
    toBlock: analytics.toBlock,
    tokenCount: tokens.length,
    tokens
  };
}

function walletPnlLiveNewTokenQueryRequested(url: URL): boolean {
  return url.searchParams.get("live") === "1";
}

function walletPnlMaybeScheduleTokenBootstrap(
  deps: WebDeps,
  chain: ChainSlug,
  tokenAddress: string,
  tokenTrades: WalletPnlTradeRecord[],
  reason: string,
  force = false
): void {
  if (!deps.env.intelEnabled) return;
  if (!force && tokenTrades.length > 0) return;
  deps.walletPnlIndexer?.scheduleTokenBootstrap(chain, tokenAddress, reason, force);
}

function walletPnlMissingCachedTokenWithWindowTrades(
  analytics: WalletPnlAnalyticsSnapshot | undefined,
  chain: ChainSlug,
  tokenAddress: string,
  tokenTrades: WalletPnlTradeRecord[]
): boolean {
  if (!analytics) return false;
  const normalized = tokenAddress.toLowerCase();
  if (analytics.tokens.some((token) => token.tokenAddress.toLowerCase() === normalized)) return false;
  return tokenTrades.some((trade) =>
    trade.blockNumber >= analytics.fromBlock &&
    trade.blockNumber <= analytics.toBlock &&
    !isWalletPnlIgnoredToken(chain, trade.tokenAddress, trade.tokenSymbol)
  );
}

function startWalletPnlHistoricalPrecomputeHeartbeat(deps: WebDeps): NodeJS.Timeout[] {
  if (!deps.env.intelEnabled) return [];
  if (!deps.env.walletPnlEnabled) return [];
  if (!deps.env.walletPnlBlockscoutHistoricalBackfillEnabled) return [];
  if (deps.env.walletPnlHistoricalPrecomputeIntervalMs <= 0 || deps.env.walletPnlHistoricalPrecomputeTokenLimit <= 0) return [];
  const timers: NodeJS.Timeout[] = [];
  const startupTimer = setTimeout(() => {
    walletPnlScheduleHistoricalPrecompute(deps, deps.env.walletPnlChain, { reason: "startup" });
  }, WALLET_PNL_HISTORICAL_PRECOMPUTE_START_DELAY_MS);
  startupTimer.unref?.();
  timers.push(startupTimer);

  const intervalTimer = setInterval(() => {
    walletPnlScheduleHistoricalPrecompute(deps, deps.env.walletPnlChain, { reason: "interval" });
  }, deps.env.walletPnlHistoricalPrecomputeIntervalMs);
  intervalTimer.unref?.();
  timers.push(intervalTimer);
  return timers;
}

function walletPnlScheduleHistoricalPrecompute(
  deps: WebDeps,
  chain: ChainSlug,
  options: { reason: string; delayMs?: number }
): void {
  if (!deps.env.intelEnabled) return;
  if (deps.env.walletPnlHistoricalPrecomputeIntervalMs <= 0 || deps.env.walletPnlHistoricalPrecomputeTokenLimit <= 0) return;
  if (!deps.env.walletPnlBlockscoutHistoricalBackfillEnabled) return;
  if (!deps.blockscoutClient) return;
  const key = chain;
  if (walletPnlHistoricalPrecomputes.has(key)) return;
  walletPnlHistoricalPrecomputes.add(key);
  setTimeout(() => {
    void walletPnlRunHistoricalPrecompute(deps, chain, options.reason).finally(() => {
      walletPnlHistoricalPrecomputes.delete(key);
    });
  }, options.delayMs ?? 0).unref?.();
}

async function walletPnlRunHistoricalPrecompute(deps: WebDeps, chain: ChainSlug, reason: string): Promise<void> {
  const analytics = deps.store.getWalletPnlAnalyticsSnapshot(chain);
  if (!analytics) return;
  const candidates = walletPnlHistoricalPrecomputeCandidates(deps, chain, analytics);
  if (candidates.length === 0) return;

  const startedAt = Date.now();
  let scheduled = 0;
  let skipped = 0;
  const tradeReadOptions = { trustedV4Hooks: deps.env.walletPnlTrustedV4Hooks };
  for (const tokenAddress of candidates) {
    const tokenTrades = deps.store.getWalletPnlTradesForToken(chain, tokenAddress, analytics.fromBlock, tradeReadOptions)
      .filter((trade) => trade.blockNumber <= analytics.toBlock);
    const highRoiWallets = highRoiWalletsFromSingleTokenTrades(chain, tokenTrades);
    if (!hasHighRoiWalletTokenCohort(chain, tokenTrades) && !hasCoordinatedHighRoiEntryCluster(chain, tokenTrades)) {
      skipped += 1;
      continue;
    }
    const wallets = mergeWalletSamples(highRoiWallets, topWalletsFromTrades(tokenTrades, WALLET_PNL_HISTORICAL_DEFAULT_OVERLAP_WALLET_LIMIT), WALLET_PNL_HISTORICAL_DEFAULT_OVERLAP_WALLET_LIMIT);
    if (wallets.length < WALLET_PNL_CLUSTER_HIGH_ROI_ENTRY_MIN_WALLETS) {
      skipped += 1;
      continue;
    }
    const cohortTrades = walletPnlTradesForWallets(deps.store, chain, wallets, analytics.fromBlock, tradeReadOptions)
      .filter((trade) => trade.blockNumber <= analytics.toBlock);
    if (!shouldBackfillOverlapCluster(analytics, chain, tokenAddress, tokenTrades, cohortTrades)) {
      skipped += 1;
      continue;
    }
    const sampleWallets = historicalWalletSampleFromLimit(
      cohortTrades,
      wallets,
      deps.env.walletPnlHistoricalPrecomputeWalletLimit,
      highRoiWallets
    );
    if (sampleWallets.length < WALLET_PNL_CLUSTER_HIGH_ROI_ENTRY_MIN_WALLETS) {
      skipped += 1;
      continue;
    }
    const clusterKey = walletPnlHistoricalClusterKey(chain, "overlap", [tokenAddress, ...sampleWallets]);
    const cached = deps.store.getWalletPnlHistoricalTokenBuys(chain, clusterKey);
    if (cached && (walletPnlHistoricalCacheFresh(cached) || walletPnlHistoricalPendingFresh(cached))) {
      skipped += 1;
      continue;
    }

    const pending = walletPnlHistoricalSnapshotBase(chain, {
      clusterKey,
      clusterLabel: `overlap:${tokenAddress.toLowerCase()}`,
      wallets: sampleWallets,
      toBlock: analytics.toBlock
    }, "pending", new Date().toISOString(), {
      generatedAt: cached?.generatedAt,
      tokens: cached?.tokens ?? []
    });
    deps.store.setWalletPnlHistoricalTokenBuys(pending);
    const ran = await walletPnlRunHistoricalTokenBuyBackfillLocked(deps, chain, {
      clusterKey,
      clusterLabel: `overlap:${tokenAddress.toLowerCase()}`,
      wallets: sampleWallets,
      toBlock: analytics.toBlock,
      excludeTokenAddress: tokenAddress
    });
    if (ran) scheduled += 1;
  }

  deps.logger.info(
    {
      chain,
      reason,
      candidates: candidates.length,
      backfills: scheduled,
      skipped,
      elapsedMs: Date.now() - startedAt
    },
    "wallet pnl historical cluster precompute completed"
  );
}

function walletPnlHistoricalPrecomputeCandidates(
  deps: WebDeps,
  chain: ChainSlug,
  analytics: WalletPnlAnalyticsSnapshot
): string[] {
  const byToken = new Map<string, { tokenAddress: string; highRoiWallets: Set<string>; maxRoiPct: number; pnlUsd: number; volumeUsd: number }>();
  for (const row of analytics.roiLeaders ?? []) {
    if (!isHighRoiLeader(row)) continue;
    if (isWalletPnlIgnoredToken(chain, row.tokenAddress, row.tokenSymbol)) continue;
    const key = row.tokenAddress.toLowerCase();
    const item = byToken.get(key) ?? {
      tokenAddress: key,
      highRoiWallets: new Set<string>(),
      maxRoiPct: 0,
      pnlUsd: 0,
      volumeUsd: 0
    };
    item.highRoiWallets.add(row.wallet.toLowerCase());
    item.maxRoiPct = Math.max(item.maxRoiPct, row.roiPct ?? 0);
    item.pnlUsd += row.realizedPnlUsd;
    item.volumeUsd += row.volumeUsd;
    byToken.set(key, item);
  }
  return [...byToken.values()]
    .filter((item) => item.highRoiWallets.size >= WALLET_PNL_CLUSTER_HIGH_ROI_ENTRY_MIN_WALLETS)
    .sort((a, b) =>
      b.highRoiWallets.size - a.highRoiWallets.size ||
      b.maxRoiPct - a.maxRoiPct ||
      b.pnlUsd - a.pnlUsd ||
      b.volumeUsd - a.volumeUsd
    )
    .slice(0, deps.env.walletPnlHistoricalPrecomputeTokenLimit)
    .map((item) => item.tokenAddress);
}

function isHighRoiLeader(row: {
  roiPct?: number;
  realizedCostUsd: number;
  realizedProceedsUsd: number;
}): boolean {
  return Boolean(
    row.roiPct !== undefined &&
    row.roiPct >= WALLET_PNL_CLUSTER_HIGH_ROI_PCT &&
    row.realizedCostUsd >= WALLET_PNL_CLUSTER_HIGH_ROI_MIN_COST_USD &&
    row.realizedProceedsUsd >= WALLET_PNL_CLUSTER_HIGH_ROI_MIN_PROCEEDS_USD
  );
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

async function walletPnlMaterializeAnalyticsSnapshot(
  deps: WebDeps,
  chain: ChainSlug,
  options: { force?: boolean; reason: string; fromBlock: number; positionFromBlock: number; toBlock: number }
): Promise<void> {
  try {
    if (!options.force && deps.store.getWalletPnlAnalyticsSnapshot(chain)) return;
    const startedAt = Date.now();
    deps.logger.info(
      { chain, fromBlock: options.fromBlock, toBlock: options.toBlock, reason: options.reason },
      "wallet pnl analytics materialization started"
    );
    const flatStore = deps.store as Storage & WalletPnlFlatAnalyticsStore;
    const profile = walletPnlCreateProfile(deps.env.walletPnlProfileRebuilds);
    const flatAnalyticsOptions = {
      chain,
      fromBlock: options.fromBlock,
      positionFromBlock: options.positionFromBlock,
      toBlock: options.toBlock,
      windowHours: deps.env.walletPnlAnalyticsWindowHours,
      positionWindowHours: deps.env.walletPnlPositionWindowHours,
      trustedV4Hooks: deps.env.walletPnlTrustedV4Hooks,
      profile: profile.sink
    };
    const flatAnalytics = flatStore.buildWalletPnlAnalyticsSnapshotFromFlatTradesInWorker
      ? await flatStore.buildWalletPnlAnalyticsSnapshotFromFlatTradesInWorker(flatAnalyticsOptions)
      : flatStore.buildWalletPnlAnalyticsSnapshotFromFlatTrades?.(flatAnalyticsOptions);
    const analytics = flatAnalytics ?? (!flatStore.buildWalletPnlAnalyticsSnapshotFromFlatTrades ? (() => {
      const trades = deps.store
        .getWalletPnlTrades(chain, options.fromBlock, { trustedV4Hooks: deps.env.walletPnlTrustedV4Hooks })
        .filter((trade) => trade.blockNumber <= options.toBlock);
      if (trades.length === 0) return undefined;
      return buildWalletPnlAnalyticsSnapshot({
        chain,
        trades,
        poolRecords: deps.store.getWalletPnlPools(chain),
        trustedV4Hooks: deps.env.walletPnlTrustedV4Hooks,
        fromBlock: options.fromBlock,
        positionFromBlock: options.positionFromBlock,
        toBlock: options.toBlock
      });
    })() : undefined);
    if (!analytics || analytics.tradeCount === 0) {
      deps.logger.warn(
        { chain, fromBlock: options.fromBlock, toBlock: options.toBlock, reason: options.reason },
        flatStore.buildWalletPnlAnalyticsSnapshotFromFlatTrades
          ? "wallet pnl analytics materialization skipped; flat trade columns are not ready"
          : "wallet pnl analytics materialization skipped; no retained trades"
      );
      return;
    }
    const filteredAnalytics = await enrichWalletPnlAnalyticsTokenCreators({
      snapshot: analytics,
      blockscoutClient: walletPnlCreatorBlockscoutClient(deps),
      rpc: deps.rpcs.get(chain),
      store: deps.store,
      deniedTokenFactoryContracts: deps.env.walletPnlDeniedTokenFactoryContracts,
      lookupDeadlineMs: WALLET_PNL_ANALYTICS_CREATOR_LOOKUP_DEADLINE_MS,
      logger: deps.logger
    });
    deps.store.setWalletPnlAnalyticsSnapshot(filteredAnalytics);
    if (!deps.store.getWalletPnlNewTokensSnapshot(chain)) {
      deps.store.setWalletPnlNewTokensSnapshot(walletPnlNewTokensSnapshotFromAnalytics(filteredAnalytics));
    }
    await deps.store.save();
    walletPnlScheduleHistoricalPrecompute(deps, chain, { reason: `analytics:${options.reason}`, delayMs: 1_000 });
    deps.logger.info(
      {
        chain,
        fromBlock: filteredAnalytics.fromBlock,
        toBlock: filteredAnalytics.toBlock,
        trades: filteredAnalytics.tradeCount,
        tokens: filteredAnalytics.tokenCount,
        wallets: filteredAnalytics.walletCount,
        pools: filteredAnalytics.poolCount,
        elapsedMs: Date.now() - startedAt,
        source: flatStore.buildWalletPnlAnalyticsSnapshotFromFlatTradesInWorker ? "flat-sql-worker" : "flat-sql",
        reason: options.reason,
        ...walletPnlProfileLogField(profile)
      },
      "wallet pnl analytics snapshot materialized"
    );
  } catch (error) {
    deps.logger.error(
      { err: serializeError(error), chain, fromBlock: options.fromBlock, toBlock: options.toBlock, reason: options.reason },
      "wallet pnl analytics materialization failed"
    );
  }
}

function historicalWalletSample(
  trades: WalletPnlTradeRecord[],
  fallbackWallets: string[],
  url: URL,
  priorityWallets: string[] = [],
  defaultLimit = 25
): string[] {
  const limit = walletPnlQueryLimit(url, "historicalWallets", defaultLimit, 1, 50);
  return historicalWalletSampleFromLimit(trades, fallbackWallets, limit, priorityWallets);
}

function historicalWalletSampleFromLimit(trades: WalletPnlTradeRecord[], fallbackWallets: string[], limit: number, priorityWallets: string[] = []): string[] {
  const ranked = topWalletsFromTrades(trades, limit);
  const source = [...priorityWallets, ...(ranked.length > 0 ? ranked : fallbackWallets)];
  const out: string[] = [];
  for (const wallet of source) {
    const normalized = parseWalletAddress(wallet)?.toLowerCase();
    if (normalized && !out.includes(normalized)) out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function walletPnlForceHistoricalBackfill(url: URL): boolean {
  return url.searchParams.get("historical") === "1" || url.searchParams.get("backfill") === "1";
}

function walletPnlHistoricalClusterKey(chain: ChainSlug, kind: "overlap" | "cohort", parts: string[]): string {
  const normalized = [chain, kind, ...parts.map((part) => part.toLowerCase()).sort()].join("|");
  return `${kind}:${crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 32)}`;
}

interface WalletTokenPnlSignalRow {
  wallet: string;
  tokenAddress: string;
  tokenSymbol?: string;
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  volumeUsd: number;
  realizedPnlUsd: number;
  realizedCostUsd: number;
  realizedProceedsUsd: number;
  roiPct?: number;
  quantity: number;
  costUsd: number;
  firstBuyBlock?: number;
}

function hasHighRoiWalletTokenCohort(chain: ChainSlug, trades: WalletPnlTradeRecord[]): boolean {
  const wallets = new Set(
    buildWalletTokenPnlRows(chain, trades)
      .filter(isHighRoiWalletTokenCluster)
      .map((row) => row.wallet)
  );
  return wallets.size >= WALLET_PNL_CLUSTER_HIGH_ROI_ENTRY_MIN_WALLETS;
}

function hasCoordinatedHighRoiEntryCluster(chain: ChainSlug, trades: WalletPnlTradeRecord[]): boolean {
  return coordinatedHighRoiEntryWallets(chain, buildWalletTokenPnlRows(chain, trades)).length >= WALLET_PNL_CLUSTER_HIGH_ROI_ENTRY_MIN_WALLETS;
}

function isHighRoiWalletTokenCluster(row: WalletTokenPnlSignalRow): boolean {
  return Boolean(
    row.roiPct !== undefined &&
    row.roiPct >= WALLET_PNL_CLUSTER_HIGH_ROI_PCT &&
    row.realizedCostUsd >= WALLET_PNL_CLUSTER_HIGH_ROI_MIN_COST_USD &&
    row.realizedProceedsUsd >= WALLET_PNL_CLUSTER_HIGH_ROI_MIN_PROCEEDS_USD
  );
}

function buildWalletTokenPnlRows(chain: ChainSlug, trades: WalletPnlTradeRecord[]): WalletTokenPnlSignalRow[] {
  const rows = new Map<string, WalletTokenPnlSignalRow>();
  const ordered = [...trades].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  for (const trade of ordered) {
    if (isWalletPnlIgnoredToken(chain, trade.tokenAddress, trade.tokenSymbol)) continue;
    const wallet = trade.wallet.toLowerCase();
    const tokenAddress = trade.tokenAddress.toLowerCase();
    const key = `${wallet}:${tokenAddress}`;
    const row = rows.get(key) ?? {
      wallet,
      tokenAddress,
      tokenSymbol: trade.tokenSymbol,
      tradeCount: 0,
      buyCount: 0,
      sellCount: 0,
      volumeUsd: 0,
      realizedPnlUsd: 0,
      realizedCostUsd: 0,
      realizedProceedsUsd: 0,
      quantity: 0,
      costUsd: 0
    };
    const valueUsd = finiteUsd(trade.volumeUsd);
    row.tradeCount += 1;
    row.volumeUsd += valueUsd;
    if (trade.side === "buy") {
      row.buyCount += 1;
      row.firstBuyBlock = row.firstBuyBlock === undefined ? trade.blockNumber : Math.min(row.firstBuyBlock, trade.blockNumber);
      row.quantity += trade.baseAmount;
      row.costUsd += valueUsd;
    } else {
      row.sellCount += 1;
      if (row.quantity > 0 && row.costUsd > 0 && trade.baseAmount > 0) {
        const soldQuantity = Math.min(row.quantity, trade.baseAmount);
        const soldRatio = soldQuantity / trade.baseAmount;
        const proceedsUsd = valueUsd * soldRatio;
        const costBasisUsd = (row.costUsd / row.quantity) * soldQuantity;
        row.realizedProceedsUsd += proceedsUsd;
        row.realizedCostUsd += costBasisUsd;
        row.realizedPnlUsd += proceedsUsd - costBasisUsd;
        row.quantity -= soldQuantity;
        row.costUsd = Math.max(0, row.costUsd - costBasisUsd);
      }
    }
    rows.set(key, row);
  }
  return [...rows.values()].map((row) => ({
    ...row,
    volumeUsd: roundUsd(row.volumeUsd),
    realizedPnlUsd: roundUsd(row.realizedPnlUsd),
    realizedCostUsd: roundUsd(row.realizedCostUsd),
    realizedProceedsUsd: roundUsd(row.realizedProceedsUsd),
    roiPct: row.realizedCostUsd > 0 ? roundPct((row.realizedPnlUsd / row.realizedCostUsd) * 100) : undefined
  }));
}

function coordinatedHighRoiEntryWallets(chain: ChainSlug, rows: WalletTokenPnlSignalRow[]): string[] {
  const byToken = new Map<string, WalletTokenPnlSignalRow[]>();
  for (const row of rows) {
    if (!isHighRoiWalletTokenCluster(row) || row.firstBuyBlock === undefined) continue;
    const tokenRows = byToken.get(row.tokenAddress) ?? [];
    tokenRows.push(row);
    byToken.set(row.tokenAddress, tokenRows);
  }
  const out: string[] = [];
  const windowBlocks = walletPnlHighRoiEntryWindowBlocks(chain);
  for (const tokenRows of byToken.values()) {
    tokenRows.sort((a, b) => (a.firstBuyBlock ?? 0) - (b.firstBuyBlock ?? 0));
    for (let start = 0; start < tokenRows.length; start += 1) {
      const first = tokenRows[start];
      const startBlock = first?.firstBuyBlock;
      if (startBlock === undefined) continue;
      const cluster: WalletTokenPnlSignalRow[] = [];
      for (let index = start; index < tokenRows.length; index += 1) {
        const row = tokenRows[index];
        if (!row || row.firstBuyBlock === undefined || row.firstBuyBlock - startBlock > windowBlocks) break;
        cluster.push(row);
      }
      if (cluster.length >= WALLET_PNL_CLUSTER_HIGH_ROI_ENTRY_MIN_WALLETS) {
        for (const row of cluster) {
          if (!out.includes(row.wallet)) out.push(row.wallet);
        }
      }
    }
  }
  return out;
}

function walletPnlHighRoiEntryWindowBlocks(chain: ChainSlug): number {
  return Math.max(1, Math.ceil((WALLET_PNL_CLUSTER_HIGH_ROI_ENTRY_WINDOW_MS / 1000) / blockSecondsFor(chain)));
}

function finiteUsd(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0;
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundPct(value: number): number {
  return Math.round(value * 100) / 100;
}

function shouldBackfillOverlapCluster(
  analytics: ReturnType<Storage["getWalletPnlAnalyticsSnapshot"]>,
  chain: ChainSlug,
  tokenAddress: string,
  tokenTrades: WalletPnlTradeRecord[],
  cohortTrades: WalletPnlTradeRecord[]
): boolean {
  const token = analytics?.tokens.find((item) => item.tokenAddress.toLowerCase() === tokenAddress.toLowerCase());
  const walletCount = new Set(tokenTrades.map((trade) => trade.wallet.toLowerCase())).size;
  if (hasCoordinatedHighRoiEntryCluster(chain, tokenTrades)) return true;
  if (hasHighRoiWalletTokenCohort(chain, tokenTrades)) return true;
  if (walletCount < 2) return false;
  return Boolean(
    (token && (token.suspiciousScore >= 35 || token.topWalletConcentrationPct >= 25 || token.avgTradesPerWallet >= 5)) ||
    sharedTokenCount(chain, cohortTrades, tokenAddress) > 0 ||
    tokenTrades.length >= 100
  );
}

function shouldBackfillCohortCluster(chain: ChainSlug, wallets: string[], trades: WalletPnlTradeRecord[]): boolean {
  if (hasCoordinatedHighRoiEntryCluster(chain, trades)) return true;
  if (hasHighRoiWalletTokenCohort(chain, trades)) return true;
  if (wallets.length < 2) return false;
  return sharedTokenCount(chain, trades) > 0 || sharedPoolCount(trades) > 0 || trades.length >= 100;
}

function sharedTokenCount(chain: ChainSlug, trades: WalletPnlTradeRecord[], excludeTokenAddress?: string): number {
  const excluded = excludeTokenAddress?.toLowerCase();
  const byToken = new Map<string, Set<string>>();
  for (const trade of trades) {
    const token = trade.tokenAddress.toLowerCase();
    if (token === excluded) continue;
    if (isWalletPnlIgnoredToken(chain, trade.tokenAddress, trade.tokenSymbol)) continue;
    const wallets = byToken.get(token) ?? new Set<string>();
    wallets.add(trade.wallet.toLowerCase());
    byToken.set(token, wallets);
  }
  return [...byToken.values()].filter((wallets) => wallets.size >= 2).length;
}

function sharedPoolCount(trades: WalletPnlTradeRecord[]): number {
  const byPool = new Map<string, Set<string>>();
  for (const trade of trades) {
    const wallets = byPool.get(trade.poolId.toLowerCase()) ?? new Set<string>();
    wallets.add(trade.wallet.toLowerCase());
    byPool.set(trade.poolId.toLowerCase(), wallets);
  }
  return [...byPool.values()].filter((wallets) => wallets.size >= 2).length;
}

async function walletPnlHistoricalTokenBuysCache(
  deps: WebDeps,
  chain: ChainSlug,
  options: {
    clusterKey: string;
    clusterLabel: string;
    wallets: string[];
    toBlock?: number;
    excludeTokenAddress?: string;
    forceBackfill?: boolean;
    shouldBackfill: boolean;
  }
): Promise<WalletPnlHistoricalTokenBuys | undefined> {
  const cached = deps.store.getWalletPnlHistoricalTokenBuys(chain, options.clusterKey);
  if (!options.shouldBackfill) return cached;
  if (!options.forceBackfill && cached && walletPnlHistoricalCacheFresh(cached)) return cached;

  const now = new Date().toISOString();
  if (!deps.env.walletPnlBlockscoutHistoricalBackfillEnabled) {
    const disabled = walletPnlHistoricalSnapshotBase(chain, options, "disabled", now, {
      error: "WALLET_PNL_BLOCKSCOUT_HISTORICAL_BACKFILL_ENABLED=false.",
      sampledWalletCount: 0
    });
    deps.store.setWalletPnlHistoricalTokenBuys(disabled);
    walletPnlSaveStoreLater(deps, "wallet pnl historical disabled cache");
    return disabled;
  }
  if (!deps.blockscoutClient) {
    const disabled = walletPnlHistoricalSnapshotBase(chain, options, "disabled", now, {
      error: "BLOCKSCOUT_API_KEY is not configured for historical token lookups."
    });
    deps.store.setWalletPnlHistoricalTokenBuys(disabled);
    walletPnlSaveStoreLater(deps, "wallet pnl historical disabled cache");
    return disabled;
  }
  if (options.toBlock === undefined) {
    const error = walletPnlHistoricalSnapshotBase(chain, options, "error", now, {
      error: "No wallet-PnL block cursor is available yet, so a one-month Blockscout range cannot be bounded."
    });
    deps.store.setWalletPnlHistoricalTokenBuys(error);
    walletPnlSaveStoreLater(deps, "wallet pnl historical error cache");
    return error;
  }

  const pendingRecently = cached?.status === "pending" && Date.now() - Date.parse(cached.updatedAt) < WALLET_PNL_HISTORICAL_PENDING_TTL_MS;
  if (!options.forceBackfill && pendingRecently) return cached;
  const pending = walletPnlHistoricalSnapshotBase(chain, options, "pending", now, {
    generatedAt: cached?.generatedAt,
    tokens: cached?.tokens ?? []
  });
  deps.store.setWalletPnlHistoricalTokenBuys(pending);
  walletPnlSaveStoreLater(deps, "wallet pnl historical pending cache");
  walletPnlScheduleHistoricalTokenBuyBackfill(deps, chain, options);
  return pending;
}

function walletPnlSaveStoreLater(deps: WebDeps, label: string): void {
  void deps.store.save().catch((error) => {
    deps.logger.warn({ err: serializeError(error) }, `${label} save failed`);
  });
}

function walletPnlHistoricalCacheFresh(snapshot: WalletPnlHistoricalTokenBuys): boolean {
  if (snapshot.status !== "ready") return false;
  return Date.now() - Date.parse(snapshot.updatedAt) < WALLET_PNL_HISTORICAL_CACHE_TTL_MS;
}

function walletPnlHistoricalPendingFresh(snapshot: WalletPnlHistoricalTokenBuys): boolean {
  return snapshot.status === "pending" && Date.now() - Date.parse(snapshot.updatedAt) < WALLET_PNL_HISTORICAL_PENDING_TTL_MS;
}

function walletPnlHistoricalSnapshotBase(
  chain: ChainSlug,
  options: {
    clusterKey: string;
    clusterLabel: string;
    wallets: string[];
    toBlock?: number;
  },
  status: WalletPnlHistoricalTokenBuys["status"],
  updatedAt: string,
  extra: Partial<WalletPnlHistoricalTokenBuys> = {}
): WalletPnlHistoricalTokenBuys {
  const toBlock = options.toBlock;
  const fromBlock = toBlock === undefined
    ? undefined
    : Math.max(0, toBlock - Math.ceil((WALLET_PNL_HISTORICAL_LOOKBACK_DAYS * 24 * 60 * 60) / blockSecondsFor(chain)));
  return {
    schemaVersion: 1,
    chain,
    clusterKey: options.clusterKey.toLowerCase(),
    clusterLabel: options.clusterLabel,
    status,
    source: "blockscout",
    lookbackDays: WALLET_PNL_HISTORICAL_LOOKBACK_DAYS,
    fromBlock,
    toBlock,
    walletCount: options.wallets.length,
    sampledWalletCount: options.wallets.length,
    wallets: options.wallets.map((wallet) => wallet.toLowerCase()),
    updatedAt,
    tokens: [],
    ...extra
  };
}

function walletPnlScheduleHistoricalTokenBuyBackfill(
  deps: WebDeps,
  chain: ChainSlug,
  options: {
    clusterKey: string;
    clusterLabel: string;
    wallets: string[];
    toBlock?: number;
    excludeTokenAddress?: string;
  }
): void {
  const key = `${chain}:${options.clusterKey.toLowerCase()}`;
  void walletPnlRunHistoricalTokenBuyBackfillLocked(deps, chain, options, key);
}

async function walletPnlRunHistoricalTokenBuyBackfillLocked(
  deps: WebDeps,
  chain: ChainSlug,
  options: {
    clusterKey: string;
    clusterLabel: string;
    wallets: string[];
    toBlock?: number;
    excludeTokenAddress?: string;
  },
  lockKey = `${chain}:${options.clusterKey.toLowerCase()}`
): Promise<boolean> {
  if (walletPnlHistoricalBackfills.has(lockKey)) return false;
  walletPnlHistoricalBackfills.add(lockKey);
  try {
    await walletPnlRunHistoricalTokenBuyBackfill(deps, chain, options);
    return true;
  } finally {
    walletPnlHistoricalBackfills.delete(lockKey);
  }
}

async function walletPnlRunHistoricalTokenBuyBackfill(
  deps: WebDeps,
  chain: ChainSlug,
  options: {
    clusterKey: string;
    clusterLabel: string;
    wallets: string[];
    toBlock?: number;
    excludeTokenAddress?: string;
  }
): Promise<void> {
  const now = new Date().toISOString();
  if (!deps.env.walletPnlBlockscoutHistoricalBackfillEnabled) {
    deps.store.setWalletPnlHistoricalTokenBuys(walletPnlHistoricalSnapshotBase(chain, options, "disabled", now, {
      error: "WALLET_PNL_BLOCKSCOUT_HISTORICAL_BACKFILL_ENABLED=false.",
      sampledWalletCount: 0
    }));
    await deps.store.save();
    return;
  }
  if (!deps.blockscoutClient) {
    deps.store.setWalletPnlHistoricalTokenBuys(walletPnlHistoricalSnapshotBase(chain, options, "disabled", now, {
      error: "BLOCKSCOUT_API_KEY is not configured for historical token lookups.",
      sampledWalletCount: 0
    }));
    await deps.store.save();
    return;
  }
  const toBlock = options.toBlock;
  if (toBlock === undefined) {
    deps.store.setWalletPnlHistoricalTokenBuys(walletPnlHistoricalSnapshotBase(chain, options, "error", now, {
      error: "No wallet-PnL block cursor is available yet, so a one-month Blockscout range cannot be bounded."
    }));
    await deps.store.save();
    return;
  }

  const fromBlock = Math.max(0, toBlock - Math.ceil((WALLET_PNL_HISTORICAL_LOOKBACK_DAYS * 24 * 60 * 60) / blockSecondsFor(chain)));
  const excluded = new Set<string>();
  if (options.excludeTokenAddress) excluded.add(options.excludeTokenAddress.toLowerCase());
  const byToken = new Map<string, {
    tokenAddress: string;
    tokenSymbol?: string;
    tokenName?: string;
    wallets: Set<string>;
    txs: Set<string>;
    transferCount: number;
    firstBlock?: number;
    lastBlock?: number;
  }>();

  try {
    for (const wallet of options.wallets) {
      const transfers = await deps.blockscoutClient.fetchAddressTokenTransfers({
        chain,
        address: wallet,
        startBlock: fromBlock,
        endBlock: toBlock,
        limit: WALLET_PNL_HISTORICAL_TRANSFERS_PER_WALLET
      });
      for (const transfer of transfers) {
        if (!isInboundTokenTransfer(transfer, wallet)) continue;
        const tokenAddress = transfer.tokenAddress.toLowerCase();
        if (excluded.has(tokenAddress)) continue;
        if (isWalletPnlIgnoredToken(chain, tokenAddress, transfer.tokenSymbol)) continue;
        const item = byToken.get(tokenAddress) ?? {
          tokenAddress,
          tokenSymbol: transfer.tokenSymbol,
          tokenName: transfer.tokenName,
          wallets: new Set<string>(),
          txs: new Set<string>(),
          transferCount: 0,
          firstBlock: transfer.blockNumber,
          lastBlock: transfer.blockNumber
        };
        item.wallets.add(wallet.toLowerCase());
        if (transfer.txHash) item.txs.add(transfer.txHash.toLowerCase());
        item.transferCount += 1;
        if (transfer.blockNumber !== undefined) {
          item.firstBlock = item.firstBlock === undefined ? transfer.blockNumber : Math.min(item.firstBlock, transfer.blockNumber);
          item.lastBlock = item.lastBlock === undefined ? transfer.blockNumber : Math.max(item.lastBlock, transfer.blockNumber);
        }
        if (!item.tokenSymbol) item.tokenSymbol = transfer.tokenSymbol;
        if (!item.tokenName) item.tokenName = transfer.tokenName;
        byToken.set(tokenAddress, item);
      }
    }
  } catch (error) {
    deps.logger.warn({ chain, wallets: options.wallets.length, err: serializeError(error) }, "wallet pnl Blockscout historical token backfill failed");
    deps.store.setWalletPnlHistoricalTokenBuys(walletPnlHistoricalSnapshotBase(chain, options, "error", new Date().toISOString(), {
      fromBlock,
      toBlock,
      error: (error as Error).message,
      tokens: []
    }));
    await deps.store.save();
    return;
  }

  const tokens = [...byToken.values()]
    .map((item) => ({
      tokenAddress: item.tokenAddress,
      tokenSymbol: item.tokenSymbol,
      tokenName: item.tokenName,
      walletCount: item.wallets.size,
      transferCount: item.transferCount,
      txCount: item.txs.size,
      firstBlock: item.firstBlock,
      lastBlock: item.lastBlock
    }))
    .sort((a, b) => b.walletCount - a.walletCount || b.transferCount - a.transferCount || (b.lastBlock ?? 0) - (a.lastBlock ?? 0))
    .slice(0, 100);

  deps.store.setWalletPnlHistoricalTokenBuys(walletPnlHistoricalSnapshotBase(chain, options, "ready", new Date().toISOString(), {
    generatedAt: new Date().toISOString(),
    fromBlock,
    toBlock,
    tokens
  }));
  await deps.store.save();
}

function isInboundTokenTransfer(transfer: BlockscoutTokenTransferRecord, wallet: string): boolean {
  const to = transfer.to?.toLowerCase();
  if (to !== wallet.toLowerCase()) return false;
  return tokenTransferHasPositiveValue(transfer.valueRaw);
}

function tokenTransferHasPositiveValue(valueRaw: string | undefined): boolean {
  if (!valueRaw) return false;
  try {
    return BigInt(valueRaw) > 0n;
  } catch {
    try {
      return BigInt(valueRaw.toLowerCase()) > 0n;
    } catch {
      return false;
    }
  }
}

function walletPnlIntelAccessFailure(_deps: WebDeps, _req: http.IncomingMessage, _returnPath: string): { status: number; body: string } | undefined {
  return undefined;
}

function walletPnlIntelGatePage(deps: WebDeps, returnPath: string, error?: string): string {
  const gate = walletPnlGateConfig(deps.env);
  if (!gate) {
    return intelHomePage({
      walletPnlChain: deps.env.walletPnlChain,
      walletPnlEnabled: deps.env.walletPnlEnabled
    });
  }
  const chainName = getChain(gate.chain).name;
  return walletPnlAdminGatePage({
    chainName,
    chainId: getChain(gate.chain).chainId,
    tokenAddress: gate.tokenAddress,
    minBalance: gate.minBalance,
    heading: "baes intel",
    copy: `Connect a wallet holding ${formatTokenBalanceForCopy(gate.minBalance)} or more $BAES on ${chainName}.`,
    returnPath,
    error
  });
}

async function handleWalletPnlGateChallenge(
  deps: WebDeps,
  req: http.IncomingMessage,
  url: URL,
  res: http.ServerResponse
): Promise<void> {
  const gate = walletPnlGateConfig(deps.env);
  if (!gate) return json(res, 410, { ok: false, error: "wallet PnL token gate is disabled" });
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("allow", "GET");
    return json(res, 405, { ok: false, error: "unsupported method" });
  }

  const address = parseWalletAddress(url.searchParams.get("address"));
  if (!address) return json(res, 400, { ok: false, error: "valid wallet address is required" });

  const expiresAt = new Date(Date.now() + WALLET_PNL_GATE_CHALLENGE_TTL_MS).toISOString();
  const message = walletPnlGateMessage({
    address,
    chainName: getChain(gate.chain).name,
    chainId: getChain(gate.chain).chainId,
    tokenAddress: gate.tokenAddress,
    minBalance: gate.minBalance,
    nonce: crypto.randomBytes(16).toString("base64url"),
    expiresAt
  });
  const challenge: WalletPnlGateChallenge = {
    address: address.toLowerCase(),
    chain: gate.chain,
    tokenAddress: gate.tokenAddress.toLowerCase(),
    message,
    expiresAt
  };
  res.setHeader("set-cookie", walletPnlGateChallengeCookie(deps.env, gate, challenge, isSecureRequest(req)));
  return json(res, 200, {
    ok: true,
    address,
    chain: gate.chain,
    chainId: getChain(gate.chain).chainId,
    tokenAddress: gate.tokenAddress,
    minBalance: gate.minBalance,
    message,
    expiresAt
  });
}

async function handleWalletPnlGateVerify(
  deps: WebDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const gate = walletPnlGateConfig(deps.env);
  if (!gate) return json(res, 410, { ok: false, error: "wallet PnL token gate is disabled" });
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    return json(res, 405, { ok: false, error: "unsupported method" });
  }

  let body = "";
  try {
    body = await readRequestBody(req, ADMIN_FORM_LIMIT_BYTES);
  } catch {
    return json(res, 413, { ok: false, error: "wallet gate request is too large" });
  }
  const submitted = parseWalletPnlGateVerifyBody(body);
  const address = parseWalletAddress(submitted.address);
  if (!address || !submitted.signature) return walletPnlGateVerifyFailure(res, 400, { ok: false, error: "wallet address and signature are required" });

  const challenge = walletPnlGateChallengeFromRequest(req, deps.env, gate);
  if (!challenge) return walletPnlGateVerifyFailure(res, 401, { ok: false, error: "wallet challenge expired; try connecting again" });
  if (!walletPnlGateChallengeMatches(challenge, gate, address)) {
    return walletPnlGateVerifyFailure(res, 401, { ok: false, error: "wallet challenge did not match this gate" });
  }

  let recovered: string;
  try {
    recovered = getAddress(verifyMessage(challenge.message, submitted.signature));
  } catch {
    return walletPnlGateVerifyFailure(res, 401, { ok: false, error: "wallet signature could not be verified" });
  }
  if (recovered.toLowerCase() !== address.toLowerCase()) {
    return walletPnlGateVerifyFailure(res, 401, { ok: false, error: "wallet signature did not match the connected address" });
  }

  let holderCheck: Awaited<ReturnType<typeof checkWalletPnlGateBalance>>;
  try {
    holderCheck = await checkWalletPnlGateBalance(deps, gate, address);
  } catch (error) {
    deps.logger.warn({ err: serializeError(error), chain: gate.chain }, "wallet pnl token gate balance check failed");
    return walletPnlGateVerifyFailure(res, 503, { ok: false, error: "token balance check failed; try again shortly" });
  }
  if (!holderCheck.authorized) {
    return walletPnlGateVerifyFailure(res, 403, {
      ok: false,
      error: `wallet does not hold the required ${gate.minBalance}+ token balance`,
      balance: holderCheck.balance,
      required: holderCheck.required
    });
  }

  res.setHeader("set-cookie", [
    walletPnlGateSessionCookie(deps.env, gate, address, isSecureRequest(req)),
    clearWalletPnlGateChallengeCookie()
  ]);
  return json(res, 200, { ok: true, address, chain: gate.chain });
}

function walletPnlGateVerifyFailure(res: http.ServerResponse, status: number, payload: unknown): void {
  res.setHeader("set-cookie", clearWalletPnlGateChallengeCookie());
  return json(res, status, payload);
}

async function handleCopyShadowAdmin(
  deps: WebDeps,
  req: http.IncomingMessage,
  url: URL,
  res: http.ServerResponse
): Promise<void> {
  const password = deps.env.webAdminPassword;
  if (url.searchParams.get("logout") === "1") {
    res.writeHead(303, {
      location: "/admin/copy-shadow",
      "set-cookie": [clearAdminSessionCookie(), clearLegacyAdminSessionCookie()],
      "cache-control": "no-store"
    });
    res.end();
    return;
  }

  if (!password) {
    return htmlStatus(res, 503, copyShadowAdminLoginPage({ configured: false }));
  }

  if (req.method === "POST") {
    let body = "";
    try {
      body = await readRequestBody(req, ADMIN_FORM_LIMIT_BYTES);
    } catch {
      return htmlStatus(res, 413, copyShadowAdminLoginPage({ configured: true, error: "Password request is too large." }));
    }
    const params = new URLSearchParams(body);
    if (!hasAdminSession(req, password)) {
      const submitted = params.get("password") ?? "";
      if (!isSameSecret(submitted, password)) {
        return htmlStatus(res, 401, copyShadowAdminLoginPage({ configured: true, error: "Password did not match." }));
      }
      res.writeHead(303, {
        location: "/admin/copy-shadow",
        "set-cookie": adminSessionCookie(password, isSecureRequest(req)),
        "cache-control": "no-store"
      });
      res.end();
      return;
    }

    const current = copyShadowAdminConfig(deps);
    if (params.get("action") === "stop") {
      deps.store.setCopyShadowConfig({
        ...current,
        enabled: false,
        updatedAt: new Date().toISOString()
      });
      await deps.store.save();
      res.writeHead(303, {
        location: "/admin/copy-shadow?saved=1",
        "cache-control": "no-store"
      });
      res.end();
      return;
    }

    const parsed = parseCopyShadowConfigForm(params, current);
    if ("error" in parsed) {
      return htmlStatus(res, 400, copyShadowAdminPage({
        config: current,
        snapshot: deps.store.getCopyShadowSnapshot(current.chain),
        error: parsed.error
      }));
    }
    deps.store.setCopyShadowConfig(parsed.config);
    if (parsed.config.enabled && parsed.config.wallets.length > 0) {
      const snapshot = buildCopyShadowSnapshotFromConfig({
        config: parsed.config,
        trades: deps.store.getWalletPnlTrades(parsed.config.chain, undefined, { trustedV4Hooks: deps.env.walletPnlTrustedV4Hooks })
      });
      deps.store.setCopyShadowSnapshot(snapshot);
    }
    await deps.store.save();
    res.writeHead(303, {
      location: "/admin/copy-shadow?saved=1",
      "cache-control": "no-store"
    });
    res.end();
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("allow", "GET, POST");
    return htmlStatus(res, 405, copyShadowAdminLoginPage({ configured: true, error: "Unsupported method." }));
  }

  if (!hasAdminSession(req, password)) {
    return htmlStatus(res, 401, copyShadowAdminLoginPage({ configured: true }));
  }

  const config = copyShadowAdminConfig(deps);
  return htmlStatus(res, 200, copyShadowAdminPage({
    config,
    snapshot: deps.store.getCopyShadowSnapshot(config.chain),
    saved: url.searchParams.get("saved") === "1"
  }));
}

function copyShadowAdminConfig(deps: WebDeps): CopyShadowConfig {
  const config = deps.store.getCopyShadowConfig() ?? copyShadowConfigFromEnv(deps.env);
  return {
    ...config,
    intervalMs: clampCopyShadowIntervalMs(config.intervalMs ?? deps.env.copyShadowIntervalMs)
  };
}

function parseCopyShadowConfigForm(
  params: URLSearchParams,
  current: CopyShadowConfig
): { config: CopyShadowConfig } | { error: string } {
  try {
    const chain = parseCopyShadowAdminChain(params.get("chain"));
    const wallets = parseCopyShadowAdminWallets(params.get("wallets") ?? "");
    const settings = current.settings;
    return {
      config: {
        schemaVersion: 1,
        enabled: params.get("enabled") === "on",
        chain,
        wallets,
        intervalMs: formNumber(params, "intervalSeconds", Math.floor((current.intervalMs ?? 60_000) / 1000), 30, 900, true) * 1000,
        settings: {
          tradeSizeUsd: formNumber(params, "tradeSizeUsd", settings.tradeSizeUsd, 1, 10_000),
          maxPositionUsd: formNumber(params, "maxPositionUsd", settings.maxPositionUsd, 1, 100_000),
          executionDelayBlocks: formNumber(params, "executionDelayBlocks", settings.executionDelayBlocks, 0, 10_000, true),
          maxPriceLookaheadBlocks: formNumber(params, "maxPriceLookaheadBlocks", settings.maxPriceLookaheadBlocks, 1, 50_000, true),
          slippageBps: formNumber(params, "slippageBps", settings.slippageBps, 0, 9_000),
          gasUsd: formNumber(params, "gasUsd", settings.gasUsd, 0, 100),
          minSourceVolumeUsd: formNumber(params, "minSourceVolumeUsd", settings.minSourceVolumeUsd, 0, 100_000_000)
        },
        recentSignalsLimit: formNumber(params, "recentSignalsLimit", current.recentSignalsLimit, 10, 1_000, true),
        positionLimit: formNumber(params, "positionLimit", current.positionLimit, 10, 1_000, true),
        updatedAt: new Date().toISOString()
      }
    };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

function parseCopyShadowAdminChain(raw: string | null): ChainSlug {
  const slug = raw?.trim().toLowerCase();
  if (!isChainSlug(slug)) throw new Error("Choose a supported EVM chain.");
  if (getChain(slug).kind !== "evm") throw new Error("Copy shadow only supports EVM chains.");
  return slug;
}

function parseCopyShadowAdminWallets(raw: string): string[] {
  const values = raw.split(/[\s,;]+/g).map((value) => value.trim()).filter(Boolean);
  if (values.length > 25) throw new Error("Copy shadow supports up to 25 watched wallets for now.");
  const out: string[] = [];
  for (const value of values) {
    let normalized: string;
    try {
      normalized = getAddress(value).toLowerCase();
    } catch {
      throw new Error(`Invalid wallet address: ${value}`);
    }
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out;
}

function formNumber(
  params: URLSearchParams,
  name: string,
  fallback: number,
  min: number,
  max: number,
  integer = false
): number {
  const raw = params.get(name)?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number.`);
  const normalized = integer ? Math.floor(parsed) : parsed;
  return Math.min(max, Math.max(min, normalized));
}

function clampCopyShadowIntervalMs(value: number): number {
  return Math.min(15 * 60_000, Math.max(30_000, Math.floor(value)));
}

function walletPnlSortFromUrl(url: URL): WalletPnlSort {
  const rawKey = url.searchParams.get("sort");
  const rawDir = url.searchParams.get("dir");
  const key: WalletPnlSortKey = isWalletPnlSortKey(rawKey) ? rawKey : "realized";
  const dir: WalletPnlSortDir = rawDir === "asc" ? "asc" : "desc";
  return { key, dir };
}

function isWalletPnlSortKey(value: string | null): value is WalletPnlSortKey {
  return value === "realized"
    || value === "roi"
    || value === "proceeds"
    || value === "cost"
    || value === "volume"
    || value === "trades"
    || value === "lastBlock";
}

async function handleContractCreator(
  deps: WebDeps,
  url: URL,
  res: http.ServerResponse,
  chain: ChainSlug,
  pathAddress?: string
): Promise<void> {
  const chainConfig = getChain(chain);
  if (chainConfig.kind !== "evm") return solanaNotSupportedJson(res);
  const rpc = deps.rpcs.get(chain);
  if (!rpc) return json(res, 503, { error: "RPC is not configured for this chain", code: "rpc_not_configured", chain });

  const addresses = contractCreatorAddressInputs(url, pathAddress);
  if (addresses.length === 0) {
    return json(res, 400, {
      error: "missing contract address",
      code: "missing_contract_address",
      hint: "/api/contract-creator/{chain}/{address} or /api/contract-creator/{chain}?addresses=0x..."
    });
  }
  if (addresses.length > CONTRACT_CREATOR_BATCH_LIMIT) {
    return json(res, 400, {
      error: `contract creator lookups are limited to ${CONTRACT_CREATOR_BATCH_LIMIT} addresses per request`,
      code: "too_many_addresses"
    });
  }

  const etherscanFormat = wantsEtherscanContractCreationFormat(url);
  const t0 = Date.now();
  deps.logger.info({ chain, route: "contract-creator", count: addresses.length }, "web: contract creator request");

  if (addresses.length === 1) {
    try {
      const result = await lookupContractCreator(chain, rpc, addresses[0]!, { blockscoutClient: deps.blockscoutClient });
      deps.logger.info(
        { chain, route: "contract-creator", address: result.address, source: result.source, durationMs: Date.now() - t0 },
        "web: contract creator response"
      );
      if (etherscanFormat) return json(res, 200, etherscanContractCreationPayload([result]), cacheSecondsForContractCreator(result));
      return json(res, 200, publicContractCreatorResult(result), cacheSecondsForContractCreator(result));
    } catch (error) {
      deps.logger.warn(
        { chain, route: "contract-creator", address: addresses[0], err: serializeError(error), durationMs: Date.now() - t0 },
        "web: contract creator lookup failed"
      );
      if (etherscanFormat) return json(res, 200, etherscanContractCreationError(error));
      if (error instanceof ContractCreatorLookupError) return json(res, error.statusCode, contractCreatorPublicError(error, addresses[0]));
      throw error;
    }
  }

  const results: ContractCreatorResult[] = [];
  const errors: Record<string, unknown>[] = [];
  for (const address of addresses) {
    try {
      results.push(await lookupContractCreator(chain, rpc, address, { blockscoutClient: deps.blockscoutClient }));
    } catch (error) {
      errors.push(contractCreatorPublicError(error, address));
    }
  }

  deps.logger.info(
    { chain, route: "contract-creator", count: addresses.length, results: results.length, errors: errors.length, durationMs: Date.now() - t0 },
    "web: contract creator batch response"
  );

  if (etherscanFormat) {
    if (results.length === 0) return json(res, 200, etherscanContractCreationError(errors[0]));
    return json(res, 200, etherscanContractCreationPayload(results), 300);
  }
  return json(res, 200, { chain, count: addresses.length, results: results.map(publicContractCreatorResult), errors }, errors.length === 0 ? 300 : 0);
}

function contractCreatorAddressInputs(url: URL, pathAddress?: string): string[] {
  const values: string[] = [];
  if (pathAddress) values.push(decodeURIComponent(pathAddress));
  for (const key of ["address", "addresses", "contractaddress", "contractaddresses"]) {
    for (const value of url.searchParams.getAll(key)) {
      values.push(...value.split(","));
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function wantsEtherscanContractCreationFormat(url: URL): boolean {
  const format = url.searchParams.get("format")?.trim().toLowerCase();
  if (format === "etherscan") return true;
  const module = url.searchParams.get("module")?.trim().toLowerCase();
  const action = url.searchParams.get("action")?.trim().toLowerCase();
  return module === "contract" && action === "getcontractcreation";
}

function etherscanContractCreationPayload(results: ContractCreatorResult[]): Record<string, unknown> {
  return {
    status: "1",
    message: "OK",
    result: results.map((result) => ({
      contractAddress: result.address,
      contractCreator: result.contractCreator,
      txHash: result.creationTxHash,
      blockNumber: result.creationBlock,
      transactionFrom: result.transactionFrom,
      confidence: result.confidence
    }))
  };
}

function publicContractCreatorResult(result: ContractCreatorResult): Record<string, unknown> {
  return {
    chain: result.chain,
    address: result.address,
    creator: result.creator,
    contractCreator: result.contractCreator,
    transactionFrom: result.transactionFrom,
    txHash: result.txHash,
    creationTxHash: result.creationTxHash,
    blockNumber: result.blockNumber,
    creationBlock: result.creationBlock,
    confidence: result.confidence,
    createdByContract: result.createdByContract,
    generatedAt: result.generatedAt,
    note: result.note
  };
}

function etherscanContractCreationError(error: unknown): Record<string, unknown> {
  const payload = contractCreatorPublicError(error);
  return {
    status: "0",
    message: String(payload.error ?? "NOTOK"),
    result: [],
    code: payload.code
  };
}

function cacheSecondsForContractCreator(result: ContractCreatorResult): number {
  return result.confidence === "high" ? 3600 : 300;
}

function publishSnapshot(deps: WebDeps, label: string, publish: () => Promise<unknown>): void {
  if (!deps.snapshotStore) return;
  if (deps.env.marketArchiveEnabled) return;
  void publish().catch((error) => {
    deps.logger.warn({ label, error: (error as Error).message }, "failed to publish market snapshot");
  });
}

function preloadStylesheetBundle(deps: WebDeps): void {
  if (stylesheetBundle || stylesheetBundleMissing) return;
  const candidates = [
    path.resolve(__dirname, "styles.css"),
    path.resolve(process.cwd(), "src", "web", "styles.css"),
    path.resolve(process.cwd(), "build", "web", "styles.css")
  ];
  for (const bundlePath of candidates) {
    try {
      stylesheetBundle = fs.readFileSync(bundlePath);
      deps.logger.info({ path: bundlePath, bytes: stylesheetBundle.byteLength }, "stylesheet cached");
      return;
    } catch {
      // Try the next dev/build candidate.
    }
  }
  stylesheetBundleMissing = true;
  deps.logger.warn({ candidates }, "stylesheet is not installed; pages will render without local CSS");
}

function handleStylesheet(res: http.ServerResponse): void {
  if (!stylesheetBundle) {
    return json(res, 404, {
      error: "stylesheet is not installed",
      hint: "Run npm run build so src/web/styles.css is copied to build/web/styles.css."
    });
  }
  res.writeHead(200, {
    "content-type": "text/css; charset=utf-8",
    "cache-control": "public, max-age=300"
  });
  res.end(stylesheetBundle);
}

function handleWebAsset(pathname: string, res: http.ServerResponse): void {
  const asset = readWebAsset(pathname);
  if (!asset) return json(res, 404, { error: "asset not found" });
  res.writeHead(200, {
    "content-type": contentTypeForWebAsset(asset.path),
    "cache-control": "public, max-age=31536000, immutable"
  });
  res.end(asset.body);
}

function readWebAsset(pathname: string): { path: string; body: Buffer } | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const relative = decoded.replace(/^\/+/, "");
  if (!/^og\/[a-z0-9._/-]+\.(png|jpe?g|webp|svg)$/i.test(relative)) return undefined;
  const candidates = [
    path.resolve(__dirname, relative),
    path.resolve(process.cwd(), "build", "web", relative),
    path.resolve(process.cwd(), "src", "web", "assets", relative)
  ];
  const roots = [
    path.resolve(__dirname),
    path.resolve(process.cwd(), "build", "web"),
    path.resolve(process.cwd(), "src", "web", "assets")
  ];
  for (let index = 0; index < candidates.length; index++) {
    const filePath = candidates[index]!;
    const root = roots[index]!;
    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) continue;
    try {
      return { path: filePath, body: fs.readFileSync(filePath) };
    } catch {
      // Try the next dev/build candidate.
    }
  }
  return undefined;
}

function contentTypeForWebAsset(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml; charset=utf-8";
  return "application/octet-stream";
}

function preloadGeneratedSeoFiles(deps: WebDeps): void {
  sitemapBundle = readGeneratedSeoFile("sitemap.xml");
  if (sitemapBundle) deps.logger.info({ bytes: sitemapBundle.byteLength }, "sitemap cached");
}

function readGeneratedSeoFile(fileName: string): Buffer | undefined {
  const candidates = [
    path.resolve(__dirname, fileName),
    path.resolve(process.cwd(), "build", "web", fileName)
  ];
  for (const filePath of candidates) {
    try {
      return fs.readFileSync(filePath);
    } catch {
      // Try the next build candidate.
    }
  }
  return undefined;
}

async function handleSitemap(res: http.ServerResponse, intelEnabled: boolean): Promise<void> {
  try {
    const body = await generatedSitemap(intelEnabled);
    return xml(res, body, 300);
  } catch {
    if (sitemapBundle) return xml(res, sitemapBundle, 300);
    throw new Error("failed to generate sitemap");
  }
}

function handleRobots(res: http.ServerResponse, intelEnabled: boolean): void {
  return text(res, Buffer.from(generateRobotsTxt(siteOriginFromEnv(), { intelEnabled }), "utf8"), 300);
}

async function generatedSitemap(intelEnabled: boolean): Promise<Buffer> {
  const now = Date.now();
  if (generatedSitemapCache && generatedSitemapCache.expiresAt > now && generatedSitemapCache.intelEnabled === intelEnabled) {
    return generatedSitemapCache.body;
  }
  const body = Buffer.from(await generateSitemapXml({ intelEnabled }), "utf8");
  generatedSitemapCache = { expiresAt: now + SITEMAP_CACHE_TTL_MS, intelEnabled, body };
  return body;
}

async function handleRaw(deps: WebDeps, url: URL, res: http.ServerResponse): Promise<void> {
  if (!deps.env.marketsEnabled) return marketDisabledJson(res);
  if (deps.env.publicMode || deps.env.marketArchiveEnabled) {
    return json(res, 410, {
      error: "request-driven raw RPC previews are disabled; use archived market endpoints",
      code: "raw_rpc_preview_disabled"
    });
  }
  const [, , , chainRaw, ...poolParts] = url.pathname.split("/");
  if (!isChainSlug(chainRaw)) return json(res, 400, { error: "invalid chain" });
  const poolId = decodeURIComponent(poolParts.join("/"));
  const chain = getChain(chainRaw);
  if (chain.kind !== "evm") return solanaNotSupportedJson(res);
  const pool = findStoredPool(deps.store, chainRaw, poolId);
  if (!pool) return json(res, 404, { error: "pool is not in local state yet", chain: chainRaw, poolId });
  const rpc = deps.rpcs.get(chainRaw);
  if (!rpc) return json(res, 503, { error: "RPC is not configured for this chain" });

  const latest = await rpc.getBlockNumber();
  const lookback = Math.min(1000, Math.max(1, Number(process.env.MOCK_CHART_LOOKBACK_BLOCKS ?? 250)));
  const fromBlock = Math.max(0, latest - deps.env.confirmations - lookback);
  const toBlock = Math.max(0, latest - deps.env.confirmations);
  const logs = await fetchSwapLogs(rpc, deps.env, chainRaw, [pool], fromBlock, toBlock);
  const quoteUsd = await deps.priceService.quoteUsdMultiplier(pool.currency1, chainRaw);
  return json(res, 200, {
    chain: chainRaw,
    pool,
    fromBlock,
    toBlock,
    swapLogCount: logs.length,
    quoteUsdMultiplier: quoteUsd,
    logs: logs.slice(-50).map((log) => ({
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      logIndex: log.index,
      address: log.address,
      topics: log.topics
    }))
  });
}

function findStoredPool(store: Storage, chain: ChainSlug, poolId: string): PoolKey | undefined {
  const key = poolId.toLowerCase();
  for (const chat of store.getAllChats()) {
    if ((chat.chain ?? "base") !== chain) continue;
    const pool = chat.pools[key] ?? Object.values(chat.pools).find((candidate) => candidate.id.toLowerCase() === key);
    if (pool) return pool;
  }
  return undefined;
}

function walletPnlGateConfig(env: Env): WalletPnlGateConfig | undefined {
  if (!env.walletPnlGateEnabled || !env.walletPnlGateTokenAddress) return undefined;
  return {
    chain: env.walletPnlGateChain,
    tokenAddress: env.walletPnlGateTokenAddress,
    minBalance: env.walletPnlGateMinBalance,
    sessionHours: env.walletPnlGateSessionHours
  };
}

function formatTokenBalanceForCopy(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return parsed.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function parseWalletAddress(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return getAddress(value.trim());
  } catch {
    return undefined;
  }
}

function parseWalletPnlGateVerifyBody(body: string): { address?: string; signature?: string } {
  const trimmed = body.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { address?: unknown; signature?: unknown };
      return {
        address: typeof parsed.address === "string" ? parsed.address : undefined,
        signature: typeof parsed.signature === "string" ? parsed.signature : undefined
      };
    } catch {
      return {};
    }
  }
  const params = new URLSearchParams(body);
  return {
    address: params.get("address") ?? undefined,
    signature: params.get("signature") ?? undefined
  };
}

function walletPnlGateMessage(options: {
  address: string;
  chainName: string;
  chainId?: number;
  tokenAddress: string;
  minBalance: string;
  nonce: string;
  expiresAt: string;
}): string {
  return [
    "baes scan intel access",
    "",
    `Wallet: ${options.address}`,
    `Chain: ${options.chainName}${options.chainId ? ` (${options.chainId})` : ""}`,
    `Token: ${options.tokenAddress}`,
    `Required balance: ${options.minBalance}+`,
    `Nonce: ${options.nonce}`,
    `Expires: ${options.expiresAt}`,
    "",
    "Signing this message proves wallet ownership only. It does not authorize a transaction."
  ].join("\n");
}

function walletPnlGateChallengeMatches(challenge: WalletPnlGateChallenge, gate: WalletPnlGateConfig, address: string): boolean {
  return challenge.address === address.toLowerCase()
    && challenge.chain === gate.chain
    && challenge.tokenAddress === gate.tokenAddress.toLowerCase()
    && Date.parse(challenge.expiresAt) > Date.now();
}

async function checkWalletPnlGateBalance(
  deps: WebDeps,
  gate: WalletPnlGateConfig,
  address: string
): Promise<{ authorized: boolean; balance: string; required: string; decimals: number }> {
  const rpc = deps.rpcs.get(gate.chain);
  if (!rpc) throw new Error(`RPC is not configured for wallet PnL gate chain: ${gate.chain}`);
  const decimals = await walletPnlGateTokenDecimals(rpc, gate.tokenAddress);
  const [balance, required] = await Promise.all([
    rpc.callContract<bigint>(gate.tokenAddress, ERC20_GATE_ABI, "balanceOf", [address]),
    Promise.resolve(parseUnits(gate.minBalance, decimals))
  ]);
  return {
    authorized: required > 0n ? balance >= required : balance > 0n,
    balance: balance.toString(),
    required: required.toString(),
    decimals
  };
}

async function walletPnlGateTokenDecimals(rpc: RpcPool, tokenAddress: string): Promise<number> {
  try {
    return normalizeTokenDecimals(await rpc.callContract<unknown>(tokenAddress, ERC20_GATE_ABI, "decimals"));
  } catch {
    return 18;
  }
}

function normalizeTokenDecimals(value: unknown): number {
  const parsed = typeof value === "bigint"
    ? Number(value)
    : typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : 18;
  if (!Number.isFinite(parsed)) return 18;
  return Math.min(36, Math.max(0, Math.floor(parsed)));
}

async function readRequestBody(req: http.IncomingMessage, limitBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > limitBytes) throw new Error("request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function hasAdminSession(req: http.IncomingMessage, password: string): boolean {
  const cookie = parseCookies(req.headers.cookie)[ADMIN_SESSION_COOKIE];
  return Boolean(cookie && isSameSecret(cookie, adminSessionToken(password)));
}

function hasWalletPnlGateSession(req: http.IncomingMessage, env: Env, gate: WalletPnlGateConfig): boolean {
  const cookie = parseCookies(req.headers.cookie)[WALLET_PNL_GATE_SESSION_COOKIE];
  const session = cookie ? verifySignedCookie<WalletPnlGateSession>(cookie, walletPnlGateCookieSecret(env, gate)) : undefined;
  if (!session) return false;
  return session.chain === gate.chain
    && session.tokenAddress === gate.tokenAddress.toLowerCase()
    && session.minBalance === gate.minBalance
    && Date.parse(session.expiresAt) > Date.now();
}

function walletPnlGateChallengeFromRequest(req: http.IncomingMessage, env: Env, gate: WalletPnlGateConfig): WalletPnlGateChallenge | undefined {
  const cookie = parseCookies(req.headers.cookie)[WALLET_PNL_GATE_CHALLENGE_COOKIE];
  if (!cookie) return undefined;
  const challenge = verifySignedCookie<WalletPnlGateChallenge>(cookie, walletPnlGateCookieSecret(env, gate));
  if (!challenge || Date.parse(challenge.expiresAt) <= Date.now()) return undefined;
  return challenge;
}

function adminSessionCookie(password: string, secure: boolean): string {
  const parts = [
    `${ADMIN_SESSION_COOKIE}=${adminSessionToken(password)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=86400"
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function walletPnlGateChallengeCookie(env: Env, gate: WalletPnlGateConfig, challenge: WalletPnlGateChallenge, secure: boolean): string {
  const parts = [
    `${WALLET_PNL_GATE_CHALLENGE_COOKIE}=${signedCookie(challenge, walletPnlGateCookieSecret(env, gate))}`,
    "Path=/intel",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.ceil(WALLET_PNL_GATE_CHALLENGE_TTL_MS / 1000)}`
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function walletPnlGateSessionCookie(env: Env, gate: WalletPnlGateConfig, address: string, secure: boolean): string {
  const session: WalletPnlGateSession = {
    address: address.toLowerCase(),
    chain: gate.chain,
    tokenAddress: gate.tokenAddress.toLowerCase(),
    minBalance: gate.minBalance,
    expiresAt: new Date(Date.now() + gate.sessionHours * 60 * 60_000).toISOString()
  };
  const parts = [
    `${WALLET_PNL_GATE_SESSION_COOKIE}=${signedCookie(session, walletPnlGateCookieSecret(env, gate))}`,
    "Path=/intel",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${gate.sessionHours * 60 * 60}`
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function clearAdminSessionCookie(): string {
  return `${ADMIN_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function clearLegacyAdminSessionCookie(): string {
  return `${ADMIN_SESSION_COOKIE}=; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function clearLegacyWalletPnlGateChallengeCookie(): string {
  return `${WALLET_PNL_GATE_CHALLENGE_COOKIE}=; Path=/admin/wallet-pnl; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function clearLegacyWalletPnlGateSessionCookie(): string {
  return `${WALLET_PNL_GATE_SESSION_COOKIE}=; Path=/admin/wallet-pnl; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function clearWalletPnlGateChallengeCookie(): string {
  return `${WALLET_PNL_GATE_CHALLENGE_COOKIE}=; Path=/intel; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function clearWalletPnlGateSessionCookie(): string {
  return `${WALLET_PNL_GATE_SESSION_COOKIE}=; Path=/intel; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function clearLegacyIntelWalletPnlGateChallengeCookie(): string {
  return `${WALLET_PNL_GATE_CHALLENGE_COOKIE}=; Path=/intel/wallet-pnl; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function clearLegacyIntelWalletPnlGateSessionCookie(): string {
  return `${WALLET_PNL_GATE_SESSION_COOKIE}=; Path=/intel/wallet-pnl; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function clearWalletPnlAdminCookies(): string[] {
  return [
    clearAdminSessionCookie(),
    clearLegacyAdminSessionCookie(),
    clearWalletPnlGateChallengeCookie(),
    clearWalletPnlGateSessionCookie(),
    clearLegacyIntelWalletPnlGateChallengeCookie(),
    clearLegacyIntelWalletPnlGateSessionCookie(),
    clearLegacyWalletPnlGateChallengeCookie(),
    clearLegacyWalletPnlGateSessionCookie()
  ];
}

function adminSessionToken(password: string): string {
  return crypto.createHash("sha256").update(`baes-wallet-pnl-admin:${password}`).digest("base64url");
}

function walletPnlGateCookieSecret(env: Env, gate: WalletPnlGateConfig): string {
  const secret = env.intelSessionSecret ?? `${gate.chain}:${gate.tokenAddress.toLowerCase()}:${gate.minBalance}`;
  return crypto.createHash("sha256").update(`baes-intel-gate:${secret}`).digest("base64url");
}

function signedCookie(payload: unknown, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${signCookiePayload(encoded, secret)}`;
}

function verifySignedCookie<T>(value: string, secret: string): T | undefined {
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return undefined;
  const encoded = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  if (!isSameSecret(signature, signCookiePayload(encoded, secret))) return undefined;
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as T;
  } catch {
    return undefined;
  }
}

function signCookiePayload(encoded: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
}

function isSameSecret(left: string, right: string): boolean {
  const leftHash = crypto.createHash("sha256").update(left).digest();
  const rightHash = crypto.createHash("sha256").update(right).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    cookies[key] = value;
  }
  return cookies;
}

function isSecureRequest(req: http.IncomingMessage): boolean {
  const proto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim().toLowerCase();
  return proto === "https" || Boolean((req.socket as { encrypted?: boolean }).encrypted);
}

function json(res: http.ServerResponse, status: number, payload: unknown, cacheSeconds = 0): void {
  const body = JSON.stringify(payload, jsonReplacer, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : "no-store"
  });
  res.end(body);
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function marketDisabledJson(res: http.ServerResponse): void {
  return json(res, 410, {
    error: "market board is disabled",
    code: "markets_disabled"
  });
}

function solanaNotSupportedJson(res: http.ServerResponse): void {
  return json(res, 410, {
    error: "Solana is not currently supported by baes scan",
    code: "solana_not_supported"
  });
}

function notFound(res: http.ServerResponse): void {
  res.writeHead(404, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end("<!doctype html><title>Not found</title><body>Not found.</body>");
}

function html(res: http.ServerResponse, body: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function htmlStatus(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function marketDisabledHtml(res: http.ServerResponse): void {
  res.writeHead(410, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end("<!doctype html><title>Markets disabled</title><body>Market pages are disabled.</body>");
}

function xml(res: http.ServerResponse, body: Buffer, cacheSeconds: number): void {
  res.writeHead(200, {
    "content-type": "application/xml; charset=utf-8",
    "cache-control": `public, max-age=${cacheSeconds}`
  });
  res.end(body);
}

function text(res: http.ServerResponse, body: Buffer, cacheSeconds: number): void {
  res.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": `public, max-age=${cacheSeconds}`
  });
  res.end(body);
}

function redirect(res: http.ServerResponse, location: string): void {
  res.writeHead(308, {
    location,
    "cache-control": "public, max-age=300"
  });
  res.end();
}

function serializeError(error: unknown): { message: string; name?: string; stack?: string } {
  if (error instanceof Error) {
    return { message: error.message, name: error.name, stack: error.stack };
  }
  if (typeof error === "string") return { message: error };
  try { return { message: JSON.stringify(error) }; }
  catch { return { message: String(error) }; }
}

function httpStatusForError(error: unknown): number {
  const status = typeof error === "object" && error !== null && "statusCode" in error
    ? Number((error as { statusCode?: unknown }).statusCode)
    : undefined;
  if (status && Number.isInteger(status) && status >= 400 && status <= 599) return status;
  return 500;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

function cachedHtml(key: string, build: () => string): string {
  const now = Date.now();
  const cached = htmlCache.get(key);
  if (cached && cached.expiresAt > now) return cached.body;
  const body = build();
  htmlCache.set(key, { expiresAt: now + HTML_CACHE_TTL_MS, body });
  return body;
}
