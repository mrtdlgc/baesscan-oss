import path from "node:path";
import dotenv from "dotenv";
import { getAddress } from "ethers";
import type { Address, ChainSlug } from "../types";
import { CHAIN_SLUGS, CHAINS, getChain, isChainSlug, poolManagerFor } from "../chains/registry";
import type { StorageBackend } from "../store/store";

dotenv.config();

function str(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric env var ${name}: ${raw}`);
  return parsed;
}

function optionalNum(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric env var ${name}: ${raw}`);
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function parseBlockscoutLogSource(): "disabled" | "fallback" | "preferred" {
  const raw = process.env.BLOCKSCOUT_LOG_SOURCE?.trim().toLowerCase();
  if (!raw) return process.env.BLOCKSCOUT_API_KEY?.trim() ? "fallback" : "disabled";
  if (raw === "disabled" || raw === "fallback" || raw === "preferred") return raw;
  throw new Error(`Invalid BLOCKSCOUT_LOG_SOURCE: ${raw}`);
}

function csvNumbers(name: string): number[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v));
}

function csvStrings(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function rpcUrlsFor(chain: ChainSlug): string[] {
  const cfg = getChain(chain);
  const multi = csvStrings(cfg.rpcEnv).slice(0, 10);
  const singleEnv = cfg.rpcEnv.replace(/S$/, "");
  const single = process.env[singleEnv]?.trim();
  if (multi.length > 0) return multi;
  return single ? [single] : [];
}

export function backfillRpcProvidersEnvName(chain: ChainSlug): string {
  return `${chain.toUpperCase().replace(/-/g, "_")}_BACKFILL_RPC_PROVIDERS`;
}

function backfillRpcProvidersFor(chain: ChainSlug): BackfillRpcProviderConfig[] {
  const envName = backfillRpcProvidersEnvName(chain);
  return csvStrings(envName).slice(0, 10).map((entry, index) => parseBackfillRpcProvider(entry, envName, index));
}

function parseBackfillRpcProvider(entry: string, envName: string, index: number): BackfillRpcProviderConfig {
  const parts = entry.split("|").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error(`Invalid ${envName} entry at #${index + 1}: empty entry`);
  const first = parts[0]!;
  const hasExplicitLabel = !/^https?:\/\//i.test(first);
  const label = hasExplicitLabel ? first : `backfill-rpc-${index + 1}`;
  const url = hasExplicitLabel ? parts[1] : first;
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new Error(`Invalid ${envName} entry at #${index + 1}: expected label|https://... or https://...`);
  }
  const options = hasExplicitLabel ? parts.slice(2) : parts.slice(1);
  let maxRps = 1;
  let logBlockLimit: number | undefined;
  let weight = 1;
  for (const option of options) {
    const equalsIndex = option.indexOf("=");
    const [rawKey, rawValue] = equalsIndex === -1
      ? ["rps", option]
      : [option.slice(0, equalsIndex), option.slice(equalsIndex + 1)];
    const key = rawKey!.trim().toLowerCase();
    const value = rawValue?.trim() ?? "";
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`Invalid ${envName} ${key} value for ${label}: ${value}`);
    if (key === "rps" || key === "maxrps" || key === "max_rps") {
      maxRps = Math.min(100, Math.max(0.05, parsed));
    } else if (key === "blocks" || key === "logblocks" || key === "logblocklimit" || key === "log_block_limit") {
      logBlockLimit = Math.min(100_000, Math.max(1, Math.floor(parsed)));
    } else if (key === "weight") {
      weight = Math.min(100, Math.max(0.1, parsed));
    } else {
      throw new Error(`Invalid ${envName} option for ${label}: ${rawKey}`);
    }
  }
  return { label, url, maxRps, logBlockLimit, weight };
}

function parsePrimaryChain(): ChainSlug {
  const raw = str("PRIMARY_CHAIN", "base").toLowerCase();
  if (!isChainSlug(raw)) throw new Error(`Invalid PRIMARY_CHAIN: ${raw}`);
  if (raw === "solana") throw new Error("Solana is currently hidden from the supported product surface. Use an EVM PRIMARY_CHAIN.");
  return raw;
}

function parseEnabledChains(primaryChain: ChainSlug): ChainSlug[] {
  const raw = csvStrings("ENABLED_CHAINS");
  const selected = raw.length > 0 ? raw : [primaryChain];
  const out: ChainSlug[] = [];
  for (const value of selected) {
    const slug = value.toLowerCase();
    if (!isChainSlug(slug)) throw new Error(`Invalid ENABLED_CHAINS entry: ${value}`);
    if (slug === "solana") continue;
    if (!out.includes(slug)) out.push(slug);
  }
  return out;
}

