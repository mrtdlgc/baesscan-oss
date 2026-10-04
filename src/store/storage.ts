import type { AppState, ChainSlug, ChatState, PoolKey } from "../types";

export interface TokenInfoRecord {
  chain: string;
  tokenAddress: string;
  website?: string;
  description?: string;
  updatedAt: string;
  postedBy?: number;
}

export type MarketPoolSource = "factory" | "seed" | "pending-factory" | "pending-seed";

export interface TrackedMarketPoolRecord {
  chain: ChainSlug;
  poolId: string;
  pool: PoolKey;
  source: MarketPoolSource;
  firstSeenBlock?: number;
  lastSeenBlock?: number;
  createdAt: string;
  updatedAt: string;
}

export interface MarketArchiveCursor {
  chain: ChainSlug;
  factoryLastBlock?: number;
  swapLastBlock?: number;
  updatedAt: string;
}

export interface SwapArchiveChunkRecord {
  chain: ChainSlug;
  key: string;
  objectKey: string;
  fromBlock: number;
  toBlock: number;
  partIndex: number;
  partCount: number;
  eventCount: number;
  tradeCount: number;
  poolCount: number;
  compressedBytes: number;
  uncompressedBytes: number;
  generatedAt: string;
}

export type WalletPnlPoolSource = "factory" | "seed" | "blockscout";

export interface WalletPnlPoolScanOptions {
  limit?: number;
  activeFromBlock?: number;
  sources?: readonly WalletPnlPoolSource[];
  trustedV4Hooks?: readonly string[];
}

export interface WalletPnlTradeReadOptions {
  trustedV4Hooks?: readonly string[];
}

export interface WalletPnlPoolRecord {
  chain: ChainSlug;
  poolId: string;
  pool: PoolKey;
  source: WalletPnlPoolSource;
  firstSeenBlock?: number;
  lastSeenBlock?: number;
  createdAt: string;
  updatedAt: string;
}

export interface WalletPnlTokenCreatorRecord {
  chain: ChainSlug;
  tokenAddress: string;
  creator: string;
  creationTxHash?: string;
  creationBlock?: number;
  source?: string;
  confidence?: "high" | "medium";
  createdByContract?: boolean;
  updatedAt: string;
}

export interface WalletPnlTradeRecord {
  chain: ChainSlug;
  wallet: string;
  poolId: string;
  poolAddress?: string;
  dex: string;
  protocol: string;
  tokenAddress: string;
  tokenSymbol: string;
  quoteAddress: string;
  quoteSymbol: string;
  side: "buy" | "sell";
  baseAmount: number;
  quoteAmount: number;
  priceUsd?: number;
  volumeUsd?: number;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  createdAt: string;
}

export interface WalletPnlCursor {
  chain: ChainSlug;
  lastBlock?: number;
  lastPostedAt?: string;
  updatedAt: string;
}

export interface WalletPnlTokenRef {
  symbol: string;
  address: string;
}

export interface WalletPnlWalletSummary {
  wallet: string;
  realizedPnlUsd: number;
  realizedCostUsd: number;
  realizedProceedsUsd: number;
  roiPct?: number;
  buyCount: number;
  sellCount: number;
  profitableExitCount: number;
  losingExitCount: number;
  tradedTokens: string[];
  tradedTokenRefs?: WalletPnlTokenRef[];
  volumeUsd: number;
  lastBlock: number;
  lastTxHash: string;
}

export interface WalletPnlSnapshot {
  schemaVersion: 1;
  hookPolicyVersion?: number;
  chain: ChainSlug;
  generatedAt: string;
  windowHours: number;
  positionWindowHours?: number;
  retentionDays: number;
  windowFromBlock: number;
  positionFromBlock?: number;
  retentionFromBlock: number;
  toBlock: number;
  tradeCount: number;
  walletCount: number;
  top: WalletPnlWalletSummary[];
  partial: boolean;
}

