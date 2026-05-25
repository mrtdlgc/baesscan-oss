import { getChain } from "../../chains/registry";
import type { Env } from "../../config/env";
import type {
  WalletPnlAnalyticsPnlLeader,
  WalletPnlAnalyticsPoolSummary,
  WalletPnlAnalyticsSignalWallet,
  WalletPnlAnalyticsSnapshot,
  WalletPnlAnalyticsTokenSummary,
  WalletPnlAnalyticsWalletSummary,
  WalletPnlCursor,
  WalletPnlClusterRecord,
  WalletPnlHistoricalTokenBuys,
  WalletPnlPoolRecord,
  WalletPnlSnapshot,
  WalletPnlTradeRecord
} from "../../store/storage";
import { blockscoutWalletUrl, dexscreenerTokenUrl, gmgnTokenUrl, gmgnWalletUrl, isWalletPnlIgnoredToken } from "../../services/walletPnlFilters";
import type { ChainSlug } from "../../types";
import { poolV4Hook, untrustedV4Hook } from "../../services/v4HookRisk";
import { shortAddress } from "../../utils/address";
import { blockSecondsFor } from "../markets/config";
import { displayTokenTicker, tokenTickerTitle } from "../tokenDisplay";
import { escapeAttr, escapeText, page } from "./shared";

type WalletPnlAnalyticsEnv = Pick<Env, "walletPnlChain" | "walletPnlEnabled" | "walletPnlAnalyticsIntervalMs" | "walletPnlNewTokensIntervalMs" | "walletPnlTrustedV4Hooks">;
const HIGH_ROI_CLUSTER_PCT = 200;
const HIGH_ROI_CLUSTER_MIN_COST_USD = 25;
const HIGH_ROI_CLUSTER_MIN_PROCEEDS_USD = 50;
const HIGH_ROI_ENTRY_CLUSTER_WINDOW_MS = 5 * 60_000;
const HIGH_ROI_ENTRY_CLUSTER_MIN_WALLETS = 2;

type AnalyticsActivePage =
  | "overview"
  | "tokens"
  | "new-tokens"
  | "risk-tokens"
  | "risk-wallets"
  | "token"
  | "wallet"
  | "pool"
  | "pools"
  | "leaderboards"
  | "signals"
  | "overlap"
  | "cohort"
  | "status";

interface AnalyticsPageOptions {
  env: WalletPnlAnalyticsEnv;
  analytics?: WalletPnlAnalyticsSnapshot;
  snapshot?: WalletPnlSnapshot;
  cursor?: WalletPnlCursor;
  persistedClusters?: WalletPnlClusterRecord[];
  newTokens?: WalletPnlAnalyticsTokenSummary[];
  newTokensToBlock?: number;
  newTokensGeneratedAt?: string;
  newTokensSource?: "cache" | "live";
}

interface TokenDetailOptions extends AnalyticsPageOptions {
  tokenAddress: string;
  trades: WalletPnlTradeRecord[];
}

interface WalletDetailOptions extends AnalyticsPageOptions {
  wallet: string;
  trades: WalletPnlTradeRecord[];
}

interface PoolDetailOptions extends AnalyticsPageOptions {
  poolId: string;
  pool?: WalletPnlPoolRecord;
  trades: WalletPnlTradeRecord[];
}

interface TokenWalletsOptions extends AnalyticsPageOptions {
  tokenAddress: string;
  trades: WalletPnlTradeRecord[];
  sort: TokenWalletSort;
}

interface OverlapPageOptions extends AnalyticsPageOptions {
  tokenAddress?: string;
  tokenTrades?: WalletPnlTradeRecord[];
  cohortTrades?: WalletPnlTradeRecord[];
  historicalBuys?: WalletPnlHistoricalTokenBuys;
  walletLimit: number;
  walletCount: number;
}

interface CohortPageOptions extends AnalyticsPageOptions {
  wallets: string[];
  trades: WalletPnlTradeRecord[];
  historicalBuys?: WalletPnlHistoricalTokenBuys;
  clusterLabel?: string;
}

interface LeaderboardPageOptions extends AnalyticsPageOptions {
  kind: LeaderboardKind;
}

export type LeaderboardKind = "pnl" | "roi" | "volume";
export type TokenWalletSort = "pnl" | "roi" | "losers" | "volume" | "earliest" | "roundtrip";

interface TokenWalletRow {
  wallet: string;
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  volumeUsd: number;
  realizedPnlUsd: number;
  realizedCostUsd: number;
  realizedProceedsUsd: number;
  roiPct?: number;
  netBaseAmount: number;
  firstBlock: number;
  lastBlock: number;
  firstBuyBlock?: number;
}

interface SuspiciousTokenClusterRow {
  id: string;
  label: string;
  reason: string;
  clusterScore: number;
  wallets: string[];
  walletCount: number;
  volumeUsd: number;
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  realizedPnlUsd: number;
  realizedCostUsd: number;
  realizedProceedsUsd: number;
  minRoiPct?: number;
  maxRoiPct?: number;
  netBaseAmount: number;
  firstBuyBlock?: number;
  lastBuyBlock?: number;
}

interface RiskWalletClusterRow {
  id: string;
  label: string;
  reason: string;
  clusterScore: number;
  wallets: string[];
  walletCount: number;
  volumeUsd: number;
  tradeCount: number;
  tokenCount: number;
  topTokenAddress?: string;
  topTokenSymbol?: string;
  topPoolId?: string;
  avgSymmetryPct?: number;
  avgTokenConcentrationPct?: number;
  avgPoolConcentrationPct?: number;
}

interface WalletClusterSource {
  label: string;
  wallets: string[];
}

interface WalletClusterSignal {
  label: string;
  wallets: string[];
}

interface WalletClusterSignals {
  byWallet: Map<string, WalletClusterSignal[]>;
}

interface WalletTokenRow {
  tokenAddress: string;
  tokenSymbol: string;
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  volumeUsd: number;
  realizedPnlUsd: number;
  realizedCostUsd: number;
  realizedProceedsUsd: number;
  roiPct?: number;
  netBaseAmount: number;
  firstBlock: number;
  lastBlock: number;
}

interface CohortWalletRow {
  wallet: string;
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  tokenCount: number;
  poolCount: number;
  volumeUsd: number;
  realizedPnlUsd: number;
  realizedCostUsd: number;
  realizedProceedsUsd: number;
  roiPct?: number;
  firstBlock?: number;
  lastBlock?: number;
  topTokenAddress?: string;
  topTokenSymbol?: string;
  topTokenVolumeUsd: number;
  topTokenConcentrationPct?: number;
}

interface CohortTokenRow {
  tokenAddress: string;
  tokenSymbol: string;
  walletCount: number;
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  volumeUsd: number;
  topWalletVolumeUsd: number;
  topWalletConcentrationPct: number;
  firstBlock: number;
  lastBlock: number;
}

interface CohortPoolRow {
  poolId: string;
  dex: string;
  protocol: string;
  walletCount: number;
  tradeCount: number;
  volumeUsd: number;
  firstBlock: number;
  lastBlock: number;
}

interface PoolRow {
  poolId: string;
  dex: string;
  protocol: string;
  tradeCount: number;
  walletCount: number;
  buyCount: number;
  sellCount: number;
  volumeUsd: number;
  firstBlock: number;
  lastBlock: number;
}

export function walletPnlPersistableClustersFromAnalytics(
  chain: ChainSlug,
  analytics: WalletPnlAnalyticsSnapshot | undefined
): WalletPnlClusterRecord[] {
  if (!analytics) return [];
  const timestamp = analytics.generatedAt;
  const riskClusters = buildRiskWalletClusters(chain, visibleAnalyticsWallets(chain, analytics.riskWallets))
    .filter((cluster) => cluster.topTokenAddress || cluster.topPoolId)
    .map((cluster) => riskWalletClusterRecord(chain, cluster, timestamp));
  return uniqueClusterRecords([
    ...riskClusters,
    ...buildLeaderboardClusterRecords(chain, analytics, timestamp)
  ]);
}

export function walletPnlPersistableClustersFromTokenTrades(
  chain: ChainSlug,
  analytics: WalletPnlAnalyticsSnapshot | undefined,
  tokenAddress: string,
  trades: WalletPnlTradeRecord[]
): WalletPnlClusterRecord[] {
  const token = findToken(analytics, tokenAddress);
  const tokenSymbol = token?.tokenSymbol ?? trades[0]?.tokenSymbol;
  const tokenLabel = displayTokenTicker(tokenSymbol, tokenAddress);
  const timestamp = walletPnlClusterTimestamp(analytics, trades);
  return uniqueClusterRecords(buildSuspiciousTokenClusters(chain, buildTokenWalletRows(trades), tokenLabel)
    .map((cluster) => suspiciousTokenClusterRecord(chain, tokenAddress, tokenSymbol, cluster, timestamp)));
}

export function walletPnlTokensPage(options: AnalyticsPageOptions): string {
  const analytics = options.analytics;
  const rows = visibleAnalyticsTokens(options.env.walletPnlChain, analytics)
    .slice(0, 250)
    .map((token) => renderTokenRow(options.env.walletPnlChain, token))
    .join("");
  return analyticsShell({
    env: options.env,
    analytics,
    cursor: options.cursor,
    active: "tokens",
    title: "Wallet PnL tokens",
    eyebrow: "Premium wallet ledger",
    heading: "Tokens",
    body: `
      ${renderAnalyticsSummary(options)}
      <section class="board-card admin-wallet-card" aria-label="Token analytics table">
        <div class="admin-table-toolbar">
          <span>Top retained tokens by volume</span>
          <span class="source-pill">Cached snapshot</span>
          <a class="admin-sort-chip" href="/intel/wallet-pnl/tokens/new">New tokens</a>
        </div>
        <div class="table-scroll">
          <table class="dex-table admin-wallet-table">
            <thead>
              <tr>
                <th>Token</th>
                <th>Created through</th>
                <th class="num">Volume</th>
                <th class="num">Trades</th>
                <th class="num">Wallets</th>
                <th class="num">Pools</th>
                <th class="num">Buy/Sell</th>
                <th class="num">Top wallet</th>
                <th class="num">Risk</th>
                <th>Hook</th>
                <th>DEXes</th>
                <th>Open</th>
              </tr>
            </thead>
            <tbody>
              ${rows || emptyRow(12, analytics ? "No token analytics are stored yet." : "No cached analytics snapshot is available yet.")}
            </tbody>
          </table>
        </div>
      </section>
    `
  });
}

export function walletPnlNewTokensPage(options: AnalyticsPageOptions): string {
  const analytics = options.analytics;
  const liveRows = options.newTokens ? visibleAnalyticsTokenRows(options.env.walletPnlChain, options.newTokens) : undefined;
  const toBlock = Math.max(
    options.newTokensToBlock ?? 0,
    analytics?.toBlock ?? 0,
    ...(liveRows ?? []).map((token) => token.lastBlock)
  );
  const analysisCadence = formatCadence(options.env.walletPnlNewTokensIntervalMs);
  const sourceLabel = options.newTokensSource === "live"
    ? "Live indexed"
    : options.newTokensSource === "cache"
      ? `${analysisCadence} cache`
      : "Cached snapshot";
  const tokensForRows = liveRows ?? visibleAnalyticsTokens(options.env.walletPnlChain, analytics);
  const rows = tokensForRows
    .slice()
    .sort((a, b) => b.firstBlock - a.firstBlock || b.lastBlock - a.lastBlock || b.volumeUsd - a.volumeUsd)
    .slice(0, 250)
    .map((token) => renderNewTokenRow(options.env.walletPnlChain, token, toBlock || token.lastBlock))
    .join("");
  return analyticsShell({
    env: options.env,
    analytics,
    cursor: options.cursor,
    active: "new-tokens",
    title: "Wallet PnL new tokens",
    eyebrow: "Cached token discovery",
    heading: "New Tokens",
    body: `
      ${renderNewTokensSummary(options, sourceLabel, tokensForRows.length)}
      <section class="board-card admin-wallet-card" aria-label="New token analytics table">
        <div class="admin-table-toolbar">
          <span>Newest tokens from the retained wallet-ledger window</span>
          <span class="source-pill">${escapeText(sourceLabel)}</span>
          <a class="admin-sort-chip" href="/intel/wallet-pnl/tokens">Volume tokens</a>
        </div>
        <p class="admin-inline-note">This is not a live deployment-discovery feed. It is a token-gated ${escapeText(analysisCadence)} cache for reviewing newly surfaced tokens, wallet clusters, and early risk signals from the retained wallet-PnL ledger.</p>
        <div class="table-scroll">
          <table class="dex-table admin-wallet-table">
            <thead>
              <tr>
                <th>Token</th>
                <th>Created through</th>
                <th class="num">First seen</th>
                <th class="num">Last active</th>
                <th class="num">Age</th>
                <th class="num">Volume</th>
                <th class="num">Trades</th>
                <th class="num">Wallets</th>
                <th class="num">Pools</th>
                <th class="num">Risk</th>
                <th>Hook</th>
                <th>Open</th>
              </tr>
            </thead>
            <tbody>
              ${rows || emptyRow(12, analytics ? "No new token rows are available yet." : "No cached analytics snapshot is available yet.")}
            </tbody>
          </table>
        </div>
      </section>
    `
  });
}

export function walletPnlRiskTokensPage(options: AnalyticsPageOptions): string {
  const analytics = options.analytics;
  const rows = visibleAnalyticsTokens(options.env.walletPnlChain, analytics)
    .filter((token) => token.tradeCount >= 20 || token.volumeUsd >= 10_000)
    .sort((a, b) => b.suspiciousScore - a.suspiciousScore || b.volumeUsd - a.volumeUsd)
    .slice(0, 250)
    .map((token) => renderRiskTokenRow(options.env.walletPnlChain, token))
    .join("");
  return analyticsShell({
    env: options.env,
    analytics,
    cursor: options.cursor,
    active: "risk-tokens",
    title: "Wallet PnL token risk",
    eyebrow: "Premium wallet ledger",
    heading: "Token Risk",
    body: `
      ${renderAnalyticsSummary(options)}
      <section class="board-card admin-wallet-card" aria-label="Token risk table">
        <div class="admin-table-toolbar">
          <span>High-churn token signals</span>
          <span class="source-pill">Cached snapshot</span>
        </div>
        <div class="table-scroll">
          <table class="dex-table admin-wallet-table">
            <thead>
              <tr>
                <th>Token</th>
                <th>Created through</th>
                <th class="num">Risk</th>
                <th class="num">Symmetry</th>
                <th class="num">Top wallet</th>
                <th class="num">Trades/wallet</th>
                <th class="num">Trades/tx</th>
                <th class="num">Volume</th>
                <th class="num">Wallets</th>
                <th>Hook</th>
                <th>Open</th>
              </tr>
            </thead>
            <tbody>
              ${rows || emptyRow(11, analytics ? "No token risk rows match the current filters." : "No cached analytics snapshot is available yet.")}
            </tbody>
          </table>
        </div>
      </section>
    `
  });
}

export function walletPnlRiskWalletsPage(options: AnalyticsPageOptions): string {
  const analytics = options.analytics;
  const clusters = mergeRiskWalletClusters(
    buildRiskWalletClusters(options.env.walletPnlChain, visibleAnalyticsWallets(options.env.walletPnlChain, analytics?.riskWallets)),
    riskWalletRowsFromPersistedClusters(options.env.walletPnlChain, options.persistedClusters)
  );
  const rows = clusters
    .slice(0, 250)
    .map(renderRiskWalletClusterRow)
    .join("");
  return analyticsShell({
    env: options.env,
    analytics,
    cursor: options.cursor,
    active: "risk-wallets",
    title: "Wallet PnL wallet risk",
    eyebrow: "Premium wallet ledger",
    heading: "Wallet Risk",
    body: `
      ${renderAnalyticsSummary(options)}
      <section class="board-card admin-wallet-card" aria-label="Wallet risk clusters table">
        <div class="admin-table-toolbar">
          <span>High-frequency wallet clusters</span>
          <span class="source-pill">${fmtInt(clusters.length)} cached clusters</span>
        </div>
        <div class="table-scroll">
          <table class="dex-table admin-wallet-table">
            <thead>
              <tr>
                <th>Cluster</th>
                <th class="num">Risk</th>
                <th>Reason</th>
                <th class="num">Wallets</th>
                <th class="num">Volume</th>
                <th class="num">Trades</th>
                <th class="num">Tokens</th>
                <th class="num">Top token</th>
                <th class="num">Top pool</th>
                <th class="num">Symmetry</th>
                <th>Open</th>
              </tr>
            </thead>
            <tbody>
              ${rows || emptyRow(11, analytics ? "No multi-wallet risk clusters are stored yet." : "No cached analytics snapshot is available yet.")}
            </tbody>
          </table>
        </div>
      </section>
    `
  });
}

export function walletPnlLeaderboardsPage(options: LeaderboardPageOptions): string {
  const heading = options.kind === "roi"
    ? "ROI Leaders"
    : options.kind === "volume"
      ? "Volume Leaders"
      : "PnL Leaders";
  const clusterSignals = buildWalletClusterSignals(options.env.walletPnlChain, options.analytics, [], options.persistedClusters);
  const rows = options.kind === "volume"
    ? visibleAnalyticsWallets(options.env.walletPnlChain, options.analytics?.volumeWallets ?? options.analytics?.riskWallets)
      .slice()
      .sort((a, b) => b.volumeUsd - a.volumeUsd || b.tradeCount - a.tradeCount)
      .slice(0, 250)
      .map((wallet) => renderVolumeWalletRow(options.env.walletPnlChain, wallet, clusterSignals))
      .join("")
    : (options.kind === "roi" ? options.analytics?.roiLeaders : options.analytics?.pnlLeaders)
      ?.filter((row) => !isWalletPnlIgnoredToken(options.env.walletPnlChain, row.tokenAddress, row.tokenSymbol))
      .slice(0, 250)
      .map((row) => renderPnlLeaderRow(options.env.walletPnlChain, row, clusterSignals))
      .join("") ?? "";
  return analyticsShell({
    env: options.env,
    analytics: options.analytics,
    snapshot: options.snapshot,
    cursor: options.cursor,
    active: "leaderboards",
    title: `Wallet PnL ${heading}`,
    eyebrow: "Cached leaderboards",
    heading,
    body: `
      ${renderAnalyticsSummary(options)}
      <section class="board-card admin-wallet-card" aria-label="Wallet PnL leaderboard">
        <div class="admin-table-toolbar">
          <span>${escapeText(heading)}</span>
          <a class="admin-sort-chip${options.kind === "pnl" ? " is-active" : ""}" href="/intel/wallet-pnl/leaderboards/pnl">PnL</a>
          <a class="admin-sort-chip${options.kind === "roi" ? " is-active" : ""}" href="/intel/wallet-pnl/leaderboards/roi">ROI</a>
          <a class="admin-sort-chip${options.kind === "volume" ? " is-active" : ""}" href="/intel/wallet-pnl/leaderboards/volume">Volume</a>
        </div>
        <div class="table-scroll">
          <table class="dex-table admin-wallet-table">
            <thead>
              ${options.kind === "volume" ? `
                <tr>
                  <th>Wallet</th>
                  <th class="num">Volume</th>
                  <th class="num">Trades</th>
                  <th class="num">Tokens</th>
                  <th class="num">Top token</th>
                  <th class="num">Top pool</th>
                  <th class="num">Risk</th>
                  <th>Open</th>
                </tr>
              ` : `
                <tr>
                  <th>Wallet</th>
                  <th>Token</th>
                  <th class="num">Realized PnL</th>
                  <th class="num">ROI</th>
                  <th class="num">Proceeds</th>
                  <th class="num">Cost</th>
                  <th class="num">Volume</th>
                  <th class="num">Trades</th>
                  <th>Open</th>
                </tr>
              `}
            </thead>
            <tbody>
              ${rows || emptyRow(options.kind === "volume" ? 8 : 9, "No cached leaderboard rows are available yet.")}
            </tbody>
          </table>
        </div>
      </section>
    `
  });
}

