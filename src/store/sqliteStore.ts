import { existsSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Worker } from "node:worker_threads";
import type { AppState, BannedChat, ChainSlug, ChatSettings, ChatState, PoolKey } from "../types";
import { WALLET_PNL_IGNORED_TOKEN_SYMBOLS, walletPnlIgnoredTokenAddresses } from "../services/walletPnlFilters";
import { poolV4Hook, trustedV4Hook, trustedV4HookSet, untrustedV4Hook, untrustedV4HookRiskScore } from "../services/v4HookRisk";
import { buildWalletPnlGoodSignalWallets } from "../services/walletPnlGoodSignal";
import type {
  ChatLastBlockUpdate,
  CopyShadowConfig,
  CopyShadowSnapshot,
  MarketArchiveCursor,
  Storage,
  SwapArchiveChunkRecord,
  TokenInfoRecord,
  TrackedMarketPoolRecord,
  WalletPnlAnalyticsSnapshot,
  WalletPnlAnalyticsPnlLeader,
  WalletPnlAnalyticsPoolSummary,
  WalletPnlAnalyticsTokenSummary,
  WalletPnlAnalyticsWalletSummary,
  WalletPnlClusterRecord,
  WalletPnlHistoricalTokenBuys,
  WalletPnlNewTokensSnapshot,
  WalletPnlProfileSink,
  WalletPnlProfileStage,
  WalletPnlCursor,
  WalletPnlPoolRecord,
  WalletPnlPoolScanOptions,
  WalletPnlSnapshot,
  WalletPnlTokenCreatorRecord,
  WalletPnlTradeReadOptions,
  WalletPnlWalletSummary,
  WalletPnlTradeRecord
} from "./storage";
import { mergeWalletPnlClusterRecord } from "./storage";
import { walletPnlScanSources } from "./walletPnlPoolScan";
import { defaultSettings } from "./jsonStore";
import { cloneChat } from "./snapshots";

function nowIso(): string {
  return new Date().toISOString();
}

const WALLET_PNL_IGNORED_SYMBOLS = [...WALLET_PNL_IGNORED_TOKEN_SYMBOLS];
const SQLITE_CACHE_SIZE_KIB = 262_144;
const SQLITE_MMAP_SIZE_BYTES = 1_073_741_824;
const SQLITE_WAL_AUTOCHECKPOINT_PAGES = 1_000;
const WALLET_PNL_ANALYTICS_WORKER_FILE = "walletPnlAnalyticsWorker.js";
const WALLET_PNL_ANALYTICS_WORKER_TIMEOUT_MS = 10 * 60_000;
const WALLET_PNL_HOOK_POLICY_VERSION = 1;

interface ChatRow {
  chat_id: number;
  title: string | null;
  alert_thread_id: number | null;
  chain: string | null;
  enabled: number;
  token_address: string | null;
  token_json: string | null;
  settings_json: string;
  last_block: number | null;
  last_signature: string | null;
  created_at: string;
  updated_at: string;
}

interface PoolRow {
  pool_id: string;
  chat_id: number;
  data_json: string;
}

interface BannedRow {
  chat_id: number;
  reason: string | null;
  banned_at: string;
}

interface MarketPoolRow {
  chain: ChainSlug;
  pool_id: string;
  data_json: string;
  source: TrackedMarketPoolRecord["source"];
  first_seen_block: number | null;
  last_seen_block: number | null;
  created_at: string;
  updated_at: string;
}

interface MarketArchiveCursorRow {
  chain: ChainSlug;
  factory_last_block: number | null;
  swap_last_block: number | null;
  updated_at: string;
}

interface SwapArchiveChunkRow {
  chain: ChainSlug;
  object_key: string;
  key: string;
  from_block: number;
  to_block: number;
  part_index: number;
  part_count: number;
  event_count: number;
  trade_count: number | null;
  pool_count: number | null;
  compressed_bytes: number;
  uncompressed_bytes: number;
  generated_at: string;
}

interface WalletPnlPoolRow {
  chain: ChainSlug;
  pool_id: string;
  data_json: string;
  source: WalletPnlPoolRecord["source"];
  first_seen_block: number | null;
  last_seen_block: number | null;
  created_at: string;
  updated_at: string;
}

interface WalletPnlTokenCreatorRow {
  chain: ChainSlug;
  token_address: string;
  creator: string;
  creation_tx_hash: string | null;
  creation_block: number | null;
  source: string | null;
  confidence: WalletPnlTokenCreatorRecord["confidence"] | null;
  created_by_contract: number | null;
  updated_at: string;
}

interface WalletPnlTradeRow {
  data_json: string;
}

interface WalletPnlFlatTradeRow {
  chain: ChainSlug;
  tx_hash: string;
  log_index: number;
  pool_id: string;
  pool_address: string | null;
  wallet: string;
  token_address: string;
  token_symbol: string | null;
  quote_address: string | null;
  quote_symbol: string | null;
  side: "buy" | "sell";
  block_number: number;
  base_amount: number | null;
  quote_amount: number | null;
  price_usd: number | null;
  volume_usd: number | null;
  dex: string | null;
  protocol: string | null;
}

interface WalletPnlFlatPnlState {
  quantity: number;
  costUsd: number;
}

interface WalletPnlFlatLeaderSummary {
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

interface WalletPnlFlatWalletSummary {
  wallet: string;
  realizedPnlUsd: number;
  realizedCostUsd: number;
  realizedProceedsUsd: number;
  buyCount: number;
  sellCount: number;
  profitableExitCount: number;
  losingExitCount: number;
  tradedTokens: Set<string>;
  tradedTokenRefs: Map<string, { symbol: string; address: string }>;
  volumeUsd: number;
  lastBlock: number;
  lastTxHash: string;
}

type WalletPnlSnapshotBuildOptions = {
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
};

type WalletPnlAnalyticsBuildOptions = {
  chain: ChainSlug;
  fromBlock: number;
  positionFromBlock: number;
  toBlock: number;
  windowHours: number;
  positionWindowHours: number;
  trustedV4Hooks?: string[];
  profile?: WalletPnlProfileSink;
};

type WalletPnlNewTokensBuildOptions = {
  chain: ChainSlug;
  fromBlock: number;
  toBlock: number;
  windowHours: number;
  limit: number;
  trustedV4Hooks?: string[];
  profile?: WalletPnlProfileSink;
};

type WalletPnlAnalyticsWorkerMode = "snapshot" | "analytics" | "newTokens";

interface WalletPnlAnalyticsWorkerMessage<T> {
  ok: boolean;
  value?: T;
  profile?: WalletPnlProfileStage[];
  error?: string;
}

interface WalletPnlCursorRow {
  chain: ChainSlug;
  last_block: number | null;
  last_posted_at: string | null;
  updated_at: string;
}

interface WalletPnlSnapshotRow {
  data_json: string;
}

interface WalletPnlAnalyticsSnapshotRow {
  data_json: string;
}

interface WalletPnlNewTokensSnapshotRow {
  data_json: string;
}

interface WalletPnlHistoricalTokenBuysRow {
  data_json: string;
}

interface WalletPnlClusterRow {
  data_json: string;
}

interface CopyShadowSnapshotRow {
  data_json: string;
}

interface CopyShadowConfigRow {
  data_json: string;
}

export class SqliteStateStore implements Storage {
  private db!: DatabaseSync;
  private readonly cache = new Map<number, ChatState>();
  private bannedCache = new Map<number, BannedChat>();
  private walletPnlAnalyticsWorkerQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string, private readonly defaultBackfillBlocks: number) {}

