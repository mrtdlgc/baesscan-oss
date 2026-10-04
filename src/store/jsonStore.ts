import { copyFile, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { CHAIN_SLUGS } from "../chains/registry";
import { walletPnlTradeHookPolicy } from "../services/walletPnlHookPolicy";
import type { AppState, BannedChat, ChainSlug, ChatSettings, ChatState } from "../types";
import { mergeWalletPnlClusterRecord } from "./storage";
import { compareWalletPnlScanPools, walletPnlPoolMatchesScan } from "./walletPnlPoolScan";
import type {
  ChatLastBlockUpdate,
  CopyShadowConfig,
  CopyShadowSnapshot,
  MarketArchiveCursor,
  Storage,
  SwapArchiveChunkRecord,
  TokenInfoRecord,
  TrackedMarketPoolRecord,
  WalletPnlCursor,
  WalletPnlClusterRecord,
  WalletPnlAnalyticsSnapshot,
  WalletPnlHistoricalTokenBuys,
  WalletPnlNewTokensSnapshot,
  WalletPnlPoolRecord,
  WalletPnlPoolScanOptions,
  WalletPnlSnapshot,
  WalletPnlTokenCreatorRecord,
  WalletPnlTradeReadOptions,
  WalletPnlTradeRecord
} from "./storage";
import { cloneAppState, cloneChat, cloneTokenInfo } from "./snapshots";

type TokenInfoMap = Record<string, TokenInfoRecord>;
type MarketPoolMap = Record<string, TrackedMarketPoolRecord>;
type MarketArchiveCursorMap = Record<string, MarketArchiveCursor>;
type SwapArchiveChunkMap = Record<string, SwapArchiveChunkRecord>;
type WalletPnlPoolMap = Record<string, WalletPnlPoolRecord>;
type WalletPnlTokenCreatorMap = Record<string, WalletPnlTokenCreatorRecord>;
type WalletPnlTradeMap = Record<string, WalletPnlTradeRecord>;
type WalletPnlCursorMap = Record<string, WalletPnlCursor>;
type WalletPnlSnapshotMap = Record<string, WalletPnlSnapshot>;
type WalletPnlAnalyticsSnapshotMap = Record<string, WalletPnlAnalyticsSnapshot>;
type WalletPnlNewTokensSnapshotMap = Record<string, WalletPnlNewTokensSnapshot>;
type WalletPnlHistoricalTokenBuysMap = Record<string, WalletPnlHistoricalTokenBuys>;
type WalletPnlClusterMap = Record<string, WalletPnlClusterRecord>;
type CopyShadowSnapshotMap = Record<string, CopyShadowSnapshot>;
type SidecarGroup = "market-pools" | "swap-archive-chunks" | "wallet-pnl-pools" | "wallet-pnl-token-creators" | "wallet-pnl-trades";

const SIDECAR_CHUNK_RECORD_LIMIT = 1_000;

export function defaultSettings(defaultBackfillBlocks: number): ChatSettings {
  return {
    minUsd: 0,
    minQuote: 0,
    emoji: "+",
    emojiStepUsd: 25,
    maxEmojis: 40,
    showTxLink: true,
    showChartLink: true,
    backfillBlocks: defaultBackfillBlocks,
    onlyClankerHooks: false
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

interface JsonAppState extends AppState {
  tokenInfo?: TokenInfoMap;
  marketPools?: MarketPoolMap;
  marketArchiveCursors?: MarketArchiveCursorMap;
  swapArchiveChunks?: SwapArchiveChunkMap;
  walletPnlPools?: WalletPnlPoolMap;
  walletPnlTokenCreators?: WalletPnlTokenCreatorMap;
  walletPnlTrades?: WalletPnlTradeMap;
  walletPnlCursors?: WalletPnlCursorMap;
  walletPnlSnapshots?: WalletPnlSnapshotMap;
  walletPnlAnalyticsSnapshots?: WalletPnlAnalyticsSnapshotMap;
  walletPnlNewTokensSnapshots?: WalletPnlNewTokensSnapshotMap;
  walletPnlHistoricalTokenBuys?: WalletPnlHistoricalTokenBuysMap;
  walletPnlClusters?: WalletPnlClusterMap;
  copyShadowConfig?: CopyShadowConfig;
  copyShadowSnapshots?: CopyShadowSnapshotMap;
  archiveSidecars?: {
    schemaVersion: 1;
    directory: string;
    chunkRecordLimit: number;
  };
}

export class JsonStateStore implements Storage {
  private state: JsonAppState = {
    version: 2,
    chats: {},
    bannedChats: {},
    tokenInfo: {},
    marketPools: {},
    marketArchiveCursors: {},
    swapArchiveChunks: {},
    walletPnlPools: {},
    walletPnlTokenCreators: {},
    walletPnlTrades: {},
    walletPnlCursors: {},
    walletPnlSnapshots: {},
    walletPnlAnalyticsSnapshots: {},
    walletPnlNewTokensSnapshots: {},
    walletPnlHistoricalTokenBuys: {},
    walletPnlClusters: {},
    copyShadowConfig: undefined,
    copyShadowSnapshots: {}
  };
  private saveQueue: Promise<void> = Promise.resolve();
  private saveCounter = 0;
  private readonly directWriteFallbacks = new Set<string>();
  private readonly sidecarDir: string;
  private readonly preferDirectWrites: boolean;

  constructor(private readonly filePath: string, private readonly defaultBackfillBlocks: number) {
    this.sidecarDir = `${filePath}.chunks`;
    this.preferDirectWrites = process.env.JSON_STATE_DIRECT_WRITE === "true" || /[\\/]OneDrive[\\/]/i.test(path.resolve(filePath));
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as JsonAppState;
      const sidecarMarketPools = await this.loadSidecarMap<TrackedMarketPoolRecord>("market-pools");
      const sidecarSwapArchiveChunks = await this.loadSidecarMap<SwapArchiveChunkRecord>("swap-archive-chunks");
      const sidecarWalletPnlPools = await this.loadSidecarMap<WalletPnlPoolRecord>("wallet-pnl-pools");
      const sidecarWalletPnlTokenCreators = await this.loadSidecarMap<WalletPnlTokenCreatorRecord>("wallet-pnl-token-creators");
      const sidecarWalletPnlTrades = await this.loadSidecarMap<WalletPnlTradeRecord>("wallet-pnl-trades");
      this.state = {
        version: parsed.version ?? 1,
        chats: parsed.chats ?? {},
        bannedChats: parsed.bannedChats ?? {},
        tokenInfo: parsed.tokenInfo ?? {},
        marketPools: { ...(parsed.marketPools ?? {}), ...sidecarMarketPools },
        marketArchiveCursors: parsed.marketArchiveCursors ?? {},
        swapArchiveChunks: { ...(parsed.swapArchiveChunks ?? {}), ...sidecarSwapArchiveChunks },
        walletPnlPools: { ...(parsed.walletPnlPools ?? {}), ...sidecarWalletPnlPools },
        walletPnlTokenCreators: { ...(parsed.walletPnlTokenCreators ?? {}), ...sidecarWalletPnlTokenCreators },
        walletPnlTrades: { ...(parsed.walletPnlTrades ?? {}), ...sidecarWalletPnlTrades },
        walletPnlCursors: parsed.walletPnlCursors ?? {},
        walletPnlSnapshots: parsed.walletPnlSnapshots ?? {},
        walletPnlAnalyticsSnapshots: parsed.walletPnlAnalyticsSnapshots ?? {},
        walletPnlNewTokensSnapshots: parsed.walletPnlNewTokensSnapshots ?? {},
        walletPnlHistoricalTokenBuys: parsed.walletPnlHistoricalTokenBuys ?? {},
        walletPnlClusters: parsed.walletPnlClusters ?? {},
        copyShadowConfig: parsed.copyShadowConfig,
        copyShadowSnapshots: parsed.copyShadowSnapshots ?? {}
      };
      for (const chat of Object.values(this.state.chats)) {
        chat.chain ??= "base";
        chat.settings = { ...defaultSettings(this.defaultBackfillBlocks), ...(chat.settings ?? {}) };
        chat.pools = chat.pools ?? {};
        for (const pool of Object.values(chat.pools)) pool.chain ??= chat.chain;
        chat.enabled = Boolean(chat.enabled);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      this.state = {
        version: 2,
        chats: {},
        bannedChats: {},
        tokenInfo: {},
        marketPools: {},
        marketArchiveCursors: {},
        swapArchiveChunks: {},
        walletPnlPools: {},
        walletPnlTokenCreators: {},
        walletPnlTrades: {},
        walletPnlCursors: {},
        walletPnlSnapshots: {},
        walletPnlAnalyticsSnapshots: {},
        walletPnlNewTokensSnapshots: {},
        walletPnlHistoricalTokenBuys: {},
        walletPnlClusters: {},
        copyShadowConfig: undefined,
        copyShadowSnapshots: {}
      };
      await this.save();
    }
  }

  getState(): AppState {
    return cloneAppState(this.state);
  }

  getChat(chatId: number): ChatState | undefined {
    const chat = this.state.chats[String(chatId)];
    return chat ? cloneChat(chat) : undefined;
  }

  ensureChat(chatId: number, title?: string): ChatState {
    const key = String(chatId);
    const existing = this.state.chats[key];
    if (existing) {
      if (title) existing.title = title;
      existing.updatedAt = nowIso();
      return cloneChat(existing);
    }
    const timestamp = nowIso();
    const chat: ChatState = {
      chatId,
      title,
      chain: "base",
      enabled: false,
      pools: {},
      settings: defaultSettings(this.defaultBackfillBlocks),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.state.chats[key] = chat;
    return cloneChat(chat);
  }

  setChat(chat: ChatState): void {
    const next = cloneChat(chat);
    next.updatedAt = nowIso();
    this.state.chats[String(next.chatId)] = next;
  }

  advanceChatLastBlocks(updates: ChatLastBlockUpdate[]): void {
    if (updates.length === 0) return;
    const timestamp = nowIso();
    for (const update of updates) {
      const chat = this.state.chats[String(update.chatId)];
      if (!chat) continue;
      if (chat.lastBlock !== undefined && chat.lastBlock >= update.lastBlock) continue;
      chat.lastBlock = update.lastBlock;
      chat.updatedAt = timestamp;
    }
  }

  deleteChat(chatId: number): void {
    delete this.state.chats[String(chatId)];
  }

  getActiveChats(): ChatState[] {
    return Object.values(this.state.chats).filter(
      (chat) => chat.enabled && Boolean(chat.tokenAddress) && Object.keys(chat.pools).length > 0
    ).map(cloneChat);
  }

  getAllChats(): ChatState[] {
    return Object.values(this.state.chats).map(cloneChat);
  }

  getChatCount(): number {
    return Object.keys(this.state.chats).length;
  }

  isChatBanned(chatId: number): boolean {
    return Boolean(this.state.bannedChats?.[String(chatId)]);
  }

  banChat(chatId: number, reason?: string): void {
    if (!this.state.bannedChats) this.state.bannedChats = {};
    const entry: BannedChat = { chatId, reason, bannedAt: nowIso() };
    this.state.bannedChats[String(chatId)] = entry;
    delete this.state.chats[String(chatId)];
  }

  unbanChat(chatId: number): void {
    if (!this.state.bannedChats) return;
    delete this.state.bannedChats[String(chatId)];
  }

  getBannedChatIds(): number[] {
    return Object.values(this.state.bannedChats ?? {}).map((b) => b.chatId);
  }

  getTokenInfo(chain: string, tokenAddress: string): TokenInfoRecord | undefined {
    return cloneTokenInfo(this.state.tokenInfo?.[tokenInfoKey(chain, tokenAddress)]);
  }

  setTokenInfo(record: TokenInfoRecord): void {
    if (!this.state.tokenInfo) this.state.tokenInfo = {};
    this.state.tokenInfo[tokenInfoKey(record.chain, record.tokenAddress)] = {
      ...record,
      tokenAddress: record.tokenAddress.toLowerCase(),
      chain: record.chain
    };
  }

  async save(): Promise<void> {
    const snapshot = `${JSON.stringify(this.rootStateForSave(), null, 2)}\n`;
    const write = async () => {
      await this.writeSidecarMap("market-pools", this.state.marketPools ?? {});
      await this.writeSidecarMap("swap-archive-chunks", this.state.swapArchiveChunks ?? {});
      await this.writeSidecarMap("wallet-pnl-pools", this.state.walletPnlPools ?? {});
      await this.writeSidecarMap("wallet-pnl-token-creators", this.state.walletPnlTokenCreators ?? {});
      await this.writeSidecarMap("wallet-pnl-trades", this.state.walletPnlTrades ?? {});
      await this.writeSnapshot(snapshot);
    };
    this.saveQueue = this.saveQueue.then(write, write);
    return this.saveQueue;
  }

  upsertMarketPools(records: TrackedMarketPoolRecord[]): void {
    if (!this.state.marketPools) this.state.marketPools = {};
    for (const record of records) {
      this.state.marketPools[marketPoolKey(record.chain, record.poolId)] = cloneMarketPoolRecord({
        ...record,
        poolId: record.poolId.toLowerCase()
      })!;
    }
  }

  getMarketPools(chain: ChainSlug, limit?: number): TrackedMarketPoolRecord[] {
    const pools = Object.values(this.state.marketPools ?? {})
      .filter((record) => record.chain === chain)
      .sort((a, b) => (a.firstSeenBlock ?? 0) - (b.firstSeenBlock ?? 0) || a.poolId.localeCompare(b.poolId));
    return pools.slice(0, limit && limit > 0 ? limit : pools.length).map((record) => cloneMarketPoolRecord(record)!);
  }

  getMarketPool(chain: ChainSlug, poolId: string): TrackedMarketPoolRecord | undefined {
    return cloneMarketPoolRecord(this.state.marketPools?.[marketPoolKey(chain, poolId)]);
  }

  getMarketArchiveCursor(chain: ChainSlug): MarketArchiveCursor | undefined {
    return cloneMarketArchiveCursor(this.state.marketArchiveCursors?.[chain]);
  }

  setMarketArchiveCursor(cursor: MarketArchiveCursor): void {
    if (!this.state.marketArchiveCursors) this.state.marketArchiveCursors = {};
    this.state.marketArchiveCursors[cursor.chain] = cloneMarketArchiveCursor(cursor)!;
  }

  recordSwapArchiveChunks(records: SwapArchiveChunkRecord[]): void {
    if (!this.state.swapArchiveChunks) this.state.swapArchiveChunks = {};
    for (const record of records) {
      this.state.swapArchiveChunks[swapArchiveChunkKey(record.chain, record.objectKey)] = cloneSwapArchiveChunkRecord(record);
    }
  }

  pruneSwapArchiveChunks(chain: ChainSlug, olderThanIso: string): number {
    if (!this.state.swapArchiveChunks) return 0;
    const keysToDelete = Object.entries(this.state.swapArchiveChunks)
      .filter(([, record]) => record.chain === chain && record.generatedAt < olderThanIso)
      .map(([key]) => key);
    for (const key of keysToDelete) delete this.state.swapArchiveChunks[key];
    return keysToDelete.length;
  }

  getSwapArchiveChunks(chain: ChainSlug, limit?: number): SwapArchiveChunkRecord[] {
    const chunks = Object.values(this.state.swapArchiveChunks ?? {})
      .filter((record) => record.chain === chain)
      .sort((a, b) => b.toBlock - a.toBlock || b.generatedAt.localeCompare(a.generatedAt));
    return chunks.slice(0, limit && limit > 0 ? limit : chunks.length).map(cloneSwapArchiveChunkRecord);
  }

  upsertWalletPnlPools(records: WalletPnlPoolRecord[]): void {
    if (!this.state.walletPnlPools) this.state.walletPnlPools = {};
    for (const record of records) {
      this.state.walletPnlPools[walletPnlPoolKey(record.chain, record.poolId)] = cloneWalletPnlPoolRecord({
        ...record,
        poolId: record.poolId.toLowerCase()
      })!;
    }
  }

  getWalletPnlPools(chain: ChainSlug, limit?: number): WalletPnlPoolRecord[] {
    const pools = Object.values(this.state.walletPnlPools ?? {})
      .filter((record) => record.chain === chain)
      .sort((a, b) => (a.firstSeenBlock ?? 0) - (b.firstSeenBlock ?? 0) || a.poolId.localeCompare(b.poolId));
    return pools.slice(0, limit && limit > 0 ? limit : pools.length).map((record) => cloneWalletPnlPoolRecord(record)!);
  }

  getWalletPnlScanPools(chain: ChainSlug, options?: WalletPnlPoolScanOptions): WalletPnlPoolRecord[] {
    const lastTradeByPool = new Map<string, number>();
    for (const trade of Object.values(this.state.walletPnlTrades ?? {})) {
      if (trade.chain !== chain) continue;
      if (options?.activeFromBlock !== undefined && trade.blockNumber < options.activeFromBlock) continue;
      const poolId = trade.poolId.toLowerCase();
      const previous = lastTradeByPool.get(poolId);
      if (previous === undefined || trade.blockNumber > previous) lastTradeByPool.set(poolId, trade.blockNumber);
    }
    const pools = Object.values(this.state.walletPnlPools ?? {})
      .filter((record) => record.chain === chain)
      .map((record) => ({ record, lastTradeBlock: lastTradeByPool.get(record.poolId.toLowerCase()) }))
      .filter((candidate) => walletPnlPoolMatchesScan(candidate.record, candidate.lastTradeBlock, options))
      .sort(compareWalletPnlScanPools)
      .map((candidate) => candidate.record);
    return pools.slice(0, options?.limit && options.limit > 0 ? options.limit : pools.length).map((record) => cloneWalletPnlPoolRecord(record)!);
  }

  getWalletPnlPool(chain: ChainSlug, poolId: string): WalletPnlPoolRecord | undefined {
    return cloneWalletPnlPoolRecord(this.state.walletPnlPools?.[walletPnlPoolKey(chain, poolId)]);
  }

  getWalletPnlTokenCreator(chain: ChainSlug, tokenAddress: string): WalletPnlTokenCreatorRecord | undefined {
    return cloneWalletPnlTokenCreatorRecord(this.state.walletPnlTokenCreators?.[walletPnlTokenCreatorKey(chain, tokenAddress)]);
  }

  upsertWalletPnlTokenCreators(records: WalletPnlTokenCreatorRecord[]): void {
    if (!this.state.walletPnlTokenCreators) this.state.walletPnlTokenCreators = {};
    for (const record of records) {
      this.state.walletPnlTokenCreators[walletPnlTokenCreatorKey(record.chain, record.tokenAddress)] = cloneWalletPnlTokenCreatorRecord({
        ...record,
        tokenAddress: record.tokenAddress.toLowerCase(),
        creator: record.creator.toLowerCase()
      })!;
    }
  }

  upsertWalletPnlTrades(records: WalletPnlTradeRecord[]): void {
    if (!this.state.walletPnlTrades) this.state.walletPnlTrades = {};
    for (const record of records) {
      this.state.walletPnlTrades[walletPnlTradeKey(record)] = cloneWalletPnlTradeRecord({
        ...record,
        poolId: record.poolId.toLowerCase(),
        txHash: record.txHash.toLowerCase(),
        wallet: record.wallet.toLowerCase(),
        tokenAddress: record.tokenAddress.toLowerCase(),
        quoteAddress: record.quoteAddress.toLowerCase()
      });
    }
  }

  pruneWalletPnlTradesBeforeBlock(chain: ChainSlug, beforeBlock: number): number {
    if (!this.state.walletPnlTrades) return 0;
    const keysToDelete = Object.entries(this.state.walletPnlTrades)
      .filter(([, record]) => record.chain === chain && record.blockNumber < beforeBlock)
      .map(([key]) => key);
    for (const key of keysToDelete) delete this.state.walletPnlTrades[key];
    return keysToDelete.length;
  }

  getWalletPnlTrades(chain: ChainSlug, fromBlock?: number, options?: WalletPnlTradeReadOptions): WalletPnlTradeRecord[] {
    return Object.values(this.state.walletPnlTrades ?? {})
      .filter((record) => record.chain === chain && (fromBlock === undefined || record.blockNumber >= fromBlock))
      .filter((record) => this.walletPnlTradeAllowed(record, options))
      .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
      .map(cloneWalletPnlTradeRecord);
  }

  getWalletPnlTradesForToken(chain: ChainSlug, tokenAddress: string, fromBlock?: number, options?: WalletPnlTradeReadOptions): WalletPnlTradeRecord[] {
    const normalized = tokenAddress.toLowerCase();
    return this.getWalletPnlTrades(chain, fromBlock, options).filter((record) => record.tokenAddress.toLowerCase() === normalized);
  }

  getWalletPnlTradesForWallet(chain: ChainSlug, wallet: string, fromBlock?: number, options?: WalletPnlTradeReadOptions): WalletPnlTradeRecord[] {
    const normalized = wallet.toLowerCase();
    return this.getWalletPnlTrades(chain, fromBlock, options).filter((record) => record.wallet.toLowerCase() === normalized);
  }

  getWalletPnlTradesForPool(chain: ChainSlug, poolId: string, fromBlock?: number, options?: WalletPnlTradeReadOptions): WalletPnlTradeRecord[] {
    const normalized = poolId.toLowerCase();
    return this.getWalletPnlTrades(chain, fromBlock, options).filter((record) => record.poolId.toLowerCase() === normalized);
  }

  private walletPnlTradeAllowed(record: WalletPnlTradeRecord, options?: WalletPnlTradeReadOptions): boolean {
    const pool = this.state.walletPnlPools?.[walletPnlPoolKey(record.chain, record.poolId)]?.pool;
    return walletPnlTradeHookPolicy(record.chain, record, pool, options?.trustedV4Hooks).allowed;
  }

  getWalletPnlCursor(chain: ChainSlug): WalletPnlCursor | undefined {
    return cloneWalletPnlCursor(this.state.walletPnlCursors?.[chain]);
  }

  setWalletPnlCursor(cursor: WalletPnlCursor): void {
    if (!this.state.walletPnlCursors) this.state.walletPnlCursors = {};
    this.state.walletPnlCursors[cursor.chain] = cloneWalletPnlCursor(cursor)!;
  }

  getWalletPnlSnapshot(chain: ChainSlug): WalletPnlSnapshot | undefined {
    return cloneWalletPnlSnapshot(this.state.walletPnlSnapshots?.[chain]);
  }

  setWalletPnlSnapshot(snapshot: WalletPnlSnapshot): void {
    if (!this.state.walletPnlSnapshots) this.state.walletPnlSnapshots = {};
    this.state.walletPnlSnapshots[snapshot.chain] = cloneWalletPnlSnapshot(snapshot)!;
  }

  getWalletPnlAnalyticsSnapshot(chain: ChainSlug): WalletPnlAnalyticsSnapshot | undefined {
    return cloneWalletPnlAnalyticsSnapshot(this.state.walletPnlAnalyticsSnapshots?.[chain]);
  }

  setWalletPnlAnalyticsSnapshot(snapshot: WalletPnlAnalyticsSnapshot): void {
    if (!this.state.walletPnlAnalyticsSnapshots) this.state.walletPnlAnalyticsSnapshots = {};
    this.state.walletPnlAnalyticsSnapshots[snapshot.chain] = cloneWalletPnlAnalyticsSnapshot(snapshot)!;
  }

  getWalletPnlNewTokensSnapshot(chain: ChainSlug): WalletPnlNewTokensSnapshot | undefined {
    return cloneWalletPnlNewTokensSnapshot(this.state.walletPnlNewTokensSnapshots?.[chain]);
  }

  setWalletPnlNewTokensSnapshot(snapshot: WalletPnlNewTokensSnapshot): void {
    if (!this.state.walletPnlNewTokensSnapshots) this.state.walletPnlNewTokensSnapshots = {};
    this.state.walletPnlNewTokensSnapshots[snapshot.chain] = cloneWalletPnlNewTokensSnapshot(snapshot)!;
  }

  getWalletPnlHistoricalTokenBuys(chain: ChainSlug, clusterKey: string): WalletPnlHistoricalTokenBuys | undefined {
    return cloneWalletPnlHistoricalTokenBuys(this.state.walletPnlHistoricalTokenBuys?.[walletPnlHistoricalTokenBuysKey(chain, clusterKey)]);
  }

  setWalletPnlHistoricalTokenBuys(snapshot: WalletPnlHistoricalTokenBuys): void {
    if (!this.state.walletPnlHistoricalTokenBuys) this.state.walletPnlHistoricalTokenBuys = {};
    this.state.walletPnlHistoricalTokenBuys[walletPnlHistoricalTokenBuysKey(snapshot.chain, snapshot.clusterKey)] = cloneWalletPnlHistoricalTokenBuys(snapshot)!;
  }

  getWalletPnlClusters(chain: ChainSlug): WalletPnlClusterRecord[] {
    return Object.values(this.state.walletPnlClusters ?? {})
      .filter((record) => record.chain === chain)
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt) || b.clusterScore - a.clusterScore || a.label.localeCompare(b.label))
      .map(cloneWalletPnlClusterRecord);
  }

  upsertWalletPnlClusters(records: WalletPnlClusterRecord[]): number {
    if (records.length === 0) return 0;
    if (!this.state.walletPnlClusters) this.state.walletPnlClusters = {};
    let changed = 0;
    for (const record of records) {
      const key = walletPnlClusterKey(record.chain, record.clusterId);
      const merged = mergeWalletPnlClusterRecord(record, this.state.walletPnlClusters[key]);
      const previous = this.state.walletPnlClusters[key];
      if (!previous || JSON.stringify(previous) !== JSON.stringify(merged)) {
        this.state.walletPnlClusters[key] = cloneWalletPnlClusterRecord(merged);
        changed += 1;
      }
    }
    return changed;
  }

  getCopyShadowConfig(): CopyShadowConfig | undefined {
    return cloneCopyShadowConfig(this.state.copyShadowConfig);
  }

  setCopyShadowConfig(config: CopyShadowConfig): void {
    this.state.copyShadowConfig = cloneCopyShadowConfig(config);
  }

  getCopyShadowSnapshot(chain: ChainSlug): CopyShadowSnapshot | undefined {
    return cloneCopyShadowSnapshot(this.state.copyShadowSnapshots?.[chain]);
  }

  setCopyShadowSnapshot(snapshot: CopyShadowSnapshot): void {
    if (!this.state.copyShadowSnapshots) this.state.copyShadowSnapshots = {};
    this.state.copyShadowSnapshots[snapshot.chain] = cloneCopyShadowSnapshot(snapshot)!;
  }

  private async writeSnapshot(snapshot: string): Promise<void> {
    await this.writeFileSnapshot(this.filePath, snapshot);
  }

  private rootStateForSave(): JsonAppState {
    return {
      version: this.state.version,
      chats: this.state.chats,
      bannedChats: this.state.bannedChats,
      tokenInfo: this.state.tokenInfo,
      marketArchiveCursors: this.state.marketArchiveCursors,
      walletPnlCursors: this.state.walletPnlCursors,
      walletPnlSnapshots: this.state.walletPnlSnapshots,
      walletPnlAnalyticsSnapshots: this.state.walletPnlAnalyticsSnapshots,
      walletPnlNewTokensSnapshots: this.state.walletPnlNewTokensSnapshots,
      walletPnlHistoricalTokenBuys: this.state.walletPnlHistoricalTokenBuys,
      walletPnlClusters: this.state.walletPnlClusters,
      copyShadowConfig: this.state.copyShadowConfig,
      copyShadowSnapshots: this.state.copyShadowSnapshots,
      archiveSidecars: {
        schemaVersion: 1,
        directory: path.basename(this.sidecarDir),
        chunkRecordLimit: SIDECAR_CHUNK_RECORD_LIMIT
      }
    };
  }

  private async loadSidecarMap<T>(group: SidecarGroup): Promise<Record<string, T>> {
    const records: Record<string, T> = {};
    for (const chain of CHAIN_SLUGS) {
      const directory = this.sidecarChainDir(group, chain);
      let files: string[];
      try {
        files = (await readdir(directory)).filter((file) => file.endsWith(".json")).sort();
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") continue;
        throw error;
      }
      for (const file of files) {
        const raw = await readFile(path.join(directory, file), "utf8");
        Object.assign(records, JSON.parse(raw) as Record<string, T>);
      }
    }
    return records;
  }

  private async writeSidecarMap<T extends { chain: ChainSlug }>(group: SidecarGroup, records: Record<string, T>): Promise<void> {
    const byChain = new Map<ChainSlug, Array<[string, T]>>();
    for (const [key, record] of Object.entries(records)) {
      if (!byChain.has(record.chain)) byChain.set(record.chain, []);
      byChain.get(record.chain)!.push([key, record]);
    }

    for (const chain of CHAIN_SLUGS) {
      const directory = this.sidecarChainDir(group, chain);
      const entries = (byChain.get(chain) ?? []).sort(([a], [b]) => a.localeCompare(b));
      const chunkCount = Math.ceil(entries.length / SIDECAR_CHUNK_RECORD_LIMIT);
      if (entries.length > 0 || await directoryHasJson(directory)) {
        await mkdir(directory, { recursive: true });
      }

      for (let index = 0; index < chunkCount; index++) {
        const part = entries.slice(index * SIDECAR_CHUNK_RECORD_LIMIT, (index + 1) * SIDECAR_CHUNK_RECORD_LIMIT);
        const chunkMap = Object.fromEntries(part);
        const snapshot = `${JSON.stringify(chunkMap, null, 2)}\n`;
        await this.writeFileSnapshot(this.sidecarChunkPath(group, chain, index), snapshot);
      }

      const desired = new Set(Array.from({ length: chunkCount }, (_, index) => path.basename(this.sidecarChunkPath(group, chain, index))));
      const existing = await listJsonFiles(directory);
      for (const file of existing) {
        if (!desired.has(file)) await unlink(path.join(directory, file)).catch(() => undefined);
      }
    }
  }

  private sidecarChainDir(group: SidecarGroup, chain: ChainSlug): string {
    return path.join(this.sidecarDir, group, chain);
  }

  private sidecarChunkPath(group: SidecarGroup, chain: ChainSlug, index: number): string {
    return path.join(this.sidecarChainDir(group, chain), `${String(index).padStart(5, "0")}.json`);
  }

  private async writeFileSnapshot(filePath: string, snapshot: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    if (this.preferDirectWrites || this.directWriteFallbacks.has(filePath)) {
      await writeFile(filePath, snapshot, "utf8");
      return;
    }
    const tmp = `${filePath}.${process.pid}.${++this.saveCounter}.tmp`;
    await writeFile(tmp, snapshot, "utf8");
    try {
      await rename(tmp, filePath);
    } catch (error) {
      if (!isRenameFallbackError(error)) throw error;
      this.directWriteFallbacks.add(filePath);
      await copyFile(tmp, filePath);
      await unlink(tmp).catch(() => undefined);
    }
  }
}

async function listJsonFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).filter((file) => file.endsWith(".json"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw error;
  }
}

async function directoryHasJson(directory: string): Promise<boolean> {
  return (await listJsonFiles(directory)).length > 0;
}

function isRenameFallbackError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EACCES" || code === "EXDEV";
}