export function walletPnlSignalsPage(options: AnalyticsPageOptions): string {
  const chain = options.env.walletPnlChain;
  const allSignalWallets = visibleGoodSignalWallets(chain, options.analytics);
  const signalWallets = allSignalWallets.slice(0, 250);
  const clusterSignals = buildWalletClusterSignals(chain, options.analytics, [], options.persistedClusters);
  const rows = signalWallets
    .map((wallet) => renderGoodSignalWalletRow(chain, wallet, clusterSignals))
    .join("");
  return analyticsShell({
    env: options.env,
    analytics: options.analytics,
    snapshot: options.snapshot,
    cursor: options.cursor,
    active: "signals",
    title: "Wallet PnL signals",
    eyebrow: "Wallet signals",
    heading: "Wallet Signals",
    body: `
      ${renderWalletSignalSummary(options, allSignalWallets)}
      <section class="board-card admin-wallet-card" aria-label="Wallet signals">
        <div class="admin-table-toolbar">
          <span>Signal wallets</span>
          <span class="source-pill">Cached snapshot</span>
        </div>
        <div class="table-scroll">
          <table class="dex-table admin-wallet-table">
            <thead>
              <tr>
                <th>Wallet</th>
                <th class="num">Signal</th>
                <th class="num">Realized PnL</th>
                <th class="num">ROI</th>
                <th class="num">Win rate</th>
                <th class="num">Wins / losses</th>
                <th class="num">Hook trades</th>
                <th class="num">Profit factor</th>
                <th>Top wins</th>
                <th class="num">Risk</th>
                <th>Open</th>
              </tr>
            </thead>
            <tbody>
              ${rows || emptyRow(11, "No cached signal wallets are available yet.")}
            </tbody>
          </table>
        </div>
      </section>
    `
  });
}

export function walletPnlPoolsPage(options: AnalyticsPageOptions): string {
  const rows = options.analytics?.pools.slice(0, 250).map(renderAnalyticsPoolRow).join("") ?? "";
  return analyticsShell({
    env: options.env,
    analytics: options.analytics,
    snapshot: options.snapshot,
    cursor: options.cursor,
    active: "pools",
    title: "Wallet PnL pools",
    eyebrow: "Premium wallet ledger",
    heading: "Pools",
    body: `
      ${renderAnalyticsSummary(options)}
      <section class="board-card admin-wallet-card" aria-label="Pool leaderboard">
        <div class="admin-table-toolbar">
          <span>Pool leaderboard</span>
          <span class="source-pill">Cached snapshot</span>
        </div>
        <div class="table-scroll">
          <table class="dex-table admin-wallet-table">
            <thead>
              <tr>
                <th>Pool</th>
                <th>Token</th>
                <th>DEX</th>
                <th class="num">Volume</th>
                <th class="num">Trades</th>
                <th class="num">Wallets</th>
                <th class="num">Top wallet</th>
                <th class="num">Symmetry</th>
                <th class="num">Risk</th>
                <th>Hook</th>
                <th>Open</th>
              </tr>
            </thead>
            <tbody>
              ${rows || emptyRow(11, options.analytics ? "No pool analytics are stored yet." : "No cached analytics snapshot is available yet.")}
            </tbody>
          </table>
        </div>
      </section>
    `
  });
}

export function walletPnlTokenWalletsPage(options: TokenWalletsOptions): string {
  const token = findToken(options.analytics, options.tokenAddress);
  const title = displayTokenTicker(token?.tokenSymbol ?? options.trades[0]?.tokenSymbol, options.tokenAddress);
  const rows = sortTokenWalletRows(buildTokenWalletRows(options.trades), options.sort);
  const suspiciousClusters = mergeSuspiciousTokenClusters(
    buildSuspiciousTokenClusters(options.env.walletPnlChain, rows, title),
    tokenClusterRowsFromPersistedClusters(options.env.walletPnlChain, options.tokenAddress, options.persistedClusters)
  );
  const clusterSignals = buildWalletClusterSignals(options.env.walletPnlChain, options.analytics, suspiciousClusters, options.persistedClusters);
  return analyticsShell({
    env: options.env,
    analytics: options.analytics,
    snapshot: options.snapshot,
    cursor: options.cursor,
    active: "token",
    title: `${title} wallet leaderboard`,
    eyebrow: "Token wallet leaderboard",
    heading: title,
    body: `
      ${renderTokenDetailSummary(options.env.walletPnlChain, options.tokenAddress, token, options.trades)}
      <section class="board-card admin-wallet-card" aria-label="Token wallet leaderboard">
        <div class="admin-table-toolbar">
          <span>Wallet leaderboard</span>
          ${renderTokenWalletSorts(options.tokenAddress, options.sort)}
        </div>
        <div class="table-scroll">
          <table class="dex-table admin-wallet-table">
            <thead>
              <tr>
                <th>Wallet</th>
                <th class="num">Realized PnL</th>
                <th class="num">ROI</th>
                <th class="num">Proceeds</th>
                <th class="num">Cost</th>
                <th class="num">Volume</th>
                <th class="num">Trades</th>
                <th class="num">Net base</th>
                <th class="num">First block</th>
                <th class="num">Last block</th>
                <th>Open</th>
              </tr>
            </thead>
            <tbody>
              ${rows.slice(0, 500).map((row) => renderTokenWalletLeaderboardRow(options.env.walletPnlChain, row, clusterSignals)).join("") || emptyRow(11, "No retained wallet rows found for this token.")}
            </tbody>
          </table>
        </div>
      </section>
    `
  });
}

export function walletPnlTokenDetailPage(options: TokenDetailOptions): string {
  const token = findToken(options.analytics, options.tokenAddress);
  const title = displayTokenTicker(token?.tokenSymbol ?? options.trades[0]?.tokenSymbol, options.tokenAddress);
  const walletRows = buildTokenWalletRows(options.trades);
  const suspiciousClusters = mergeSuspiciousTokenClusters(
    buildSuspiciousTokenClusters(options.env.walletPnlChain, walletRows, title),
    tokenClusterRowsFromPersistedClusters(options.env.walletPnlChain, options.tokenAddress, options.persistedClusters)
  );
  const clusterSignals = buildWalletClusterSignals(options.env.walletPnlChain, options.analytics, suspiciousClusters, options.persistedClusters);
  const poolRows = buildPoolRows(options.trades);
  return analyticsShell({
    env: options.env,
    analytics: options.analytics,
    cursor: options.cursor,
    active: "token",
    title: `${title} wallet PnL`,
    eyebrow: "Token detail",
    heading: title,
    body: `
      ${renderTokenDetailSummary(options.env.walletPnlChain, options.tokenAddress, token, options.trades)}
      ${renderSuspiciousTokenClusters(suspiciousClusters)}
      <section class="board-card admin-wallet-card" aria-label="Token wallet table">
        <div class="admin-table-toolbar">
          <span>Wallet PnL for this token</span>
          <span class="source-pill">Filtered rows</span>
          <a class="admin-sort-chip" href="/intel/wallet-pnl/token/${escapeAttr(options.tokenAddress)}/wallets">Full wallet report</a>
          <a class="admin-sort-chip" href="/intel/wallet-pnl/overlap?token=${escapeAttr(options.tokenAddress)}">Overlap</a>
        </div>
        <div class="table-scroll">
          <table class="dex-table admin-wallet-table">
            <thead>
              <tr>
                <th>Wallet</th>
                <th class="num">Realized PnL</th>
                <th class="num">ROI</th>
                <th class="num">Proceeds</th>
                <th class="num">Cost</th>
                <th class="num">Volume</th>
                <th class="num">Trades</th>
                <th class="num">Net base</th>
                <th>Open</th>
              </tr>
            </thead>
            <tbody>
              ${walletRows.slice(0, 250).map((row) => renderTokenWalletRow(options.env.walletPnlChain, row, clusterSignals)).join("") || emptyRow(9, "No retained trades found for this token.")}
            </tbody>
          </table>
        </div>
      </section>
      <section class="board-card admin-wallet-card" aria-label="Token pool table">
        <div class="admin-table-toolbar">
          <span>Pools</span>
        </div>
        <div class="table-scroll">
          <table class="dex-table admin-wallet-table">
            <thead>
              <tr>
                <th>Pool</th>
                <th>DEX</th>
                <th class="num">Volume</th>
                <th class="num">Trades</th>
                <th class="num">Wallets</th>
                <th class="num">Buy/Sell</th>
                <th class="num">Blocks</th>
                <th>Open</th>
              </tr>
            </thead>
            <tbody>
              ${poolRows.slice(0, 100).map(renderPoolRow).join("") || emptyRow(8, "No retained pool rows found for this token.")}
            </tbody>
          </table>
        </div>
      </section>
    `
  });
}

export function walletPnlWalletDetailPage(options: WalletDetailOptions): string {
  const rows = buildWalletTokenRows(options.env.walletPnlChain, options.trades);
  const wallet = options.wallet.toLowerCase();
  const clusterSignals = buildWalletClusterSignals(options.env.walletPnlChain, options.analytics, [], options.persistedClusters);
  return analyticsShell({
    env: options.env,
    analytics: options.analytics,
    cursor: options.cursor,
    active: "wallet",
    title: `${shortAddress(wallet)} wallet PnL`,
    eyebrow: "Wallet detail",
    heading: shortAddress(wallet),
    body: `
      ${renderWalletDetailSummary(options.env.walletPnlChain, wallet, options.trades, clusterSignals)}
      <section class="board-card admin-wallet-card" aria-label="Wallet token PnL table">
        <div class="admin-table-toolbar">
          <span>Token-level realized PnL</span>
          <span class="source-pill">Filtered rows</span>
        </div>
        <div class="table-scroll">
          <table class="dex-table admin-wallet-table">
            <thead>
              <tr>
                <th>Token</th>
                <th class="num">Realized PnL</th>
                <th class="num">ROI</th>
                <th class="num">Proceeds</th>
                <th class="num">Cost</th>
                <th class="num">Volume</th>
                <th class="num">Trades</th>
                <th class="num">Net base</th>
                <th>Open</th>
              </tr>
            </thead>
            <tbody>
              ${rows.slice(0, 250).map(renderWalletTokenRow).join("") || emptyRow(9, "No retained trades found for this wallet.")}
            </tbody>
          </table>
        </div>
      </section>
    `
  });
}

export function walletPnlPoolDetailPage(options: PoolDetailOptions): string {
  const rows = buildPoolWalletRows(options.trades);
  const clusterSignals = buildWalletClusterSignals(options.env.walletPnlChain, options.analytics, [], options.persistedClusters);
  return analyticsShell({
    env: options.env,
    analytics: options.analytics,
    cursor: options.cursor,
    active: "pool",
    title: `${shortAddress(options.poolId)} pool`,
    eyebrow: "Pool detail",
    heading: shortAddress(options.poolId),
    body: `
      ${renderPoolDetailSummary(options.poolId, options.pool, options.trades, options.env.walletPnlTrustedV4Hooks)}
      <section class="board-card admin-wallet-card" aria-label="Pool wallet table">
        <div class="admin-table-toolbar">
          <span>Wallets in this pool</span>
          <span class="source-pill">Filtered rows</span>
        </div>
        <div class="table-scroll">
          <table class="dex-table admin-wallet-table">
            <thead>
              <tr>
                <th>Wallet</th>
                <th class="num">Volume</th>
                <th class="num">Trades</th>
                <th class="num">Buy/Sell</th>
                <th class="num">First block</th>
                <th class="num">Last block</th>
                <th>Open</th>
              </tr>
            </thead>
            <tbody>
              ${rows.slice(0, 250).map((row) => renderPoolWalletRow(options.env.walletPnlChain, row, clusterSignals)).join("") || emptyRow(7, "No retained trades found for this pool.")}
            </tbody>
          </table>
        </div>
      </section>
    `
  });
}

export function walletPnlOverlapPage(options: OverlapPageOptions): string {
  const token = options.tokenAddress ? findToken(options.analytics, options.tokenAddress) : undefined;
  const title = options.tokenAddress
    ? `${displayTokenTicker(token?.tokenSymbol ?? options.tokenTrades?.[0]?.tokenSymbol, options.tokenAddress)} overlap`
    : "Token Overlap";
  const rows = options.tokenAddress && options.cohortTrades
    ? buildCohortTokenRows(options.env.walletPnlChain, options.cohortTrades, options.tokenAddress)
    : [];
  return analyticsShell({
    env: options.env,
    analytics: options.analytics,
    snapshot: options.snapshot,
    cursor: options.cursor,
    active: "overlap",
    title: `Wallet PnL ${title}`,
    eyebrow: "Cohort intelligence",
    heading: title,
    body: `
      ${renderOverlapForm(options.tokenAddress, options.walletLimit)}
      ${options.tokenAddress ? renderTokenDetailSummary(options.env.walletPnlChain, options.tokenAddress, token, options.tokenTrades ?? []) : ""}
      ${renderHistoricalBuys(options.env.walletPnlChain, options.historicalBuys)}
      ${options.tokenAddress ? `
        <section class="board-card admin-wallet-card" aria-label="Token overlap table">
          <div class="admin-table-toolbar">
            <span>Also-traded tokens</span>
            <span class="source-pill">${fmtInt(Math.min(options.walletCount, options.walletLimit))} wallets sampled</span>
          </div>
          <div class="table-scroll">
            <table class="dex-table admin-wallet-table">
              <thead>
                <tr>
                  <th>Token</th>
                  <th class="num">Shared wallets</th>
                  <th class="num">Volume</th>
                  <th class="num">Trades</th>
                  <th class="num">Top wallet</th>
                  <th class="num">Buy/Sell</th>
                  <th class="num">Blocks</th>
                  <th>Open</th>
                </tr>
              </thead>
              <tbody>
                ${rows.slice(0, 250).map(renderCohortTokenRow).join("") || emptyRow(8, "No also-traded tokens found for this sampled cohort.")}
              </tbody>
            </table>
          </div>
        </section>
      ` : renderTopTokenShortlist(options.env.walletPnlChain, options.analytics)}
    `
  });
}

export function walletPnlCohortPage(options: CohortPageOptions): string {
  const walletRows = buildCohortWalletRows(options.env.walletPnlChain, options.wallets, options.trades);
  const tokenRows = buildCohortTokenRows(options.env.walletPnlChain, options.trades);
  const poolRows = buildCohortPoolRows(options.trades);
  const clusterSignals = buildWalletClusterSignals(
    options.env.walletPnlChain,
    options.analytics,
    options.clusterLabel && options.wallets.length >= 2
      ? [{ label: options.clusterLabel, wallets: options.wallets }]
      : [],
    options.persistedClusters
  );
  const cohortClusterLabel = resolveCohortClusterLabel(options.clusterLabel, options.wallets, clusterSignals);
  const summary = summarizeTrades(options.trades);
  return analyticsShell({
    env: options.env,
    analytics: options.analytics,
    snapshot: options.snapshot,
    cursor: options.cursor,
    active: "cohort",
    title: cohortClusterLabel ? `${cohortClusterLabel} wallet cohort` : "Wallet PnL cohort",
    eyebrow: "Cohort intelligence",
    heading: cohortClusterLabel ? `Cohort: ${cohortClusterLabel}` : "Cohort",
    body: `
      ${renderCohortForm(options.wallets)}
      ${options.wallets.length > 0 ? `
        <section class="admin-summary" aria-labelledby="cohortSummaryTitle">
          <div class="admin-summary-copy">
            <div class="admin-title-row">
              <h2 id="cohortSummaryTitle">${cohortClusterLabel ? escapeText(cohortClusterLabel) : "Cohort snapshot"}</h2>
              <span class="source-pill">${cohortClusterLabel ? "Wallet cluster" : "Filtered rows"}</span>
            </div>
            <p>${cohortClusterLabel ? "Loaded wallet cluster: " : ""}${options.wallets.slice(0, 6).map((wallet) => `<span class="mono">${escapeText(shortAddress(wallet))}</span>`).join(" ")}${options.wallets.length > 6 ? ` +${options.wallets.length - 6}` : ""}</p>
          </div>
          <dl class="admin-metrics">
            <div><dt>Wallets</dt><dd>${fmtInt(options.wallets.length)}</dd></div>
            <div><dt>Trades</dt><dd>${fmtInt(summary.tradeCount)}</dd></div>
            <div><dt>Tokens</dt><dd>${fmtInt(tokenRows.length)}</dd></div>
            <div><dt>Pools</dt><dd>${fmtInt(poolRows.length)}</dd></div>
            <div><dt>Volume</dt><dd>${fmtUsd(summary.volumeUsd)}</dd></div>
            <div><dt>Blocks</dt><dd>${fmtInt(summary.firstBlock)} to ${fmtInt(summary.lastBlock)}</dd></div>
          </dl>
        </section>
        ${renderHistoricalBuys(options.env.walletPnlChain, options.historicalBuys)}
        <section class="board-card admin-wallet-card" aria-label="Cohort wallet table">
          <div class="admin-table-toolbar">
            <span>Cluster wallets</span>
            <span class="source-pill">${fmtInt(walletRows.length)} wallets</span>
            ${renderCohortExportControls(walletRows, cohortClusterLabel)}
          </div>
          <div class="table-scroll">
            <table class="dex-table admin-wallet-table">
              <thead>
                <tr>
                  <th>Wallet</th>
                  <th class="num">Realized PnL</th>
                  <th class="num">ROI</th>
                  <th class="num">Volume</th>
                  <th class="num">Trades</th>
                  <th class="num">Buy/Sell</th>
                  <th class="num">Tokens</th>
                  <th class="num">Pools</th>
                  <th class="num">Top token</th>
                  <th class="num">Blocks</th>
                  <th>Open</th>
                </tr>
              </thead>
              <tbody>
                ${walletRows.map((row) => renderCohortWalletRow(options.env.walletPnlChain, row, clusterSignals)).join("") || emptyRow(11, "No wallets were provided for this cohort.")}
              </tbody>
            </table>
          </div>
        </section>
        <section class="board-card admin-wallet-card" aria-label="Cohort token table">
          <div class="admin-table-toolbar">
            <span>Shared tokens</span>
          </div>
          <div class="table-scroll">
            <table class="dex-table admin-wallet-table">
              <thead>
                <tr>
                  <th>Token</th>
                  <th class="num">Wallets</th>
                  <th class="num">Volume</th>
                  <th class="num">Trades</th>
                  <th class="num">Top wallet</th>
                  <th class="num">Buy/Sell</th>
                  <th class="num">Blocks</th>
                  <th>Open</th>
                </tr>
              </thead>
              <tbody>
                ${tokenRows.slice(0, 250).map(renderCohortTokenRow).join("") || emptyRow(8, "No shared tokens found for this cohort.")}
              </tbody>
            </table>
          </div>
        </section>
        <section class="board-card admin-wallet-card" aria-label="Cohort pool table">
          <div class="admin-table-toolbar">
            <span>Shared pools</span>
          </div>
          <div class="table-scroll">
            <table class="dex-table admin-wallet-table">
              <thead>
                <tr>
                  <th>Pool</th>
                  <th>DEX</th>
                  <th class="num">Wallets</th>
                  <th class="num">Volume</th>
                  <th class="num">Trades</th>
                  <th class="num">Blocks</th>
                  <th>Open</th>
                </tr>
              </thead>
              <tbody>
                ${poolRows.slice(0, 150).map(renderCohortPoolRow).join("") || emptyRow(7, "No shared pools found for this cohort.")}
              </tbody>
            </table>
          </div>
        </section>
        ${renderCohortExportScript()}
      ` : renderTopTokenShortlist(options.env.walletPnlChain, options.analytics)}
    `
  });
}