function parseMarketArchiveChains(enabledChains: ChainSlug[]): ChainSlug[] {
  const raw = csvStrings("MARKET_ARCHIVE_CHAINS");
  const selected = raw.length > 0 ? raw : enabledChains.filter((chain) => chain === "base" || chain === "ethereum");
  const out: ChainSlug[] = [];
  for (const value of selected) {
    const slug = value.toLowerCase();
    if (!isChainSlug(slug)) throw new Error(`Invalid MARKET_ARCHIVE_CHAINS entry: ${value}`);
    if (!out.includes(slug)) out.push(slug);
  }
  return out;
}

function parseWalletPnlChain(): ChainSlug {
  const raw = str("WALLET_PNL_CHAIN", "base").toLowerCase();
  if (!isChainSlug(raw)) throw new Error(`Invalid WALLET_PNL_CHAIN: ${raw}`);
  if (getChain(raw).kind !== "evm") throw new Error("WALLET_PNL_CHAIN must be an EVM chain.");
  return raw;
}

function parseWalletPnlGateChain(fallback: ChainSlug): ChainSlug {
  const raw = process.env.WALLET_PNL_GATE_CHAIN?.trim().toLowerCase();
  if (!raw) return fallback;
  if (!isChainSlug(raw)) throw new Error(`Invalid WALLET_PNL_GATE_CHAIN: ${raw}`);
  if (getChain(raw).kind !== "evm") throw new Error("WALLET_PNL_GATE_CHAIN must be an EVM chain.");
  return raw;
}

function optionalConfigAddress(name: string): Address | undefined {
  const raw = process.env[name]?.trim();
  return raw ? parseConfigAddress(raw, name) : undefined;
}

function parseWalletPnlTrustedV4Hooks(): Address[] {
  const out: Address[] = [];
  const seen = new Set<string>();
  for (const value of csvStrings("WALLET_PNL_TRUSTED_V4_HOOKS")) {
    const address = parseConfigAddress(value, "WALLET_PNL_TRUSTED_V4_HOOKS");
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(address);
  }
  return out;
}

function parseWalletPnlDeniedTokenFactoryContracts(): Address[] {
  const defaults = ["0xAEC49a050917DDba7a09Db04fa27360f44Df6DB3"];
  const out: Address[] = [];
  const seen = new Set<string>();
  const configured = [
    ...csvStrings("WALLET_PNL_DENIED_TOKEN_FACTORY_CONTRACTS"),
    ...csvStrings("WALLET_PNL_DENIED_TOKEN_CREATORS")
  ];
  for (const value of [...defaults, ...configured]) {
    const address = parseConfigAddress(value, "WALLET_PNL_DENIED_TOKEN_FACTORY_CONTRACTS");
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(address);
  }
  return out;
}

function decimalString(name: string, fallback: string): string {
  const raw = process.env[name]?.trim() || fallback;
  if (!/^\d+(?:\.\d+)?$/.test(raw)) throw new Error(`Invalid decimal env var ${name}: ${raw}`);
  return raw;
}

function parseCopyShadowChain(): ChainSlug {
  const raw = str("COPY_SHADOW_CHAIN", "base").toLowerCase();
  if (!isChainSlug(raw)) throw new Error(`Invalid COPY_SHADOW_CHAIN: ${raw}`);
  if (getChain(raw).kind !== "evm") throw new Error("COPY_SHADOW_CHAIN must be an EVM chain.");
  return raw;
}

function parseCopyShadowWallets(): Address[] {
  const raw = csvStrings("COPY_SHADOW_WALLETS");
  const fallback = process.env.COPY_SHADOW_WALLET?.trim();
  const values = raw.length > 0 ? raw : fallback ? [fallback] : [];
  const out: Address[] = [];
  for (const value of values) {
    const address = parseConfigAddress(value, "COPY_SHADOW_WALLETS");
    if (!out.some((existing) => existing.toLowerCase() === address.toLowerCase())) out.push(address);
  }
  return out.slice(0, 25);
}