function tokenInfoKey(chain: string, tokenAddress: string): string {
  return `${chain}:${tokenAddress.toLowerCase()}`;
}

function marketPoolKey(chain: ChainSlug, poolId: string): string {
  return `${chain}:${poolId.toLowerCase()}`;
}

function swapArchiveChunkKey(chain: ChainSlug, objectKey: string): string {
  return `${chain}:${objectKey}`;
}

function walletPnlPoolKey(chain: ChainSlug, poolId: string): string {
  return `${chain}:${poolId.toLowerCase()}`;
}

function walletPnlTokenCreatorKey(chain: ChainSlug, tokenAddress: string): string {
  return `${chain}:${tokenAddress.toLowerCase()}`;
}

function walletPnlTradeKey(record: Pick<WalletPnlTradeRecord, "chain" | "txHash" | "logIndex" | "poolId">): string {
  return `${record.chain}:${record.txHash.toLowerCase()}:${record.logIndex}:${record.poolId.toLowerCase()}`;
}

function walletPnlHistoricalTokenBuysKey(chain: ChainSlug, clusterKey: string): string {
  return `${chain}:${clusterKey.toLowerCase()}`;
}

function walletPnlClusterKey(chain: ChainSlug, clusterId: string): string {
  return `${chain}:${clusterId.toLowerCase()}`;
}