export function walletPnlStatusPage(options: AnalyticsPageOptions): string {
  const snapshot = options.snapshot;
  const analytics = options.analytics;
  return analyticsShell({
    env: options.env,
    analytics,
    snapshot,
    cursor: options.cursor,
    active: "status",
    title: "Wallet PnL status",
    eyebrow: "Indexer status",
    heading: "Status",
    body: `
      <section class="admin-summary" aria-labelledby="walletPnlStatusTitle">
        <div class="admin-summary-copy">
          <div class="admin-title-row">
            <h2 id="walletPnlStatusTitle">Retained data</h2>
            <span class="source-pill${snapshot?.partial ? " is-warning" : ""}">${snapshot?.partial ? "Catching up" : "Ready"}</span>
          </div>
          <p>${analytics
            ? `Analytics generated ${escapeText(formatDateTime(analytics.generatedAt))}.`
            : "No cached analytics snapshot is available yet."}</p>
        </div>
        <dl class="admin-metrics">
          <div><dt>Cursor</dt><dd>${fmtInt(options.cursor?.lastBlock)}</dd></div>
          <div><dt>Snapshot block</dt><dd>${fmtInt(snapshot?.toBlock)}</dd></div>
          <div><dt>Analytics block</dt><dd>${fmtInt(analytics?.toBlock)}</dd></div>
          <div><dt>Retained from</dt><dd>${fmtInt(snapshot?.retentionFromBlock ?? analytics?.fromBlock)}</dd></div>
          <div><dt>Window from</dt><dd>${fmtInt(snapshot?.windowFromBlock)}</dd></div>
          <div><dt>Last post</dt><dd>${snapshot && options.cursor?.lastPostedAt ? escapeText(formatDateTime(options.cursor.lastPostedAt)) : "-"}</dd></div>
          <div><dt>Trades</dt><dd>${fmtInt(analytics?.tradeCount ?? snapshot?.tradeCount)}</dd></div>
          <div><dt>Wallets</dt><dd>${fmtInt(analytics?.walletCount ?? snapshot?.walletCount)}</dd></div>
          <div><dt>Tokens</dt><dd>${fmtInt(analytics?.tokenCount)}</dd></div>
          <div><dt>Pools</dt><dd>${fmtInt(analytics?.poolCount)}</dd></div>
          <div><dt>PnL leaders</dt><dd>${fmtInt(analytics?.pnlLeaders?.length)}</dd></div>
          <div><dt>ROI leaders</dt><dd>${fmtInt(analytics?.roiLeaders?.length)}</dd></div>
          <div><dt>Good signal</dt><dd>${fmtInt(analytics?.goodSignalWallets?.length)}</dd></div>
        </dl>
      </section>
    `
  });
}

function analyticsShell(options: {
  env: WalletPnlAnalyticsEnv;
  analytics?: WalletPnlAnalyticsSnapshot;
  snapshot?: WalletPnlSnapshot;
  cursor?: WalletPnlCursor;
  active: AnalyticsActivePage;
  title: string;
  eyebrow: string;
  heading: string;
  body: string;
}): string {
  const chain = options.analytics?.chain ?? options.env.walletPnlChain;
  const chainName = getChain(chain).name;
  return page(options.title, `
    <div class="dex-shell admin-shell">
      <aside class="dex-sidebar" aria-label="Wallet PnL navigation">
        <a class="brand-mark" href="/"><span>baes</span><strong>scan</strong></a>
        <nav class="side-nav">
          ${navLink("/intel", "I", "Intel", false)}
          ${navLink("/intel/wallet-pnl", "P", "Wallet PnL", options.active === "overview")}
          ${navLink("/intel/wallet-pnl/tokens", "T", "Tokens", options.active === "tokens" || options.active === "token")}
          ${navLink("/intel/wallet-pnl/tokens/new", "N", "New Tokens", options.active === "new-tokens")}
          ${navLink("/intel/wallet-pnl/leaderboards/pnl", "L", "Leaders", options.active === "leaderboards")}
          ${navLink("/intel/wallet-pnl/signals", "G", "Signals", options.active === "signals")}
          ${navLink("/intel/wallet-pnl/overlap", "O", "Overlap", options.active === "overlap")}
          ${navLink("/intel/wallet-pnl/cohort", "C", "Cohort", options.active === "cohort")}
          ${navLink("/intel/wallet-pnl/risk/tokens", "R", "Token Risk", options.active === "risk-tokens")}
          ${navLink("/intel/wallet-pnl/risk/wallets", "W", "Wallet Risk", options.active === "risk-wallets" || options.active === "wallet")}
          ${navLink("/intel/wallet-pnl/pools", "U", "Pools", options.active === "pools" || options.active === "pool")}
          ${navLink("/intel/wallet-pnl/status", "S", "Status", options.active === "status")}
          ${navLink("/", "B", "Buybot", false)}
          ${navLink("/intel/wallet-pnl?logout=1", "L", "Logout", false)}
        </nav>
        <div class="side-block">
          <p>Status</p>
          <span class="side-link">${options.env.walletPnlEnabled ? "Indexer enabled" : "Indexer disabled"}</span>
          <span class="side-link">${escapeText(chainName)}</span>
          <span class="side-link">${options.analytics ? `To block ${options.analytics.toBlock.toLocaleString()}` : "No analytics snapshot"}</span>
        </div>
      </aside>

      <div class="admin-app">
        <header class="admin-top">
          <div>
            <p class="eyebrow">${escapeText(options.eyebrow)}</p>
            <h1>${escapeText(options.heading)}</h1>
          </div>
          <div class="inline-actions">
            <a class="ghost-link" href="/intel/wallet-pnl/tokens">Tokens</a>
            <a class="ghost-link" href="/intel/wallet-pnl/tokens/new">New Tokens</a>
            <a class="ghost-link" href="/intel/wallet-pnl/leaderboards/pnl">Leaders</a>
            <a class="ghost-link" href="/intel/wallet-pnl/signals">Signals</a>
            <a class="ghost-link" href="/intel/wallet-pnl/overlap">Overlap</a>
            <a class="ghost-link" href="/intel/wallet-pnl/cohort">Cohort</a>
            <a class="ghost-link" href="/intel/wallet-pnl/risk/tokens">Token Risk</a>
            <a class="ghost-link" href="/intel/wallet-pnl/risk/wallets">Wallet Risk</a>
            <a class="ghost-link" href="/intel/wallet-pnl/pools">Pools</a>
            <a class="ghost-link" href="/intel/wallet-pnl/status">Status</a>
          </div>
        </header>
        ${options.body}
      </div>
    </div>
  `, {
    description: `${options.heading} for baes intel: token-gated wallet PnL, New Tokens, risk clusters, and retained-window DEX flow on ${chainName}.`,
    canonicalPath: options.active === "new-tokens"
      ? "/intel/wallet-pnl/tokens/new"
      : options.active === "signals"
        ? "/intel/wallet-pnl/signals"
        : "/intel/wallet-pnl",
    imagePath: "/og/baes-intel.png",
    robots: "noindex, nofollow"
  });
}

function renderNewTokensSummary(options: AnalyticsPageOptions, sourceLabel: string, visibleTokenCount: number): string {
  const analytics = options.analytics;
  const generatedAt = options.newTokensGeneratedAt ?? analytics?.generatedAt;
  const fromBlock = options.newTokens?.length
    ? options.newTokens.reduce((min, token) => Math.min(min, token.firstBlock), options.newTokens[0]!.firstBlock)
    : analytics?.fromBlock;
  const toBlock = options.newTokensToBlock ?? analytics?.toBlock;
  return `
    <section class="admin-summary" aria-labelledby="walletPnlNewTokensSummaryTitle">
      <div class="admin-summary-copy">
        <div class="admin-title-row">
          <h2 id="walletPnlNewTokensSummaryTitle">New Tokens cache</h2>
          <span class="source-pill${generatedAt ? "" : " is-warning"}">${escapeText(sourceLabel)}</span>
        </div>
        <p>${generatedAt
          ? `Generated ${escapeText(formatDateTime(generatedAt))}. This panel tracks the lighter 5-minute New Tokens worker, separately from the heavier full analytics snapshot.`
          : "Waiting for the New Tokens cache to be materialized from retained normalized trades."}</p>
      </div>
      <dl class="admin-metrics">
        <div><dt>Rows</dt><dd>${fmtInt(visibleTokenCount)}</dd></div>
        <div><dt>From block</dt><dd>${fmtInt(fromBlock)}</dd></div>
        <div><dt>To block</dt><dd>${fmtInt(toBlock)}</dd></div>
        <div><dt>Cursor</dt><dd>${fmtInt(options.cursor?.lastBlock)}</dd></div>
        <div><dt>Cadence</dt><dd>${escapeText(formatCadence(options.env.walletPnlNewTokensIntervalMs))}</dd></div>
        <div><dt>Analytics</dt><dd>${analytics?.generatedAt ? escapeText(formatDateTime(analytics.generatedAt)) : "-"}</dd></div>
      </dl>
    </section>
  `;
}

function renderAnalyticsSummary(options: AnalyticsPageOptions): string {
  const analytics = options.analytics;
  return `
    <section class="admin-summary" aria-labelledby="walletPnlAnalyticsSummaryTitle">
      <div class="admin-summary-copy">
        <div class="admin-title-row">
          <h2 id="walletPnlAnalyticsSummaryTitle">Cached analytics</h2>
          <span class="source-pill${analytics ? "" : " is-warning"}">${analytics ? "Ready" : "Waiting"}</span>
        </div>
        <p>${analytics
          ? `Generated ${escapeText(formatDateTime(analytics.generatedAt))}. Rows here are derived once from retained normalized trades, then reused by the gated pages.`
          : "Run the wallet PnL indexer once to materialize token, wallet, and pool analytics."}</p>
      </div>
      <dl class="admin-metrics">
        <div><dt>Trades</dt><dd>${fmtInt(analytics?.tradeCount)}</dd></div>
        <div><dt>Tokens</dt><dd>${fmtInt(analytics?.tokenCount)}</dd></div>
        <div><dt>Wallets</dt><dd>${fmtInt(analytics?.walletCount)}</dd></div>
        <div><dt>Pools</dt><dd>${fmtInt(analytics?.poolCount)}</dd></div>
        <div><dt>From block</dt><dd>${fmtInt(analytics?.fromBlock)}</dd></div>
        <div><dt>Cursor</dt><dd>${fmtInt(options.cursor?.lastBlock)}</dd></div>
      </dl>
    </section>
  `;
}

function renderWalletSignalSummary(options: AnalyticsPageOptions, signalWallets: WalletPnlAnalyticsSignalWallet[]): string {
  const analytics = options.analytics;
  const hookTrades = signalWallets.reduce((total, wallet) => total + safeNumber(wallet.trustedV4HookTradeCount), 0);
  const realizedPnlUsd = signalWallets.reduce((total, wallet) => total + safeNumber(wallet.realizedPnlUsd), 0);
  const avgWinRatePct = signalWallets.length
    ? signalWallets.reduce((total, wallet) => total + safeNumber(wallet.winRatePct), 0) / signalWallets.length
    : undefined;
  const avgSignalScore = signalWallets.length
    ? signalWallets.reduce((total, wallet) => total + safeNumber(wallet.goodSignalScore), 0) / signalWallets.length
    : undefined;
  return `
    <section class="admin-summary" aria-labelledby="walletPnlSignalsSummaryTitle">
      <div class="admin-summary-copy">
        <div class="admin-title-row">
          <h2 id="walletPnlSignalsSummaryTitle">Signal wallet cache</h2>
          <span class="source-pill${analytics ? "" : " is-warning"}">${analytics ? "Ready" : "Waiting"}</span>
        </div>
        <p>${analytics
          ? `Generated ${escapeText(formatDateTime(analytics.generatedAt))}. Rows are served from the cached analytics snapshot.`
          : "Waiting for the cached analytics snapshot to materialize signal wallets."}</p>
      </div>
      <dl class="admin-metrics">
        <div><dt>Wallets</dt><dd>${fmtInt(analytics ? signalWallets.length : undefined)}</dd></div>
        <div><dt>Hook trades</dt><dd>${fmtInt(analytics ? hookTrades : undefined)}</dd></div>
        <div><dt>Realized PnL</dt><dd>${analytics ? fmtSignedUsd(realizedPnlUsd) : "-"}</dd></div>
        <div><dt>Avg win rate</dt><dd>${fmtPct(avgWinRatePct)}</dd></div>
        <div><dt>Avg signal</dt><dd>${fmtScore(avgSignalScore)}</dd></div>
        <div><dt>To block</dt><dd>${fmtInt(analytics?.toBlock)}</dd></div>
      </dl>
    </section>
  `;
}

function renderTokenDetailSummary(
  chain: ChainSlug,
  tokenAddress: string,
  token: WalletPnlAnalyticsTokenSummary | undefined,
  trades: WalletPnlTradeRecord[]
): string {
  const fallback = summarizeTrades(trades);
  const gmgnUrl = gmgnTokenUrl(chain, tokenAddress);
  const dexscreenerUrl = dexscreenerTokenUrl(chain, tokenAddress);
  const externalLinks = [
    gmgnUrl ? `<a class="ghost-link" href="${escapeAttr(gmgnUrl)}" target="_blank" rel="noreferrer">GMGN</a>` : "",
    dexscreenerUrl ? `<a class="ghost-link" href="${escapeAttr(dexscreenerUrl)}" target="_blank" rel="noreferrer">Dexscreener</a>` : ""
  ].filter(Boolean).join("");
  return `
    <section class="admin-summary" aria-labelledby="tokenDetailSummaryTitle">
      <div class="admin-summary-copy">
        <div class="admin-title-row">
          <h2 id="tokenDetailSummaryTitle">Token snapshot</h2>
          <span class="source-pill">${token ? "Cached" : "Filtered"}</span>
        </div>
        <p class="mono">${escapeText(tokenAddress.toLowerCase())}</p>
        ${externalLinks ? `<div class="admin-link-row">${externalLinks}</div>` : ""}
      </div>
      <dl class="admin-metrics">
        <div><dt>Volume</dt><dd>${fmtUsd(token?.volumeUsd ?? fallback.volumeUsd)}</dd></div>
        <div><dt>Trades</dt><dd>${fmtInt(token?.tradeCount ?? fallback.tradeCount)}</dd></div>
        <div><dt>Wallets</dt><dd>${fmtInt(token?.walletCount ?? fallback.walletCount)}</dd></div>
        <div><dt>Pools</dt><dd>${fmtInt(token?.poolCount ?? fallback.poolCount)}</dd></div>
        <div><dt>Buy/Sell</dt><dd>${fmtInt(token?.buyCount ?? fallback.buyCount)} / ${fmtInt(token?.sellCount ?? fallback.sellCount)}</dd></div>
        <div><dt>Top wallet</dt><dd>${fmtPct(token?.topWalletConcentrationPct)}</dd></div>
        <div><dt>Risk</dt><dd>${fmtScore(token?.suspiciousScore)}</dd></div>
        <div><dt>Created through</dt><dd>${token ? renderTokenCreatorSignal(chain, token) : "-"}</dd></div>
        <div><dt>V4 hook</dt><dd>${token ? renderTokenHookSignal(token) : "-"}</dd></div>
        <div><dt>Latest price</dt><dd>${fmtPrice(token?.latestPriceUsd)}</dd></div>
      </dl>
    </section>
  `;
}

function renderWalletDetailSummary(chain: ChainSlug, wallet: string, trades: WalletPnlTradeRecord[], clusterSignals?: WalletClusterSignals): string {
  const fallback = summarizeTrades(trades);
  const tokens = new Set(trades.map((trade) => trade.tokenAddress.toLowerCase()));
  const actions = `${renderWalletExternalLinks(chain, wallet)}${renderWalletClusterSignal(wallet, clusterSignals)}`;
  return `
    <section class="admin-summary" aria-labelledby="walletDetailSummaryTitle">
      <div class="admin-summary-copy">
        <div class="admin-title-row">
          <h2 id="walletDetailSummaryTitle">Wallet snapshot</h2>
          <span class="source-pill">Filtered</span>
        </div>
        <p class="mono">${escapeText(wallet)}</p>
        ${actions ? `<div class="wallet-link-group">${actions}</div>` : ""}
      </div>
      <dl class="admin-metrics">
        <div><dt>Volume</dt><dd>${fmtUsd(fallback.volumeUsd)}</dd></div>
        <div><dt>Trades</dt><dd>${fmtInt(fallback.tradeCount)}</dd></div>
        <div><dt>Tokens</dt><dd>${fmtInt(tokens.size)}</dd></div>
        <div><dt>Pools</dt><dd>${fmtInt(fallback.poolCount)}</dd></div>
        <div><dt>Buy/Sell</dt><dd>${fmtInt(fallback.buyCount)} / ${fmtInt(fallback.sellCount)}</dd></div>
        <div><dt>First block</dt><dd>${fmtInt(fallback.firstBlock)}</dd></div>
        <div><dt>Last block</dt><dd>${fmtInt(fallback.lastBlock)}</dd></div>
      </dl>
    </section>
  `;
}

function renderPoolDetailSummary(
  poolId: string,
  pool: WalletPnlPoolRecord | undefined,
  trades: WalletPnlTradeRecord[],
  trustedV4Hooks?: string[]
): string {
  const fallback = summarizeTrades(trades);
  const first = trades[0];
  const hook = poolV4Hook(pool?.pool);
  const riskyHook = untrustedV4Hook(pool?.pool, trustedV4Hooks);
  return `
    <section class="admin-summary" aria-labelledby="poolDetailSummaryTitle">
      <div class="admin-summary-copy">
        <div class="admin-title-row">
          <h2 id="poolDetailSummaryTitle">Pool snapshot</h2>
          <span class="source-pill">${pool ? "Pool metadata" : "Filtered"}</span>
        </div>
        <p class="mono">${escapeText(poolId.toLowerCase())}</p>
      </div>
      <dl class="admin-metrics">
        <div><dt>DEX</dt><dd>${escapeText(String(pool?.pool.dex ?? first?.dex ?? "-"))}</dd></div>
        <div><dt>Protocol</dt><dd>${escapeText(String(pool?.pool.protocol ?? first?.protocol ?? "-"))}</dd></div>
        <div><dt>Volume</dt><dd>${fmtUsd(fallback.volumeUsd)}</dd></div>
        <div><dt>Trades</dt><dd>${fmtInt(fallback.tradeCount)}</dd></div>
        <div><dt>Wallets</dt><dd>${fmtInt(fallback.walletCount)}</dd></div>
        <div><dt>Buy/Sell</dt><dd>${fmtInt(fallback.buyCount)} / ${fmtInt(fallback.sellCount)}</dd></div>
        <div><dt>V4 hook</dt><dd>${renderPoolHookSignal(hook, Boolean(riskyHook))}</dd></div>
        <div><dt>First seen</dt><dd>${fmtInt(pool?.firstSeenBlock ?? fallback.firstBlock)}</dd></div>
        <div><dt>Last seen</dt><dd>${fmtInt(pool?.lastSeenBlock ?? fallback.lastBlock)}</dd></div>
      </dl>
    </section>
  `;
}