export interface WalletPnlAnalyticsTokenSummary {
  tokenAddress: string;
  tokenSymbol: string;
  creator?: string;
  creatorTxHash?: string;
  creatorBlock?: number;
  creatorSource?: string;
  creatorConfidence?: "high" | "medium";
  createdByContract?: boolean;
  creatorDenied?: boolean;
  createdThroughDeniedFactory?: boolean;
  creatorLookupStatus?: "resolved" | "unresolved" | "pending";
  tradeCount: number;
  txCount: number;
  walletCount: number;
  poolCount: number;
  buyCount: number;
  sellCount: number;
  volumeUsd: number;
  buyVolumeUsd: number;
  sellVolumeUsd: number;
  firstBlock: number;
  lastBlock: number;
  latestPriceUsd?: number;
  minPriceUsd?: number;
  maxPriceUsd?: number;
  topWalletVolumeUsd: number;
  topWalletConcentrationPct: number;
  avgTradesPerWallet: number;
  tradesPerTx: number;
  buySellSymmetryPct: number;
  untrustedV4HookCount?: number;
  untrustedV4Hooks?: string[];
  suspiciousScore: number;
  dexes: string[];
  protocols: string[];
}

export interface WalletPnlAnalyticsWalletSummary {
  wallet: string;
  tradeCount: number;
  txCount: number;
  tokenCount: number;
  poolCount: number;
  buyCount: number;
  sellCount: number;
  volumeUsd: number;
  firstBlock: number;
  lastBlock: number;
  topTokenAddress?: string;
  topTokenSymbol?: string;
  topTokenVolumeUsd: number;
  tokenConcentrationPct: number;
  topPoolId?: string;
  topPoolVolumeUsd: number;
  poolConcentrationPct: number;
  buySellSymmetryPct: number;
  avgTradesPerToken: number;
  avgTradeUsd: number;
  suspiciousScore: number;
}

export interface WalletPnlAnalyticsPoolSummary {
  poolId: string;
  poolAddress?: string;
  dex: string;
  protocol: string;
  tokenAddress: string;
  tokenSymbol: string;
  quoteAddress: string;
  quoteSymbol: string;
  tradeCount: number;
  txCount: number;
  walletCount: number;
  buyCount: number;
  sellCount: number;
  volumeUsd: number;
  firstBlock: number;
  lastBlock: number;
  topWalletVolumeUsd: number;
  topWalletConcentrationPct: number;
  buySellSymmetryPct: number;
  v4Hook?: string;
  untrustedV4Hook?: boolean;
  suspiciousScore: number;
}

export interface WalletPnlAnalyticsPnlLeader {
  wallet: string;
  tokenAddress: string;
  tokenSymbol: string;
  realizedPnlUsd: number;
  realizedCostUsd: number;
  realizedProceedsUsd: number;
  roiPct?: number;
  buyCount: number;
  sellCount: number;
  profitableExitCount: number;
  losingExitCount: number;
  trustedV4HookTradeCount?: number;
  volumeUsd: number;
  firstBlock: number;
  lastBlock: number;
}

export interface WalletPnlAnalyticsSignalToken {
  tokenAddress: string;
  tokenSymbol: string;
  realizedPnlUsd: number;
  roiPct?: number;
}

export interface WalletPnlAnalyticsSignalWallet {
  wallet: string;
  goodSignalScore: number;
  profitableTokenCount: number;
  losingTokenCount: number;
  tokenCount: number;
  winRatePct: number;
  realizedPnlUsd: number;
  realizedCostUsd: number;
  realizedProceedsUsd: number;
  roiPct?: number;
  profitFactor: number;
  trustedV4HookTradeCount: number;
  buyCount: number;
  sellCount: number;
  volumeUsd: number;
  firstBlock: number;
  lastBlock: number;
  topTokens: WalletPnlAnalyticsSignalToken[];
  tokenAddresses: string[];
  suspiciousScore?: number;
}