  async load(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    this.db = new DatabaseSync(this.filePath);
    this.configureConnection();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        chat_id INTEGER PRIMARY KEY,
        title TEXT,
        alert_thread_id INTEGER,
        chain TEXT,
        enabled INTEGER NOT NULL DEFAULT 0,
        token_address TEXT,
        token_json TEXT,
        settings_json TEXT NOT NULL,
        last_block INTEGER,
        last_signature TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pools (
        pool_id TEXT NOT NULL,
        chat_id INTEGER NOT NULL,
        data_json TEXT NOT NULL,
        PRIMARY KEY (pool_id, chat_id),
        FOREIGN KEY (chat_id) REFERENCES chats(chat_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS pools_chat_idx ON pools(chat_id);
      CREATE TABLE IF NOT EXISTS banned_chats (
        chat_id INTEGER PRIMARY KEY,
        reason TEXT,
        banned_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE IF NOT EXISTS token_info (
        chain TEXT NOT NULL,
        token_address TEXT NOT NULL,
        website TEXT,
        description TEXT,
        posted_by INTEGER,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (chain, token_address)
      );
      CREATE TABLE IF NOT EXISTS market_pools (
        chain TEXT NOT NULL,
        pool_id TEXT NOT NULL,
        data_json TEXT NOT NULL,
        source TEXT NOT NULL,
        first_seen_block INTEGER,
        last_seen_block INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (chain, pool_id)
      );
      CREATE INDEX IF NOT EXISTS market_pools_chain_seen_idx ON market_pools(chain, first_seen_block);
      CREATE TABLE IF NOT EXISTS market_archive_cursors (
        chain TEXT PRIMARY KEY,
        factory_last_block INTEGER,
        swap_last_block INTEGER,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS swap_archive_chunks (
        chain TEXT NOT NULL,
        object_key TEXT NOT NULL,
        key TEXT NOT NULL,
        from_block INTEGER NOT NULL,
        to_block INTEGER NOT NULL,
        part_index INTEGER NOT NULL,
        part_count INTEGER NOT NULL,
        event_count INTEGER NOT NULL,
        trade_count INTEGER,
        pool_count INTEGER,
        compressed_bytes INTEGER NOT NULL,
        uncompressed_bytes INTEGER NOT NULL,
        generated_at TEXT NOT NULL,
        PRIMARY KEY (chain, object_key)
      );
      CREATE INDEX IF NOT EXISTS swap_archive_chunks_chain_block_idx ON swap_archive_chunks(chain, to_block DESC);
      CREATE TABLE IF NOT EXISTS wallet_pnl_pools (
        chain TEXT NOT NULL,
        pool_id TEXT NOT NULL,
        data_json TEXT NOT NULL,
        source TEXT NOT NULL,
        first_seen_block INTEGER,
        last_seen_block INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (chain, pool_id)
      );
      CREATE INDEX IF NOT EXISTS wallet_pnl_pools_chain_seen_idx ON wallet_pnl_pools(chain, first_seen_block);
      CREATE INDEX IF NOT EXISTS wallet_pnl_pools_chain_source_idx ON wallet_pnl_pools(chain, source);
      CREATE TABLE IF NOT EXISTS wallet_pnl_token_creators (
        chain TEXT NOT NULL,
        token_address TEXT NOT NULL,
        creator TEXT NOT NULL,
        creation_tx_hash TEXT,
        creation_block INTEGER,
        source TEXT,
        confidence TEXT,
        created_by_contract INTEGER,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (chain, token_address)
      );
      CREATE INDEX IF NOT EXISTS wallet_pnl_token_creators_creator_idx ON wallet_pnl_token_creators(chain, creator);
      CREATE TABLE IF NOT EXISTS wallet_pnl_trades (
        chain TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        pool_id TEXT NOT NULL,
        wallet TEXT NOT NULL,
        token_address TEXT NOT NULL,
        token_symbol TEXT,
        quote_address TEXT,
        quote_symbol TEXT,
        side TEXT NOT NULL,
        block_number INTEGER NOT NULL,
        base_amount REAL,
        quote_amount REAL,
        price_usd REAL,
        volume_usd REAL,
        pool_address TEXT,
        dex TEXT,
        protocol TEXT,
        created_at TEXT,
        data_json TEXT NOT NULL,
        PRIMARY KEY (chain, tx_hash, log_index, pool_id)
      );
      CREATE INDEX IF NOT EXISTS wallet_pnl_trades_chain_block_idx ON wallet_pnl_trades(chain, block_number);
      CREATE INDEX IF NOT EXISTS wallet_pnl_trades_chain_wallet_idx ON wallet_pnl_trades(chain, wallet, block_number);
      CREATE INDEX IF NOT EXISTS wallet_pnl_trades_chain_token_idx ON wallet_pnl_trades(chain, token_address, block_number);
      CREATE INDEX IF NOT EXISTS wallet_pnl_trades_chain_pool_idx ON wallet_pnl_trades(chain, pool_id, block_number);
      CREATE INDEX IF NOT EXISTS wallet_pnl_trades_chain_token_wallet_idx ON wallet_pnl_trades(chain, token_address, wallet);
      CREATE TABLE IF NOT EXISTS wallet_pnl_cursors (
        chain TEXT PRIMARY KEY,
        last_block INTEGER,
        last_posted_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wallet_pnl_snapshots (
        chain TEXT PRIMARY KEY,
        data_json TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        to_block INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wallet_pnl_analytics_snapshots (
        chain TEXT PRIMARY KEY,
        data_json TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        to_block INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wallet_pnl_new_token_snapshots (
        chain TEXT PRIMARY KEY,
        data_json TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        to_block INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wallet_pnl_historical_token_buys (
        chain TEXT NOT NULL,
        cluster_key TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data_json TEXT NOT NULL,
        PRIMARY KEY (chain, cluster_key)
      );
      CREATE TABLE IF NOT EXISTS wallet_pnl_clusters (
        chain TEXT NOT NULL,
        cluster_id TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        data_json TEXT NOT NULL,
        PRIMARY KEY (chain, cluster_id)
      );
      CREATE INDEX IF NOT EXISTS wallet_pnl_clusters_chain_seen_idx ON wallet_pnl_clusters(chain, last_seen_at DESC);
      CREATE TABLE IF NOT EXISTS copy_shadow_snapshots (
        chain TEXT PRIMARY KEY,
        data_json TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        to_block INTEGER
      );
      CREATE TABLE IF NOT EXISTS copy_shadow_config (
        id TEXT PRIMARY KEY,
        data_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    // Idempotent column migration for older databases. PRAGMA table_info is cheap.
    const chatCols = this.db.prepare("PRAGMA table_info(chats)").all() as Array<{ name: string }>;
    if (!chatCols.some((col) => col.name === "chain")) {
      this.db.exec("ALTER TABLE chats ADD COLUMN chain TEXT;");
    }
    if (!chatCols.some((col) => col.name === "last_signature")) {
      this.db.exec("ALTER TABLE chats ADD COLUMN last_signature TEXT;");
    }
    if (!chatCols.some((col) => col.name === "alert_thread_id")) {
      this.db.exec("ALTER TABLE chats ADD COLUMN alert_thread_id INTEGER;");
    }
    const swapChunkCols = this.db.prepare("PRAGMA table_info(swap_archive_chunks)").all() as Array<{ name: string }>;
    if (!swapChunkCols.some((col) => col.name === "trade_count")) {
      this.db.exec("ALTER TABLE swap_archive_chunks ADD COLUMN trade_count INTEGER;");
    }
    if (!swapChunkCols.some((col) => col.name === "pool_count")) {
      this.db.exec("ALTER TABLE swap_archive_chunks ADD COLUMN pool_count INTEGER;");
    }
    this.ensureWalletPnlFlatTradeColumns();

    // Optional migration from existing JSON state file if present and DB empty.
    await this.maybeMigrateJson();

    this.refreshCache();
  }

  private configureConnection(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA cache_size = -${SQLITE_CACHE_SIZE_KIB};
      PRAGMA mmap_size = ${SQLITE_MMAP_SIZE_BYTES};
      PRAGMA wal_autocheckpoint = ${SQLITE_WAL_AUTOCHECKPOINT_PAGES};
    `);
  }

  private ensureWalletPnlFlatTradeColumns(): void {
    const cols = this.db.prepare("PRAGMA table_info(wallet_pnl_trades)").all() as Array<{ name: string }>;
    const names = new Set(cols.map((col) => col.name));
    const migrations: Array<[string, string]> = [
      ["token_symbol", "TEXT"],
      ["quote_address", "TEXT"],
      ["quote_symbol", "TEXT"],
      ["base_amount", "REAL"],
      ["quote_amount", "REAL"],
      ["price_usd", "REAL"],
      ["pool_address", "TEXT"],
      ["dex", "TEXT"],
      ["protocol", "TEXT"],
      ["created_at", "TEXT"]
    ];
    for (const [name, type] of migrations) {
      if (!names.has(name)) this.db.exec(`ALTER TABLE wallet_pnl_trades ADD COLUMN ${name} ${type};`);
    }
  }

  private async maybeMigrateJson(): Promise<void> {
    const dir = path.dirname(this.filePath);
    const jsonCandidate = path.join(dir, "state.json");
    const flag = this.db.prepare("SELECT value FROM meta WHERE key = ?").get("json_migrated") as { value: string } | undefined;
    if (flag?.value === "1") return;
    const count = (this.db.prepare("SELECT COUNT(*) AS c FROM chats").get() as { c: number }).c;
    if (count > 0) {
      this.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run("json_migrated", "1");
      return;
    }
    try {
      await stat(jsonCandidate);
    } catch {
      this.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run("json_migrated", "1");
      return;
    }
    try {
      const raw = await readFile(jsonCandidate, "utf8");
      const parsed = JSON.parse(raw) as AppState;
      const upsertChat = this.db.prepare(
        `INSERT OR REPLACE INTO chats(chat_id, title, alert_thread_id, chain, enabled, token_address, token_json, settings_json, last_block, last_signature, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const upsertPool = this.db.prepare(
        `INSERT OR REPLACE INTO pools(pool_id, chat_id, data_json) VALUES (?, ?, ?)`
      );
      const upsertBan = this.db.prepare(
        `INSERT OR REPLACE INTO banned_chats(chat_id, reason, banned_at) VALUES (?, ?, ?)`
      );
      for (const chat of Object.values(parsed.chats ?? {})) {
        upsertChat.run(
          chat.chatId,
          chat.title ?? null,
          chat.alertThreadId ?? null,
          chat.chain ?? "base",
          chat.enabled ? 1 : 0,
          chat.tokenAddress ?? null,
          chat.token ? JSON.stringify(chat.token) : null,
          JSON.stringify({ ...defaultSettings(this.defaultBackfillBlocks), ...(chat.settings ?? {}) }),
          chat.lastBlock ?? null,
          chat.lastSignature ?? null,
          chat.createdAt ?? nowIso(),
          chat.updatedAt ?? nowIso()
        );
        for (const [poolId, pool] of Object.entries(chat.pools ?? {})) {
          upsertPool.run(poolId.toLowerCase(), chat.chatId, JSON.stringify(pool));
        }
      }
      for (const ban of Object.values(parsed.bannedChats ?? {})) {
        upsertBan.run(ban.chatId, ban.reason ?? null, ban.bannedAt ?? nowIso());
      }
    } catch {
      // ignore corrupt or missing
    }
    this.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run("json_migrated", "1");
  }

  private refreshCache(): void {
    this.cache.clear();
    this.bannedCache.clear();
    const chats = this.db.prepare("SELECT * FROM chats").all() as unknown as ChatRow[];
    const pools = this.db.prepare("SELECT * FROM pools").all() as unknown as PoolRow[];
    const poolsByChat = new Map<number, Record<string, PoolKey>>();
    for (const p of pools) {
      let map = poolsByChat.get(p.chat_id);
      if (!map) {
        map = {};
        poolsByChat.set(p.chat_id, map);
      }
      try {
        map[p.pool_id] = JSON.parse(p.data_json) as PoolKey;
      } catch {
        // skip corrupt row
      }
    }
    for (const row of chats) {
      this.cache.set(row.chat_id, this.rowToChat(row, poolsByChat.get(row.chat_id) ?? {}));
    }
    const bans = this.db.prepare("SELECT * FROM banned_chats").all() as unknown as BannedRow[];
    for (const b of bans) {
      this.bannedCache.set(b.chat_id, { chatId: b.chat_id, reason: b.reason ?? undefined, bannedAt: b.banned_at });
    }
  }

  private rowToChat(row: ChatRow, pools: Record<string, PoolKey>): ChatState {
    const chain = (row.chain ?? "base") as ChatState["chain"];
    for (const pool of Object.values(pools)) pool.chain ??= chain;
    let settings: ChatSettings;
    try {
      settings = { ...defaultSettings(this.defaultBackfillBlocks), ...(JSON.parse(row.settings_json) as ChatSettings) };
    } catch {
      settings = defaultSettings(this.defaultBackfillBlocks);
    }
    let token: ChatState["token"];
    if (row.token_json) {
      try { token = JSON.parse(row.token_json); } catch { /* ignore */ }
    }
    return {
      chatId: row.chat_id,
      title: row.title ?? undefined,
      alertThreadId: row.alert_thread_id ?? undefined,
      chain,
      enabled: Boolean(row.enabled),
      tokenAddress: (row.token_address ?? undefined) as ChatState["tokenAddress"],
      token,
      pools,
      settings,
      lastBlock: row.last_block ?? undefined,
      lastSignature: row.last_signature ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  getState(): AppState {
    const chats: Record<string, ChatState> = {};
    for (const c of this.cache.values()) chats[String(c.chatId)] = cloneChat(c);
    const bannedChats: Record<string, BannedChat> = {};
    for (const b of this.bannedCache.values()) bannedChats[String(b.chatId)] = { ...b };
    return { version: 2, chats, bannedChats };
  }

  getChat(chatId: number): ChatState | undefined {
    const chat = this.cache.get(chatId);
    return chat ? cloneChat(chat) : undefined;
  }

  ensureChat(chatId: number, title?: string): ChatState {
    const existing = this.cache.get(chatId);
    if (existing) {
      if (title && existing.title !== title) {
        existing.title = title;
        existing.updatedAt = nowIso();
        this.persistChat(existing);
      }
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
    this.persistChat(chat);
    this.cache.set(chatId, cloneChat(chat));
    return cloneChat(chat);
  }

  setChat(chat: ChatState): void {
    const next = cloneChat(chat);
    next.updatedAt = nowIso();
    this.persistChat(next);
    this.cache.set(next.chatId, next);
  }

  advanceChatLastBlocks(updates: ChatLastBlockUpdate[]): void {
    const pending = updates.filter((update) => {
      const chat = this.cache.get(update.chatId);
      return chat !== undefined && (chat.lastBlock === undefined || chat.lastBlock < update.lastBlock);
    });
    if (pending.length === 0) return;

    const timestamp = nowIso();
    const updateCursor = this.db.prepare(
      `UPDATE chats
       SET last_block = ?, updated_at = ?
       WHERE chat_id = ? AND (last_block IS NULL OR last_block < ?)`
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const update of pending) {
        updateCursor.run(update.lastBlock, timestamp, update.chatId, update.lastBlock);
        const chat = this.cache.get(update.chatId);
        if (chat) {
          chat.lastBlock = update.lastBlock;
          chat.updatedAt = timestamp;
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction may already be closed */ }
      throw error;
    }
  }

  private persistChat(chat: ChatState): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const upsert = this.db.prepare(
        `INSERT INTO chats(chat_id, title, alert_thread_id, chain, enabled, token_address, token_json, settings_json, last_block, last_signature, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET
           title=excluded.title,
           alert_thread_id=excluded.alert_thread_id,
           chain=excluded.chain,
           enabled=excluded.enabled,
           token_address=excluded.token_address,
           token_json=excluded.token_json,
           settings_json=excluded.settings_json,
           last_block=excluded.last_block,
           last_signature=excluded.last_signature,
           updated_at=excluded.updated_at`
      );
      upsert.run(
        chat.chatId,
        chat.title ?? null,
        chat.alertThreadId ?? null,
        chat.chain ?? "base",
        chat.enabled ? 1 : 0,
        chat.tokenAddress ?? null,
        chat.token ? JSON.stringify(chat.token) : null,
        JSON.stringify(chat.settings),
        chat.lastBlock ?? null,
        chat.lastSignature ?? null,
        chat.createdAt,
        chat.updatedAt
      );

      const existingPools = this.db.prepare("SELECT pool_id FROM pools WHERE chat_id = ?").all(chat.chatId) as { pool_id: string }[];
      const keep = new Set(Object.keys(chat.pools).map((k) => k.toLowerCase()));
      const del = this.db.prepare("DELETE FROM pools WHERE chat_id = ? AND pool_id = ?");
      for (const p of existingPools) {
        if (!keep.has(p.pool_id)) del.run(chat.chatId, p.pool_id);
      }
      const upsertPool = this.db.prepare(
        `INSERT INTO pools(pool_id, chat_id, data_json) VALUES (?, ?, ?)
         ON CONFLICT(pool_id, chat_id) DO UPDATE SET data_json=excluded.data_json`
      );
      for (const [poolId, pool] of Object.entries(chat.pools)) {
        upsertPool.run(poolId.toLowerCase(), chat.chatId, JSON.stringify(pool));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction may already be closed */ }
      throw error;
    }
  }

  deleteChat(chatId: number): void {
    this.cache.delete(chatId);
    this.db.prepare("DELETE FROM chats WHERE chat_id = ?").run(chatId);
  }

  getActiveChats(): ChatState[] {
    return [...this.cache.values()].filter(
      (chat) => chat.enabled && Boolean(chat.tokenAddress) && Object.keys(chat.pools).length > 0
    ).map(cloneChat);
  }

  getAllChats(): ChatState[] {
    return [...this.cache.values()].map(cloneChat);
  }

  getChatCount(): number {
    return this.cache.size;
  }

  isChatBanned(chatId: number): boolean {
    return this.bannedCache.has(chatId);
  }

  banChat(chatId: number, reason?: string): void {
    const entry: BannedChat = { chatId, reason, bannedAt: nowIso() };
    this.bannedCache.set(chatId, entry);
    this.cache.delete(chatId);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(
        `INSERT INTO banned_chats(chat_id, reason, banned_at) VALUES (?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET reason=excluded.reason, banned_at=excluded.banned_at`
      ).run(chatId, reason ?? null, entry.bannedAt);
      this.db.prepare("DELETE FROM chats WHERE chat_id = ?").run(chatId);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction may already be closed */ }
      throw error;
    }
  }

  unbanChat(chatId: number): void {
    this.bannedCache.delete(chatId);
    this.db.prepare("DELETE FROM banned_chats WHERE chat_id = ?").run(chatId);
  }

  getBannedChatIds(): number[] {
    return [...this.bannedCache.keys()];
  }

  getTokenInfo(chain: string, tokenAddress: string): TokenInfoRecord | undefined {
    const row = this.db
      .prepare("SELECT chain, token_address, website, description, posted_by, updated_at FROM token_info WHERE chain = ? AND token_address = ?")
      .get(chain, tokenAddress.toLowerCase()) as
      | { chain: string; token_address: string; website: string | null; description: string | null; posted_by: number | null; updated_at: string }
      | undefined;
    if (!row) return undefined;
    return {
      chain: row.chain,
      tokenAddress: row.token_address,
      website: row.website ?? undefined,
      description: row.description ?? undefined,
      postedBy: row.posted_by ?? undefined,
      updatedAt: row.updated_at
    };
  }

  setTokenInfo(record: TokenInfoRecord): void {
    this.db
      .prepare(
        `INSERT INTO token_info(chain, token_address, website, description, posted_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(chain, token_address) DO UPDATE SET
           website=excluded.website,
           description=excluded.description,
           posted_by=excluded.posted_by,
           updated_at=excluded.updated_at`
      )
      .run(
        record.chain,
        record.tokenAddress.toLowerCase(),
        record.website ?? null,
        record.description ?? null,
        record.postedBy ?? null,
        record.updatedAt
      );
  }

  upsertMarketPools(records: TrackedMarketPoolRecord[]): void {
    if (records.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO market_pools(chain, pool_id, data_json, source, first_seen_block, last_seen_block, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chain, pool_id) DO UPDATE SET
         data_json=excluded.data_json,
         source=excluded.source,
         first_seen_block=COALESCE(market_pools.first_seen_block, excluded.first_seen_block),
         last_seen_block=excluded.last_seen_block,
         updated_at=excluded.updated_at`
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const record of records) {
        stmt.run(
          record.chain,
          record.poolId.toLowerCase(),
          JSON.stringify(record.pool),
          record.source,
          record.firstSeenBlock ?? null,
          record.lastSeenBlock ?? null,
          record.createdAt,
          record.updatedAt
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction may already be closed */ }
      throw error;
    }
  }

  getMarketPools(chain: ChainSlug, limit?: number): TrackedMarketPoolRecord[] {
    const sql = `SELECT * FROM market_pools WHERE chain = ? ORDER BY COALESCE(first_seen_block, 0), pool_id${limit && limit > 0 ? " LIMIT ?" : ""}`;
    const rows = (limit && limit > 0
      ? this.db.prepare(sql).all(chain, limit)
      : this.db.prepare(sql).all(chain)) as unknown as MarketPoolRow[];
    return rows.map((row) => this.marketPoolFromRow(row)).filter((record): record is TrackedMarketPoolRecord => Boolean(record));
  }

  getMarketPool(chain: ChainSlug, poolId: string): TrackedMarketPoolRecord | undefined {
    const row = this.db.prepare("SELECT * FROM market_pools WHERE chain = ? AND pool_id = ?").get(chain, poolId.toLowerCase()) as MarketPoolRow | undefined;
    return row ? this.marketPoolFromRow(row) : undefined;
  }

  getMarketArchiveCursor(chain: ChainSlug): MarketArchiveCursor | undefined {
    const row = this.db.prepare("SELECT * FROM market_archive_cursors WHERE chain = ?").get(chain) as MarketArchiveCursorRow | undefined;
    if (!row) return undefined;
    return {
      chain: row.chain,
      factoryLastBlock: row.factory_last_block ?? undefined,
      swapLastBlock: row.swap_last_block ?? undefined,
      updatedAt: row.updated_at
    };
  }

  setMarketArchiveCursor(cursor: MarketArchiveCursor): void {
    this.db
      .prepare(
        `INSERT INTO market_archive_cursors(chain, factory_last_block, swap_last_block, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(chain) DO UPDATE SET
           factory_last_block=excluded.factory_last_block,
           swap_last_block=excluded.swap_last_block,
           updated_at=excluded.updated_at`
      )
      .run(cursor.chain, cursor.factoryLastBlock ?? null, cursor.swapLastBlock ?? null, cursor.updatedAt);
  }

  recordSwapArchiveChunks(records: SwapArchiveChunkRecord[]): void {
    if (records.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO swap_archive_chunks(chain, object_key, key, from_block, to_block, part_index, part_count, event_count, trade_count, pool_count, compressed_bytes, uncompressed_bytes, generated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chain, object_key) DO UPDATE SET
         key=excluded.key,
         from_block=excluded.from_block,
         to_block=excluded.to_block,
         part_index=excluded.part_index,
         part_count=excluded.part_count,
         event_count=excluded.event_count,
         trade_count=excluded.trade_count,
         pool_count=excluded.pool_count,
         compressed_bytes=excluded.compressed_bytes,
         uncompressed_bytes=excluded.uncompressed_bytes,
         generated_at=excluded.generated_at`
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const record of records) {
        stmt.run(
          record.chain,
          record.objectKey,
          record.key,
          record.fromBlock,
          record.toBlock,
          record.partIndex,
          record.partCount,
          record.eventCount,
          record.tradeCount,
          record.poolCount,
          record.compressedBytes,
          record.uncompressedBytes,
          record.generatedAt
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction may already be closed */ }
      throw error;
    }
  }

  pruneSwapArchiveChunks(chain: ChainSlug, olderThanIso: string): number {
    const result = this.db.prepare("DELETE FROM swap_archive_chunks WHERE chain = ? AND generated_at < ?").run(chain, olderThanIso);
    return Number(result.changes ?? 0);
  }

  getSwapArchiveChunks(chain: ChainSlug, limit?: number): SwapArchiveChunkRecord[] {
    const sql = `SELECT * FROM swap_archive_chunks WHERE chain = ? ORDER BY to_block DESC, generated_at DESC${limit && limit > 0 ? " LIMIT ?" : ""}`;
    const rows = (limit && limit > 0
      ? this.db.prepare(sql).all(chain, limit)
      : this.db.prepare(sql).all(chain)) as unknown as SwapArchiveChunkRow[];
    return rows.map((row) => ({
      chain: row.chain,
      key: row.key,
      objectKey: row.object_key,
      fromBlock: row.from_block,
      toBlock: row.to_block,
      partIndex: row.part_index,
      partCount: row.part_count,
      eventCount: row.event_count,
      tradeCount: row.trade_count ?? row.event_count,
      poolCount: row.pool_count ?? 0,
      compressedBytes: row.compressed_bytes,
      uncompressedBytes: row.uncompressed_bytes,
      generatedAt: row.generated_at
    }));
  }

  upsertWalletPnlPools(records: WalletPnlPoolRecord[]): void {
    if (records.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO wallet_pnl_pools(chain, pool_id, data_json, source, first_seen_block, last_seen_block, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chain, pool_id) DO UPDATE SET
         data_json=excluded.data_json,
         source=excluded.source,
         first_seen_block=COALESCE(wallet_pnl_pools.first_seen_block, excluded.first_seen_block),
         last_seen_block=excluded.last_seen_block,
         updated_at=excluded.updated_at`
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const record of records) {
        stmt.run(
          record.chain,
          record.poolId.toLowerCase(),
          JSON.stringify(record.pool),
          record.source,
          record.firstSeenBlock ?? null,
          record.lastSeenBlock ?? null,
          record.createdAt,
          record.updatedAt
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction may already be closed */ }
      throw error;
    }
  }

  getWalletPnlPools(chain: ChainSlug, limit?: number): WalletPnlPoolRecord[] {
    const sql = `SELECT * FROM wallet_pnl_pools WHERE chain = ? ORDER BY COALESCE(first_seen_block, 0), pool_id${limit && limit > 0 ? " LIMIT ?" : ""}`;
    const rows = (limit && limit > 0
      ? this.db.prepare(sql).all(chain, limit)
      : this.db.prepare(sql).all(chain)) as unknown as WalletPnlPoolRow[];
    return rows.map((row) => this.walletPnlPoolFromRow(row)).filter((record): record is WalletPnlPoolRecord => Boolean(record));
  }

  getWalletPnlScanPools(chain: ChainSlug, options?: WalletPnlPoolScanOptions): WalletPnlPoolRecord[] {
    const sources = [...walletPnlScanSources(options?.sources)];
    if (sources.length === 0) return [];
    const sourcePlaceholders = sources.map(() => "?").join(", ");
    const trustedHooks = trustedV4HookSet(options?.trustedV4Hooks);
    const trustedHookValues = [...trustedHooks].filter((hook) => hook !== "0x0000000000000000000000000000000000000000");
    const trustedHookPredicate = trustedHookValues.length > 0
      ? ` OR LOWER(COALESCE(json_extract(p.data_json, '$.hooks'), '')) IN (${trustedHookValues.map(() => "?").join(", ")})`
      : "";
    const baseTrustedHookPredicate = trustedHookValues.length > 0
      ? `LOWER(COALESCE(json_extract(p.data_json, '$.hooks'), '')) IN (${trustedHookValues.map(() => "?").join(", ")})`
      : "0";
    const lastTradeWhere = options?.activeFromBlock !== undefined ? "chain = ? AND block_number >= ?" : "chain = ?";
    const sql = `
      WITH last_trade AS (
        SELECT pool_id, MAX(block_number) AS last_trade_block
        FROM wallet_pnl_trades
        WHERE ${lastTradeWhere}
        GROUP BY pool_id
      )
      SELECT p.*
      FROM wallet_pnl_pools p
      LEFT JOIN last_trade t ON t.pool_id = p.pool_id
      WHERE p.chain = ?
        AND p.source IN (${sourcePlaceholders})
        AND (
          p.chain != 'base'
          OR LOWER(COALESCE(json_extract(p.data_json, '$.dex'), 'uniswap')) != 'uniswap'
          OR LOWER(COALESCE(json_extract(p.data_json, '$.protocol'), 'v4')) != 'v4'
          OR ${baseTrustedHookPredicate}
        )
        AND (
          p.source = 'seed'
          OR t.last_trade_block IS NOT NULL
          OR p.source = 'blockscout'
          OR NOT (
            p.source = 'factory'
            AND LOWER(COALESCE(json_extract(p.data_json, '$.dex'), 'uniswap')) = 'uniswap'
            AND LOWER(COALESCE(json_extract(p.data_json, '$.protocol'), 'v4')) = 'v4'
          )
          ${trustedHookPredicate}
        )
      ORDER BY
        CASE
          WHEN p.source = 'seed' THEN 0
          WHEN t.last_trade_block IS NOT NULL THEN 1
          WHEN p.source = 'blockscout' THEN 2
          ELSE 3
        END,
        COALESCE(t.last_trade_block, p.last_seen_block, p.first_seen_block, 0) DESC,
        p.pool_id
      ${options?.limit && options.limit > 0 ? "LIMIT ?" : ""}
    `;
    const params: SQLInputValue[] = options?.activeFromBlock !== undefined
      ? [chain, options.activeFromBlock, chain, ...sources, ...trustedHookValues, ...trustedHookValues]
      : [chain, chain, ...sources, ...trustedHookValues, ...trustedHookValues];
    if (options?.limit && options.limit > 0) params.push(options.limit);
    const rows = this.db.prepare(sql).all(...params) as unknown as WalletPnlPoolRow[];
    return rows.map((row) => this.walletPnlPoolFromRow(row)).filter((record): record is WalletPnlPoolRecord => Boolean(record));
  }

  getWalletPnlPool(chain: ChainSlug, poolId: string): WalletPnlPoolRecord | undefined {
    const row = this.db.prepare("SELECT * FROM wallet_pnl_pools WHERE chain = ? AND pool_id = ?").get(chain, poolId.toLowerCase()) as WalletPnlPoolRow | undefined;
    return row ? this.walletPnlPoolFromRow(row) : undefined;
  }

  getWalletPnlTokenCreator(chain: ChainSlug, tokenAddress: string): WalletPnlTokenCreatorRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM wallet_pnl_token_creators WHERE chain = ? AND token_address = ?")
      .get(chain, tokenAddress.toLowerCase()) as WalletPnlTokenCreatorRow | undefined;
    return row ? this.walletPnlTokenCreatorFromRow(row) : undefined;
  }

  upsertWalletPnlTokenCreators(records: WalletPnlTokenCreatorRecord[]): void {
    if (records.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO wallet_pnl_token_creators(
         chain, token_address, creator, creation_tx_hash, creation_block, source, confidence, created_by_contract, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chain, token_address) DO UPDATE SET
         creator=excluded.creator,
         creation_tx_hash=excluded.creation_tx_hash,
         creation_block=excluded.creation_block,
         source=excluded.source,
         confidence=excluded.confidence,
         created_by_contract=excluded.created_by_contract,
         updated_at=excluded.updated_at`
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const record of records) {
        stmt.run(
          record.chain,
          record.tokenAddress.toLowerCase(),
          record.creator.toLowerCase(),
          record.creationTxHash ?? null,
          record.creationBlock ?? null,
          record.source ?? null,
          record.confidence ?? null,
          record.createdByContract === undefined ? null : record.createdByContract ? 1 : 0,
          record.updatedAt
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction may already be closed */ }
      throw error;
    }
  }

  upsertWalletPnlTrades(records: WalletPnlTradeRecord[]): void {
    if (records.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO wallet_pnl_trades(
         chain, tx_hash, log_index, pool_id, wallet, token_address, token_symbol, quote_address, quote_symbol,
         side, block_number, base_amount, quote_amount, price_usd, volume_usd, pool_address, dex, protocol, created_at, data_json
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chain, tx_hash, log_index, pool_id) DO UPDATE SET
         wallet=excluded.wallet,
         token_address=excluded.token_address,
         token_symbol=excluded.token_symbol,
         quote_address=excluded.quote_address,
         quote_symbol=excluded.quote_symbol,
         side=excluded.side,
         block_number=excluded.block_number,
         base_amount=excluded.base_amount,
         quote_amount=excluded.quote_amount,
         price_usd=excluded.price_usd,
         volume_usd=excluded.volume_usd,
         pool_address=excluded.pool_address,
         dex=excluded.dex,
         protocol=excluded.protocol,
         created_at=excluded.created_at,
         data_json=excluded.data_json`
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const raw of records) {
        const record: WalletPnlTradeRecord = {
          ...raw,
          wallet: raw.wallet.toLowerCase(),
          poolId: raw.poolId.toLowerCase(),
          txHash: raw.txHash.toLowerCase(),
          tokenAddress: raw.tokenAddress.toLowerCase(),
          quoteAddress: raw.quoteAddress.toLowerCase()
        };
        stmt.run(
          record.chain,
          record.txHash,
          record.logIndex,
          record.poolId,
          record.wallet,
          record.tokenAddress,
          record.tokenSymbol,
          record.quoteAddress,
          record.quoteSymbol,
          record.side,
          record.blockNumber,
          record.baseAmount,
          record.quoteAmount,
          record.priceUsd ?? null,
          record.volumeUsd ?? null,
          record.poolAddress?.toLowerCase() ?? null,
          record.dex,
          record.protocol,
          record.createdAt,
          JSON.stringify(record)
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction may already be closed */ }
      throw error;
    }
  }

  pruneWalletPnlTradesBeforeBlock(chain: ChainSlug, beforeBlock: number): number {
    const result = this.db.prepare("DELETE FROM wallet_pnl_trades WHERE chain = ? AND block_number < ?").run(chain, beforeBlock);
    return Number(result.changes ?? 0);
  }

  getWalletPnlTrades(chain: ChainSlug, fromBlock?: number, options?: WalletPnlTradeReadOptions): WalletPnlTradeRecord[] {
    const where = this.walletPnlReadTradeWhere(chain, fromBlock, options?.trustedV4Hooks);
    const sql = `SELECT data_json FROM wallet_pnl_trades WHERE ${where.sql} ORDER BY block_number, log_index`;
    const rows = this.db.prepare(sql).all(...where.args) as unknown as WalletPnlTradeRow[];
    return this.walletPnlTradesFromRows(rows);
  }

  getWalletPnlTradesForToken(chain: ChainSlug, tokenAddress: string, fromBlock?: number, options?: WalletPnlTradeReadOptions): WalletPnlTradeRecord[] {
    const where = this.walletPnlReadTradeWhere(chain, fromBlock, options?.trustedV4Hooks);
    const normalized = tokenAddress.toLowerCase();
    const rows = this.db.prepare(
      `SELECT data_json FROM wallet_pnl_trades WHERE ${where.sql} AND token_address = ? ORDER BY block_number, log_index`
    ).all(...where.args, normalized) as unknown as WalletPnlTradeRow[];
    return this.walletPnlTradesFromRows(rows);
  }

  getWalletPnlTradesForWallet(chain: ChainSlug, wallet: string, fromBlock?: number, options?: WalletPnlTradeReadOptions): WalletPnlTradeRecord[] {
    const where = this.walletPnlReadTradeWhere(chain, fromBlock, options?.trustedV4Hooks);
    const normalized = wallet.toLowerCase();
    const rows = this.db.prepare(
      `SELECT data_json FROM wallet_pnl_trades WHERE ${where.sql} AND wallet = ? ORDER BY block_number, log_index`
    ).all(...where.args, normalized) as unknown as WalletPnlTradeRow[];
    return this.walletPnlTradesFromRows(rows);
  }

  getWalletPnlTradesForPool(chain: ChainSlug, poolId: string, fromBlock?: number, options?: WalletPnlTradeReadOptions): WalletPnlTradeRecord[] {
    const where = this.walletPnlReadTradeWhere(chain, fromBlock, options?.trustedV4Hooks);
    const normalized = poolId.toLowerCase();
    const rows = this.db.prepare(
      `SELECT data_json FROM wallet_pnl_trades WHERE ${where.sql} AND pool_id = ? ORDER BY block_number, log_index`
    ).all(...where.args, normalized) as unknown as WalletPnlTradeRow[];
    return this.walletPnlTradesFromRows(rows);
  }

  async buildWalletPnlSnapshotFromFlatTradesInWorker(options: WalletPnlSnapshotBuildOptions): Promise<WalletPnlSnapshot | undefined> {
    const { profile, ...workerOptions } = options;
    return this.runWalletPnlAnalyticsWorker<WalletPnlSnapshot>("snapshot", workerOptions, profile, () =>
      this.buildWalletPnlSnapshotFromFlatTrades(options)
    );
  }

  buildWalletPnlSnapshotFromFlatTrades(options: WalletPnlSnapshotBuildOptions): WalletPnlSnapshot | undefined {
    const windowFromBlock = Math.max(0, options.toBlock - options.windowBlocks + 1);
    const retentionFromBlock = Math.max(0, options.toBlock - options.retentionBlocks + 1);
    const positionFromBlock = Math.max(retentionFromBlock, options.toBlock - options.positionBlocks + 1);
    const rangeReady = walletPnlProfileStage(options.profile, "snapshot.rangeReady", () =>
      this.walletPnlFlatRangeReady(options.chain, positionFromBlock, options.toBlock, options.trustedV4Hooks)
    );
    if (!rangeReady) return undefined;
    const positions = new Map<string, WalletPnlFlatPnlState>();
    const summaries = new Map<string, WalletPnlFlatWalletSummary>();

    let scannedRows = 0;
    const fifoStartedAt = Date.now();
    for (const row of this.iterateWalletPnlFlatRows(options.chain, positionFromBlock, options.toBlock, true, options.trustedV4Hooks)) {
      scannedRows += 1;
      const valueUsd = walletPnlFinite(row.volume_usd);
      const baseAmount = walletPnlFinite(row.base_amount);
      if (valueUsd === undefined || baseAmount === undefined || baseAmount <= 0) continue;
      const wallet = row.wallet.toLowerCase();
      const tokenAddress = row.token_address.toLowerCase();
      const positionKey = `${wallet}:${tokenAddress}`;
      const position = positions.get(positionKey) ?? { quantity: 0, costUsd: 0 };
      const inWindow = row.block_number >= windowFromBlock;
      const summary = inWindow ? walletPnlFlatWalletSummaryFor(summaries, wallet) : undefined;
      if (summary) {
        summary.volumeUsd += valueUsd;
        const tokenSymbol = row.token_symbol ?? "";
        if (tokenSymbol) summary.tradedTokens.add(tokenSymbol);
        summary.tradedTokenRefs.set(tokenAddress, { symbol: tokenSymbol, address: tokenAddress });
        if (row.block_number >= summary.lastBlock) {
          summary.lastBlock = row.block_number;
          summary.lastTxHash = row.tx_hash.toLowerCase();
        }
      }

      if (row.side === "buy") {
        position.quantity += baseAmount;
        position.costUsd += valueUsd;
        positions.set(positionKey, position);
        if (summary) summary.buyCount += 1;
        continue;
      }

      if (summary) summary.sellCount += 1;
      if (position.quantity <= 0 || position.costUsd <= 0) continue;
      const soldQuantity = Math.min(position.quantity, baseAmount);
      if (soldQuantity <= 0) continue;
      const soldRatio = soldQuantity / baseAmount;
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
      if (pnlUsd >= 0) summary.profitableExitCount += 1;
      else summary.losingExitCount += 1;
    }
    walletPnlProfileEmit(options.profile, "snapshot.fifoScan", fifoStartedAt, scannedRows);

    const top = [...summaries.values()]
      .filter((item) => item.realizedPnlUsd > options.minProfitUsd && item.realizedCostUsd > 0)
      .map((item): WalletPnlWalletSummary => ({
        wallet: item.wallet,
        realizedPnlUsd: walletPnlRoundMoney(item.realizedPnlUsd),
        realizedCostUsd: walletPnlRoundMoney(item.realizedCostUsd),
        realizedProceedsUsd: walletPnlRoundMoney(item.realizedProceedsUsd),
        roiPct: item.realizedCostUsd > 0 ? walletPnlRoundPct((item.realizedPnlUsd / item.realizedCostUsd) * 100) : undefined,
        buyCount: item.buyCount,
        sellCount: item.sellCount,
        profitableExitCount: item.profitableExitCount,
        losingExitCount: item.losingExitCount,
        tradedTokens: [...item.tradedTokens].sort().slice(0, 12),
        tradedTokenRefs: [...item.tradedTokenRefs.values()]
          .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.address.localeCompare(b.address))
          .slice(0, 12),
        volumeUsd: walletPnlRoundMoney(item.volumeUsd),
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
      tradeCount: walletPnlProfileStage(options.profile, "snapshot.tradeCount", () =>
        this.countWalletPnlFlatTrades(options.chain, windowFromBlock, options.toBlock, false, options.trustedV4Hooks)
      ),
      walletCount: summaries.size,
      top,
      partial: options.partial
    };
  }

  async buildWalletPnlAnalyticsSnapshotFromFlatTradesInWorker(options: WalletPnlAnalyticsBuildOptions): Promise<WalletPnlAnalyticsSnapshot | undefined> {
    const { profile, ...workerOptions } = options;
    return this.runWalletPnlAnalyticsWorker<WalletPnlAnalyticsSnapshot>("analytics", workerOptions, profile, () =>
      this.buildWalletPnlAnalyticsSnapshotFromFlatTrades(options)
    );
  }

  buildWalletPnlAnalyticsSnapshotFromFlatTrades(options: WalletPnlAnalyticsBuildOptions): WalletPnlAnalyticsSnapshot | undefined {
    const rangeReady = walletPnlProfileStage(options.profile, "analytics.rangeReady", () =>
      this.walletPnlFlatRangeReady(options.chain, options.positionFromBlock, options.toBlock, options.trustedV4Hooks)
    );
    if (!rangeReady) return undefined;
    const tokenSummaries = walletPnlProfileStage(options.profile, "analytics.token.total", () =>
      this.walletPnlTokenAnalyticsFromSql(options.chain, options.fromBlock, options.toBlock, options.trustedV4Hooks, options.profile),
      (rows) => rows.length
    );
    const walletSummaries = walletPnlProfileStage(options.profile, "analytics.wallet.total", () =>
      this.walletPnlWalletAnalyticsFromSql(options.chain, options.fromBlock, options.toBlock, options.trustedV4Hooks, options.profile),
      (rows) => rows.length
    );
    const poolSummaries = walletPnlProfileStage(options.profile, "analytics.pool.total", () =>
      this.walletPnlPoolAnalyticsFromSql(options.chain, options.fromBlock, options.toBlock, options.trustedV4Hooks, options.profile),
      (rows) => rows.length
    );
    const trustedV4HookPoolIds = this.walletPnlTrustedV4HookPoolIds(options.chain, options.trustedV4Hooks, options.profile);
    const pnlRows = walletPnlProfileStage(options.profile, "analytics.pnlLeaders.total", () =>
      this.buildWalletPnlFlatPnlLeaders(
        options.chain,
        options.positionFromBlock,
        options.toBlock,
        options.fromBlock,
        options.trustedV4Hooks,
        trustedV4HookPoolIds,
        options.profile
      ),
      (rows) => rows.length
    );
    const pnlLeaders = pnlRows
      .filter((row) => row.realizedPnlUsd > 0 && row.realizedCostUsd > 0)
      .sort((a, b) => b.realizedPnlUsd - a.realizedPnlUsd || (b.roiPct ?? 0) - (a.roiPct ?? 0))
      .slice(0, 1_000);
    const roiLeaders = pnlRows
      .filter((row) => row.realizedPnlUsd > 0 && row.realizedCostUsd >= 25 && row.realizedProceedsUsd >= 50 && row.roiPct !== undefined)
      .sort((a, b) => (b.roiPct ?? 0) - (a.roiPct ?? 0) || b.realizedPnlUsd - a.realizedPnlUsd)
      .slice(0, 1_000);
    const goodSignalWallets = walletPnlProfileStage(options.profile, "analytics.goodSignalWallets.total", () =>
      buildWalletPnlGoodSignalWallets({
        chain: options.chain,
        pnlRows,
        walletSummaries,
        tokenSummaries
      }),
      (rows) => rows.length
    );

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
      tradeCount: walletPnlProfileStage(options.profile, "analytics.tradeCount", () =>
        this.countWalletPnlFlatTrades(options.chain, options.fromBlock, options.toBlock, false, options.trustedV4Hooks)
      ),
      tokenCount: tokenSummaries.length,
      walletCount: walletSummaries.length,
      poolCount: poolSummaries.length,
      tokens: tokenSummaries,
      riskWallets: walletSummaries
        .slice()
        .filter((wallet) => wallet.tradeCount >= 10 || wallet.volumeUsd >= 1_000)
        .sort((a, b) => b.suspiciousScore - a.suspiciousScore || b.volumeUsd - a.volumeUsd)
        .slice(0, 1_000),
      pools: poolSummaries,
      pnlLeaders,
      roiLeaders,
      goodSignalWallets,
      volumeWallets: walletSummaries
        .slice()
        .sort((a, b) => b.volumeUsd - a.volumeUsd || b.tradeCount - a.tradeCount)
        .slice(0, 1_000)
    };
  }

  async buildWalletPnlNewTokensSnapshotFromFlatTradesInWorker(options: WalletPnlNewTokensBuildOptions): Promise<WalletPnlNewTokensSnapshot | undefined> {
    const { profile, ...workerOptions } = options;
    return this.runWalletPnlAnalyticsWorker<WalletPnlNewTokensSnapshot>("newTokens", workerOptions, profile, () =>
      this.buildWalletPnlNewTokensSnapshotFromFlatTrades(options)
    );
  }

  buildWalletPnlNewTokensSnapshotFromFlatTrades(options: WalletPnlNewTokensBuildOptions): WalletPnlNewTokensSnapshot | undefined {
    const tokens = walletPnlProfileStage(options.profile, "newTokens.total", () =>
      this.getWalletPnlNewTokenSummaries({
        chain: options.chain,
        fromBlock: options.fromBlock,
        toBlock: options.toBlock,
        trustedV4Hooks: options.trustedV4Hooks,
        limit: options.limit
      }),
      (rows) => rows?.length ?? 0
    );
    if (!tokens) return undefined;
    return {
      schemaVersion: 1,
      hookPolicyVersion: WALLET_PNL_HOOK_POLICY_VERSION,
      chain: options.chain,
      generatedAt: new Date().toISOString(),
      windowHours: options.windowHours,
      fromBlock: options.fromBlock,
      toBlock: options.toBlock,
      tokenCount: tokens.length,
      tokens
    };
  }

  getWalletPnlNewTokenSummaries(options: {
    chain: ChainSlug;
    fromBlock: number;
    toBlock: number;
    trustedV4Hooks?: string[];
    limit: number;
  }): WalletPnlAnalyticsTokenSummary[] | undefined {
    if (!this.walletPnlFlatRangeReady(options.chain, options.fromBlock, options.toBlock, options.trustedV4Hooks)) return undefined;
    const limit = Math.max(1, Math.floor(options.limit));
    const where = this.walletPnlRangeWhere(options.chain, options.fromBlock, options.toBlock, true, options.trustedV4Hooks);
    const rows = this.db.prepare(`
      SELECT
        token_address,
        COALESCE(MAX(token_symbol), '') AS token_symbol,
        COUNT(*) AS trade_count,
        COUNT(DISTINCT tx_hash) AS tx_count,
        COUNT(DISTINCT wallet) AS wallet_count,
        COUNT(DISTINCT pool_id) AS pool_count,
        SUM(CASE WHEN side = 'buy' THEN 1 ELSE 0 END) AS buy_count,
        SUM(CASE WHEN side = 'sell' THEN 1 ELSE 0 END) AS sell_count,
        SUM(COALESCE(volume_usd, 0)) AS volume_usd,
        SUM(CASE WHEN side = 'buy' THEN COALESCE(volume_usd, 0) ELSE 0 END) AS buy_volume_usd,
        SUM(CASE WHEN side = 'sell' THEN COALESCE(volume_usd, 0) ELSE 0 END) AS sell_volume_usd,
        MIN(block_number) AS first_block,
        MAX(block_number) AS last_block,
        MIN(CASE WHEN price_usd > 0 THEN price_usd END) AS min_price_usd,
        MAX(CASE WHEN price_usd > 0 THEN price_usd END) AS max_price_usd
      FROM wallet_pnl_trades
      WHERE ${where.sql}
      GROUP BY token_address
      ORDER BY first_block DESC, last_block DESC, volume_usd DESC
      LIMIT ?
    `).all(...where.args, limit) as unknown as Array<Record<string, unknown>>;
    const hookRisk = this.walletPnlV4HookRiskByToken(
      options.chain,
      options.fromBlock,
      options.toBlock,
      options.trustedV4Hooks
    );
    return rows.map((row): WalletPnlAnalyticsTokenSummary => {
      const tradeCount = walletPnlInt(row.trade_count);
      const txCount = walletPnlInt(row.tx_count);
      const walletCount = walletPnlInt(row.wallet_count);
      const volumeUsd = walletPnlNumber(row.volume_usd);
      const buyCount = walletPnlInt(row.buy_count);
      const sellCount = walletPnlInt(row.sell_count);
      const avgTradesPerWallet = walletPnlRatio(tradeCount, walletCount);
      const tradesPerTx = walletPnlRatio(tradeCount, txCount);
      const buySellSymmetryPct = walletPnlSymmetryPct(buyCount, sellCount);
      const lowWalletHighVolumeScore = volumeUsd >= 1_000_000 && walletCount <= 150
        ? 90
        : volumeUsd >= 100_000 && walletCount <= 50
          ? 80
          : 0;
      const hookSummary = hookRisk.get(String(row.token_address).toLowerCase());
      const hookRiskScore = untrustedV4HookRiskScore(hookSummary?.untrustedV4HookCount);
      const baseSuspiciousScore = walletPnlClampScore(
        buySellSymmetryPct * 0.25 +
        walletPnlPressureScore(avgTradesPerWallet, 40) * 0.25 +
        walletPnlPressureScore(tradesPerTx, 4) * 0.17 +
        lowWalletHighVolumeScore * 0.16 +
        hookRiskScore * 0.17
      );
      const suspiciousScore = walletPnlClampScore(Math.max(baseSuspiciousScore, hookRiskScore));
      return {
        tokenAddress: String(row.token_address).toLowerCase(),
        tokenSymbol: String(row.token_symbol ?? ""),
        tradeCount,
        txCount,
        walletCount,
        poolCount: walletPnlInt(row.pool_count),
        buyCount,
        sellCount,
        volumeUsd: walletPnlRoundMoney(volumeUsd),
        buyVolumeUsd: walletPnlRoundMoney(walletPnlNumber(row.buy_volume_usd)),
        sellVolumeUsd: walletPnlRoundMoney(walletPnlNumber(row.sell_volume_usd)),
        firstBlock: walletPnlInt(row.first_block),
        lastBlock: walletPnlInt(row.last_block),
        minPriceUsd: walletPnlRoundPrice(walletPnlFinite(row.min_price_usd)),
        maxPriceUsd: walletPnlRoundPrice(walletPnlFinite(row.max_price_usd)),
        topWalletVolumeUsd: 0,
        topWalletConcentrationPct: 0,
        avgTradesPerWallet: walletPnlRoundRatio(avgTradesPerWallet),
        tradesPerTx: walletPnlRoundRatio(tradesPerTx),
        buySellSymmetryPct,
        untrustedV4HookCount: hookSummary?.untrustedV4HookCount ?? 0,
        untrustedV4Hooks: hookSummary?.untrustedV4Hooks ?? [],
        suspiciousScore,
        dexes: [],
        protocols: []
      };
    });
  }

  private runWalletPnlAnalyticsWorker<T>(
    mode: WalletPnlAnalyticsWorkerMode,
    options: Omit<WalletPnlSnapshotBuildOptions, "profile"> | Omit<WalletPnlAnalyticsBuildOptions, "profile"> | Omit<WalletPnlNewTokensBuildOptions, "profile">,
    profile: WalletPnlProfileSink | undefined,
    _fallback: () => T | undefined
  ): Promise<T | undefined> {
    const workerPath = this.walletPnlAnalyticsWorkerPath();
    if (!workerPath) {
      walletPnlProfileEmit(profile, `${mode}.workerUnavailable`, Date.now());
      return Promise.resolve(undefined);
    }

    const run = (): Promise<T | undefined> => new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const worker = new Worker(workerPath, {
        workerData: {
          filePath: this.filePath,
          defaultBackfillBlocks: this.defaultBackfillBlocks,
          mode,
          options,
          profileEnabled: Boolean(profile)
        }
      });
      let settled = false;
      const timeout = setTimeout(() => {
        settle(() => {
          void worker.terminate();
          reject(new Error(`wallet pnl ${mode} worker timed out after ${WALLET_PNL_ANALYTICS_WORKER_TIMEOUT_MS}ms`));
        });
      }, WALLET_PNL_ANALYTICS_WORKER_TIMEOUT_MS);
      timeout.unref?.();
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        fn();
      };
      worker.once("message", (message: WalletPnlAnalyticsWorkerMessage<T>) => {
        settle(() => {
          void worker.terminate();
          walletPnlProfileEmit(profile, `${mode}.worker`, startedAt);
          for (const stage of message.profile ?? []) profile?.(stage);
          if (message.ok) resolve(message.value);
          else reject(new Error(message.error ?? "wallet pnl analytics worker failed"));
        });
      });
      worker.once("error", (error) => {
        settle(() => reject(error));
      });
      worker.once("exit", (code) => {
        if (settled) return;
        if (code === 0) {
          settle(() => reject(new Error(`wallet pnl ${mode} worker exited before posting a result`)));
          return;
        }
        settle(() => reject(new Error(`wallet pnl analytics worker exited with code ${code}`)));
      });
    });
    const queued = this.walletPnlAnalyticsWorkerQueue.then(run, run);
    this.walletPnlAnalyticsWorkerQueue = queued.catch(() => undefined);
    return queued;
  }

  private walletPnlAnalyticsWorkerPath(): string | undefined {
    const candidates = [
      path.join(__dirname, "..", "services", WALLET_PNL_ANALYTICS_WORKER_FILE),
      path.join(__dirname, WALLET_PNL_ANALYTICS_WORKER_FILE)
    ];
    return candidates.find((candidate) => existsSync(candidate));
  }

  private walletPnlTokenAnalyticsFromSql(
    chain: ChainSlug,
    fromBlock: number,
    toBlock: number,
    trustedV4Hooks?: string[],
    profile?: WalletPnlProfileSink
  ): WalletPnlAnalyticsTokenSummary[] {
    const where = this.walletPnlRangeWhere(chain, fromBlock, toBlock, true, trustedV4Hooks);
    const rows = walletPnlProfileStage(profile, "analytics.token.summarySql", () => this.db.prepare(`
      SELECT
        token_address,
        COALESCE(MAX(token_symbol), '') AS token_symbol,
        COUNT(*) AS trade_count,
        COUNT(DISTINCT tx_hash) AS tx_count,
        COUNT(DISTINCT wallet) AS wallet_count,
        COUNT(DISTINCT pool_id) AS pool_count,
        SUM(CASE WHEN side = 'buy' THEN 1 ELSE 0 END) AS buy_count,
        SUM(CASE WHEN side = 'sell' THEN 1 ELSE 0 END) AS sell_count,
        SUM(COALESCE(volume_usd, 0)) AS volume_usd,
        SUM(CASE WHEN side = 'buy' THEN COALESCE(volume_usd, 0) ELSE 0 END) AS buy_volume_usd,
        SUM(CASE WHEN side = 'sell' THEN COALESCE(volume_usd, 0) ELSE 0 END) AS sell_volume_usd,
        MIN(block_number) AS first_block,
        MAX(block_number) AS last_block,
        MIN(CASE WHEN price_usd > 0 THEN price_usd END) AS min_price_usd,
        MAX(CASE WHEN price_usd > 0 THEN price_usd END) AS max_price_usd
      FROM wallet_pnl_trades
      WHERE ${where.sql}
      GROUP BY token_address
    `).all(...where.args) as unknown as Array<Record<string, unknown>>, (rows) => rows.length);
    const latestPrice = this.walletPnlLatestPriceByToken(chain, fromBlock, toBlock, trustedV4Hooks, profile);
    const topWalletVolume = this.walletPnlTopWalletVolumeByToken(chain, fromBlock, toBlock, trustedV4Hooks, profile);
    const dexProtocols = this.walletPnlDexProtocolsByToken(chain, fromBlock, toBlock, trustedV4Hooks, profile);
    const hookRisk = this.walletPnlV4HookRiskByToken(chain, fromBlock, toBlock, trustedV4Hooks, profile);
    return rows
      .map((row): WalletPnlAnalyticsTokenSummary => {
        const tokenAddress = String(row.token_address).toLowerCase();
        const tradeCount = walletPnlInt(row.trade_count);
        const txCount = walletPnlInt(row.tx_count);
        const walletCount = walletPnlInt(row.wallet_count);
        const volumeUsd = walletPnlNumber(row.volume_usd);
        const topWalletVolumeUsd = topWalletVolume.get(tokenAddress) ?? 0;
        const avgTradesPerWallet = walletPnlRatio(tradeCount, walletCount);
        const tradesPerTx = walletPnlRatio(tradeCount, txCount);
        const concentrationPct = walletPnlPercentage(topWalletVolumeUsd, volumeUsd);
        const buyCount = walletPnlInt(row.buy_count);
        const sellCount = walletPnlInt(row.sell_count);
        const buySellSymmetryPct = walletPnlSymmetryPct(buyCount, sellCount);
        const lowWalletHighVolumeScore = volumeUsd >= 1_000_000 && walletCount <= 150
          ? 90
          : volumeUsd >= 100_000 && walletCount <= 50
            ? 80
            : 0;
        const hookSummary = hookRisk.get(tokenAddress);
        const hookRiskScore = untrustedV4HookRiskScore(hookSummary?.untrustedV4HookCount);
        const baseSuspiciousScore = walletPnlClampScore(
          concentrationPct * 0.26 +
          buySellSymmetryPct * 0.20 +
          walletPnlPressureScore(avgTradesPerWallet, 40) * 0.17 +
          walletPnlPressureScore(tradesPerTx, 4) * 0.10 +
          lowWalletHighVolumeScore * 0.10 +
          hookRiskScore * 0.17
        );
        const suspiciousScore = walletPnlClampScore(Math.max(baseSuspiciousScore, hookRiskScore));
        const dexProtocol = dexProtocols.get(tokenAddress);
        return {
          tokenAddress,
          tokenSymbol: String(row.token_symbol ?? ""),
          tradeCount,
          txCount,
          walletCount,
          poolCount: walletPnlInt(row.pool_count),
          buyCount,
          sellCount,
          volumeUsd: walletPnlRoundMoney(volumeUsd),
          buyVolumeUsd: walletPnlRoundMoney(walletPnlNumber(row.buy_volume_usd)),
          sellVolumeUsd: walletPnlRoundMoney(walletPnlNumber(row.sell_volume_usd)),
          firstBlock: walletPnlInt(row.first_block),
          lastBlock: walletPnlInt(row.last_block),
          latestPriceUsd: walletPnlRoundPrice(latestPrice.get(tokenAddress)),
          minPriceUsd: walletPnlRoundPrice(walletPnlFinite(row.min_price_usd)),
          maxPriceUsd: walletPnlRoundPrice(walletPnlFinite(row.max_price_usd)),
          topWalletVolumeUsd: walletPnlRoundMoney(topWalletVolumeUsd),
          topWalletConcentrationPct: concentrationPct,
          avgTradesPerWallet: walletPnlRoundRatio(avgTradesPerWallet),
          tradesPerTx: walletPnlRoundRatio(tradesPerTx),
          buySellSymmetryPct,
          untrustedV4HookCount: hookSummary?.untrustedV4HookCount ?? 0,
          untrustedV4Hooks: hookSummary?.untrustedV4Hooks ?? [],
          suspiciousScore,
          dexes: dexProtocol?.dexes ?? [],
          protocols: dexProtocol?.protocols ?? []
        };
      })
      .sort((a, b) => b.volumeUsd - a.volumeUsd || b.tradeCount - a.tradeCount);
  }

  private walletPnlWalletAnalyticsFromSql(
    chain: ChainSlug,
    fromBlock: number,
    toBlock: number,
    trustedV4Hooks?: string[],
    profile?: WalletPnlProfileSink
  ): WalletPnlAnalyticsWalletSummary[] {
    const where = this.walletPnlRangeWhere(chain, fromBlock, toBlock, false, trustedV4Hooks);
    const rows = walletPnlProfileStage(profile, "analytics.wallet.summarySql", () => this.db.prepare(`
      SELECT
        wallet,
        COUNT(*) AS trade_count,
        COUNT(DISTINCT tx_hash) AS tx_count,
        COUNT(DISTINCT pool_id) AS pool_count,
        SUM(CASE WHEN side = 'buy' THEN 1 ELSE 0 END) AS buy_count,
        SUM(CASE WHEN side = 'sell' THEN 1 ELSE 0 END) AS sell_count,
        SUM(COALESCE(volume_usd, 0)) AS volume_usd,
        MIN(block_number) AS first_block,
        MAX(block_number) AS last_block
      FROM wallet_pnl_trades
      WHERE ${where.sql}
      GROUP BY wallet
    `).all(...where.args) as unknown as Array<Record<string, unknown>>, (rows) => rows.length);
    const tokenCounts = this.walletPnlTokenCountByWallet(chain, fromBlock, toBlock, trustedV4Hooks, profile);
    const topTokens = this.walletPnlTopTokenByWallet(chain, fromBlock, toBlock, trustedV4Hooks, profile);
    const topPools = this.walletPnlTopPoolByWallet(chain, fromBlock, toBlock, trustedV4Hooks, profile);
    return rows.map((row): WalletPnlAnalyticsWalletSummary => {
      const wallet = String(row.wallet).toLowerCase();
      const tradeCount = walletPnlInt(row.trade_count);
      const tokenCount = tokenCounts.get(wallet) ?? 0;
      const poolCount = walletPnlInt(row.pool_count);
      const buyCount = walletPnlInt(row.buy_count);
      const sellCount = walletPnlInt(row.sell_count);
      const volumeUsd = walletPnlNumber(row.volume_usd);
      const topToken = topTokens.get(wallet);
      const topPool = topPools.get(wallet);
      const buySellSymmetryPct = walletPnlSymmetryPct(buyCount, sellCount);
      const avgTradesPerToken = walletPnlRatio(tradeCount, tokenCount);
      const avgTradeUsd = walletPnlRatio(volumeUsd, tradeCount);
      const tokenConcentrationPct = walletPnlPercentage(topToken?.volumeUsd ?? 0, volumeUsd);
      const poolConcentrationPct = walletPnlPercentage(topPool?.volumeUsd ?? 0, volumeUsd);
      const suspiciousScore = walletPnlClampScore(
        tokenConcentrationPct * 0.31 +
        poolConcentrationPct * 0.22 +
        buySellSymmetryPct * 0.19 +
        walletPnlPressureScore(avgTradesPerToken, 200) * 0.16 +
        walletPnlPressureScore(volumeUsd, 1_000_000) * 0.12
      );
      return {
        wallet,
        tradeCount,
        txCount: walletPnlInt(row.tx_count),
        tokenCount,
        poolCount,
        buyCount,
        sellCount,
        volumeUsd: walletPnlRoundMoney(volumeUsd),
        firstBlock: walletPnlInt(row.first_block),
        lastBlock: walletPnlInt(row.last_block),
        topTokenAddress: topToken?.tokenAddress,
        topTokenSymbol: topToken?.tokenSymbol,
        topTokenVolumeUsd: walletPnlRoundMoney(topToken?.volumeUsd ?? 0),
        tokenConcentrationPct,
        topPoolId: topPool?.poolId,
        topPoolVolumeUsd: walletPnlRoundMoney(topPool?.volumeUsd ?? 0),
        poolConcentrationPct,
        buySellSymmetryPct,
        avgTradesPerToken: walletPnlRoundRatio(avgTradesPerToken),
        avgTradeUsd: walletPnlRoundMoney(avgTradeUsd),
        suspiciousScore
      };
    });
  }

  private walletPnlPoolAnalyticsFromSql(
    chain: ChainSlug,
    fromBlock: number,
    toBlock: number,
    trustedV4Hooks?: string[],
    profile?: WalletPnlProfileSink
  ): WalletPnlAnalyticsPoolSummary[] {
    const where = this.walletPnlRangeWhere(chain, fromBlock, toBlock, true, trustedV4Hooks);
    const rows = walletPnlProfileStage(profile, "analytics.pool.summarySql", () => this.db.prepare(`
      SELECT
        pool_id,
        COALESCE(MAX(pool_address), '') AS pool_address,
        COALESCE(MAX(dex), '') AS dex,
        COALESCE(MAX(protocol), '') AS protocol,
        COALESCE(MAX(token_address), '') AS token_address,
        COALESCE(MAX(token_symbol), '') AS token_symbol,
        COALESCE(MAX(quote_address), '') AS quote_address,
        COALESCE(MAX(quote_symbol), '') AS quote_symbol,
        COUNT(*) AS trade_count,
        COUNT(DISTINCT tx_hash) AS tx_count,
        COUNT(DISTINCT wallet) AS wallet_count,
        SUM(CASE WHEN side = 'buy' THEN 1 ELSE 0 END) AS buy_count,
        SUM(CASE WHEN side = 'sell' THEN 1 ELSE 0 END) AS sell_count,
        SUM(COALESCE(volume_usd, 0)) AS volume_usd,
        MIN(block_number) AS first_block,
        MAX(block_number) AS last_block
      FROM wallet_pnl_trades
      WHERE ${where.sql}
      GROUP BY pool_id
    `).all(...where.args) as unknown as Array<Record<string, unknown>>, (rows) => rows.length);
    const topWalletVolume = this.walletPnlTopWalletVolumeByPool(chain, fromBlock, toBlock, trustedV4Hooks, profile);
    const hookRisk = this.walletPnlV4HookRiskByPool(chain, fromBlock, toBlock, trustedV4Hooks, profile);
    return rows
      .map((row): WalletPnlAnalyticsPoolSummary => {
        const poolId = String(row.pool_id).toLowerCase();
        const tradeCount = walletPnlInt(row.trade_count);
        const txCount = walletPnlInt(row.tx_count);
        const walletCount = walletPnlInt(row.wallet_count);
        const buyCount = walletPnlInt(row.buy_count);
        const sellCount = walletPnlInt(row.sell_count);
        const volumeUsd = walletPnlNumber(row.volume_usd);
        const topWalletVolumeUsd = topWalletVolume.get(poolId) ?? 0;
        const buySellSymmetryPct = walletPnlSymmetryPct(buyCount, sellCount);
        const topWalletConcentrationPct = walletPnlPercentage(topWalletVolumeUsd, volumeUsd);
        const hookSummary = hookRisk.get(poolId);
        const hookRiskScore = untrustedV4HookRiskScore(hookSummary?.untrustedV4Hook ? 1 : 0);
        const baseSuspiciousScore = walletPnlClampScore(
          topWalletConcentrationPct * 0.28 +
          buySellSymmetryPct * 0.20 +
          walletPnlPressureScore(walletPnlRatio(tradeCount, walletCount), 45) * 0.20 +
          walletPnlPressureScore(walletPnlRatio(tradeCount, txCount), 4) * 0.14 +
          hookRiskScore * 0.18
        );
        const suspiciousScore = walletPnlClampScore(Math.max(baseSuspiciousScore, hookRiskScore));
        const poolAddress = String(row.pool_address ?? "");
        return {
          poolId,
          poolAddress: poolAddress || undefined,
          dex: String(row.dex ?? ""),
          protocol: String(row.protocol ?? ""),
          tokenAddress: String(row.token_address ?? "").toLowerCase(),
          tokenSymbol: String(row.token_symbol ?? ""),
          quoteAddress: String(row.quote_address ?? "").toLowerCase(),
          quoteSymbol: String(row.quote_symbol ?? ""),
          tradeCount,
          txCount,
          walletCount,
          buyCount,
          sellCount,
          volumeUsd: walletPnlRoundMoney(volumeUsd),
          firstBlock: walletPnlInt(row.first_block),
          lastBlock: walletPnlInt(row.last_block),
          topWalletVolumeUsd: walletPnlRoundMoney(topWalletVolumeUsd),
          topWalletConcentrationPct,
          buySellSymmetryPct,
          v4Hook: hookSummary?.v4Hook,
          untrustedV4Hook: hookSummary?.untrustedV4Hook ?? false,
          suspiciousScore
        };
      })
      .sort((a, b) => b.volumeUsd - a.volumeUsd || b.tradeCount - a.tradeCount)
      .slice(0, 5_000);
  }

  private buildWalletPnlFlatPnlLeaders(
    chain: ChainSlug,
    positionFromBlock: number,
    toBlock: number,
    summaryFromBlock = positionFromBlock,
    trustedV4Hooks?: string[],
    trustedV4HookPoolIds?: ReadonlySet<string>,
    profile?: WalletPnlProfileSink
  ): WalletPnlAnalyticsPnlLeader[] {
    const positions = new Map<string, WalletPnlFlatPnlState>();
    const summaries = new Map<string, WalletPnlFlatLeaderSummary>();
    let scannedRows = 0;
    const fifoStartedAt = Date.now();
    for (const row of this.iterateWalletPnlFlatRows(chain, positionFromBlock, toBlock, true, trustedV4Hooks)) {
      scannedRows += 1;
      const valueUsd = walletPnlFinite(row.volume_usd);
      const baseAmount = walletPnlFinite(row.base_amount);
      if (valueUsd === undefined || baseAmount === undefined || baseAmount <= 0) continue;
      const wallet = row.wallet.toLowerCase();
      const tokenAddress = row.token_address.toLowerCase();
      const key = `${wallet}:${tokenAddress}`;
      const position = positions.get(key) ?? { quantity: 0, costUsd: 0 };
      const inSummaryWindow = row.block_number >= summaryFromBlock;
      const summary = inSummaryWindow ? walletPnlFlatLeaderFor(summaries, row) : undefined;
      if (summary) {
        summary.volumeUsd += valueUsd;
        summary.firstBlock = Math.min(summary.firstBlock, row.block_number);
        summary.lastBlock = Math.max(summary.lastBlock, row.block_number);
        if (trustedV4HookPoolIds?.has(row.pool_id.toLowerCase())) {
          summary.trustedV4HookTradeCount += 1;
        }
      }

      if (row.side === "buy") {
        if (summary) summary.buyCount += 1;
        position.quantity += baseAmount;
        position.costUsd += valueUsd;
        positions.set(key, position);
        continue;
      }

      if (summary) summary.sellCount += 1;
      if (position.quantity <= 0 || position.costUsd <= 0) continue;
      const soldQuantity = Math.min(position.quantity, baseAmount);
      if (soldQuantity <= 0) continue;
      const soldRatio = soldQuantity / baseAmount;
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
    walletPnlProfileEmit(profile, "analytics.pnlLeaders.fifoScan", fifoStartedAt, scannedRows);

    return [...summaries.values()]
      .filter((row) => row.sellCount > 0 && row.realizedCostUsd > 0)
      .map((row) => ({
        wallet: row.wallet,
        tokenAddress: row.tokenAddress,
        tokenSymbol: row.tokenSymbol,
        realizedPnlUsd: walletPnlRoundMoney(row.realizedPnlUsd),
        realizedCostUsd: walletPnlRoundMoney(row.realizedCostUsd),
        realizedProceedsUsd: walletPnlRoundMoney(row.realizedProceedsUsd),
        roiPct: row.realizedCostUsd > 0 ? walletPnlRoundPct((row.realizedPnlUsd / row.realizedCostUsd) * 100) : undefined,
        buyCount: row.buyCount,
        sellCount: row.sellCount,
        profitableExitCount: row.profitableExitCount,
        losingExitCount: row.losingExitCount,
        trustedV4HookTradeCount: row.trustedV4HookTradeCount,
        volumeUsd: walletPnlRoundMoney(row.volumeUsd),
        firstBlock: walletPnlBlockOrZero(row.firstBlock),
        lastBlock: row.lastBlock
      }));
  }

  private iterateWalletPnlFlatRows(
    chain: ChainSlug,
    fromBlock: number,
    toBlock: number,
    excludeIgnored: boolean,
    trustedV4Hooks?: string[]
  ): Iterable<WalletPnlFlatTradeRow> {
    const where = this.walletPnlRangeWhere(chain, fromBlock, toBlock, excludeIgnored, trustedV4Hooks);
    return this.db.prepare(`
      SELECT
        chain, tx_hash, log_index, pool_id, pool_address, wallet, token_address, token_symbol,
        quote_address, quote_symbol, side, block_number, base_amount, quote_amount, price_usd,
        volume_usd, dex, protocol
      FROM wallet_pnl_trades
      WHERE ${where.sql}
      ORDER BY block_number, log_index
    `).iterate(...where.args) as Iterable<WalletPnlFlatTradeRow>;
  }

  private countWalletPnlFlatTrades(chain: ChainSlug, fromBlock: number, toBlock: number, excludeIgnored: boolean, trustedV4Hooks?: string[]): number {
    const where = this.walletPnlRangeWhere(chain, fromBlock, toBlock, excludeIgnored, trustedV4Hooks);
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM wallet_pnl_trades WHERE ${where.sql}`).get(...where.args) as { count: number } | undefined;
    return walletPnlInt(row?.count);
  }

  private walletPnlFlatRangeReady(chain: ChainSlug, fromBlock: number, toBlock: number, trustedV4Hooks?: string[]): boolean {
    const eligible = this.walletPnlEligibleTradeWhere("", chain, trustedV4Hooks);
    const row = this.db.prepare(
      `SELECT 1 FROM wallet_pnl_trades
       WHERE chain = ?
         AND block_number >= ?
         AND block_number <= ?
         AND ${eligible.sql}
         AND (token_symbol IS NULL OR quote_address IS NULL OR base_amount IS NULL OR dex IS NULL OR protocol IS NULL)
       LIMIT 1`
    ).get(chain, fromBlock, toBlock, ...eligible.args) as unknown;
    return row === undefined;
  }

  private walletPnlLatestPriceByToken(chain: ChainSlug, fromBlock: number, toBlock: number, trustedV4Hooks?: string[], profile?: WalletPnlProfileSink): Map<string, number> {
    const where = this.walletPnlRangeWhere(chain, fromBlock, toBlock, true, trustedV4Hooks);
    const rows = walletPnlProfileStage(profile, "analytics.token.latestPriceSql", () => this.db.prepare(`
      SELECT token_address, price_usd
      FROM (
        SELECT token_address, price_usd,
          ROW_NUMBER() OVER (PARTITION BY token_address ORDER BY block_number DESC, log_index DESC) AS rn
        FROM wallet_pnl_trades
        WHERE ${where.sql} AND price_usd > 0
      )
      WHERE rn = 1
    `).all(...where.args) as unknown as Array<{ token_address: string; price_usd: number }>, (rows) => rows.length);
    return new Map(rows.map((row) => [row.token_address.toLowerCase(), walletPnlNumber(row.price_usd)]));
  }

  private walletPnlTopWalletVolumeByToken(chain: ChainSlug, fromBlock: number, toBlock: number, trustedV4Hooks?: string[], profile?: WalletPnlProfileSink): Map<string, number> {
    const where = this.walletPnlRangeWhere(chain, fromBlock, toBlock, true, trustedV4Hooks);
    const rows = walletPnlProfileStage(profile, "analytics.token.topWalletSql", () => this.db.prepare(`
      SELECT token_address, MAX(wallet_volume_usd) AS top_wallet_volume_usd
      FROM (
        SELECT token_address, wallet, SUM(COALESCE(volume_usd, 0)) AS wallet_volume_usd
        FROM wallet_pnl_trades
        WHERE ${where.sql}
        GROUP BY token_address, wallet
      )
      GROUP BY token_address
    `).all(...where.args) as unknown as Array<{ token_address: string; top_wallet_volume_usd: number }>, (rows) => rows.length);
    return new Map(rows.map((row) => [row.token_address.toLowerCase(), walletPnlNumber(row.top_wallet_volume_usd)]));
  }

  private walletPnlTopWalletVolumeByPool(chain: ChainSlug, fromBlock: number, toBlock: number, trustedV4Hooks?: string[], profile?: WalletPnlProfileSink): Map<string, number> {
    const where = this.walletPnlRangeWhere(chain, fromBlock, toBlock, true, trustedV4Hooks);
    const rows = walletPnlProfileStage(profile, "analytics.pool.topWalletSql", () => this.db.prepare(`
      SELECT pool_id, MAX(wallet_volume_usd) AS top_wallet_volume_usd
      FROM (
        SELECT pool_id, wallet, SUM(COALESCE(volume_usd, 0)) AS wallet_volume_usd
        FROM wallet_pnl_trades
        WHERE ${where.sql}
        GROUP BY pool_id, wallet
      )
      GROUP BY pool_id
    `).all(...where.args) as unknown as Array<{ pool_id: string; top_wallet_volume_usd: number }>, (rows) => rows.length);
    return new Map(rows.map((row) => [row.pool_id.toLowerCase(), walletPnlNumber(row.top_wallet_volume_usd)]));
  }

  private walletPnlDexProtocolsByToken(chain: ChainSlug, fromBlock: number, toBlock: number, trustedV4Hooks?: string[], profile?: WalletPnlProfileSink): Map<string, { dexes: string[]; protocols: string[] }> {
    const where = this.walletPnlRangeWhere(chain, fromBlock, toBlock, true, trustedV4Hooks);
    const rows = walletPnlProfileStage(profile, "analytics.token.dexProtocolsSql", () => this.db.prepare(`
      SELECT token_address, GROUP_CONCAT(DISTINCT dex) AS dexes, GROUP_CONCAT(DISTINCT protocol) AS protocols
      FROM wallet_pnl_trades
      WHERE ${where.sql}
      GROUP BY token_address
    `).all(...where.args) as unknown as Array<{ token_address: string; dexes: string | null; protocols: string | null }>, (rows) => rows.length);
    return new Map(rows.map((row) => [
      row.token_address.toLowerCase(),
      {
        dexes: walletPnlCsv(row.dexes).sort().slice(0, 8),
        protocols: walletPnlCsv(row.protocols).sort().slice(0, 8)
      }
    ]));
  }

  private walletPnlV4HookRiskByToken(
    chain: ChainSlug,
    fromBlock: number,
    toBlock: number,
    trustedV4Hooks?: string[],
    profile?: WalletPnlProfileSink
  ): Map<string, { untrustedV4HookCount: number; untrustedV4Hooks: string[] }> {
    const where = this.walletPnlAliasedRangeWhere("t", chain, fromBlock, toBlock, true, trustedV4Hooks);
    const rows = walletPnlProfileStage(profile, "analytics.token.v4HookRiskSql", () => this.db.prepare(`
      SELECT DISTINCT t.token_address, t.pool_id, p.data_json
      FROM wallet_pnl_trades t
      LEFT JOIN wallet_pnl_pools p ON p.chain = t.chain AND p.pool_id = LOWER(t.pool_id)
      WHERE ${where.sql}
    `).all(...where.args) as unknown as Array<{ token_address: string; pool_id: string; data_json: string | null }>, (rows) => rows.length);
    const byToken = new Map<string, Set<string>>();
    for (const row of rows) {
      const hook = untrustedV4Hook(walletPnlParsePoolJson(row.data_json), trustedV4Hooks);
      if (!hook) continue;
      const tokenAddress = row.token_address.toLowerCase();
      const hooks = byToken.get(tokenAddress) ?? new Set<string>();
      hooks.add(hook);
      byToken.set(tokenAddress, hooks);
    }
    return new Map([...byToken.entries()].map(([tokenAddress, hooks]) => [
      tokenAddress,
      {
        untrustedV4HookCount: hooks.size,
        untrustedV4Hooks: [...hooks].sort().slice(0, 8)
      }
    ]));
  }

  private walletPnlV4HookRiskByPool(
    chain: ChainSlug,
    fromBlock: number,
    toBlock: number,
    trustedV4Hooks?: string[],
    profile?: WalletPnlProfileSink
  ): Map<string, { v4Hook?: string; untrustedV4Hook: boolean }> {
    const where = this.walletPnlAliasedRangeWhere("t", chain, fromBlock, toBlock, true, trustedV4Hooks);
    const rows = walletPnlProfileStage(profile, "analytics.pool.v4HookRiskSql", () => this.db.prepare(`
      SELECT DISTINCT t.pool_id, p.data_json
      FROM wallet_pnl_trades t
      LEFT JOIN wallet_pnl_pools p ON p.chain = t.chain AND p.pool_id = LOWER(t.pool_id)
      WHERE ${where.sql}
    `).all(...where.args) as unknown as Array<{ pool_id: string; data_json: string | null }>, (rows) => rows.length);
    const out = new Map<string, { v4Hook?: string; untrustedV4Hook: boolean }>();
    for (const row of rows) {
      const pool = walletPnlParsePoolJson(row.data_json);
      const v4Hook = poolV4Hook(pool);
      const riskyHook = untrustedV4Hook(pool, trustedV4Hooks);
      out.set(row.pool_id.toLowerCase(), {
        v4Hook,
        untrustedV4Hook: Boolean(riskyHook)
      });
    }
    return out;
  }

  private walletPnlTrustedV4HookPoolIds(
    chain: ChainSlug,
    trustedV4Hooks?: string[],
    profile?: WalletPnlProfileSink
  ): Set<string> {
    const rows = walletPnlProfileStage(profile, "analytics.trustedV4HookPools.sql", () => this.db.prepare(`
      SELECT pool_id, data_json
      FROM wallet_pnl_pools
      WHERE chain = ?
    `).all(chain) as unknown as Array<{ pool_id: string; data_json: string | null }>, (rows) => rows.length);
    const out = new Set<string>();
    for (const row of rows) {
      if (!trustedV4Hook(walletPnlParsePoolJson(row.data_json), trustedV4Hooks)) continue;
      out.add(row.pool_id.toLowerCase());
    }
    return out;
  }

  private walletPnlTokenCountByWallet(chain: ChainSlug, fromBlock: number, toBlock: number, trustedV4Hooks?: string[], profile?: WalletPnlProfileSink): Map<string, number> {
    const where = this.walletPnlRangeWhere(chain, fromBlock, toBlock, true, trustedV4Hooks);
    const rows = walletPnlProfileStage(profile, "analytics.wallet.tokenCountSql", () => this.db.prepare(`
      SELECT wallet, COUNT(DISTINCT token_address) AS token_count
      FROM wallet_pnl_trades
      WHERE ${where.sql}
      GROUP BY wallet
    `).all(...where.args) as unknown as Array<{ wallet: string; token_count: number }>, (rows) => rows.length);
    return new Map(rows.map((row) => [row.wallet.toLowerCase(), walletPnlInt(row.token_count)]));
  }

  private walletPnlTopTokenByWallet(chain: ChainSlug, fromBlock: number, toBlock: number, trustedV4Hooks?: string[], profile?: WalletPnlProfileSink): Map<string, { tokenAddress: string; tokenSymbol: string; volumeUsd: number }> {
    const where = this.walletPnlRangeWhere(chain, fromBlock, toBlock, true, trustedV4Hooks);
    const rows = walletPnlProfileStage(profile, "analytics.wallet.topTokenSql", () => this.db.prepare(`
      SELECT wallet, token_address, token_symbol, token_volume_usd
      FROM (
        SELECT wallet, token_address, COALESCE(MAX(token_symbol), '') AS token_symbol,
          SUM(COALESCE(volume_usd, 0)) AS token_volume_usd,
          ROW_NUMBER() OVER (PARTITION BY wallet ORDER BY SUM(COALESCE(volume_usd, 0)) DESC, token_address) AS rn
        FROM wallet_pnl_trades
        WHERE ${where.sql}
        GROUP BY wallet, token_address
      )
      WHERE rn = 1
    `).all(...where.args) as unknown as Array<{ wallet: string; token_address: string; token_symbol: string; token_volume_usd: number }>, (rows) => rows.length);
    return new Map(rows.map((row) => [row.wallet.toLowerCase(), {
      tokenAddress: row.token_address.toLowerCase(),
      tokenSymbol: row.token_symbol,
      volumeUsd: walletPnlNumber(row.token_volume_usd)
    }]));
  }

  private walletPnlTopPoolByWallet(chain: ChainSlug, fromBlock: number, toBlock: number, trustedV4Hooks?: string[], profile?: WalletPnlProfileSink): Map<string, { poolId: string; volumeUsd: number }> {
    const where = this.walletPnlRangeWhere(chain, fromBlock, toBlock, false, trustedV4Hooks);
    const rows = walletPnlProfileStage(profile, "analytics.wallet.topPoolSql", () => this.db.prepare(`
      SELECT wallet, pool_id, pool_volume_usd
      FROM (
        SELECT wallet, pool_id, SUM(COALESCE(volume_usd, 0)) AS pool_volume_usd,
          ROW_NUMBER() OVER (PARTITION BY wallet ORDER BY SUM(COALESCE(volume_usd, 0)) DESC, pool_id) AS rn
        FROM wallet_pnl_trades
        WHERE ${where.sql}
        GROUP BY wallet, pool_id
      )
      WHERE rn = 1
    `).all(...where.args) as unknown as Array<{ wallet: string; pool_id: string; pool_volume_usd: number }>, (rows) => rows.length);
    return new Map(rows.map((row) => [row.wallet.toLowerCase(), {
      poolId: row.pool_id.toLowerCase(),
      volumeUsd: walletPnlNumber(row.pool_volume_usd)
    }]));
  }

  private walletPnlReadTradeWhere(chain: ChainSlug, fromBlock?: number, trustedV4Hooks?: readonly string[]): { sql: string; args: SQLInputValue[] } {
    const conditions = ["chain = ?"];
    const args: SQLInputValue[] = [chain];
    if (fromBlock !== undefined) {
      conditions.push("block_number >= ?");
      args.push(fromBlock);
    }
    const eligible = this.walletPnlEligibleTradeWhere("", chain, trustedV4Hooks);
    conditions.push(eligible.sql);
    args.push(...eligible.args);
    return { sql: conditions.join(" AND "), args };
  }

  private walletPnlRangeWhere(
    chain: ChainSlug,
    fromBlock: number,
    toBlock: number,
    excludeIgnored: boolean,
    trustedV4Hooks?: readonly string[]
  ): { sql: string; args: SQLInputValue[] } {
    const conditions = ["chain = ?", "block_number >= ?", "block_number <= ?"];
    const args: SQLInputValue[] = [chain, fromBlock, toBlock];
    const eligible = this.walletPnlEligibleTradeWhere("", chain, trustedV4Hooks);
    conditions.push(eligible.sql);
    args.push(...eligible.args);
    if (excludeIgnored) {
      const ignored = this.walletPnlIgnoredTokenWhere();
      conditions.push(ignored.sql);
      args.push(...ignored.args);
      const ignoredAddresses = walletPnlIgnoredTokenAddresses(chain);
      if (ignoredAddresses.length > 0) {
        conditions.push(`LOWER(COALESCE(token_address, '')) NOT IN (${ignoredAddresses.map(() => "?").join(", ")})`);
        args.push(...ignoredAddresses);
      }
    }
    return { sql: conditions.join(" AND "), args };
  }

  private walletPnlAliasedRangeWhere(
    alias: string,
    chain: ChainSlug,
    fromBlock: number,
    toBlock: number,
    excludeIgnored: boolean,
    trustedV4Hooks?: readonly string[]
  ): { sql: string; args: SQLInputValue[] } {
    const prefix = alias ? `${alias}.` : "";
    const conditions = [`${prefix}chain = ?`, `${prefix}block_number >= ?`, `${prefix}block_number <= ?`];
    const args: SQLInputValue[] = [chain, fromBlock, toBlock];
    const eligible = this.walletPnlEligibleTradeWhere(prefix, chain, trustedV4Hooks);
    conditions.push(eligible.sql);
    args.push(...eligible.args);
    if (excludeIgnored) {
      conditions.push(`UPPER(COALESCE(${prefix}token_symbol, '')) NOT IN (${WALLET_PNL_IGNORED_SYMBOLS.map(() => "?").join(", ")})`);
      args.push(...WALLET_PNL_IGNORED_SYMBOLS);
      const ignoredAddresses = walletPnlIgnoredTokenAddresses(chain);
      if (ignoredAddresses.length > 0) {
        conditions.push(`LOWER(COALESCE(${prefix}token_address, '')) NOT IN (${ignoredAddresses.map(() => "?").join(", ")})`);
        args.push(...ignoredAddresses);
      }
    }
    return { sql: conditions.join(" AND "), args };
  }

  private walletPnlEligibleTradeWhere(prefix: string, chain: ChainSlug, trustedV4Hooks?: readonly string[]): { sql: string; args: SQLInputValue[] } {
    if (chain !== "base") return { sql: "1 = 1", args: [] };
    const trustedHookValues = [...trustedV4HookSet(trustedV4Hooks)]
      .filter((hook) => hook !== "0x0000000000000000000000000000000000000000");
    const trustedHookPredicate = trustedHookValues.length > 0
      ? `LOWER(COALESCE(json_extract(p.data_json, '$.hooks'), '')) IN (${trustedHookValues.map(() => "?").join(", ")})`
      : "0";
    return {
      sql: `(
        ${prefix}chain != 'base'
        OR LOWER(COALESCE(${prefix}dex, '')) != 'uniswap'
        OR LOWER(COALESCE(${prefix}protocol, '')) != 'v4'
        OR LOWER(COALESCE(${prefix}pool_id, '')) IN (
          SELECT LOWER(p.pool_id)
          FROM wallet_pnl_pools p
          WHERE p.chain = ?
            AND ${trustedHookPredicate}
        )
      )`,
      args: [chain, ...trustedHookValues]
    };
  }

  private walletPnlIgnoredTokenWhere(): { sql: string; args: SQLInputValue[] } {
    return {
      sql: `UPPER(COALESCE(token_symbol, '')) NOT IN (${WALLET_PNL_IGNORED_SYMBOLS.map(() => "?").join(", ")})`,
      args: WALLET_PNL_IGNORED_SYMBOLS
    };
  }

  private walletPnlTradesFromRows(rows: WalletPnlTradeRow[]): WalletPnlTradeRecord[] {
    return rows
      .map((row) => {
        try {
          return JSON.parse(row.data_json) as WalletPnlTradeRecord;
        } catch {
          return undefined;
        }
      })
      .filter((record): record is WalletPnlTradeRecord => Boolean(record));
  }

  getWalletPnlCursor(chain: ChainSlug): WalletPnlCursor | undefined {
    const row = this.db.prepare("SELECT * FROM wallet_pnl_cursors WHERE chain = ?").get(chain) as WalletPnlCursorRow | undefined;
    if (!row) return undefined;
    return {
      chain: row.chain,
      lastBlock: row.last_block ?? undefined,
      lastPostedAt: row.last_posted_at ?? undefined,
      updatedAt: row.updated_at
    };
  }

  setWalletPnlCursor(cursor: WalletPnlCursor): void {
    this.db
      .prepare(
        `INSERT INTO wallet_pnl_cursors(chain, last_block, last_posted_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(chain) DO UPDATE SET
           last_block=excluded.last_block,
           last_posted_at=excluded.last_posted_at,
           updated_at=excluded.updated_at`
      )
      .run(cursor.chain, cursor.lastBlock ?? null, cursor.lastPostedAt ?? null, cursor.updatedAt);
  }

  getWalletPnlSnapshot(chain: ChainSlug): WalletPnlSnapshot | undefined {
    const row = this.db.prepare("SELECT data_json FROM wallet_pnl_snapshots WHERE chain = ?").get(chain) as WalletPnlSnapshotRow | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.data_json) as WalletPnlSnapshot;
    } catch {
      return undefined;
    }
  }

  setWalletPnlSnapshot(snapshot: WalletPnlSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO wallet_pnl_snapshots(chain, data_json, generated_at, to_block)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(chain) DO UPDATE SET
           data_json=excluded.data_json,
           generated_at=excluded.generated_at,
           to_block=excluded.to_block`
      )
      .run(snapshot.chain, JSON.stringify(snapshot), snapshot.generatedAt, snapshot.toBlock);
  }

  getWalletPnlAnalyticsSnapshot(chain: ChainSlug): WalletPnlAnalyticsSnapshot | undefined {
    const row = this.db.prepare("SELECT data_json FROM wallet_pnl_analytics_snapshots WHERE chain = ?").get(chain) as WalletPnlAnalyticsSnapshotRow | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.data_json) as WalletPnlAnalyticsSnapshot;
    } catch {
      return undefined;
    }
  }

  setWalletPnlAnalyticsSnapshot(snapshot: WalletPnlAnalyticsSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO wallet_pnl_analytics_snapshots(chain, data_json, generated_at, to_block)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(chain) DO UPDATE SET
           data_json=excluded.data_json,
           generated_at=excluded.generated_at,
           to_block=excluded.to_block`
      )
      .run(snapshot.chain, JSON.stringify(snapshot), snapshot.generatedAt, snapshot.toBlock);
  }

  getWalletPnlNewTokensSnapshot(chain: ChainSlug): WalletPnlNewTokensSnapshot | undefined {
    const row = this.db.prepare("SELECT data_json FROM wallet_pnl_new_token_snapshots WHERE chain = ?").get(chain) as WalletPnlNewTokensSnapshotRow | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.data_json) as WalletPnlNewTokensSnapshot;
    } catch {
      return undefined;
    }
  }

  setWalletPnlNewTokensSnapshot(snapshot: WalletPnlNewTokensSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO wallet_pnl_new_token_snapshots(chain, data_json, generated_at, to_block)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(chain) DO UPDATE SET
           data_json=excluded.data_json,
           generated_at=excluded.generated_at,
           to_block=excluded.to_block`
      )
      .run(snapshot.chain, JSON.stringify(snapshot), snapshot.generatedAt, snapshot.toBlock);
  }

  getWalletPnlHistoricalTokenBuys(chain: ChainSlug, clusterKey: string): WalletPnlHistoricalTokenBuys | undefined {
    const row = this.db.prepare("SELECT data_json FROM wallet_pnl_historical_token_buys WHERE chain = ? AND cluster_key = ?").get(chain, clusterKey.toLowerCase()) as WalletPnlHistoricalTokenBuysRow | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.data_json) as WalletPnlHistoricalTokenBuys;
    } catch {
      return undefined;
    }
  }

  setWalletPnlHistoricalTokenBuys(snapshot: WalletPnlHistoricalTokenBuys): void {
    this.db
      .prepare(
        `INSERT INTO wallet_pnl_historical_token_buys(chain, cluster_key, status, updated_at, data_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chain, cluster_key) DO UPDATE SET
           status=excluded.status,
           updated_at=excluded.updated_at,
           data_json=excluded.data_json`
      )
      .run(snapshot.chain, snapshot.clusterKey.toLowerCase(), snapshot.status, snapshot.updatedAt, JSON.stringify(snapshot));
  }

  getWalletPnlClusters(chain: ChainSlug): WalletPnlClusterRecord[] {
    const rows = this.db
      .prepare("SELECT data_json FROM wallet_pnl_clusters WHERE chain = ? ORDER BY last_seen_at DESC")
      .all(chain) as unknown as WalletPnlClusterRow[];
    return rows
      .map((row) => {
        try {
          return JSON.parse(row.data_json) as WalletPnlClusterRecord;
        } catch {
          return undefined;
        }
      })
      .filter((record): record is WalletPnlClusterRecord => Boolean(record));
  }

  upsertWalletPnlClusters(records: WalletPnlClusterRecord[]): number {
    if (records.length === 0) return 0;
    const chains = [...new Set(records.map((record) => record.chain))];
    const existing = new Map<string, WalletPnlClusterRecord>();
    for (const chain of chains) {
      for (const record of this.getWalletPnlClusters(chain)) {
        existing.set(walletPnlClusterKey(record.chain, record.clusterId), record);
      }
    }

    const upsert = this.db.prepare(
      `INSERT INTO wallet_pnl_clusters(chain, cluster_id, status, source, first_seen_at, last_seen_at, data_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chain, cluster_id) DO UPDATE SET
         status=excluded.status,
         source=excluded.source,
         first_seen_at=excluded.first_seen_at,
         last_seen_at=excluded.last_seen_at,
         data_json=excluded.data_json`
    );

    let changed = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const record of records) {
        const key = walletPnlClusterKey(record.chain, record.clusterId);
        const merged = mergeWalletPnlClusterRecord(record, existing.get(key));
        const previous = existing.get(key);
        if (previous && JSON.stringify(previous) === JSON.stringify(merged)) continue;
        upsert.run(
          merged.chain,
          merged.clusterId.toLowerCase(),
          merged.status,
          merged.source,
          merged.firstSeenAt,
          merged.lastSeenAt,
          JSON.stringify(merged)
        );
        existing.set(key, merged);
        changed += 1;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return changed;
  }

  getCopyShadowConfig(): CopyShadowConfig | undefined {
    const row = this.db.prepare("SELECT data_json FROM copy_shadow_config WHERE id = ?").get("default") as CopyShadowConfigRow | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.data_json) as CopyShadowConfig;
    } catch {
      return undefined;
    }
  }

  setCopyShadowConfig(config: CopyShadowConfig): void {
    this.db
      .prepare(
        `INSERT INTO copy_shadow_config(id, data_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           data_json=excluded.data_json,
           updated_at=excluded.updated_at`
      )
      .run("default", JSON.stringify(config), config.updatedAt);
  }

  getCopyShadowSnapshot(chain: ChainSlug): CopyShadowSnapshot | undefined {
    const row = this.db.prepare("SELECT data_json FROM copy_shadow_snapshots WHERE chain = ?").get(chain) as CopyShadowSnapshotRow | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.data_json) as CopyShadowSnapshot;
    } catch {
      return undefined;
    }
  }

  setCopyShadowSnapshot(snapshot: CopyShadowSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO copy_shadow_snapshots(chain, data_json, generated_at, to_block)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(chain) DO UPDATE SET
           data_json=excluded.data_json,
           generated_at=excluded.generated_at,
           to_block=excluded.to_block`
      )
      .run(snapshot.chain, JSON.stringify(snapshot), snapshot.generatedAt, snapshot.toBlock ?? null);
  }

  async save(): Promise<void> {
    // No-op: writes are synchronous in node:sqlite.
  }

  private marketPoolFromRow(row: MarketPoolRow): TrackedMarketPoolRecord | undefined {
    try {
      return {
        chain: row.chain,
        poolId: row.pool_id,
        pool: JSON.parse(row.data_json) as PoolKey,
        source: row.source,
        firstSeenBlock: row.first_seen_block ?? undefined,
        lastSeenBlock: row.last_seen_block ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    } catch {
      return undefined;
    }
  }

  private walletPnlPoolFromRow(row: WalletPnlPoolRow): WalletPnlPoolRecord | undefined {
    try {
      return {
        chain: row.chain,
        poolId: row.pool_id,
        pool: JSON.parse(row.data_json) as PoolKey,
        source: row.source,
        firstSeenBlock: row.first_seen_block ?? undefined,
        lastSeenBlock: row.last_seen_block ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    } catch {
      return undefined;
    }
  }

  private walletPnlTokenCreatorFromRow(row: WalletPnlTokenCreatorRow): WalletPnlTokenCreatorRecord {
    return {
      chain: row.chain,
      tokenAddress: row.token_address,
      creator: row.creator,
      creationTxHash: row.creation_tx_hash ?? undefined,
      creationBlock: row.creation_block ?? undefined,
      source: row.source ?? undefined,
      confidence: row.confidence ?? undefined,
      createdByContract: row.created_by_contract === null ? undefined : Boolean(row.created_by_contract),
      updatedAt: row.updated_at
    };
  }
}

function walletPnlParsePoolJson(dataJson: string | null | undefined): PoolKey | undefined {
  if (!dataJson) return undefined;
  try {
    return JSON.parse(dataJson) as PoolKey;
  } catch {
    return undefined;
  }
}

function walletPnlFlatLeaderFor(summaries: Map<string, WalletPnlFlatLeaderSummary>, row: WalletPnlFlatTradeRow): WalletPnlFlatLeaderSummary {
  const wallet = row.wallet.toLowerCase();
  const tokenAddress = row.token_address.toLowerCase();
  const key = `${wallet}:${tokenAddress}`;
  let summary = summaries.get(key);
  if (!summary) {
    summary = {
      wallet,
      tokenAddress,
      tokenSymbol: row.token_symbol ?? "",
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

function walletPnlFlatWalletSummaryFor(summaries: Map<string, WalletPnlFlatWalletSummary>, wallet: string): WalletPnlFlatWalletSummary {
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

function walletPnlProfileStage<T>(
  profile: WalletPnlProfileSink | undefined,
  stage: string,
  run: () => T,
  rowCount?: (result: T) => number | undefined
): T {
  const startedAt = Date.now();
  try {
    const result = run();
    walletPnlProfileEmit(profile, stage, startedAt, rowCount?.(result));
    return result;
  } catch (error) {
    walletPnlProfileEmit(profile, stage, startedAt, undefined, (error as Error).message);
    throw error;
  }
}

function walletPnlProfileEmit(
  profile: WalletPnlProfileSink | undefined,
  stage: string,
  startedAt: number,
  rows?: number,
  error?: string
): void {
  if (!profile) return;
  const memory = process.memoryUsage();
  profile({
    stage,
    elapsedMs: Date.now() - startedAt,
    rows,
    heapUsedMb: walletPnlRoundMemoryMb(memory.heapUsed),
    rssMb: walletPnlRoundMemoryMb(memory.rss),
    error
  });
}

function walletPnlRoundMemoryMb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

function walletPnlClusterKey(chain: ChainSlug, clusterId: string): string {
  return `${chain}:${clusterId.toLowerCase()}`;
}

function walletPnlFinite(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function walletPnlNumber(value: unknown): number {
  return walletPnlFinite(value) ?? 0;
}

function walletPnlInt(value: unknown): number {
  const parsed = walletPnlNumber(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

function walletPnlRoundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function walletPnlRoundPct(value: number): number {
  return Math.round(value * 100) / 100;
}

function walletPnlRoundRatio(value: number): number {
  return Math.round(value * 100) / 100;
}

function walletPnlRoundPrice(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (value >= 1) return Math.round(value * 1_000_000) / 1_000_000;
  return Number(value.toPrecision(6));
}

function walletPnlRatio(value: number, denominator: number): number {
  return denominator > 0 ? value / denominator : 0;
}

function walletPnlPercentage(value: number, denominator: number): number {
  return walletPnlRoundPct(walletPnlRatio(value, denominator) * 100);
}

function walletPnlSymmetryPct(left: number, right: number): number {
  const total = left + right;
  if (total <= 0) return 0;
  return walletPnlRoundPct((1 - Math.abs(left - right) / total) * 100);
}

function walletPnlPressureScore(value: number, fullScoreAt: number): number {
  if (fullScoreAt <= 0) return 0;
  return walletPnlClampScore((value / fullScoreAt) * 100);
}

function walletPnlClampScore(value: number): number {
  return walletPnlRoundPct(Math.max(0, Math.min(100, value)));
}

function walletPnlBlockOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function walletPnlCsv(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