export interface Env {
  telegramEnabled: boolean;
  telegramMode: "polling" | "webhook";
  telegramBotToken: string;
  telegramWebhookPath: string;
  telegramWebhookUrl?: string;
  telegramWebhookSecret?: string;
  primaryChain: ChainSlug;
  enabledChains: ChainSlug[];
  rpcUrlsByChain: Partial<Record<ChainSlug, string[]>>;
  backfillRpcProvidersByChain: Partial<Record<ChainSlug, BackfillRpcProviderConfig[]>>;
  baseRpcUrl: string;
  baseRpcUrls: string[];
  ownerUserIds: number[];
  adminUserIds: number[];
  allowedChatIds: number[];
  publicMode: boolean;
  maxChats: number;
  maxPoolsPerChat: number;
  scanCooldownMs: number;
  poolManagerAddresses: Partial<Record<ChainSlug, Address>>;
  poolManagerAddress: Address;
  pollIntervalMs: number;
  confirmations: number;
  logChunkSize: number;
  poolScanLookbackBlocks: number;
  defaultBackfillBlocks: number;
  dataFile: string;
  storageBackend: StorageBackend;
  ethUsdOverride?: number;
  disableCoinGecko: boolean;
  brandName: string;
  supportUrl?: string;
  webEnabled: boolean;
  webPort: number;
  webAdminPassword?: string;
  intelSessionSecret?: string;
  geckoPoolLookup: boolean;
  solanaSignatureLimit: number;
  solanaTransactionLimit: number;
  marketsEnabled: boolean;
  marketSnapshotsEnabled: boolean;
  marketSnapshotPrefix: string;
  marketSnapshotCacheSeconds: number;
  marketHistoryRetentionDays: number;
  marketArchiveEnabled: boolean;
  marketArchiveChains: ChainSlug[];
  marketArchiveIntervalMs: number;
  marketArchiveFactoryLookbackBlocks: number;
  marketArchiveSwapLookbackBlocks: number;
  marketArchiveHeadLagBlocks: number;
  marketArchivePendingPoolTtlBlocks: number;
  marketArchiveLogFilterConcurrency: number;
  marketArchiveNormalizeConcurrency: number;
  marketArchiveFastTokenMetadata: boolean;
  marketArchiveMaxPoolsPerTick: number;
  marketArchiveMaxFactoryDiscoveries: number;
  marketArchiveChunkTradeLimit: number;
  walletPnlEnabled: boolean;
  walletPnlChain: ChainSlug;
  walletPnlRetentionDays: number;
  walletPnlWindowHours: number;
  walletPnlPositionWindowHours: number;
  walletPnlAnalyticsWindowHours: number;
  walletPnlBootstrapHours: number;
  walletPnlScanIntervalMs: number;
  walletPnlSnapshotIntervalMs: number;
  walletPnlAnalyticsIntervalMs: number;
  walletPnlNewTokensIntervalMs: number;
  walletPnlProfileRebuilds: boolean;
  walletPnlHistoricalPrecomputeIntervalMs: number;
  walletPnlHistoricalPrecomputeTokenLimit: number;
  walletPnlHistoricalPrecomputeWalletLimit: number;
  walletPnlPostIntervalMs: number;
  walletPnlPostChatId?: number;
  walletPnlPostThreadId?: number;
  walletPnlMaxBlocksPerTick: number;
  walletPnlMaxPoolsPerTick: number;
  walletPnlBlockLookupConcurrency: number;
  walletPnlTxLookupConcurrency: number;
  walletPnlMetadataTimeoutMs: number;
  walletPnlTxLookupTimeoutMs: number;
  walletPnlHeadLagBlocks: number;
  walletPnlSnapshotLimit: number;
  walletPnlMinProfitUsd: number;
  walletPnlSeedPoolLimit: number;
  walletPnlMaxFactoryDiscoveries: number;
  walletPnlMaxPostLagBlocks: number;
  walletPnlActivePoolDiscoveryEnabled: boolean;
  walletPnlActivePoolDiscoveryMaxPools: number;
  walletPnlTokenBootstrapEnabled: boolean;
  walletPnlTokenBootstrapDiscoveryDays: number;
  walletPnlTokenBootstrapReplayHours: number;
  walletPnlTokenBootstrapMaxPools: number;
  walletPnlTrustedV4Hooks: Address[];
  walletPnlDeniedTokenFactoryContracts: Address[];
  walletPnlGateChain: ChainSlug;
  walletPnlGateTokenAddress?: Address;
  walletPnlGateMinBalance: string;
  walletPnlGateSessionHours: number;
  copyShadowEnabled: boolean;
  copyShadowChain: ChainSlug;
  copyShadowWallets: Address[];
  copyShadowIntervalMs: number;
  copyShadowTradeSizeUsd: number;
  copyShadowMaxPositionUsd: number;
  copyShadowExecutionDelayBlocks: number;
  copyShadowMaxPriceLookaheadBlocks: number;
  copyShadowSlippageBps: number;
  copyShadowGasUsd: number;
  copyShadowMinSourceVolumeUsd: number;
  copyShadowRecentSignalsLimit: number;
  copyShadowPositionLimit: number;
  blockscoutApiKey?: string;
  blockscoutApiBaseUrl: string;
  blockscoutLogSource: "disabled" | "fallback" | "preferred";
  blockscoutLogChunkSize: number;
  blockscoutMaxLogsPerRequest: number;
  blockscoutMaxRequestsPerTick: number;
  blockscoutRequestDelayMs: number;
  r2AccountId?: string;
  r2AccessKeyId?: string;
  r2SecretAccessKey?: string;
  r2Bucket?: string;
  publicMarketApiBase?: string;
}