export interface WalletPnlAnalyticsSnapshot {
  schemaVersion: 1;
  hookPolicyVersion?: number;
  chain: ChainSlug;
  generatedAt: string;
  windowHours?: number;
  positionWindowHours?: number;
  positionFromBlock?: number;
  fromBlock: number;
  toBlock: number;
  tradeCount: number;
  tokenCount: number;
  walletCount: number;
  poolCount: number;
  tokens: WalletPnlAnalyticsTokenSummary[];
  riskWallets: WalletPnlAnalyticsWalletSummary[];
  pools: WalletPnlAnalyticsPoolSummary[];
  pnlLeaders?: WalletPnlAnalyticsPnlLeader[];
  roiLeaders?: WalletPnlAnalyticsPnlLeader[];
  volumeWallets?: WalletPnlAnalyticsWalletSummary[];
  goodSignalWallets?: WalletPnlAnalyticsSignalWallet[];
}

export interface WalletPnlNewTokensSnapshot {
  schemaVersion: 1;
  hookPolicyVersion?: number;
  chain: ChainSlug;
  generatedAt: string;
  windowHours?: number;
  fromBlock: number;
  toBlock: number;
  tokenCount: number;
  tokens: WalletPnlAnalyticsTokenSummary[];
}

export interface WalletPnlProfileStage {
  stage: string;
  elapsedMs: number;
  rows?: number;
  heapUsedMb: number;
  rssMb: number;
  error?: string;
}

export type WalletPnlProfileSink = (stage: WalletPnlProfileStage) => void;

export interface WalletPnlHistoricalTokenBuySummary {
  tokenAddress: string;
  tokenSymbol?: string;
  tokenName?: string;
  walletCount: number;
  transferCount: number;
  txCount: number;
  firstBlock?: number;
  lastBlock?: number;
}

export interface WalletPnlHistoricalTokenBuys {
  schemaVersion: 1;
  chain: ChainSlug;
  clusterKey: string;
  clusterLabel: string;
  status: "pending" | "ready" | "error" | "disabled";
  source: "blockscout";
  lookbackDays: number;
  fromBlock?: number;
  toBlock?: number;
  walletCount: number;
  sampledWalletCount: number;
  wallets: string[];
  generatedAt?: string;
  updatedAt: string;
  error?: string;
  tokens: WalletPnlHistoricalTokenBuySummary[];
}

export type WalletPnlClusterSource = "risk-wallets" | "leaderboard" | "token-detail";
export type WalletPnlClusterStatus = "suspected" | "defined";