function visibleAnalyticsTokens(
  chain: ChainSlug,
  analytics: WalletPnlAnalyticsSnapshot | undefined
): WalletPnlAnalyticsTokenSummary[] {
  return visibleAnalyticsTokenRows(chain, analytics?.tokens);
}

function visibleAnalyticsTokenRows(
  chain: ChainSlug,
  tokens: WalletPnlAnalyticsTokenSummary[] | undefined
): WalletPnlAnalyticsTokenSummary[] {
  return tokens?.filter((token) => !isWalletPnlIgnoredToken(chain, token.tokenAddress, token.tokenSymbol)) ?? [];
}

function visibleAnalyticsWallets(
  chain: ChainSlug,
  wallets: WalletPnlAnalyticsWalletSummary[] | undefined
): WalletPnlAnalyticsWalletSummary[] {
  return wallets?.filter((wallet) => {
    if (!wallet.topTokenAddress) return wallet.tokenCount > 0;
    if (!isWalletPnlIgnoredToken(chain, wallet.topTokenAddress, wallet.topTokenSymbol)) return true;
    return wallet.tokenCount > 1;
  }) ?? [];
}

function visibleGoodSignalWallets(
  chain: ChainSlug,
  analytics: WalletPnlAnalyticsSnapshot | undefined
): WalletPnlAnalyticsSignalWallet[] {
  return (analytics?.goodSignalWallets ?? []).filter((wallet) =>
    wallet.topTokens.every((token) => !isWalletPnlIgnoredToken(chain, token.tokenAddress, token.tokenSymbol))
  );
}

function renderTokenRow(chain: ChainSlug, token: WalletPnlAnalyticsTokenSummary): string {
  const ticker = displayTokenTicker(token.tokenSymbol, token.tokenAddress);
  return `
    <tr>
      <td data-label="Token">${tokenLink(token.tokenAddress, ticker, token.tokenSymbol)}</td>
      <td data-label="Created through">${renderTokenCreatorSignal(chain, token)}</td>
      <td data-label="Volume" class="num">${fmtUsd(token.volumeUsd)}</td>
      <td data-label="Trades" class="num">${fmtInt(token.tradeCount)}</td>
      <td data-label="Wallets" class="num">${fmtInt(token.walletCount)}</td>
      <td data-label="Pools" class="num">${fmtInt(token.poolCount)}</td>
      <td data-label="Buy/Sell" class="num">${fmtInt(token.buyCount)} / ${fmtInt(token.sellCount)}</td>
      <td data-label="Top wallet" class="num">${fmtPct(token.topWalletConcentrationPct)}</td>
      <td data-label="Risk" class="num">${fmtScore(token.suspiciousScore)}</td>
      <td data-label="Hook">${renderTokenHookSignal(token)}</td>
      <td data-label="DEXes">${escapeText(token.dexes.join(", ") || "-")}</td>
      <td data-label="Open"><a class="ghost-link" href="/intel/wallet-pnl/token/${escapeAttr(token.tokenAddress)}">Open</a></td>
    </tr>
  `;
}

function renderNewTokenRow(chain: ChainSlug, token: WalletPnlAnalyticsTokenSummary, toBlock: number): string {
  const ticker = displayTokenTicker(token.tokenSymbol, token.tokenAddress);
  const ageBlocks = Math.max(0, toBlock - token.firstBlock);
  return `
    <tr>
      <td data-label="Token">${tokenLink(token.tokenAddress, ticker, token.tokenSymbol)}</td>
      <td data-label="Created through">${renderTokenCreatorSignal(chain, token)}</td>
      <td data-label="First seen" class="num">${fmtInt(token.firstBlock)}</td>
      <td data-label="Last active" class="num">${fmtInt(token.lastBlock)}</td>
      <td data-label="Age" class="num">${fmtInt(ageBlocks)} blocks</td>
      <td data-label="Volume" class="num">${fmtUsd(token.volumeUsd)}</td>
      <td data-label="Trades" class="num">${fmtInt(token.tradeCount)}</td>
      <td data-label="Wallets" class="num">${fmtInt(token.walletCount)}</td>
      <td data-label="Pools" class="num">${fmtInt(token.poolCount)}</td>
      <td data-label="Risk" class="num">${fmtScore(token.suspiciousScore)}</td>
      <td data-label="Hook">${renderTokenHookSignal(token)}</td>
      <td data-label="Open"><a class="ghost-link" href="/intel/wallet-pnl/token/${escapeAttr(token.tokenAddress)}">Open</a></td>
    </tr>
  `;
}

function renderRiskTokenRow(chain: ChainSlug, token: WalletPnlAnalyticsTokenSummary): string {
  const ticker = displayTokenTicker(token.tokenSymbol, token.tokenAddress);
  return `
    <tr>
      <td data-label="Token">${tokenLink(token.tokenAddress, ticker, token.tokenSymbol)}</td>
      <td data-label="Created through">${renderTokenCreatorSignal(chain, token)}</td>
      <td data-label="Risk" class="num">${fmtScore(token.suspiciousScore)}</td>
      <td data-label="Symmetry" class="num">${fmtPct(token.buySellSymmetryPct)}</td>
      <td data-label="Top wallet" class="num">${fmtPct(token.topWalletConcentrationPct)}</td>
      <td data-label="Trades/wallet" class="num">${fmtNumber(token.avgTradesPerWallet)}</td>
      <td data-label="Trades/tx" class="num">${fmtNumber(token.tradesPerTx)}</td>
      <td data-label="Volume" class="num">${fmtUsd(token.volumeUsd)}</td>
      <td data-label="Wallets" class="num">${fmtInt(token.walletCount)}</td>
      <td data-label="Hook">${renderTokenHookSignal(token)}</td>
      <td data-label="Open"><a class="ghost-link" href="/intel/wallet-pnl/token/${escapeAttr(token.tokenAddress)}">Open</a></td>
    </tr>
  `;
}

function renderTokenHookSignal(token: WalletPnlAnalyticsTokenSummary): string {
  const hooks = token.untrustedV4Hooks ?? [];
  if (!hooks.length) return "-";
  const title = hooks.map((hook) => shortAddress(hook)).join(", ");
  return `<span class="source-pill is-warning" title="${escapeAttr(hooks.join(", "))}">Unknown hook${hooks.length > 1 ? ` ${hooks.length}` : ""}</span><span class="admin-inline-note mono">${escapeText(title)}</span>`;
}

function renderTokenCreatorSignal(chain: ChainSlug, token: WalletPnlAnalyticsTokenSummary): string {
  if (token.creator) {
    const creatorUrl = blockscoutWalletUrl(chain, token.creator);
    const denied = token.createdThroughDeniedFactory ?? token.creatorDenied;
    const label = denied ? "Denied factory" : token.createdByContract ? "Factory contract" : "Creation address";
    const source = token.creatorSource ? ` via ${token.creatorSource}` : "";
    const creator = creatorUrl
      ? `<a class="ghost-link mono" href="${escapeAttr(creatorUrl)}" target="_blank" rel="noreferrer">${escapeText(shortAddress(token.creator))}</a>`
      : `<span class="admin-inline-note mono">${escapeText(shortAddress(token.creator))}</span>`;
    return `<span class="source-pill${denied ? " is-warning" : ""}" title="${escapeAttr(`${token.creator}${source}`)}">${escapeText(label)}</span>${creator}`;
  }
  if (token.creatorLookupStatus === "unresolved") return `<span class="source-pill is-warning">Unresolved</span>`;
  if (token.creatorLookupStatus === "pending") return `<span class="source-pill">Pending</span>`;
  return "-";
}

function renderPoolHookSignal(hook: string | undefined, untrusted: boolean): string {
  if (!hook) return "-";
  const label = untrusted ? "Unknown hook" : "V4 hook";
  return `<span class="source-pill${untrusted ? " is-warning" : ""}" title="${escapeAttr(hook)}">${escapeText(label)}</span><span class="admin-inline-note mono">${escapeText(shortAddress(hook))}</span>`;
}

function renderWalletTopToken(chain: ChainSlug, wallet: WalletPnlAnalyticsWalletSummary): string {
  if (!wallet.topTokenAddress || isWalletPnlIgnoredToken(chain, wallet.topTokenAddress, wallet.topTokenSymbol)) return "-";
  return `<a class="ghost-link" href="/intel/wallet-pnl/token/${escapeAttr(wallet.topTokenAddress)}">${escapeText(displayTokenTicker(wallet.topTokenSymbol, wallet.topTokenAddress, 12))}</a>`;
}

function visibleWalletTokenCount(chain: ChainSlug, wallet: WalletPnlAnalyticsWalletSummary): number {
  if (wallet.topTokenAddress && isWalletPnlIgnoredToken(chain, wallet.topTokenAddress, wallet.topTokenSymbol)) {
    return Math.max(0, wallet.tokenCount - 1);
  }
  return wallet.tokenCount;
}

function visibleWalletTopTokenConcentrationPct(chain: ChainSlug, wallet: WalletPnlAnalyticsWalletSummary): number | undefined {
  if (wallet.topTokenAddress && isWalletPnlIgnoredToken(chain, wallet.topTokenAddress, wallet.topTokenSymbol)) return undefined;
  return wallet.tokenConcentrationPct;
}

function renderRiskWalletRow(chain: ChainSlug, wallet: WalletPnlAnalyticsWalletSummary, clusterSignals?: WalletClusterSignals): string {
  const topToken = renderWalletTopToken(chain, wallet);
  const tokenCount = visibleWalletTokenCount(chain, wallet);
  const tokenConcentrationPct = visibleWalletTopTokenConcentrationPct(chain, wallet);
  return `
    <tr>
      <td data-label="Wallet" class="mono">${walletLink(chain, wallet.wallet, clusterSignals)}</td>
      <td data-label="Risk" class="num">${fmtScore(wallet.suspiciousScore)}</td>
      <td data-label="Volume" class="num">${fmtUsd(wallet.volumeUsd)}</td>
      <td data-label="Trades" class="num">${fmtInt(wallet.tradeCount)}</td>
      <td data-label="Tokens" class="num">${fmtInt(tokenCount)}</td>
      <td data-label="Top token" class="num">${topToken} ${fmtPct(tokenConcentrationPct)}</td>
      <td data-label="Top pool" class="num">${fmtPct(wallet.poolConcentrationPct)}</td>
      <td data-label="Symmetry" class="num">${fmtPct(wallet.buySellSymmetryPct)}</td>
      <td data-label="Open"><a class="ghost-link" href="/intel/wallet-pnl/wallet/${escapeAttr(wallet.wallet)}">Open</a></td>
    </tr>
  `;
}

function renderRiskWalletClusterRow(cluster: RiskWalletClusterRow): string {
  const cohortHref = cohortHrefForCluster(cluster.wallets, cluster.label);
  const topToken = cluster.topTokenAddress
    ? tokenLink(cluster.topTokenAddress, displayTokenTicker(cluster.topTokenSymbol, cluster.topTokenAddress, 12), cluster.topTokenSymbol)
    : "-";
  const topPool = cluster.topPoolId
    ? `<a class="ghost-link mono" href="/intel/wallet-pnl/pool/${escapeAttr(encodeURIComponent(cluster.topPoolId))}">${escapeText(shortAddress(cluster.topPoolId))}</a>`
    : "-";
  return `
    <tr>
      <td data-label="Cluster">
        <a class="cluster-title-link" href="${escapeAttr(cohortHref)}"><strong>${escapeText(cluster.label)}</strong></a>
        <div class="muted mono">${escapeText(clusterWalletSample(cluster.wallets))}</div>
      </td>
      <td data-label="Risk" class="num">${fmtScore(cluster.clusterScore)}</td>
      <td data-label="Reason">${escapeText(cluster.reason)}</td>
      <td data-label="Wallets" class="num">${fmtInt(cluster.walletCount)}</td>
      <td data-label="Volume" class="num">${fmtUsd(cluster.volumeUsd)}</td>
      <td data-label="Trades" class="num">${fmtInt(cluster.tradeCount)}</td>
      <td data-label="Tokens" class="num">${fmtNumber(cluster.tokenCount, 1)}</td>
      <td data-label="Top token" class="num">${topToken} ${fmtPct(cluster.avgTokenConcentrationPct)}</td>
      <td data-label="Top pool" class="num">${topPool} ${fmtPct(cluster.avgPoolConcentrationPct)}</td>
      <td data-label="Symmetry" class="num">${fmtPct(cluster.avgSymmetryPct)}</td>
      <td data-label="Open"><a class="ghost-link" href="${escapeAttr(cohortHref)}">Wallets</a></td>
    </tr>
  `;
}

function renderTokenWalletRow(chain: ChainSlug, row: TokenWalletRow, clusterSignals?: WalletClusterSignals): string {
  return `
    <tr>
      <td data-label="Wallet" class="mono">${walletLink(chain, row.wallet, clusterSignals)}</td>
      <td data-label="Realized PnL" class="num ${row.realizedPnlUsd >= 0 ? "is-positive" : "is-negative"}">${fmtSignedUsd(row.realizedPnlUsd)}</td>
      <td data-label="ROI" class="num">${fmtPct(row.roiPct)}</td>
      <td data-label="Proceeds" class="num">${fmtUsd(row.realizedProceedsUsd)}</td>
      <td data-label="Cost" class="num">${fmtUsd(row.realizedCostUsd)}</td>
      <td data-label="Volume" class="num">${fmtUsd(row.volumeUsd)}</td>
      <td data-label="Trades" class="num">${fmtInt(row.tradeCount)}</td>
      <td data-label="Net base" class="num">${fmtNumber(row.netBaseAmount, 4)}</td>
      <td data-label="Open"><a class="ghost-link" href="/intel/wallet-pnl/wallet/${escapeAttr(row.wallet)}">Open</a></td>
    </tr>
  `;
}

function renderWalletTokenRow(row: WalletTokenRow): string {
  const ticker = displayTokenTicker(row.tokenSymbol, row.tokenAddress);
  return `
    <tr>
      <td data-label="Token">${tokenLink(row.tokenAddress, ticker, row.tokenSymbol)}</td>
      <td data-label="Realized PnL" class="num ${row.realizedPnlUsd >= 0 ? "is-positive" : "is-negative"}">${fmtSignedUsd(row.realizedPnlUsd)}</td>
      <td data-label="ROI" class="num">${fmtPct(row.roiPct)}</td>
      <td data-label="Proceeds" class="num">${fmtUsd(row.realizedProceedsUsd)}</td>
      <td data-label="Cost" class="num">${fmtUsd(row.realizedCostUsd)}</td>
      <td data-label="Volume" class="num">${fmtUsd(row.volumeUsd)}</td>
      <td data-label="Trades" class="num">${fmtInt(row.tradeCount)}</td>
      <td data-label="Net base" class="num">${fmtNumber(row.netBaseAmount, 4)}</td>
      <td data-label="Open"><a class="ghost-link" href="/intel/wallet-pnl/token/${escapeAttr(row.tokenAddress)}">Open</a></td>
    </tr>
  `;
}

function renderPoolRow(row: PoolRow): string {
  return `
    <tr>
      <td data-label="Pool" class="mono">${poolLink(row.poolId)}</td>
      <td data-label="DEX">${escapeText(`${row.dex} ${row.protocol}`)}</td>
      <td data-label="Volume" class="num">${fmtUsd(row.volumeUsd)}</td>
      <td data-label="Trades" class="num">${fmtInt(row.tradeCount)}</td>
      <td data-label="Wallets" class="num">${fmtInt(row.walletCount)}</td>
      <td data-label="Buy/Sell" class="num">${fmtInt(row.buyCount)} / ${fmtInt(row.sellCount)}</td>
      <td data-label="Blocks" class="num">${fmtInt(row.firstBlock)} to ${fmtInt(row.lastBlock)}</td>
      <td data-label="Open"><a class="ghost-link" href="/intel/wallet-pnl/pool/${escapeAttr(encodeURIComponent(row.poolId))}">Open</a></td>
    </tr>
  `;
}

function renderPoolWalletRow(chain: ChainSlug, row: TokenWalletRow, clusterSignals?: WalletClusterSignals): string {
  return `
    <tr>
      <td data-label="Wallet" class="mono">${walletLink(chain, row.wallet, clusterSignals)}</td>
      <td data-label="Volume" class="num">${fmtUsd(row.volumeUsd)}</td>
      <td data-label="Trades" class="num">${fmtInt(row.tradeCount)}</td>
      <td data-label="Buy/Sell" class="num">${fmtInt(row.buyCount)} / ${fmtInt(row.sellCount)}</td>
      <td data-label="First block" class="num">${fmtInt(row.firstBlock)}</td>
      <td data-label="Last block" class="num">${fmtInt(row.lastBlock)}</td>
      <td data-label="Open"><a class="ghost-link" href="/intel/wallet-pnl/wallet/${escapeAttr(row.wallet)}">Open</a></td>
    </tr>
  `;
}

function renderPnlLeaderRow(chain: ChainSlug, row: WalletPnlAnalyticsPnlLeader, clusterSignals?: WalletClusterSignals): string {
  const ticker = displayTokenTicker(row.tokenSymbol, row.tokenAddress);
  return `
    <tr>
      <td data-label="Wallet" class="mono">${walletLink(chain, row.wallet, clusterSignals)}</td>
      <td data-label="Token">${tokenLink(row.tokenAddress, ticker, row.tokenSymbol)}</td>
      <td data-label="Realized PnL" class="num ${row.realizedPnlUsd >= 0 ? "is-positive" : "is-negative"}">${fmtSignedUsd(row.realizedPnlUsd)}</td>
      <td data-label="ROI" class="num">${fmtPct(row.roiPct)}</td>
      <td data-label="Proceeds" class="num">${fmtUsd(row.realizedProceedsUsd)}</td>
      <td data-label="Cost" class="num">${fmtUsd(row.realizedCostUsd)}</td>
      <td data-label="Volume" class="num">${fmtUsd(row.volumeUsd)}</td>
      <td data-label="Trades" class="num">${fmtInt(row.buyCount + row.sellCount)}</td>
      <td data-label="Open"><a class="ghost-link" href="/intel/wallet-pnl/token/${escapeAttr(row.tokenAddress)}/wallets">Token wallets</a></td>
    </tr>
  `;
}