export interface BackfillRpcProviderConfig {
  label: string;
  url: string;
  maxRps: number;
  logBlockLimit?: number;
  weight: number;
}

export function loadEnv(): Env {
  const primaryChain = parsePrimaryChain();
  const enabledChains = parseEnabledChains(primaryChain);
  const telegramEnabled = bool("TELEGRAM_ENABLED", true);
  const telegramMode = parseTelegramMode();
  const telegramWebhookPath = normalizePath(str("TELEGRAM_WEBHOOK_PATH", "/telegram/webhook"));
  const publicBaseUrl = inferPublicBaseUrl();
  const telegramWebhookUrl =
    process.env.TELEGRAM_WEBHOOK_URL?.trim().replace(/\/+$/g, "") ||
    (publicBaseUrl ? `${publicBaseUrl}${telegramWebhookPath}` : undefined);
  if (telegramEnabled && telegramMode === "webhook" && !telegramWebhookUrl) {
    throw new Error("TELEGRAM_MODE=webhook requires TELEGRAM_WEBHOOK_URL, PUBLIC_BASE_URL, or RAILWAY_PUBLIC_DOMAIN");
  }
  const rpcUrlsByChain: Partial<Record<ChainSlug, string[]>> = {};
  for (const slug of enabledChains) {
    const urls = rpcUrlsFor(slug);
    if (urls.length > 0) rpcUrlsByChain[slug] = urls;
  }
  const backfillRpcProvidersByChain: Partial<Record<ChainSlug, BackfillRpcProviderConfig[]>> = {};
  for (const slug of CHAIN_SLUGS) {
    const envName = backfillRpcProvidersEnvName(slug);
    if (getChain(slug).kind !== "evm") {
      if (process.env[envName]?.trim()) throw new Error(`${envName} is only supported for EVM chains`);
      continue;
    }
    const providers = backfillRpcProvidersFor(slug);
    if (providers.length > 0) backfillRpcProvidersByChain[slug] = providers;
  }
  const baseRpcUrls = rpcUrlsByChain.base ?? rpcUrlsFor("base");
  if (getChain(primaryChain).kind === "evm" && !rpcUrlsByChain[primaryChain]?.length && !backfillRpcProvidersByChain[primaryChain]?.length) {
    throw new Error(`Missing required env var: ${getChain(primaryChain).rpcEnv}, ${getChain(primaryChain).rpcEnv.replace(/S$/, "")}, or ${backfillRpcProvidersEnvName(primaryChain)}`);
  }
  if (enabledChains.includes("solana") && !rpcUrlsByChain.solana?.length) {
    throw new Error("Missing required env var: SOLANA_RPC_URL or SOLANA_RPC_URLS");
  }

  const poolManagerAddresses: Partial<Record<ChainSlug, Address>> = {};
  for (const slug of CHAIN_SLUGS) {
    const defaultManager = poolManagerFor(CHAINS[slug]);
    const envName = `${slug.toUpperCase().replace(/-/g, "_")}_POOL_MANAGER_ADDRESS`;
    const raw = process.env[envName]?.trim() || (slug === "base" ? process.env.POOL_MANAGER_ADDRESS?.trim() : undefined);
    if (raw || defaultManager) {
      poolManagerAddresses[slug] = parseConfigAddress(raw || defaultManager!, envName);
    }
  }
  const poolManagerAddress = poolManagerAddresses[primaryChain] ?? poolManagerAddresses.base ?? parseConfigAddress("0x498581ff718922c3f8e6a244956af099b2652b2b", "POOL_MANAGER_ADDRESS");
  const storageBackendRaw = str("STORAGE_BACKEND", "auto").toLowerCase();
  const storageBackend: StorageBackend = storageBackendRaw === "json" ? "json" : storageBackendRaw === "sqlite" ? "sqlite" : "auto";

  const baseRpcUrl = baseRpcUrls[0] ?? rpcUrlsByChain[primaryChain]?.[0] ?? "";
  const marketsEnabled = bool("MARKETS_ENABLED", false);
  const walletPnlRetentionDays = Math.min(30, Math.max(1, num("WALLET_PNL_RETENTION_DAYS", 3)));
  const walletPnlWindowHours = Math.min(walletPnlRetentionDays * 24, Math.max(1, num("WALLET_PNL_WINDOW_HOURS", 24)));
  const walletPnlPositionWindowHours = Math.min(
    walletPnlRetentionDays * 24,
    Math.max(walletPnlWindowHours, num("WALLET_PNL_POSITION_WINDOW_HOURS", walletPnlWindowHours))
  );
  const walletPnlAnalyticsWindowHours = Math.min(
    walletPnlRetentionDays * 24,
    Math.max(1, num("WALLET_PNL_ANALYTICS_WINDOW_HOURS", walletPnlWindowHours))
  );
  const walletPnlChain = parseWalletPnlChain();
  const walletPnlGateTokenAddress = optionalConfigAddress("WALLET_PNL_GATE_TOKEN_ADDRESS");
  const walletPnlGateChain = walletPnlGateTokenAddress ? parseWalletPnlGateChain(walletPnlChain) : walletPnlChain;
  if (walletPnlGateTokenAddress && !enabledChains.includes(walletPnlGateChain)) {
    throw new Error("WALLET_PNL_GATE_CHAIN must be included in ENABLED_CHAINS.");
  }
  if (walletPnlGateTokenAddress && !rpcUrlsByChain[walletPnlGateChain]?.length) {
    throw new Error(`WALLET_PNL_GATE_CHAIN requires ${getChain(walletPnlGateChain).rpcEnv} or ${getChain(walletPnlGateChain).rpcEnv.replace(/S$/, "")}.`);
  }

  return {
    telegramEnabled,
    telegramMode,
    telegramBotToken: telegramEnabled ? str("TELEGRAM_BOT_TOKEN") : process.env.TELEGRAM_BOT_TOKEN?.trim() || "disabled",
    telegramWebhookPath,
    telegramWebhookUrl,
    telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET?.trim() || undefined,
    primaryChain,
    enabledChains,
    rpcUrlsByChain,
    backfillRpcProvidersByChain,
    baseRpcUrl,
    baseRpcUrls,
    ownerUserIds: csvNumbers("OWNER_USER_IDS"),
    adminUserIds: csvNumbers("ADMIN_USER_IDS"),
    allowedChatIds: csvNumbers("ALLOWED_CHAT_IDS"),
    publicMode: bool("PUBLIC_MODE", true),
    maxChats: num("MAX_CHATS", 500),
    maxPoolsPerChat: num("MAX_POOLS_PER_CHAT", 25),
    scanCooldownMs: num("SCAN_COOLDOWN_MS", 15_000),
    poolManagerAddresses,
    poolManagerAddress,
    pollIntervalMs: num("POLL_INTERVAL_MS", 30_000),
    confirmations: num("CONFIRMATIONS", 2),
    logChunkSize: num("LOG_CHUNK_SIZE", 500),
    poolScanLookbackBlocks: Math.min(50_000, Math.max(1, num("POOL_SCAN_LOOKBACK_BLOCKS", 50_000))),
    defaultBackfillBlocks: num("DEFAULT_BACKFILL_BLOCKS", 5),
    dataFile: path.resolve(str("DATA_FILE", "./data/state.db")),
    storageBackend,
    ethUsdOverride: optionalNum("ETH_USD_OVERRIDE"),
    disableCoinGecko: bool("DISABLE_COINGECKO", false),
    brandName: str("BRAND_NAME", "baes scan"),
    supportUrl: process.env.SUPPORT_URL?.trim() || undefined,
    webEnabled: bool("WEB_ENABLED", true),
    webPort: num("PORT", num("WEB_PORT", 3000)),
    webAdminPassword: process.env.WEB_ADMIN_PASSWORD?.trim() || undefined,
    intelSessionSecret: process.env.INTEL_SESSION_SECRET?.trim() || undefined,
    geckoPoolLookup: bool("GECKO_POOL_LOOKUP", true),
    solanaSignatureLimit: Math.min(50, Math.max(1, num("SOLANA_SIGNATURE_LIMIT", 20))),
    solanaTransactionLimit: Math.min(20, Math.max(1, num("SOLANA_TRANSACTION_LIMIT", 10))),
    marketsEnabled,
    marketSnapshotsEnabled: marketsEnabled && bool("MARKET_SNAPSHOTS_ENABLED", false),
    marketSnapshotPrefix: str("MARKET_SNAPSHOT_PREFIX", "dex-data").replace(/^\/+|\/+$/g, ""),
    marketSnapshotCacheSeconds: Math.min(3600, Math.max(5, num("MARKET_SNAPSHOT_CACHE_SECONDS", 20))),
    marketHistoryRetentionDays: Math.min(366, Math.max(1, num("MARKET_HISTORY_RETENTION_DAYS", 30))),
    marketArchiveEnabled: marketsEnabled && bool("MARKET_ARCHIVE_ENABLED", false),
    marketArchiveChains: parseMarketArchiveChains(enabledChains),
    marketArchiveIntervalMs: Math.min(15 * 60_000, Math.max(30_000, num("MARKET_ARCHIVE_INTERVAL_MS", 120_000))),
    marketArchiveFactoryLookbackBlocks: Math.min(100_000, Math.max(250, num("MARKET_ARCHIVE_FACTORY_LOOKBACK_BLOCKS", 5_000))),
    marketArchiveSwapLookbackBlocks: Math.min(100_000, Math.max(250, num("MARKET_ARCHIVE_SWAP_LOOKBACK_BLOCKS", 2_000))),
    marketArchiveHeadLagBlocks: Math.min(500, Math.max(0, num("MARKET_ARCHIVE_HEAD_LAG_BLOCKS", num("CONFIRMATIONS", 2)))),
    marketArchivePendingPoolTtlBlocks: Math.min(250_000, Math.max(500, num("MARKET_ARCHIVE_PENDING_POOL_TTL_BLOCKS", 43_200))),
    marketArchiveLogFilterConcurrency: Math.min(8, Math.max(1, num("MARKET_ARCHIVE_LOG_FILTER_CONCURRENCY", 3))),
    marketArchiveNormalizeConcurrency: Math.min(64, Math.max(1, num("MARKET_ARCHIVE_NORMALIZE_CONCURRENCY", 16))),
    marketArchiveFastTokenMetadata: bool("MARKET_ARCHIVE_FAST_TOKEN_METADATA", false),
    marketArchiveMaxPoolsPerTick: Math.min(10_000, Math.max(0, num("MARKET_ARCHIVE_MAX_POOLS_PER_TICK", 0))),
    marketArchiveMaxFactoryDiscoveries: Math.min(10_000, Math.max(1, num("MARKET_ARCHIVE_MAX_FACTORY_DISCOVERIES", 1_000))),
    marketArchiveChunkTradeLimit: Math.min(25_000, Math.max(500, num("MARKET_ARCHIVE_CHUNK_TRADE_LIMIT", num("MARKET_ARCHIVE_CHUNK_LOG_LIMIT", 5_000)))),
    walletPnlEnabled: bool("WALLET_PNL_ENABLED", false),
    walletPnlChain,
    walletPnlRetentionDays,
    walletPnlWindowHours,
    walletPnlPositionWindowHours,
    walletPnlAnalyticsWindowHours,
    walletPnlBootstrapHours: Math.min(walletPnlRetentionDays * 24, Math.max(1, num("WALLET_PNL_BOOTSTRAP_HOURS", walletPnlRetentionDays * 24))),
    walletPnlScanIntervalMs: Math.min(15 * 60_000, Math.max(30_000, num("WALLET_PNL_SCAN_INTERVAL_MS", 60_000))),
    walletPnlSnapshotIntervalMs: Math.min(60 * 60_000, Math.max(30_000, num("WALLET_PNL_SNAPSHOT_INTERVAL_MS", 5 * 60_000))),
    walletPnlAnalyticsIntervalMs: Math.min(60 * 60_000, Math.max(30_000, num("WALLET_PNL_ANALYTICS_INTERVAL_MS", 15 * 60_000))),
    walletPnlNewTokensIntervalMs: Math.min(60 * 60_000, Math.max(30_000, num("WALLET_PNL_NEW_TOKENS_INTERVAL_MS", 5 * 60_000))),
    walletPnlProfileRebuilds: bool("WALLET_PNL_PROFILE_REBUILDS", false),
    walletPnlHistoricalPrecomputeIntervalMs: Math.min(24 * 60 * 60_000, Math.max(0, num("WALLET_PNL_HISTORICAL_PRECOMPUTE_INTERVAL_MS", 60 * 60_000))),
    walletPnlHistoricalPrecomputeTokenLimit: Math.min(20, Math.max(0, Math.floor(num("WALLET_PNL_HISTORICAL_PRECOMPUTE_TOKEN_LIMIT", 2)))),
    walletPnlHistoricalPrecomputeWalletLimit: Math.min(50, Math.max(2, Math.floor(num("WALLET_PNL_HISTORICAL_PRECOMPUTE_WALLET_LIMIT", 25)))),
    walletPnlPostIntervalMs: Math.min(24 * 60 * 60_000, Math.max(5 * 60_000, num("WALLET_PNL_POST_INTERVAL_MS", 60 * 60_000))),
    walletPnlPostChatId: optionalNum("WALLET_PNL_POST_CHAT_ID"),
    walletPnlPostThreadId: optionalNum("WALLET_PNL_POST_THREAD_ID"),
    walletPnlMaxBlocksPerTick: Math.min(100_000, Math.max(100, num("WALLET_PNL_MAX_BLOCKS_PER_TICK", 1_000))),
    walletPnlMaxPoolsPerTick: Math.min(100_000, Math.max(0, num("WALLET_PNL_MAX_POOLS_PER_TICK", 0))),
    walletPnlBlockLookupConcurrency: Math.min(64, Math.max(1, num("WALLET_PNL_BLOCK_LOOKUP_CONCURRENCY", 8))),
    walletPnlTxLookupConcurrency: Math.min(64, Math.max(1, num("WALLET_PNL_TX_LOOKUP_CONCURRENCY", 16))),
    walletPnlMetadataTimeoutMs: Math.min(60_000, Math.max(1_000, num("WALLET_PNL_METADATA_TIMEOUT_MS", 10_000))),
    walletPnlTxLookupTimeoutMs: Math.min(60_000, Math.max(1_000, num("WALLET_PNL_TX_LOOKUP_TIMEOUT_MS", 15_000))),
    walletPnlHeadLagBlocks: Math.min(500, Math.max(0, num("WALLET_PNL_HEAD_LAG_BLOCKS", num("CONFIRMATIONS", 2)))),
    walletPnlSnapshotLimit: Math.min(1_000, Math.max(1, num("WALLET_PNL_SNAPSHOT_LIMIT", 1_000))),
    walletPnlMinProfitUsd: Math.max(0, num("WALLET_PNL_MIN_PROFIT_USD", 0)),
    walletPnlSeedPoolLimit: Math.min(500, Math.max(0, num("WALLET_PNL_SEED_POOL_LIMIT", 50))),
    walletPnlMaxFactoryDiscoveries: Math.min(10_000, Math.max(1, num("WALLET_PNL_MAX_FACTORY_DISCOVERIES", 1_000))),
    walletPnlMaxPostLagBlocks: Math.min(100_000, Math.max(0, num("WALLET_PNL_MAX_POST_LAG_BLOCKS", 3_600))),
    walletPnlActivePoolDiscoveryEnabled: bool("WALLET_PNL_ACTIVE_POOL_DISCOVERY_ENABLED", Boolean(process.env.BLOCKSCOUT_API_KEY?.trim())),
    walletPnlActivePoolDiscoveryMaxPools: Math.min(250, Math.max(1, Math.floor(num("WALLET_PNL_ACTIVE_POOL_DISCOVERY_MAX_POOLS", 25)))),
    walletPnlTokenBootstrapEnabled: bool("WALLET_PNL_TOKEN_BOOTSTRAP_ENABLED", Boolean(process.env.BLOCKSCOUT_API_KEY?.trim())),
    walletPnlTokenBootstrapDiscoveryDays: Math.min(365, Math.max(1, num("WALLET_PNL_TOKEN_BOOTSTRAP_DISCOVERY_DAYS", 30))),
    walletPnlTokenBootstrapReplayHours: Math.min(walletPnlRetentionDays * 24, Math.max(1, num("WALLET_PNL_TOKEN_BOOTSTRAP_REPLAY_HOURS", Math.max(24, walletPnlAnalyticsWindowHours)))),
    walletPnlTokenBootstrapMaxPools: Math.min(250, Math.max(1, Math.floor(num("WALLET_PNL_TOKEN_BOOTSTRAP_MAX_POOLS", 25)))),
    walletPnlTrustedV4Hooks: parseWalletPnlTrustedV4Hooks(),
    walletPnlDeniedTokenFactoryContracts: parseWalletPnlDeniedTokenFactoryContracts(),
    walletPnlGateChain,
    walletPnlGateTokenAddress,
    walletPnlGateMinBalance: decimalString("WALLET_PNL_GATE_MIN_BALANCE", "1"),
    walletPnlGateSessionHours: Math.min(24, Math.max(1, num("WALLET_PNL_GATE_SESSION_HOURS", 6))),
    copyShadowEnabled: bool("COPY_SHADOW_ENABLED", false),
    copyShadowChain: parseCopyShadowChain(),
    copyShadowWallets: parseCopyShadowWallets(),
    copyShadowIntervalMs: Math.min(15 * 60_000, Math.max(30_000, num("COPY_SHADOW_INTERVAL_MS", 60_000))),
    copyShadowTradeSizeUsd: Math.min(10_000, Math.max(1, num("COPY_SHADOW_TRADE_SIZE_USD", 25))),
    copyShadowMaxPositionUsd: Math.min(100_000, Math.max(1, num("COPY_SHADOW_MAX_POSITION_USD", 100))),
    copyShadowExecutionDelayBlocks: Math.min(10_000, Math.max(0, Math.floor(num("COPY_SHADOW_EXECUTION_DELAY_BLOCKS", 1)))),
    copyShadowMaxPriceLookaheadBlocks: Math.min(50_000, Math.max(1, Math.floor(num("COPY_SHADOW_MAX_PRICE_LOOKAHEAD_BLOCKS", 120)))),
    copyShadowSlippageBps: Math.min(9_000, Math.max(0, num("COPY_SHADOW_SLIPPAGE_BPS", 300))),
    copyShadowGasUsd: Math.min(100, Math.max(0, num("COPY_SHADOW_GAS_USD", 0.03))),
    copyShadowMinSourceVolumeUsd: Math.max(0, num("COPY_SHADOW_MIN_SOURCE_VOLUME_USD", 0)),
    copyShadowRecentSignalsLimit: Math.min(1_000, Math.max(10, Math.floor(num("COPY_SHADOW_RECENT_SIGNALS_LIMIT", 200)))),
    copyShadowPositionLimit: Math.min(1_000, Math.max(10, Math.floor(num("COPY_SHADOW_POSITION_LIMIT", 200)))),
    blockscoutApiKey: process.env.BLOCKSCOUT_API_KEY?.trim() || undefined,
    blockscoutApiBaseUrl: str("BLOCKSCOUT_API_BASE_URL", "https://api.blockscout.com/v2/api").replace(/\?+$/g, ""),
    blockscoutLogSource: parseBlockscoutLogSource(),
    blockscoutLogChunkSize: Math.min(100_000, Math.max(1, num("BLOCKSCOUT_LOG_CHUNK_SIZE", 5_000))),
    blockscoutMaxLogsPerRequest: Math.min(100_000, Math.max(1, num("BLOCKSCOUT_MAX_LOGS_PER_REQUEST", 1_000))),
    blockscoutMaxRequestsPerTick: Math.min(10_000, Math.max(1, num("BLOCKSCOUT_MAX_REQUESTS_PER_TICK", 200))),
    blockscoutRequestDelayMs: Math.min(10_000, Math.max(0, num("BLOCKSCOUT_REQUEST_DELAY_MS", 250))),
    r2AccountId: process.env.R2_ACCOUNT_ID?.trim() || undefined,
    r2AccessKeyId: process.env.R2_ACCESS_KEY_ID?.trim() || undefined,
    r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY?.trim() || undefined,
    r2Bucket: process.env.R2_BUCKET?.trim() || undefined,
    publicMarketApiBase: process.env.PUBLIC_MARKET_API_BASE?.trim().replace(/\/+$/g, "") || undefined
  };
}

function parseConfigAddress(value: string, name: string): Address {
  try {
    return getAddress(value.toLowerCase()) as Address;
  } catch (error) {
    throw new Error(`Invalid address for ${name}: ${value}`, { cause: error });
  }
}

function parseTelegramMode(): "polling" | "webhook" {
  const raw = str("TELEGRAM_MODE", "polling").toLowerCase();
  if (raw === "polling" || raw === "webhook") return raw;
  throw new Error(`Invalid TELEGRAM_MODE: ${raw}`);
}

function normalizePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "/telegram/webhook";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function inferPublicBaseUrl(): string | undefined {
  const explicit = process.env.PUBLIC_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/g, "");
  const railway = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  return railway ? `https://${railway.replace(/^https?:\/\//, "").replace(/\/+$/g, "")}` : undefined;
}