export interface WalletPnlClusterRecord {
  schemaVersion: 1;
  chain: ChainSlug;
  clusterId: string;
  label: string;
  reason: string;
  source: WalletPnlClusterSource;
  status: WalletPnlClusterStatus;
  wallets: string[];
  walletCount: number;
  clusterScore: number;
  volumeUsd: number;
  tradeCount: number;
  tokenCount?: number;
  tokenAddress?: string;
  tokenSymbol?: string;
  poolId?: string;
  buyCount?: number;
  sellCount?: number;
  realizedPnlUsd?: number;
  realizedCostUsd?: number;
  realizedProceedsUsd?: number;
  minRoiPct?: number;
  maxRoiPct?: number;
  firstBlock?: number;
  lastBlock?: number;
  firstBuyBlock?: number;
  lastBuyBlock?: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export function mergeWalletPnlClusterRecord(
  next: WalletPnlClusterRecord,
  existing?: WalletPnlClusterRecord
): WalletPnlClusterRecord {
  const wallets = mergeClusterWallets(existing?.wallets ?? [], next.wallets);
  const existingDefined = existing?.status === "defined";
  return {
    ...next,
    clusterId: next.clusterId.toLowerCase(),
    tokenAddress: (next.tokenAddress ?? existing?.tokenAddress)?.toLowerCase(),
    poolId: (next.poolId ?? existing?.poolId)?.toLowerCase(),
    label: existingDefined && existing?.label ? existing.label : next.label,
    reason: existingDefined && existing?.reason ? existing.reason : next.reason,
    source: existing?.source ?? next.source,
    status: existingDefined ? "defined" : next.status,
    wallets,
    walletCount: wallets.length,
    firstSeenAt: existing?.firstSeenAt ?? next.firstSeenAt,
    lastSeenAt: next.lastSeenAt
  };
}

function mergeClusterWallets(existing: string[], next: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const wallet of [...existing, ...next]) {
    const normalized = wallet.toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export type CopyShadowSignalSide = "buy" | "sell";
export type CopyShadowSignalStatus = "copied" | "skipped";

export interface CopyShadowSettings {
  tradeSizeUsd: number;
  maxPositionUsd: number;
  executionDelayBlocks: number;
  maxPriceLookaheadBlocks: number;
  slippageBps: number;
  gasUsd: number;
  minSourceVolumeUsd: number;
}

export interface CopyShadowConfig {
  schemaVersion: 1;
  enabled: boolean;
  chain: ChainSlug;
  wallets: string[];
  intervalMs?: number;
  settings: CopyShadowSettings;
  recentSignalsLimit: number;
  positionLimit: number;
  updatedAt: string;
}

export interface CopyShadowSignal {
  id: string;
  wallet: string;
  side: CopyShadowSignalSide;
  status: CopyShadowSignalStatus;
  reason?: string;
  tokenAddress: string;
  tokenSymbol: string;
  sourceTxHash: string;
  sourceBlock: number;
  sourceLogIndex: number;
  sourceAmount: number;
  sourcePriceUsd?: number;
  sourceVolumeUsd?: number;
  executionBlock?: number;
  executionPriceUsd?: number;
  simulatedTokenAmount?: number;
  simulatedCostUsd?: number;
  simulatedProceedsUsd?: number;
  simulatedPnlUsd?: number;
  sourceSellRatio?: number;
}

export interface CopyShadowPosition {
  wallet: string;
  tokenAddress: string;
  tokenSymbol: string;
  quantity: number;
  costUsd: number;
  latestPriceUsd?: number;
  marketValueUsd?: number;
  unrealizedPnlUsd?: number;
  lastBlock: number;
}

export interface CopyShadowWalletSummary {
  wallet: string;
  copiedBuyCount: number;
  copiedSellCount: number;
  skippedSignalCount: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  openPositionCount: number;
  lastBlock: number;
}

export interface CopyShadowSnapshot {
  schemaVersion: 1;
  chain: ChainSlug;
  generatedAt: string;
  fromBlock?: number;
  toBlock?: number;
  watchedWallets: string[];
  settings: CopyShadowSettings;
  sourceTradeCount: number;
  pricedTradeCount: number;
  copiedBuyCount: number;
  copiedSellCount: number;
  skippedSignalCount: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  openPositionCount: number;
  totalGasUsd: number;
  totalSlippageUsd: number;
  wallets: CopyShadowWalletSummary[];
  positions: CopyShadowPosition[];
  recentSignals: CopyShadowSignal[];
}

export interface ChatLastBlockUpdate {
  chatId: number;
  lastBlock: number;
}

export interface Storage {
  load(): Promise<void>;
  getState(): AppState;
  getChat(chatId: number): ChatState | undefined;
  ensureChat(chatId: number, title?: string): ChatState;
  setChat(chat: ChatState): void;
  advanceChatLastBlocks(updates: ChatLastBlockUpdate[]): void;
  deleteChat(chatId: number): void;
  getActiveChats(): ChatState[];
  getAllChats(): ChatState[];
  getChatCount(): number;
  isChatBanned(chatId: number): boolean;
  banChat(chatId: number, reason?: string): void;
  unbanChat(chatId: number): void;
  getBannedChatIds(): number[];
  getTokenInfo(chain: string, tokenAddress: string): TokenInfoRecord | undefined;
  setTokenInfo(record: TokenInfoRecord): void;
  upsertMarketPools(records: TrackedMarketPoolRecord[]): void;
  getMarketPools(chain: ChainSlug, limit?: number): TrackedMarketPoolRecord[];
  getMarketPool(chain: ChainSlug, poolId: string): TrackedMarketPoolRecord | undefined;
  getMarketArchiveCursor(chain: ChainSlug): MarketArchiveCursor | undefined;
  setMarketArchiveCursor(cursor: MarketArchiveCursor): void;
  recordSwapArchiveChunks(records: SwapArchiveChunkRecord[]): void;
  pruneSwapArchiveChunks(chain: ChainSlug, olderThanIso: string): number;
  getSwapArchiveChunks(chain: ChainSlug, limit?: number): SwapArchiveChunkRecord[];
  upsertWalletPnlPools(records: WalletPnlPoolRecord[]): void;
  getWalletPnlPools(chain: ChainSlug, limit?: number): WalletPnlPoolRecord[];
  getWalletPnlScanPools(chain: ChainSlug, options?: WalletPnlPoolScanOptions): WalletPnlPoolRecord[];
  getWalletPnlTokenCreator(chain: ChainSlug, tokenAddress: string): WalletPnlTokenCreatorRecord | undefined;
  upsertWalletPnlTokenCreators(records: WalletPnlTokenCreatorRecord[]): void;
  upsertWalletPnlTrades(records: WalletPnlTradeRecord[]): void;
  pruneWalletPnlTradesBeforeBlock(chain: ChainSlug, beforeBlock: number): number;
  getWalletPnlTrades(chain: ChainSlug, fromBlock?: number, options?: WalletPnlTradeReadOptions): WalletPnlTradeRecord[];
  getWalletPnlTradesForToken(chain: ChainSlug, tokenAddress: string, fromBlock?: number, options?: WalletPnlTradeReadOptions): WalletPnlTradeRecord[];
  getWalletPnlTradesForWallet(chain: ChainSlug, wallet: string, fromBlock?: number, options?: WalletPnlTradeReadOptions): WalletPnlTradeRecord[];
  getWalletPnlTradesForPool(chain: ChainSlug, poolId: string, fromBlock?: number, options?: WalletPnlTradeReadOptions): WalletPnlTradeRecord[];
  getWalletPnlPool(chain: ChainSlug, poolId: string): WalletPnlPoolRecord | undefined;
  getWalletPnlCursor(chain: ChainSlug): WalletPnlCursor | undefined;
  setWalletPnlCursor(cursor: WalletPnlCursor): void;
  getWalletPnlSnapshot(chain: ChainSlug): WalletPnlSnapshot | undefined;
  setWalletPnlSnapshot(snapshot: WalletPnlSnapshot): void;
  getWalletPnlAnalyticsSnapshot(chain: ChainSlug): WalletPnlAnalyticsSnapshot | undefined;
  setWalletPnlAnalyticsSnapshot(snapshot: WalletPnlAnalyticsSnapshot): void;
  getWalletPnlNewTokensSnapshot(chain: ChainSlug): WalletPnlNewTokensSnapshot | undefined;
  setWalletPnlNewTokensSnapshot(snapshot: WalletPnlNewTokensSnapshot): void;
  getWalletPnlHistoricalTokenBuys(chain: ChainSlug, clusterKey: string): WalletPnlHistoricalTokenBuys | undefined;
  setWalletPnlHistoricalTokenBuys(snapshot: WalletPnlHistoricalTokenBuys): void;
  getWalletPnlClusters(chain: ChainSlug): WalletPnlClusterRecord[];
  upsertWalletPnlClusters(records: WalletPnlClusterRecord[]): number;
  getCopyShadowConfig(): CopyShadowConfig | undefined;
  setCopyShadowConfig(config: CopyShadowConfig): void;
  getCopyShadowSnapshot(chain: ChainSlug): CopyShadowSnapshot | undefined;
  setCopyShadowSnapshot(snapshot: CopyShadowSnapshot): void;
  save(): Promise<void>;
}