function renderGoodSignalWalletRow(chain: ChainSlug, row: WalletPnlAnalyticsSignalWallet, clusterSignals?: WalletClusterSignals): string {
  const topTokens = row.topTokens.length > 0
    ? row.topTokens
      .map((token) =>
        `${tokenLink(token.tokenAddress, displayTokenTicker(token.tokenSymbol, token.tokenAddress), token.tokenSymbol)} <span class="muted">${fmtSignedUsd(token.realizedPnlUsd)}</span>`
      )
      .join("<br>")
    : "-";
  return `
    <tr>
      <td data-label="Wallet" class="mono">${walletLink(chain, row.wallet, clusterSignals)}</td>
      <td data-label="Signal" class="num">${fmtScore(row.goodSignalScore)}</td>
      <td data-label="Realized PnL" class="num ${row.realizedPnlUsd >= 0 ? "is-positive" : "is-negative"}">${fmtSignedUsd(row.realizedPnlUsd)}</td>
      <td data-label="ROI" class="num">${fmtPct(row.roiPct)}</td>
      <td data-label="Win rate" class="num">${fmtPct(row.winRatePct)}</td>
      <td data-label="Wins / losses" class="num">${fmtInt(row.profitableTokenCount)} / ${fmtInt(row.losingTokenCount)}</td>
      <td data-label="Hook trades" class="num">${fmtInt(row.trustedV4HookTradeCount)}</td>
      <td data-label="Profit factor" class="num">${fmtNumber(row.profitFactor)}</td>
      <td data-label="Top wins">${topTokens}</td>
      <td data-label="Risk" class="num">${fmtScore(row.suspiciousScore)}</td>
      <td data-label="Open"><a class="ghost-link" href="/intel/wallet-pnl/wallet/${escapeAttr(row.wallet)}">Open</a></td>
    </tr>
  `;
}

function renderVolumeWalletRow(chain: ChainSlug, wallet: WalletPnlAnalyticsWalletSummary, clusterSignals?: WalletClusterSignals): string {
  const topToken = renderWalletTopToken(chain, wallet);
  const tokenCount = visibleWalletTokenCount(chain, wallet);
  const tokenConcentrationPct = visibleWalletTopTokenConcentrationPct(chain, wallet);
  return `
    <tr>
      <td data-label="Wallet" class="mono">${walletLink(chain, wallet.wallet, clusterSignals)}</td>
      <td data-label="Volume" class="num">${fmtUsd(wallet.volumeUsd)}</td>
      <td data-label="Trades" class="num">${fmtInt(wallet.tradeCount)}</td>
      <td data-label="Tokens" class="num">${fmtInt(tokenCount)}</td>
      <td data-label="Top token" class="num">${topToken} ${fmtPct(tokenConcentrationPct)}</td>
      <td data-label="Top pool" class="num">${fmtPct(wallet.poolConcentrationPct)}</td>
      <td data-label="Risk" class="num">${fmtScore(wallet.suspiciousScore)}</td>
      <td data-label="Open"><a class="ghost-link" href="/intel/wallet-pnl/wallet/${escapeAttr(wallet.wallet)}">Open</a></td>
    </tr>
  `;
}

function renderAnalyticsPoolRow(pool: WalletPnlAnalyticsPoolSummary): string {
  const ticker = displayTokenTicker(pool.tokenSymbol, pool.tokenAddress);
  return `
    <tr>
      <td data-label="Pool" class="mono">${poolLink(pool.poolId)}</td>
      <td data-label="Token">${tokenLink(pool.tokenAddress, ticker, pool.tokenSymbol)}</td>
      <td data-label="DEX">${escapeText(`${pool.dex} ${pool.protocol}`)}</td>
      <td data-label="Volume" class="num">${fmtUsd(pool.volumeUsd)}</td>
      <td data-label="Trades" class="num">${fmtInt(pool.tradeCount)}</td>
      <td data-label="Wallets" class="num">${fmtInt(pool.walletCount)}</td>
      <td data-label="Top wallet" class="num">${fmtPct(pool.topWalletConcentrationPct)}</td>
      <td data-label="Symmetry" class="num">${fmtPct(pool.buySellSymmetryPct)}</td>
      <td data-label="Risk" class="num">${fmtScore(pool.suspiciousScore)}</td>
      <td data-label="Hook">${renderPoolHookSignal(pool.v4Hook, Boolean(pool.untrustedV4Hook))}</td>
      <td data-label="Open"><a class="ghost-link" href="/intel/wallet-pnl/pool/${escapeAttr(encodeURIComponent(pool.poolId))}">Open</a></td>
    </tr>
  `;
}

function renderTokenWalletLeaderboardRow(chain: ChainSlug, row: TokenWalletRow, clusterSignals?: WalletClusterSignals): string {
  return `
    <tr>
      <td data-label="Wallet" class="mono">${walletLink(chain, row.wallet, clusterSignals)}</td>
      <td data-label="Realized PnL" class="num ${row.realizedPnlUsd >= 0 ? "is-positive" : "is-negative"}">${fmtSignedUsd(row.realizedPnlUsd)}</td>
      <td data-label="ROI" class="num">${fmtPct(row.roiPct)}</td>
      <td data-label="Proceeds" class="num">${fmtUsd(row.realizedProceedsUsd)}</td>
      <td data-label="Cost" class="num">${fmtUsd(row.realizedCostUsd)}</td>
      <td data-label="Volume" class="num">${fmtUsd(row.volumeUsd)}</td>
      <td data-label="Trades" class="num">${fmtInt(row.tradeCount)}</td>
      <td data-label="Net base" class="num">${fmtNumber(row.netBaseAmount, 4)}</td>
      <td data-label="First block" class="num">${fmtInt(row.firstBlock)}</td>
      <td data-label="Last block" class="num">${fmtInt(row.lastBlock)}</td>
      <td data-label="Open"><a class="ghost-link" href="/intel/wallet-pnl/wallet/${escapeAttr(row.wallet)}">Open</a></td>
    </tr>
  `;
}