function cloneMarketPoolRecord(record: TrackedMarketPoolRecord | undefined): TrackedMarketPoolRecord | undefined {
  return record ? structuredClone(record) : undefined;
}

function cloneMarketArchiveCursor(cursor: MarketArchiveCursor | undefined): MarketArchiveCursor | undefined {
  return cursor ? { ...cursor } : undefined;
}

function cloneSwapArchiveChunkRecord(record: SwapArchiveChunkRecord): SwapArchiveChunkRecord {
  return {
    ...record,
    tradeCount: record.tradeCount ?? record.eventCount,
    poolCount: record.poolCount ?? 0
  };
}

function cloneWalletPnlPoolRecord(record: WalletPnlPoolRecord | undefined): WalletPnlPoolRecord | undefined {
  return record ? structuredClone(record) : undefined;
}

function cloneWalletPnlTokenCreatorRecord(record: WalletPnlTokenCreatorRecord | undefined): WalletPnlTokenCreatorRecord | undefined {
  return record ? structuredClone(record) : undefined;
}

function cloneWalletPnlTradeRecord(record: WalletPnlTradeRecord): WalletPnlTradeRecord {
  return { ...record };
}

function cloneWalletPnlCursor(cursor: WalletPnlCursor | undefined): WalletPnlCursor | undefined {
  return cursor ? { ...cursor } : undefined;
}