function renderSuspiciousTokenClusters(rows: SuspiciousTokenClusterRow[]): string {
  return `
    <section class="board-card admin-wallet-card" aria-label="Suspicious token clusters">
      <div class="admin-table-toolbar">
        <span>Suspected clusters</span>
        <span class="source-pill">${fmtInt(rows.length)} clusters</span>
      </div>
      <div class="table-scroll">
        <table class="dex-table admin-wallet-table">
          <thead>
            <tr>
              <th>Cluster</th>
              <th class="num">Score</th>
              <th>Reason</th>
              <th class="num">Wallets</th>
              <th class="num">ROI range</th>
              <th class="num">Realized PnL</th>
              <th class="num">Volume</th>
              <th class="num">Trades</th>
              <th class="num">Buy/Sell</th>
              <th class="num">Entry window</th>
              <th>Open</th>
            </tr>
          </thead>
          <tbody>
            ${rows.slice(0, 25).map(renderSuspiciousTokenClusterRow).join("") || emptyRow(11, "No multi-wallet suspected clusters crossed the retained-window threshold.")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderSuspiciousTokenClusterRow(row: SuspiciousTokenClusterRow): string {
  const cohortHref = cohortHrefForCluster(row.wallets, row.label);
  return `
    <tr>
      <td data-label="Cluster">
        <a class="cluster-title-link" href="${escapeAttr(cohortHref)}"><strong>${escapeText(row.label)}</strong></a>
        <div class="muted mono">${escapeText(clusterWalletSample(row.wallets))}</div>
      </td>
      <td data-label="Score" class="num">${fmtScore(row.clusterScore)}</td>
      <td data-label="Reason">${escapeText(row.reason)}</td>
      <td data-label="Wallets" class="num">${fmtInt(row.walletCount)}</td>
      <td data-label="ROI range" class="num">${fmtPctRange(row.minRoiPct, row.maxRoiPct)}</td>
      <td data-label="Realized PnL" class="num ${row.realizedPnlUsd >= 0 ? "is-positive" : "is-negative"}">${fmtSignedUsd(row.realizedPnlUsd)}</td>
      <td data-label="Volume" class="num">${fmtUsd(row.volumeUsd)}</td>
      <td data-label="Trades" class="num">${fmtInt(row.tradeCount)}</td>
      <td data-label="Buy/Sell" class="num">${fmtInt(row.buyCount)} / ${fmtInt(row.sellCount)}</td>
      <td data-label="Entry window" class="num">${fmtBlockRange(row.firstBuyBlock, row.lastBuyBlock)}</td>
      <td data-label="Open"><a class="ghost-link" href="${escapeAttr(cohortHref)}">Wallets</a></td>
    </tr>
  `;
}

function renderTokenWalletSorts(tokenAddress: string, active: TokenWalletSort): string {
  const sorts: Array<[TokenWalletSort, string]> = [
    ["pnl", "PnL"],
    ["roi", "ROI"],
    ["losers", "Losers"],
    ["volume", "Volume"],
    ["earliest", "Earliest"],
    ["roundtrip", "Roundtrip"]
  ];
  return sorts
    .map(([sort, label]) => `<a class="admin-sort-chip${sort === active ? " is-active" : ""}" href="/intel/wallet-pnl/token/${escapeAttr(tokenAddress)}/wallets?sort=${sort}">${escapeText(label)}</a>`)
    .join("");
}

function renderOverlapForm(tokenAddress: string | undefined, _walletLimit: number): string {
  return `
    <section class="board-card admin-settings-card" aria-label="Token overlap query">
      <form class="admin-settings-form" method="get" action="/intel/wallet-pnl/overlap">
        <label class="admin-form-field admin-form-field-wide">
          <span>Token</span>
          <input name="token" value="${escapeAttr(tokenAddress ?? "")}" placeholder="0x..." />
        </label>
        <div class="admin-form-actions">
          <button class="button-link is-primary" type="submit">Analyze</button>
        </div>
      </form>
    </section>
  `;
}

function renderCohortForm(wallets: string[]): string {
  return `
    <section class="board-card admin-settings-card" aria-label="Wallet cohort query">
      <form class="admin-settings-form" method="get" action="/intel/wallet-pnl/cohort">
        <label class="admin-form-field admin-form-field-wide">
          <span>Wallets</span>
          <textarea name="wallets" spellcheck="false" placeholder="0x...&#10;0x...">${escapeText(wallets.join("\n"))}</textarea>
        </label>
        <div class="admin-form-actions">
          <button class="button-link is-primary" type="submit">Analyze</button>
        </div>
      </form>
    </section>
  `;
}

function renderHistoricalBuys(chain: ChainSlug, lookup: WalletPnlHistoricalTokenBuys | undefined): string {
  if (!lookup) return "";
  const statusText = lookup.status === "ready"
    ? `${fmtInt(lookup.sampledWalletCount)} sampled wallets`
    : lookup.status === "pending"
      ? "Backfill pending"
    : lookup.status === "disabled"
      ? "Blockscout disabled"
      : "Blockscout error";
  const rows = lookup.tokens
    .filter((token) => !isWalletPnlIgnoredToken(chain, token.tokenAddress, token.tokenSymbol))
    .slice(0, 100)
    .map((token) => {
    const ticker = displayTokenTicker(token.tokenSymbol, token.tokenAddress);
    return `
      <tr>
        <td data-label="Token">${tokenLink(token.tokenAddress, ticker, token.tokenSymbol ?? token.tokenName)}</td>
        <td data-label="Wallets" class="num">${fmtInt(token.walletCount)}</td>
        <td data-label="Transfers" class="num">${fmtInt(token.transferCount)}</td>
        <td data-label="Txs" class="num">${fmtInt(token.txCount)}</td>
        <td data-label="Blocks" class="num">${fmtInt(token.firstBlock)} to ${fmtInt(token.lastBlock)}</td>
        <td data-label="Open"><a class="ghost-link" href="/intel/wallet-pnl/token/${escapeAttr(token.tokenAddress)}">Open</a></td>
      </tr>
    `;
  }).join("");
  return `
    <section class="board-card admin-wallet-card" aria-label="Historical Blockscout token buys">
      <div class="admin-table-toolbar">
        <span>Previously bought tokens</span>
        <span class="source-pill${lookup.status === "ready" ? "" : " is-warning"}">${escapeText(statusText)}</span>
        <span class="source-pill">Last ${fmtInt(lookup.lookbackDays)}d</span>
      </div>
      ${lookup.error ? `<p class="admin-inline-note">${escapeText(lookup.error)}</p>` : ""}
      <div class="table-scroll">
        <table class="dex-table admin-wallet-table">
          <thead>
            <tr>
              <th>Token</th>
              <th class="num">Wallets</th>
              <th class="num">Transfers</th>
              <th class="num">Txs</th>
              <th class="num">Blocks</th>
              <th>Open</th>
            </tr>
          </thead>
          <tbody>
            ${rows || emptyRow(6, lookup.status === "ready" ? "No inbound ERC-20 token transfers found for this sampled cluster." : "Historical token backfill has not produced cached results yet.")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderCohortExportControls(rows: CohortWalletRow[], clusterLabel?: string): string {
  const wallets = rows.map((row) => row.wallet).join("\n");
  const csv = cohortWalletCsv(rows);
  const gmgnJson = gmgnWalletExportJson(rows, clusterLabel);
  const encodedWallets = encodeURIComponent(wallets);
  const encodedCsv = encodeURIComponent(csv);
  const encodedGmgnJson = encodeURIComponent(gmgnJson);
  return `
    <button class="button-link" type="button" data-copy-encoded="${escapeAttr(encodedWallets)}">Copy wallets</button>
    <button class="button-link" type="button" data-copy-encoded="${escapeAttr(encodedCsv)}">Copy CSV</button>
    <a class="button-link" href="data:text/csv;charset=utf-8,${escapeAttr(encodedCsv)}" download="baes-cohort-wallets.csv">Export CSV</a>
    <button class="button-link" type="button" data-copy-encoded="${escapeAttr(encodedGmgnJson)}">Copy GMGN JSON</button>
    <a class="button-link" href="data:application/json;charset=utf-8,${escapeAttr(encodedGmgnJson)}" download="${escapeAttr(gmgnWalletExportFilename(clusterLabel))}">Export GMGN JSON</a>
  `;
}

function renderCohortExportScript(): string {
  return `
    <script>
      (function () {
        function copyFallback(value) {
          var textarea = document.createElement("textarea");
          textarea.value = value;
          textarea.setAttribute("readonly", "");
          textarea.style.position = "fixed";
          textarea.style.left = "-9999px";
          document.body.appendChild(textarea);
          textarea.select();
          try { document.execCommand("copy"); } catch (_err) {}
          document.body.removeChild(textarea);
        }
        function markCopied(button) {
          var previous = button.textContent;
          button.textContent = "Copied";
          window.setTimeout(function () { button.textContent = previous; }, 1200);
        }
        document.addEventListener("click", function (event) {
          var target = event.target && event.target.closest ? event.target.closest("[data-copy-encoded]") : null;
          if (!target) return;
          var value = decodeURIComponent(target.getAttribute("data-copy-encoded") || "");
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(value).then(function () {
              markCopied(target);
            }).catch(function () {
              copyFallback(value);
              markCopied(target);
            });
            return;
          }
          copyFallback(value);
          markCopied(target);
        });
      })();
    </script>
  `;
}

function cohortWalletCsv(rows: CohortWalletRow[]): string {
  const header = [
    "wallet",
    "realized_pnl_usd",
    "roi_pct",
    "realized_proceeds_usd",
    "realized_cost_usd",
    "volume_usd",
    "trades",
    "buys",
    "sells",
    "tokens",
    "pools",
    "top_token",
    "top_token_symbol",
    "top_token_volume_usd",
    "top_token_concentration_pct",
    "first_block",
    "last_block"
  ];
  const lines = rows.map((row) => [
    row.wallet,
    row.realizedPnlUsd,
    row.roiPct,
    row.realizedProceedsUsd,
    row.realizedCostUsd,
    row.volumeUsd,
    row.tradeCount,
    row.buyCount,
    row.sellCount,
    row.tokenCount,
    row.poolCount,
    row.topTokenAddress,
    row.topTokenSymbol,
    row.topTokenVolumeUsd,
    row.topTokenConcentrationPct,
    row.firstBlock,
    row.lastBlock
  ].map(csvCell).join(","));
  return [header.join(","), ...lines].join("\n");
}

function gmgnWalletExportJson(rows: CohortWalletRow[], clusterLabel?: string): string {
  const namePrefix = gmgnWalletExportNamePrefix(clusterLabel);
  const payload = rows.map((row, index) => ({
    address: row.wallet,
    name: gmgnWalletExportWalletName(namePrefix, index),
    emoji: ""
  }));
  return JSON.stringify(payload, null, 2);
}

function gmgnWalletExportNamePrefix(value: string | undefined): string {
  const normalized = value?.replace(/\s+/g, " ").trim() || "baes cohort";
  return normalized.length > 64 ? normalized.slice(0, 61).trimEnd() + "..." : normalized;
}

function gmgnWalletExportWalletName(prefix: string, index: number): string {
  const suffix = ` ${String(index + 1).padStart(2, "0")}`;
  if (prefix.length + suffix.length <= 64) return `${prefix}${suffix}`;
  return `${prefix.slice(0, 64 - suffix.length - 3).trimEnd()}...${suffix}`;
}

function gmgnWalletExportFilename(clusterLabel?: string): string {
  const slug = (clusterLabel ?? "wallet-cluster")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "wallet-cluster";
  return `baes-gmgn-${slug}.json`;
}

function csvCell(value: string | number | undefined): string {
  if (value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

function renderTopTokenShortlist(chain: ChainSlug, analytics: WalletPnlAnalyticsSnapshot | undefined): string {
  const rows = visibleAnalyticsTokens(chain, analytics).slice(0, 20).map((token) => {
    const ticker = displayTokenTicker(token.tokenSymbol, token.tokenAddress);
    return `
      <tr>
        <td data-label="Token">${tokenLink(token.tokenAddress, ticker, token.tokenSymbol)}</td>
        <td data-label="Volume" class="num">${fmtUsd(token.volumeUsd)}</td>
        <td data-label="Wallets" class="num">${fmtInt(token.walletCount)}</td>
        <td data-label="Risk" class="num">${fmtScore(token.suspiciousScore)}</td>
        <td data-label="Open"><a class="ghost-link" href="/intel/wallet-pnl/overlap?token=${escapeAttr(token.tokenAddress)}">Overlap</a></td>
      </tr>
    `;
  }).join("");
  return `
    <section class="board-card admin-wallet-card" aria-label="Token shortlist">
      <div class="admin-table-toolbar">
        <span>Token shortlist</span>
      </div>
      <div class="table-scroll">
        <table class="dex-table admin-wallet-table">
          <thead>
            <tr>
              <th>Token</th>
              <th class="num">Volume</th>
              <th class="num">Wallets</th>
              <th class="num">Risk</th>
              <th>Open</th>
            </tr>
          </thead>
          <tbody>
            ${rows || emptyRow(5, "No token shortlist is available yet.")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderCohortWalletRow(chain: ChainSlug, row: CohortWalletRow, clusterSignals?: WalletClusterSignals): string {
  const topToken = row.topTokenAddress
    ? `${tokenLink(row.topTokenAddress, displayTokenTicker(row.topTokenSymbol, row.topTokenAddress, 12), row.topTokenSymbol)} ${fmtPct(row.topTokenConcentrationPct)}`
    : "-";
  return `
    <tr>
      <td data-label="Wallet" class="mono">${walletLink(chain, row.wallet, clusterSignals)}</td>
      <td data-label="Realized PnL" class="num ${row.realizedPnlUsd >= 0 ? "is-positive" : "is-negative"}">${fmtSignedUsd(row.realizedPnlUsd)}</td>
      <td data-label="ROI" class="num">${fmtPct(row.roiPct)}</td>
      <td data-label="Volume" class="num">${fmtUsd(row.volumeUsd)}</td>
      <td data-label="Trades" class="num">${fmtInt(row.tradeCount)}</td>
      <td data-label="Buy/Sell" class="num">${fmtInt(row.buyCount)} / ${fmtInt(row.sellCount)}</td>
      <td data-label="Tokens" class="num">${fmtInt(row.tokenCount)}</td>
      <td data-label="Pools" class="num">${fmtInt(row.poolCount)}</td>
      <td data-label="Top token" class="num">${topToken}</td>
      <td data-label="Blocks" class="num">${fmtBlockRange(row.firstBlock, row.lastBlock)}</td>
      <td data-label="Open"><a class="ghost-link" href="/intel/wallet-pnl/wallet/${escapeAttr(row.wallet)}">Open</a></td>
    </tr>
  `;
}

function renderCohortTokenRow(row: CohortTokenRow): string {
  const ticker = displayTokenTicker(row.tokenSymbol, row.tokenAddress);
  return `
    <tr>
      <td data-label="Token">${tokenLink(row.tokenAddress, ticker, row.tokenSymbol)}</td>
      <td data-label="Wallets" class="num">${fmtInt(row.walletCount)}</td>
      <td data-label="Volume" class="num">${fmtUsd(row.volumeUsd)}</td>
      <td data-label="Trades" class="num">${fmtInt(row.tradeCount)}</td>
      <td data-label="Top wallet" class="num">${fmtPct(row.topWalletConcentrationPct)}</td>
      <td data-label="Buy/Sell" class="num">${fmtInt(row.buyCount)} / ${fmtInt(row.sellCount)}</td>
      <td data-label="Blocks" class="num">${fmtInt(row.firstBlock)} to ${fmtInt(row.lastBlock)}</td>
      <td data-label="Open"><a class="ghost-link" href="/intel/wallet-pnl/token/${escapeAttr(row.tokenAddress)}">Open</a></td>
    </tr>
  `;
}

function renderCohortPoolRow(row: CohortPoolRow): string {
  return `
    <tr>
      <td data-label="Pool" class="mono">${poolLink(row.poolId)}</td>
      <td data-label="DEX">${escapeText(`${row.dex} ${row.protocol}`)}</td>
      <td data-label="Wallets" class="num">${fmtInt(row.walletCount)}</td>
      <td data-label="Volume" class="num">${fmtUsd(row.volumeUsd)}</td>
      <td data-label="Trades" class="num">${fmtInt(row.tradeCount)}</td>
      <td data-label="Blocks" class="num">${fmtInt(row.firstBlock)} to ${fmtInt(row.lastBlock)}</td>
      <td data-label="Open"><a class="ghost-link" href="/intel/wallet-pnl/pool/${escapeAttr(encodeURIComponent(row.poolId))}">Open</a></td>
    </tr>
  `;
}

function buildRiskWalletClusters(chain: ChainSlug, wallets: WalletPnlAnalyticsWalletSummary[]): RiskWalletClusterRow[] {
  const clusters: RiskWalletClusterRow[] = [];
  const seen = new Set<string>();

  const addCluster = (
    label: string,
    reason: string,
    rows: WalletPnlAnalyticsWalletSummary[],
    options: { topTokenAddress?: string; topTokenSymbol?: string; topPoolId?: string } = {}
  ): void => {
    const uniqueRows = uniqueRiskWalletRows(rows)
      .sort((a, b) => b.suspiciousScore - a.suspiciousScore || b.volumeUsd - a.volumeUsd || b.tradeCount - a.tradeCount);
    if (uniqueRows.length < 2) return;
    const key = uniqueRows.map((row) => row.wallet).sort().join("|");
    if (seen.has(key)) return;
    seen.add(key);
    clusters.push(aggregateRiskWalletCluster(label, reason, uniqueRows, options));
  };

  const byToken = new Map<string, WalletPnlAnalyticsWalletSummary[]>();
  for (const wallet of wallets) {
    if (!wallet.topTokenAddress || isWalletPnlIgnoredToken(chain, wallet.topTokenAddress, wallet.topTokenSymbol)) continue;
    if (wallet.tokenConcentrationPct < 55 && wallet.avgTradesPerToken < 40) continue;
    const key = wallet.topTokenAddress.toLowerCase();
    const rows = byToken.get(key) ?? [];
    rows.push(wallet);
    byToken.set(key, rows);
  }

  let tokenClusterIndex = 1;
  for (const [tokenAddress, rows] of byToken.entries()) {
    const top = rows[0];
    const ticker = displayTokenTicker(top?.topTokenSymbol, tokenAddress, 12);
    addCluster(
      clusterName(ticker, "Churn Cluster", tokenClusterIndex),
      "Shared top token plus high-frequency or concentrated retained trading",
      rows,
      {
        topTokenAddress: tokenAddress,
        topTokenSymbol: top?.topTokenSymbol
      }
    );
    if (rows.length >= 2) tokenClusterIndex += 1;
  }

  const byPool = new Map<string, WalletPnlAnalyticsWalletSummary[]>();
  for (const wallet of wallets) {
    if (!wallet.topPoolId) continue;
    if (wallet.poolConcentrationPct < 70 && wallet.tradeCount < 50) continue;
    const key = wallet.topPoolId.toLowerCase();
    const rows = byPool.get(key) ?? [];
    rows.push(wallet);
    byPool.set(key, rows);
  }

  let poolClusterIndex = 1;
  for (const [poolId, rows] of byPool.entries()) {
    addCluster(
      clusterName(shortAddress(poolId, 4), "Pool Cluster", poolClusterIndex),
      "Shared top pool with concentrated or high-frequency retained trading",
      rows,
      { topPoolId: poolId }
    );
    if (rows.length >= 2) poolClusterIndex += 1;
  }

  const broadChurnRows = wallets.filter((wallet) =>
    wallet.tradeCount >= 100 &&
    wallet.buySellSymmetryPct >= 70 &&
    !walletsHasCluster(seen, wallet.wallet)
  );
  addCluster(
    "High-Frequency Churn Cluster",
    "Multiple wallets share high trade count and buy/sell symmetry",
    broadChurnRows
  );

  return clusters
    .filter((cluster) => cluster.walletCount >= 2)
    .sort((a, b) => b.clusterScore - a.clusterScore || b.volumeUsd - a.volumeUsd || b.tradeCount - a.tradeCount);
}

function aggregateRiskWalletCluster(
  label: string,
  reason: string,
  rows: WalletPnlAnalyticsWalletSummary[],
  options: { topTokenAddress?: string; topTokenSymbol?: string; topPoolId?: string }
): RiskWalletClusterRow {
  const volumeUsd = rows.reduce((total, row) => total + row.volumeUsd, 0);
  const tradeCount = rows.reduce((total, row) => total + row.tradeCount, 0);
  const walletCount = rows.length;
  return {
    id: `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${rows[0]?.wallet ?? "cluster"}`,
    label,
    reason,
    clusterScore: roundFloat(Math.max(...rows.map((row) => row.suspiciousScore), 0), 1),
    wallets: rows.map((row) => row.wallet),
    walletCount,
    volumeUsd: roundMoney(volumeUsd),
    tradeCount,
    tokenCount: roundFloat(rows.reduce((total, row) => total + visibleWalletTokenCountFromSummary(row), 0) / walletCount, 1),
    topTokenAddress: options.topTokenAddress,
    topTokenSymbol: options.topTokenSymbol,
    topPoolId: options.topPoolId,
    avgSymmetryPct: roundFloat(rows.reduce((total, row) => total + row.buySellSymmetryPct, 0) / walletCount, 2),
    avgTokenConcentrationPct: options.topTokenAddress
      ? roundFloat(rows.reduce((total, row) => total + row.tokenConcentrationPct, 0) / walletCount, 2)
      : undefined,
    avgPoolConcentrationPct: roundFloat(rows.reduce((total, row) => total + row.poolConcentrationPct, 0) / walletCount, 2)
  };
}

function uniqueRiskWalletRows(rows: WalletPnlAnalyticsWalletSummary[]): WalletPnlAnalyticsWalletSummary[] {
  const seen = new Set<string>();
  const uniqueRows: WalletPnlAnalyticsWalletSummary[] = [];
  for (const row of rows) {
    const wallet = row.wallet.toLowerCase();
    if (seen.has(wallet)) continue;
    seen.add(wallet);
    uniqueRows.push({ ...row, wallet });
  }
  return uniqueRows;
}

function clusterName(subject: string, signal: string, index = 1): string {
  const cleanSubject = subject.trim() || "Wallet";
  const suffix = index > 1 ? ` ${index}` : "";
  return `${cleanSubject} ${signal}${suffix}`;
}

function riskWalletClusterRecord(chain: ChainSlug, cluster: RiskWalletClusterRow, timestamp: string): WalletPnlClusterRecord {
  const scope = cluster.topTokenAddress
    ? `token:${cluster.topTokenAddress.toLowerCase()}`
    : cluster.topPoolId
      ? `pool:${cluster.topPoolId.toLowerCase()}`
      : "broad";
  return {
    schemaVersion: 1,
    chain,
    clusterId: clusterRecordId("risk-wallets", scope, clusterSignalSlug(cluster.label, "risk")),
    label: cluster.label,
    reason: cluster.reason,
    source: "risk-wallets",
    status: "defined",
    wallets: uniqueWalletAddresses(cluster.wallets),
    walletCount: cluster.walletCount,
    clusterScore: cluster.clusterScore,
    volumeUsd: cluster.volumeUsd,
    tradeCount: cluster.tradeCount,
    tokenCount: cluster.tokenCount,
    tokenAddress: cluster.topTokenAddress,
    tokenSymbol: cluster.topTokenSymbol,
    poolId: cluster.topPoolId,
    firstSeenAt: timestamp,
    lastSeenAt: timestamp
  };
}

function buildLeaderboardClusterRecords(
  chain: ChainSlug,
  analytics: WalletPnlAnalyticsSnapshot | undefined,
  timestamp: string
): WalletPnlClusterRecord[] {
  type Bucket = {
    tokenAddress: string;
    tokenSymbol?: string;
    rows: WalletPnlAnalyticsPnlLeader[];
  };
  const byToken = new Map<string, Bucket>();
  for (const row of analytics?.roiLeaders ?? []) {
    if ((row.roiPct ?? 0) < HIGH_ROI_CLUSTER_PCT) continue;
    if (isWalletPnlIgnoredToken(chain, row.tokenAddress, row.tokenSymbol)) continue;
    const tokenAddress = row.tokenAddress.toLowerCase();
    const bucket = byToken.get(tokenAddress) ?? { tokenAddress, tokenSymbol: row.tokenSymbol, rows: [] };
    bucket.rows.push({ ...row, wallet: row.wallet.toLowerCase(), tokenAddress });
    if (!bucket.tokenSymbol && row.tokenSymbol) bucket.tokenSymbol = row.tokenSymbol;
    byToken.set(tokenAddress, bucket);
  }

  const records: WalletPnlClusterRecord[] = [];
  for (const bucket of byToken.values()) {
    const rows = uniquePnlLeaderRows(bucket.rows);
    if (rows.length < HIGH_ROI_ENTRY_CLUSTER_MIN_WALLETS) continue;
    const label = clusterName(displayTokenTicker(bucket.tokenSymbol, bucket.tokenAddress, 12), "ROI Cohort");
    const roiValues = rows
      .map((row) => row.roiPct)
      .filter((roi): roi is number => roi !== undefined && Number.isFinite(roi));
    const wallets = uniqueWalletAddresses(rows.map((row) => row.wallet));
    const volumeUsd = roundMoney(rows.reduce((total, row) => total + row.volumeUsd, 0));
    const realizedPnlUsd = roundMoney(rows.reduce((total, row) => total + row.realizedPnlUsd, 0));
    const realizedCostUsd = roundMoney(rows.reduce((total, row) => total + row.realizedCostUsd, 0));
    const realizedProceedsUsd = roundMoney(rows.reduce((total, row) => total + row.realizedProceedsUsd, 0));
    records.push({
      schemaVersion: 1,
      chain,
      clusterId: clusterRecordId("leaderboard", `token:${bucket.tokenAddress}`, "roi-cohort"),
      label,
      reason: `Multiple wallets cleared ${HIGH_ROI_CLUSTER_PCT}% ROI on the same token`,
      source: "leaderboard",
      status: "defined",
      wallets,
      walletCount: wallets.length,
      clusterScore: clampPct(55 + pressure(wallets.length, 10) * 0.25 + pressure(realizedPnlUsd, 100_000) * 0.2),
      volumeUsd,
      tradeCount: rows.reduce((total, row) => total + row.buyCount + row.sellCount, 0),
      tokenCount: 1,
      tokenAddress: bucket.tokenAddress,
      tokenSymbol: bucket.tokenSymbol,
      buyCount: rows.reduce((total, row) => total + row.buyCount, 0),
      sellCount: rows.reduce((total, row) => total + row.sellCount, 0),
      realizedPnlUsd,
      realizedCostUsd,
      realizedProceedsUsd,
      minRoiPct: roiValues.length > 0 ? Math.min(...roiValues) : undefined,
      maxRoiPct: roiValues.length > 0 ? Math.max(...roiValues) : undefined,
      firstBlock: Math.min(...rows.map((row) => row.firstBlock)),
      lastBlock: Math.max(...rows.map((row) => row.lastBlock)),
      firstSeenAt: timestamp,
      lastSeenAt: timestamp
    });
  }
  return records;
}

function suspiciousTokenClusterRecord(
  chain: ChainSlug,
  tokenAddress: string,
  tokenSymbol: string | undefined,
  cluster: SuspiciousTokenClusterRow,
  timestamp: string
): WalletPnlClusterRecord {
  const normalizedToken = tokenAddress.toLowerCase();
  return {
    schemaVersion: 1,
    chain,
    clusterId: clusterRecordId("token-detail", `token:${normalizedToken}`, tokenClusterSignalSlug(cluster)),
    label: cluster.label,
    reason: cluster.reason,
    source: "token-detail",
    status: "defined",
    wallets: uniqueWalletAddresses(cluster.wallets),
    walletCount: cluster.walletCount,
    clusterScore: cluster.clusterScore,
    volumeUsd: cluster.volumeUsd,
    tradeCount: cluster.tradeCount,
    tokenCount: 1,
    tokenAddress: normalizedToken,
    tokenSymbol,
    buyCount: cluster.buyCount,
    sellCount: cluster.sellCount,
    realizedPnlUsd: cluster.realizedPnlUsd,
    realizedCostUsd: cluster.realizedCostUsd,
    realizedProceedsUsd: cluster.realizedProceedsUsd,
    minRoiPct: cluster.minRoiPct,
    maxRoiPct: cluster.maxRoiPct,
    firstBuyBlock: cluster.firstBuyBlock,
    lastBuyBlock: cluster.lastBuyBlock,
    firstBlock: cluster.firstBuyBlock,
    lastBlock: cluster.lastBuyBlock,
    firstSeenAt: timestamp,
    lastSeenAt: timestamp
  };
}

function uniquePnlLeaderRows(rows: WalletPnlAnalyticsPnlLeader[]): WalletPnlAnalyticsPnlLeader[] {
  const seen = new Set<string>();
  const out: WalletPnlAnalyticsPnlLeader[] = [];
  for (const row of rows) {
    const key = row.wallet.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...row, wallet: key });
  }
  return out;
}

function clusterRecordId(source: WalletPnlClusterRecord["source"], scope: string, signal: string): string {
  return `${source}:${slugPart(scope)}:${slugPart(signal)}`.toLowerCase();
}

function tokenClusterSignalSlug(cluster: SuspiciousTokenClusterRow): string {
  const lower = cluster.label.toLowerCase();
  if (lower.includes("flash entry")) return `flash-entry:${cluster.firstBuyBlock ?? "unknown"}`;
  if (lower.includes("roi cohort")) return "roi-cohort";
  if (lower.includes("churn cluster")) return "churn-cluster";
  return clusterSignalSlug(cluster.label, "token-cluster");
}

function clusterSignalSlug(label: string, fallback: string): string {
  const lower = label.toLowerCase();
  if (lower.includes("churn cluster")) return "churn-cluster";
  if (lower.includes("pool cluster")) return "pool-cluster";
  if (lower.includes("high-frequency")) return "high-frequency";
  if (lower.includes("roi cohort")) return "roi-cohort";
  if (lower.includes("flash entry")) return "flash-entry";
  return fallback;
}

function slugPart(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9:]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "cluster";
}

function uniqueClusterRecords(records: WalletPnlClusterRecord[]): WalletPnlClusterRecord[] {
  const out: WalletPnlClusterRecord[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const key = `${record.chain}:${record.clusterId.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      ...record,
      clusterId: record.clusterId.toLowerCase(),
      wallets: uniqueWalletAddresses(record.wallets),
      walletCount: uniqueWalletAddresses(record.wallets).length
    });
  }
  return out.filter((record) => record.walletCount >= HIGH_ROI_ENTRY_CLUSTER_MIN_WALLETS);
}

function walletPnlClusterTimestamp(
  analytics: WalletPnlAnalyticsSnapshot | undefined,
  trades: WalletPnlTradeRecord[]
): string {
  if (analytics?.generatedAt) return analytics.generatedAt;
  const latestTrade = trades.reduce<WalletPnlTradeRecord | undefined>((latest, trade) => {
    if (!latest) return trade;
    if (trade.blockNumber > latest.blockNumber) return trade;
    if (trade.blockNumber === latest.blockNumber && trade.logIndex > latest.logIndex) return trade;
    return latest;
  }, undefined);
  return latestTrade?.createdAt ?? new Date(0).toISOString();
}

function buildWalletClusterSignals(
  chain: ChainSlug,
  analytics: WalletPnlAnalyticsSnapshot | undefined,
  extraClusters: WalletClusterSource[] = [],
  persistedClusters: WalletPnlClusterRecord[] = []
): WalletClusterSignals {
  const signals: WalletClusterSignals = { byWallet: new Map() };
  const riskClusters = buildRiskWalletClusters(chain, visibleAnalyticsWallets(chain, analytics?.riskWallets));
  const leaderboardClusters = buildLeaderboardClusterSources(chain, analytics);
  const persistedSources = walletClusterSourcesFromRecords(chain, persistedClusters);
  for (const cluster of [...persistedSources, ...riskClusters, ...leaderboardClusters, ...extraClusters]) {
    addWalletClusterSignal(signals, cluster);
  }
  return signals;
}

function resolveCohortClusterLabel(
  explicitLabel: string | undefined,
  wallets: string[],
  clusterSignals: WalletClusterSignals
): string | undefined {
  const trimmed = explicitLabel?.trim();
  if (trimmed) return trimmed;
  const targetWallets = uniqueWalletAddresses(wallets);
  if (targetWallets.length < 2) return undefined;
  const target = new Set(targetWallets);
  let best: { label: string; score: number } | undefined;
  for (const wallet of targetWallets) {
    for (const cluster of clusterSignals.byWallet.get(wallet) ?? []) {
      const clusterWallets = uniqueWalletAddresses(cluster.wallets);
      const overlap = clusterWallets.filter((candidate) => target.has(candidate)).length;
      if (overlap < 2) continue;
      const coversTarget = overlap === targetWallets.length;
      const exact = coversTarget && clusterWallets.length === targetWallets.length;
      const score = exact
        ? 1_000_000
        : coversTarget
          ? 500_000 - Math.max(0, clusterWallets.length - targetWallets.length)
          : overlap;
      if (!best || score > best.score) {
        best = { label: cluster.label, score };
      }
    }
  }
  return best?.label;
}

function buildLeaderboardClusterSources(
  chain: ChainSlug,
  analytics: WalletPnlAnalyticsSnapshot | undefined
): WalletClusterSource[] {
  const byToken = new Map<string, { tokenAddress: string; tokenSymbol?: string; wallets: string[] }>();
  for (const row of analytics?.roiLeaders ?? []) {
    if ((row.roiPct ?? 0) < HIGH_ROI_CLUSTER_PCT) continue;
    if (isWalletPnlIgnoredToken(chain, row.tokenAddress, row.tokenSymbol)) continue;
    const tokenAddress = row.tokenAddress.toLowerCase();
    const bucket = byToken.get(tokenAddress) ?? { tokenAddress, tokenSymbol: row.tokenSymbol, wallets: [] };
    bucket.wallets.push(row.wallet.toLowerCase());
    if (!bucket.tokenSymbol && row.tokenSymbol) bucket.tokenSymbol = row.tokenSymbol;
    byToken.set(tokenAddress, bucket);
  }
  return [...byToken.values()]
    .map((bucket) => ({ ...bucket, wallets: uniqueWalletAddresses(bucket.wallets) }))
    .filter((bucket) => bucket.wallets.length >= 2)
    .map((bucket) => ({
      label: clusterName(displayTokenTicker(bucket.tokenSymbol, bucket.tokenAddress, 12), "ROI Cohort"),
      wallets: bucket.wallets
    }));
}

function walletClusterSourcesFromRecords(chain: ChainSlug, records: WalletPnlClusterRecord[]): WalletClusterSource[] {
  return records
    .filter((record) => record.chain === chain && record.wallets.length >= HIGH_ROI_ENTRY_CLUSTER_MIN_WALLETS)
    .map((record) => ({
      label: record.label,
      wallets: record.wallets
    }));
}

function riskWalletRowsFromPersistedClusters(chain: ChainSlug, records: WalletPnlClusterRecord[] | undefined): RiskWalletClusterRow[] {
  return (records ?? [])
    .filter((record) => record.chain === chain && record.wallets.length >= HIGH_ROI_ENTRY_CLUSTER_MIN_WALLETS)
    .map((record): RiskWalletClusterRow => ({
      id: record.clusterId,
      label: record.label,
      reason: record.reason,
      clusterScore: record.clusterScore,
      wallets: uniqueWalletAddresses(record.wallets),
      walletCount: record.walletCount || record.wallets.length,
      volumeUsd: record.volumeUsd,
      tradeCount: record.tradeCount,
      tokenCount: record.tokenCount ?? (record.tokenAddress ? 1 : 0),
      topTokenAddress: record.tokenAddress,
      topTokenSymbol: record.tokenSymbol,
      topPoolId: record.poolId,
      avgSymmetryPct: undefined,
      avgTokenConcentrationPct: undefined,
      avgPoolConcentrationPct: undefined
    }));
}

function tokenClusterRowsFromPersistedClusters(
  chain: ChainSlug,
  tokenAddress: string,
  records: WalletPnlClusterRecord[] | undefined
): SuspiciousTokenClusterRow[] {
  const normalizedToken = tokenAddress.toLowerCase();
  return (records ?? [])
    .filter((record) =>
      record.chain === chain &&
      record.tokenAddress?.toLowerCase() === normalizedToken &&
      record.wallets.length >= HIGH_ROI_ENTRY_CLUSTER_MIN_WALLETS
    )
    .map((record): SuspiciousTokenClusterRow => ({
      id: record.clusterId,
      label: record.label,
      reason: record.reason,
      clusterScore: record.clusterScore,
      wallets: uniqueWalletAddresses(record.wallets),
      walletCount: record.walletCount || record.wallets.length,
      volumeUsd: record.volumeUsd,
      tradeCount: record.tradeCount,
      buyCount: record.buyCount ?? 0,
      sellCount: record.sellCount ?? 0,
      realizedPnlUsd: record.realizedPnlUsd ?? 0,
      realizedCostUsd: record.realizedCostUsd ?? 0,
      realizedProceedsUsd: record.realizedProceedsUsd ?? 0,
      minRoiPct: record.minRoiPct,
      maxRoiPct: record.maxRoiPct,
      netBaseAmount: 0,
      firstBuyBlock: record.firstBuyBlock ?? record.firstBlock,
      lastBuyBlock: record.lastBuyBlock ?? record.lastBlock
    }));
}

function mergeRiskWalletClusters(current: RiskWalletClusterRow[], persisted: RiskWalletClusterRow[]): RiskWalletClusterRow[] {
  const persistedLabels = new Set(persisted.map((cluster) => cluster.label.toLowerCase()));
  return [
    ...persisted,
    ...current.filter((cluster) => !persistedLabels.has(cluster.label.toLowerCase()))
  ]
    .filter((cluster) => cluster.walletCount >= HIGH_ROI_ENTRY_CLUSTER_MIN_WALLETS)
    .sort((a, b) => b.clusterScore - a.clusterScore || b.volumeUsd - a.volumeUsd || b.tradeCount - a.tradeCount);
}

function mergeSuspiciousTokenClusters(current: SuspiciousTokenClusterRow[], persisted: SuspiciousTokenClusterRow[]): SuspiciousTokenClusterRow[] {
  const persistedLabels = new Set(persisted.map((cluster) => cluster.label.toLowerCase()));
  return [
    ...persisted,
    ...current.filter((cluster) => !persistedLabels.has(cluster.label.toLowerCase()))
  ]
    .filter((cluster) => cluster.walletCount >= HIGH_ROI_ENTRY_CLUSTER_MIN_WALLETS)
    .sort((a, b) => b.clusterScore - a.clusterScore || b.realizedPnlUsd - a.realizedPnlUsd || b.volumeUsd - a.volumeUsd || b.walletCount - a.walletCount);
}

function addWalletClusterSignal(signals: WalletClusterSignals, cluster: WalletClusterSource): void {
  const wallets = uniqueWalletAddresses(cluster.wallets);
  if (wallets.length < 2) return;
  for (const wallet of wallets) {
    const existing = signals.byWallet.get(wallet) ?? [];
    if (!existing.some((item) => item.label === cluster.label && item.wallets.join("|") === wallets.join("|"))) {
      existing.push({ label: cluster.label, wallets });
      signals.byWallet.set(wallet, existing);
    }
  }
}

function uniqueWalletAddresses(wallets: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const wallet of wallets) {
    const normalized = wallet.toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function cohortHrefForCluster(wallets: string[], label?: string): string {
  const clusterParam = label ? `&cluster=${encodeURIComponent(label)}` : "";
  return `/intel/wallet-pnl/cohort?wallets=${encodeURIComponent(uniqueWalletAddresses(wallets).join(","))}${clusterParam}`;
}

function walletsHasCluster(clusterKeys: Set<string>, wallet: string): boolean {
  const needle = wallet.toLowerCase();
  for (const key of clusterKeys) {
    if (key.split("|").includes(needle)) return true;
  }
  return false;
}

function visibleWalletTokenCountFromSummary(wallet: WalletPnlAnalyticsWalletSummary): number {
  return wallet.tokenCount;
}

function buildTokenWalletRows(trades: WalletPnlTradeRecord[]): TokenWalletRow[] {
  const rows = new Map<string, TokenWalletRow & { quantity: number; costUsd: number }>();
  for (const trade of orderTrades(trades)) {
    const key = trade.wallet.toLowerCase();
    const row = rows.get(key) ?? {
      wallet: key,
      tradeCount: 0,
      buyCount: 0,
      sellCount: 0,
      volumeUsd: 0,
      realizedPnlUsd: 0,
      realizedCostUsd: 0,
      realizedProceedsUsd: 0,
      netBaseAmount: 0,
      firstBlock: trade.blockNumber,
      lastBlock: trade.blockNumber,
      quantity: 0,
      costUsd: 0
    };
    if (trade.side === "buy") {
      row.firstBuyBlock = row.firstBuyBlock === undefined ? trade.blockNumber : Math.min(row.firstBuyBlock, trade.blockNumber);
    }
    applyPnlTrade(row, trade);
    rows.set(key, row);
  }
  return finalizePnlRows([...rows.values()]);
}

function buildSuspiciousTokenClusters(chain: ChainSlug, rows: TokenWalletRow[], tokenLabel = "Token"): SuspiciousTokenClusterRow[] {
  const clusters: SuspiciousTokenClusterRow[] = [];
  const seen = new Set<string>();
  const coordinatedEntryClusters = coordinatedHighRoiEntryClusters(chain, rows);
  const coordinatedEntryWallets = new Set(coordinatedEntryClusters.flatMap((cluster) => cluster.map((row) => row.wallet)));
  let entryIndex = 1;

  const addCluster = (label: string, reason: string, clusterRows: TokenWalletRow[], coordinatedEntry = false): void => {
    const uniqueRows = uniqueWalletRows(clusterRows);
    if (uniqueRows.length < HIGH_ROI_ENTRY_CLUSTER_MIN_WALLETS) return;
    const key = uniqueRows.map((row) => row.wallet).sort().join("|");
    if (seen.has(key)) return;
    seen.add(key);
    clusters.push(aggregateSuspiciousTokenCluster(label, reason, uniqueRows, coordinatedEntry));
  };

  for (const clusterRows of coordinatedEntryClusters) {
    addCluster(
      clusterName(tokenLabel, "Flash Entry", entryIndex),
      `High-ROI wallets first bought within ${formatDuration(HIGH_ROI_ENTRY_CLUSTER_WINDOW_MS)}`,
      clusterRows,
      true
    );
    entryIndex += 1;
  }

  const highRoiRows = rows.filter((row) => isHighRoiClusterWallet(row) && !coordinatedEntryWallets.has(row.wallet));
  addCluster(
    clusterName(tokenLabel, "ROI Cohort"),
    `Multiple wallets cleared ${HIGH_ROI_CLUSTER_PCT}% ROI in the retained window`,
    highRoiRows
  );

  const behavioralRows = rows.filter((row) => {
    if (coordinatedEntryWallets.has(row.wallet) || isHighRoiClusterWallet(row)) return false;
    const score = suspiciousTokenWalletScore(row, false);
    return score >= 45 || (row.tradeCount >= 12 && row.buyCount > 0 && row.sellCount > 0);
  });
  addCluster(
    clusterName(tokenLabel, "Churn Cluster"),
    "Multiple wallets share high-frequency, symmetric, or flat-position retained behavior",
    behavioralRows
  );

  return clusters
    .filter((cluster) => cluster.walletCount >= HIGH_ROI_ENTRY_CLUSTER_MIN_WALLETS)
    .sort((a, b) => b.clusterScore - a.clusterScore || b.realizedPnlUsd - a.realizedPnlUsd || b.volumeUsd - a.volumeUsd || b.walletCount - a.walletCount);
}

function coordinatedHighRoiEntryClusters(chain: ChainSlug, rows: TokenWalletRow[]): TokenWalletRow[][] {
  const highRoiRows = rows
    .filter((row) => isHighRoiClusterWallet(row) && row.firstBuyBlock !== undefined)
    .sort((a, b) => (a.firstBuyBlock ?? 0) - (b.firstBuyBlock ?? 0));
  const clusters: TokenWalletRow[][] = [];
  const assigned = new Set<string>();
  const windowBlocks = highRoiEntryWindowBlocks(chain);
  for (let start = 0; start < highRoiRows.length; start += 1) {
    const first = highRoiRows[start];
    const startBlock = first?.firstBuyBlock;
    if (!first || startBlock === undefined || assigned.has(first.wallet)) continue;
    const cluster: TokenWalletRow[] = [];
    for (let index = start; index < highRoiRows.length; index += 1) {
      const row = highRoiRows[index];
      if (!row || row.firstBuyBlock === undefined || row.firstBuyBlock - startBlock > windowBlocks) break;
      if (assigned.has(row.wallet)) continue;
      cluster.push(row);
    }
    if (cluster.length >= HIGH_ROI_ENTRY_CLUSTER_MIN_WALLETS) {
      for (const row of cluster) assigned.add(row.wallet);
      clusters.push(cluster);
    }
  }
  return clusters;
}

function aggregateSuspiciousTokenCluster(label: string, reason: string, rows: TokenWalletRow[], coordinatedEntry: boolean): SuspiciousTokenClusterRow {
  const sortedRows = rows
    .slice()
    .sort((a, b) => suspiciousTokenWalletScore(b, coordinatedEntry) - suspiciousTokenWalletScore(a, coordinatedEntry) || b.volumeUsd - a.volumeUsd);
  const roiValues = sortedRows
    .map((row) => row.roiPct)
    .filter((roi): roi is number => roi !== undefined && Number.isFinite(roi));
  const firstBuyBlocks = sortedRows
    .map((row) => row.firstBuyBlock)
    .filter((block): block is number => block !== undefined && Number.isFinite(block));
  const scores = sortedRows.map((row) => suspiciousTokenWalletScore(row, coordinatedEntry));

  return {
    id: `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${sortedRows[0]?.wallet ?? "cluster"}`,
    label,
    reason,
    clusterScore: roundFloat(Math.max(...scores, 0), 1),
    wallets: sortedRows.map((row) => row.wallet),
    walletCount: sortedRows.length,
    volumeUsd: roundMoney(sortedRows.reduce((total, row) => total + row.volumeUsd, 0)),
    tradeCount: sortedRows.reduce((total, row) => total + row.tradeCount, 0),
    buyCount: sortedRows.reduce((total, row) => total + row.buyCount, 0),
    sellCount: sortedRows.reduce((total, row) => total + row.sellCount, 0),
    realizedPnlUsd: roundMoney(sortedRows.reduce((total, row) => total + row.realizedPnlUsd, 0)),
    realizedCostUsd: roundMoney(sortedRows.reduce((total, row) => total + row.realizedCostUsd, 0)),
    realizedProceedsUsd: roundMoney(sortedRows.reduce((total, row) => total + row.realizedProceedsUsd, 0)),
    minRoiPct: roiValues.length > 0 ? Math.min(...roiValues) : undefined,
    maxRoiPct: roiValues.length > 0 ? Math.max(...roiValues) : undefined,
    netBaseAmount: roundFloat(sortedRows.reduce((total, row) => total + row.netBaseAmount, 0), 6),
    firstBuyBlock: firstBuyBlocks.length > 0 ? Math.min(...firstBuyBlocks) : undefined,
    lastBuyBlock: firstBuyBlocks.length > 0 ? Math.max(...firstBuyBlocks) : undefined
  };
}

function uniqueWalletRows(rows: TokenWalletRow[]): TokenWalletRow[] {
  const seen = new Set<string>();
  const uniqueRows: TokenWalletRow[] = [];
  for (const row of rows) {
    if (seen.has(row.wallet)) continue;
    seen.add(row.wallet);
    uniqueRows.push(row);
  }
  return uniqueRows;
}

function suspiciousTokenWalletScore(row: TokenWalletRow, coordinatedEntry: boolean): number {
  const symmetryPct = tokenWalletSymmetryPct(row);
  const roundtripSignal = Math.abs(row.netBaseAmount) <= 0.000001 && row.buyCount > 0 && row.sellCount > 0 ? 18 : 0;
  const highRoiSignal = isHighRoiClusterWallet(row) ? 34 : 0;
  const coordinatedEntrySignal = coordinatedEntry ? 22 : 0;
  return clampPct(
    pressure(row.tradeCount, 30) * 0.34 +
    pressure(row.volumeUsd, 100_000) * 0.24 +
    symmetryPct * 0.24 +
    roundtripSignal +
    highRoiSignal +
    coordinatedEntrySignal
  );
}

function tokenWalletSymmetryPct(row: TokenWalletRow): number {
  const totalSides = row.buyCount + row.sellCount;
  return totalSides > 0 ? (1 - Math.abs(row.buyCount - row.sellCount) / totalSides) * 100 : 0;
}

function highRoiEntryWindowBlocks(chain: ChainSlug): number {
  return Math.max(1, Math.ceil((HIGH_ROI_ENTRY_CLUSTER_WINDOW_MS / 1000) / blockSecondsFor(chain)));
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 1) return `${minutes}m`;
  return `${Math.round(ms / 1000)}s`;
}

function formatCadence(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
  if (minutes >= 1) return `${minutes}m`;
  return `${Math.round(ms / 1000)}s`;
}

function isHighRoiClusterWallet(row: TokenWalletRow): boolean {
  return Boolean(
    row.roiPct !== undefined &&
    row.roiPct >= HIGH_ROI_CLUSTER_PCT &&
    row.realizedCostUsd >= HIGH_ROI_CLUSTER_MIN_COST_USD &&
    row.realizedProceedsUsd >= HIGH_ROI_CLUSTER_MIN_PROCEEDS_USD
  );
}

function buildWalletTokenRows(chain: ChainSlug, trades: WalletPnlTradeRecord[]): WalletTokenRow[] {
  const rows = new Map<string, WalletTokenRow & { quantity: number; costUsd: number }>();
  for (const trade of orderTrades(trades)) {
    if (isWalletPnlIgnoredToken(chain, trade.tokenAddress, trade.tokenSymbol)) continue;
    const key = trade.tokenAddress.toLowerCase();
    const row = rows.get(key) ?? {
      tokenAddress: key,
      tokenSymbol: trade.tokenSymbol,
      tradeCount: 0,
      buyCount: 0,
      sellCount: 0,
      volumeUsd: 0,
      realizedPnlUsd: 0,
      realizedCostUsd: 0,
      realizedProceedsUsd: 0,
      netBaseAmount: 0,
      firstBlock: trade.blockNumber,
      lastBlock: trade.blockNumber,
      quantity: 0,
      costUsd: 0
    };
    applyPnlTrade(row, trade);
    rows.set(key, row);
  }
  return finalizePnlRows([...rows.values()]);
}

function buildPoolWalletRows(trades: WalletPnlTradeRecord[]): TokenWalletRow[] {
  const rows = new Map<string, TokenWalletRow & { quantity: number; costUsd: number }>();
  for (const trade of orderTrades(trades)) {
    const key = trade.wallet.toLowerCase();
    const row = rows.get(key) ?? {
      wallet: key,
      tradeCount: 0,
      buyCount: 0,
      sellCount: 0,
      volumeUsd: 0,
      realizedPnlUsd: 0,
      realizedCostUsd: 0,
      realizedProceedsUsd: 0,
      netBaseAmount: 0,
      firstBlock: trade.blockNumber,
      lastBlock: trade.blockNumber,
      quantity: 0,
      costUsd: 0
    };
    applyPnlTrade(row, trade);
    rows.set(key, row);
  }
  return finalizePnlRows([...rows.values()]).sort((a, b) => b.volumeUsd - a.volumeUsd || b.tradeCount - a.tradeCount);
}

function buildPoolRows(trades: WalletPnlTradeRecord[]): PoolRow[] {
  const rows = new Map<string, PoolRow & { wallets: Set<string> }>();
  for (const trade of trades) {
    const key = trade.poolId.toLowerCase();
    const row = rows.get(key) ?? {
      poolId: key,
      dex: trade.dex,
      protocol: trade.protocol,
      tradeCount: 0,
      walletCount: 0,
      wallets: new Set(),
      buyCount: 0,
      sellCount: 0,
      volumeUsd: 0,
      firstBlock: trade.blockNumber,
      lastBlock: trade.blockNumber
    };
    row.tradeCount += 1;
    row.wallets.add(trade.wallet.toLowerCase());
    row.walletCount = row.wallets.size;
    row.volumeUsd += safeNumber(trade.volumeUsd);
    row.firstBlock = Math.min(row.firstBlock, trade.blockNumber);
    row.lastBlock = Math.max(row.lastBlock, trade.blockNumber);
    if (trade.side === "buy") row.buyCount += 1;
    else row.sellCount += 1;
    rows.set(key, row);
  }
  return [...rows.values()]
    .map(({ wallets: _wallets, ...row }) => ({ ...row, volumeUsd: roundMoney(row.volumeUsd) }))
    .sort((a, b) => b.volumeUsd - a.volumeUsd || b.tradeCount - a.tradeCount);
}

function buildCohortWalletRows(chain: ChainSlug, wallets: string[], trades: WalletPnlTradeRecord[]): CohortWalletRow[] {
  type MutableWalletRow = CohortWalletRow & {
    tokens: Set<string>;
    pools: Set<string>;
    tokenVolumes: Map<string, { tokenAddress: string; tokenSymbol?: string; volumeUsd: number }>;
  };
  type PnlBucket = {
    tradeCount: number;
    buyCount: number;
    sellCount: number;
    volumeUsd: number;
    realizedPnlUsd: number;
    realizedCostUsd: number;
    realizedProceedsUsd: number;
    netBaseAmount: number;
    firstBlock: number;
    lastBlock: number;
    quantity: number;
    costUsd: number;
  };

  const rows = new Map<string, MutableWalletRow>();
  const pnlBuckets = new Map<string, PnlBucket>();
  const ensureRow = (wallet: string): MutableWalletRow => {
    const key = wallet.toLowerCase();
    const existing = rows.get(key);
    if (existing) return existing;
    const row: MutableWalletRow = {
      wallet: key,
      tradeCount: 0,
      buyCount: 0,
      sellCount: 0,
      tokenCount: 0,
      poolCount: 0,
      volumeUsd: 0,
      realizedPnlUsd: 0,
      realizedCostUsd: 0,
      realizedProceedsUsd: 0,
      topTokenVolumeUsd: 0,
      tokens: new Set(),
      pools: new Set(),
      tokenVolumes: new Map()
    };
    rows.set(key, row);
    return row;
  };

  for (const wallet of wallets) ensureRow(wallet);
  for (const trade of orderTrades(trades)) {
    const wallet = trade.wallet.toLowerCase();
    const row = ensureRow(wallet);
    const valueUsd = safeNumber(trade.volumeUsd);
    row.tradeCount += 1;
    row.volumeUsd += valueUsd;
    row.firstBlock = row.firstBlock === undefined ? trade.blockNumber : Math.min(row.firstBlock, trade.blockNumber);
    row.lastBlock = row.lastBlock === undefined ? trade.blockNumber : Math.max(row.lastBlock, trade.blockNumber);
    row.pools.add(trade.poolId.toLowerCase());
    row.poolCount = row.pools.size;
    if (trade.side === "buy") row.buyCount += 1;
    else row.sellCount += 1;

    const tokenAddress = trade.tokenAddress.toLowerCase();
    if (isWalletPnlIgnoredToken(chain, tokenAddress, trade.tokenSymbol)) continue;
    row.tokens.add(tokenAddress);
    row.tokenCount = row.tokens.size;
    const tokenVolume = row.tokenVolumes.get(tokenAddress) ?? {
      tokenAddress,
      tokenSymbol: trade.tokenSymbol,
      volumeUsd: 0
    };
    tokenVolume.volumeUsd += valueUsd;
    if (!tokenVolume.tokenSymbol && trade.tokenSymbol) tokenVolume.tokenSymbol = trade.tokenSymbol;
    row.tokenVolumes.set(tokenAddress, tokenVolume);

    const bucketKey = `${wallet}:${tokenAddress}`;
    const bucket = pnlBuckets.get(bucketKey) ?? {
      tradeCount: 0,
      buyCount: 0,
      sellCount: 0,
      volumeUsd: 0,
      realizedPnlUsd: 0,
      realizedCostUsd: 0,
      realizedProceedsUsd: 0,
      netBaseAmount: 0,
      firstBlock: trade.blockNumber,
      lastBlock: trade.blockNumber,
      quantity: 0,
      costUsd: 0
    };
    const beforePnl = bucket.realizedPnlUsd;
    const beforeCost = bucket.realizedCostUsd;
    const beforeProceeds = bucket.realizedProceedsUsd;
    applyPnlTrade(bucket, trade);
    row.realizedPnlUsd += bucket.realizedPnlUsd - beforePnl;
    row.realizedCostUsd += bucket.realizedCostUsd - beforeCost;
    row.realizedProceedsUsd += bucket.realizedProceedsUsd - beforeProceeds;
    pnlBuckets.set(bucketKey, bucket);
  }

  return [...rows.values()]
    .map(({ tokens: _tokens, pools: _pools, tokenVolumes, ...row }) => {
      const topToken = [...tokenVolumes.values()].sort((a, b) => b.volumeUsd - a.volumeUsd)[0];
      const topTokenVolumeUsd = topToken ? roundMoney(topToken.volumeUsd) : 0;
      return {
        ...row,
        volumeUsd: roundMoney(row.volumeUsd),
        realizedPnlUsd: roundMoney(row.realizedPnlUsd),
        realizedCostUsd: roundMoney(row.realizedCostUsd),
        realizedProceedsUsd: roundMoney(row.realizedProceedsUsd),
        roiPct: row.realizedCostUsd > 0 ? roundFloat((row.realizedPnlUsd / row.realizedCostUsd) * 100, 2) : undefined,
        topTokenAddress: topToken?.tokenAddress,
        topTokenSymbol: topToken?.tokenSymbol,
        topTokenVolumeUsd,
        topTokenConcentrationPct: row.volumeUsd > 0 && topToken ? roundFloat((topToken.volumeUsd / row.volumeUsd) * 100, 2) : undefined
      };
    })
    .sort((a, b) => b.realizedPnlUsd - a.realizedPnlUsd || (b.roiPct ?? 0) - (a.roiPct ?? 0) || b.volumeUsd - a.volumeUsd);
}

function buildCohortTokenRows(chain: ChainSlug, trades: WalletPnlTradeRecord[], excludeTokenAddress?: string): CohortTokenRow[] {
  const excluded = excludeTokenAddress?.toLowerCase();
  const rows = new Map<string, CohortTokenRow & { wallets: Set<string>; walletVolumes: Map<string, number> }>();
  for (const trade of trades) {
    const key = trade.tokenAddress.toLowerCase();
    if (excluded && key === excluded) continue;
    if (isWalletPnlIgnoredToken(chain, key, trade.tokenSymbol)) continue;
    const row = rows.get(key) ?? {
      tokenAddress: key,
      tokenSymbol: trade.tokenSymbol,
      walletCount: 0,
      tradeCount: 0,
      buyCount: 0,
      sellCount: 0,
      volumeUsd: 0,
      topWalletVolumeUsd: 0,
      topWalletConcentrationPct: 0,
      firstBlock: trade.blockNumber,
      lastBlock: trade.blockNumber,
      wallets: new Set(),
      walletVolumes: new Map()
    };
    const wallet = trade.wallet.toLowerCase();
    const valueUsd = safeNumber(trade.volumeUsd);
    row.wallets.add(wallet);
    row.walletCount = row.wallets.size;
    row.tradeCount += 1;
    row.volumeUsd += valueUsd;
    row.walletVolumes.set(wallet, (row.walletVolumes.get(wallet) ?? 0) + valueUsd);
    row.firstBlock = Math.min(row.firstBlock, trade.blockNumber);
    row.lastBlock = Math.max(row.lastBlock, trade.blockNumber);
    if (trade.side === "buy") row.buyCount += 1;
    else row.sellCount += 1;
    rows.set(key, row);
  }
  return [...rows.values()]
    .map(({ wallets: _wallets, walletVolumes, ...row }) => {
      const topWalletVolumeUsd = Math.max(0, ...walletVolumes.values());
      return {
        ...row,
        volumeUsd: roundMoney(row.volumeUsd),
        topWalletVolumeUsd: roundMoney(topWalletVolumeUsd),
        topWalletConcentrationPct: row.volumeUsd > 0 ? roundFloat((topWalletVolumeUsd / row.volumeUsd) * 100, 2) : 0
      };
    })
    .sort((a, b) => b.walletCount - a.walletCount || b.volumeUsd - a.volumeUsd || b.tradeCount - a.tradeCount);
}

function buildCohortPoolRows(trades: WalletPnlTradeRecord[]): CohortPoolRow[] {
  const rows = new Map<string, CohortPoolRow & { wallets: Set<string> }>();
  for (const trade of trades) {
    const key = trade.poolId.toLowerCase();
    const row = rows.get(key) ?? {
      poolId: key,
      dex: trade.dex,
      protocol: trade.protocol,
      walletCount: 0,
      tradeCount: 0,
      volumeUsd: 0,
      firstBlock: trade.blockNumber,
      lastBlock: trade.blockNumber,
      wallets: new Set()
    };
    row.wallets.add(trade.wallet.toLowerCase());
    row.walletCount = row.wallets.size;
    row.tradeCount += 1;
    row.volumeUsd += safeNumber(trade.volumeUsd);
    row.firstBlock = Math.min(row.firstBlock, trade.blockNumber);
    row.lastBlock = Math.max(row.lastBlock, trade.blockNumber);
    rows.set(key, row);
  }
  return [...rows.values()]
    .map(({ wallets: _wallets, ...row }) => ({ ...row, volumeUsd: roundMoney(row.volumeUsd) }))
    .sort((a, b) => b.walletCount - a.walletCount || b.volumeUsd - a.volumeUsd || b.tradeCount - a.tradeCount);
}

function sortTokenWalletRows(rows: TokenWalletRow[], sort: TokenWalletSort): TokenWalletRow[] {
  const sorted = rows.slice();
  if (sort === "roi") {
    return sorted.sort((a, b) => (b.roiPct ?? Number.NEGATIVE_INFINITY) - (a.roiPct ?? Number.NEGATIVE_INFINITY) || b.realizedPnlUsd - a.realizedPnlUsd);
  }
  if (sort === "losers") {
    return sorted.sort((a, b) => a.realizedPnlUsd - b.realizedPnlUsd || b.volumeUsd - a.volumeUsd);
  }
  if (sort === "volume") {
    return sorted.sort((a, b) => b.volumeUsd - a.volumeUsd || b.tradeCount - a.tradeCount);
  }
  if (sort === "earliest") {
    return sorted.sort((a, b) => a.firstBlock - b.firstBlock || b.volumeUsd - a.volumeUsd);
  }
  if (sort === "roundtrip") {
    return sorted.sort((a, b) => roundtripScore(b) - roundtripScore(a) || b.volumeUsd - a.volumeUsd);
  }
  return sorted.sort((a, b) => b.realizedPnlUsd - a.realizedPnlUsd || (b.roiPct ?? 0) - (a.roiPct ?? 0));
}

function roundtripScore(row: TokenWalletRow): number {
  const countSymmetry = row.buyCount + row.sellCount > 0
    ? 1 - Math.abs(row.buyCount - row.sellCount) / (row.buyCount + row.sellCount)
    : 0;
  return countSymmetry * 100 + Math.min(25, row.tradeCount);
}

function applyPnlTrade(
  row: {
    tradeCount: number;
    buyCount: number;
    sellCount: number;
    volumeUsd: number;
    realizedPnlUsd: number;
    realizedCostUsd: number;
    realizedProceedsUsd: number;
    netBaseAmount: number;
    firstBlock: number;
    lastBlock: number;
    quantity: number;
    costUsd: number;
  },
  trade: WalletPnlTradeRecord
): void {
  const valueUsd = safeNumber(trade.volumeUsd);
  row.tradeCount += 1;
  row.volumeUsd += valueUsd;
  row.firstBlock = Math.min(row.firstBlock, trade.blockNumber);
  row.lastBlock = Math.max(row.lastBlock, trade.blockNumber);

  if (trade.side === "buy") {
    row.buyCount += 1;
    row.netBaseAmount += trade.baseAmount;
    row.quantity += trade.baseAmount;
    row.costUsd += valueUsd;
    return;
  }

  row.sellCount += 1;
  row.netBaseAmount -= trade.baseAmount;
  if (row.quantity <= 0 || row.costUsd <= 0 || trade.baseAmount <= 0) return;
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

function finalizePnlRows<T extends { realizedPnlUsd: number; realizedCostUsd: number; realizedProceedsUsd: number; volumeUsd: number; netBaseAmount: number }>(
  rows: T[]
): Array<T & { roiPct?: number }> {
  return rows
    .map((row) => ({
      ...row,
      realizedPnlUsd: roundMoney(row.realizedPnlUsd),
      realizedCostUsd: roundMoney(row.realizedCostUsd),
      realizedProceedsUsd: roundMoney(row.realizedProceedsUsd),
      volumeUsd: roundMoney(row.volumeUsd),
      netBaseAmount: roundFloat(row.netBaseAmount, 6),
      roiPct: row.realizedCostUsd > 0 ? roundFloat((row.realizedPnlUsd / row.realizedCostUsd) * 100, 2) : undefined
    }))
    .sort((a, b) => b.realizedPnlUsd - a.realizedPnlUsd || (b.roiPct ?? 0) - (a.roiPct ?? 0) || b.volumeUsd - a.volumeUsd);
}

function summarizeTrades(trades: WalletPnlTradeRecord[]): {
  tradeCount: number;
  walletCount: number;
  poolCount: number;
  buyCount: number;
  sellCount: number;
  volumeUsd: number;
  firstBlock?: number;
  lastBlock?: number;
} {
  const wallets = new Set<string>();
  const pools = new Set<string>();
  let buyCount = 0;
  let sellCount = 0;
  let volumeUsd = 0;
  let firstBlock: number | undefined;
  let lastBlock: number | undefined;
  for (const trade of trades) {
    wallets.add(trade.wallet.toLowerCase());
    pools.add(trade.poolId.toLowerCase());
    volumeUsd += safeNumber(trade.volumeUsd);
    firstBlock = firstBlock === undefined ? trade.blockNumber : Math.min(firstBlock, trade.blockNumber);
    lastBlock = lastBlock === undefined ? trade.blockNumber : Math.max(lastBlock, trade.blockNumber);
    if (trade.side === "buy") buyCount += 1;
    else sellCount += 1;
  }
  return {
    tradeCount: trades.length,
    walletCount: wallets.size,
    poolCount: pools.size,
    buyCount,
    sellCount,
    volumeUsd: roundMoney(volumeUsd),
    firstBlock,
    lastBlock
  };
}

function findToken(analytics: WalletPnlAnalyticsSnapshot | undefined, tokenAddress: string): WalletPnlAnalyticsTokenSummary | undefined {
  const lowered = tokenAddress.toLowerCase();
  return analytics?.tokens.find((token) => token.tokenAddress.toLowerCase() === lowered);
}

function orderTrades(trades: WalletPnlTradeRecord[]): WalletPnlTradeRecord[] {
  return trades.slice().sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
}

function navLink(href: string, icon: string, label: string, active: boolean): string {
  return `<a${active ? " class=\"is-active\"" : ""} href="${escapeAttr(href)}"><span class="nav-icon">${escapeText(icon)}</span>${escapeText(label)}</a>`;
}

function tokenLink(address: string, ticker: string, title?: string): string {
  return `
    <a class="token-chip" href="/intel/wallet-pnl/token/${escapeAttr(address)}" title="${escapeAttr(tokenTickerTitle(title ?? ticker, address))}">
      <strong>${escapeText(ticker)}</strong>
      <span class="mono">${escapeText(shortAddress(address, 4))}</span>
    </a>
  `;
}

function walletLink(chain: ChainSlug, wallet: string, clusterSignals?: WalletClusterSignals): string {
  return `
    <span class="wallet-link-group">
      <a class="ghost-link mono wallet-primary-link" href="/intel/wallet-pnl/wallet/${escapeAttr(wallet)}">${escapeText(shortAddress(wallet))}</a>
      ${renderWalletExternalLinks(chain, wallet)}
      ${renderWalletClusterSignal(wallet, clusterSignals)}
    </span>
  `;
}

function renderWalletExternalLinks(chain: ChainSlug, wallet: string): string {
  const blockscoutUrl = blockscoutWalletUrl(chain, wallet);
  const gmgnUrl = gmgnWalletUrl(chain, wallet);
  return [
    blockscoutUrl ? `<a class="wallet-external-link" href="${escapeAttr(blockscoutUrl)}" target="_blank" rel="noreferrer" title="Open wallet on Blockscout">Blockscout</a>` : "",
    gmgnUrl ? `<a class="wallet-external-link" href="${escapeAttr(gmgnUrl)}" target="_blank" rel="noreferrer" title="Open wallet on GMGN">GMGN</a>` : ""
  ].filter(Boolean).join("");
}

function renderWalletClusterSignal(wallet: string, clusterSignals: WalletClusterSignals | undefined): string {
  const clusters = clusterSignals?.byWallet.get(wallet.toLowerCase()) ?? [];
  const first = clusters[0];
  if (!first) return "";
  const title = `Suspected cluster: ${first.label}${clusters.length > 1 ? ` (+${clusters.length - 1} more)` : ""}`;
  return `<a class="wallet-cluster-signal" href="${escapeAttr(cohortHrefForCluster(first.wallets, first.label))}" title="${escapeAttr(title)}">cluster</a>`;
}

function clusterWalletSample(wallets: string[]): string {
  const sample = wallets.slice(0, 3).map((wallet) => shortAddress(wallet)).join(", ");
  const remaining = wallets.length > 3 ? ` +${wallets.length - 3}` : "";
  return `${sample}${remaining}`;
}

function poolLink(poolId: string): string {
  return `<a class="ghost-link mono" href="/intel/wallet-pnl/pool/${escapeAttr(encodeURIComponent(poolId))}">${escapeText(shortAddress(poolId))}</a>`;
}

function emptyRow(colspan: number, message: string): string {
  return `<tr><td colspan="${colspan}" class="empty-cell">${escapeText(message)}</td></tr>`;
}

function safeNumber(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0;
}

function pressure(value: number, fullScoreAt: number): number {
  if (!Number.isFinite(value) || value <= 0 || fullScoreAt <= 0) return 0;
  return clampPct((value / fullScoreAt) * 100);
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function fmtInt(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? "-" : Math.round(value).toLocaleString();
}

function fmtNumber(value: number | undefined, digits = 2): string {
  return value === undefined || !Number.isFinite(value)
    ? "-"
    : value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function fmtUsd(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value)
    ? "-"
    : `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function fmtSignedUsd(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${fmtUsd(Math.abs(value))}`;
}

function fmtPct(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value)
    ? "-"
    : `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

function fmtPctRange(min: number | undefined, max: number | undefined): string {
  if (min === undefined || max === undefined || !Number.isFinite(min) || !Number.isFinite(max)) return "-";
  if (Math.abs(min - max) < 0.01) return fmtPct(min);
  return `${fmtPct(min)} to ${fmtPct(max)}`;
}

function fmtScore(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value)
    ? "-"
    : value.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function fmtBlockRange(first: number | undefined, last: number | undefined): string {
  if (first === undefined || last === undefined || !Number.isFinite(first) || !Number.isFinite(last)) return "-";
  if (first === last) return fmtInt(first);
  return `${fmtInt(first)} to ${fmtInt(last)}`;
}

function fmtPrice(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "-";
  if (value >= 1) return `$${value.toLocaleString(undefined, { maximumFractionDigits: 6 })}`;
  return `$${value.toPrecision(6)}`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundFloat(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