function cloneWalletPnlSnapshot(snapshot: WalletPnlSnapshot | undefined): WalletPnlSnapshot | undefined {
  return snapshot ? structuredClone(snapshot) : undefined;
}

function cloneWalletPnlAnalyticsSnapshot(snapshot: WalletPnlAnalyticsSnapshot | undefined): WalletPnlAnalyticsSnapshot | undefined {
  return snapshot ? structuredClone(snapshot) : undefined;
}

function cloneWalletPnlNewTokensSnapshot(snapshot: WalletPnlNewTokensSnapshot | undefined): WalletPnlNewTokensSnapshot | undefined {
  return snapshot ? structuredClone(snapshot) : undefined;
}

function cloneWalletPnlHistoricalTokenBuys(snapshot: WalletPnlHistoricalTokenBuys | undefined): WalletPnlHistoricalTokenBuys | undefined {
  return snapshot ? structuredClone(snapshot) : undefined;
}

function cloneWalletPnlClusterRecord(record: WalletPnlClusterRecord): WalletPnlClusterRecord {
  return structuredClone(record);
}

function cloneCopyShadowConfig(config: CopyShadowConfig | undefined): CopyShadowConfig | undefined {
  return config ? structuredClone(config) : undefined;
}

function cloneCopyShadowSnapshot(snapshot: CopyShadowSnapshot | undefined): CopyShadowSnapshot | undefined {
  return snapshot ? structuredClone(snapshot) : undefined;
}
