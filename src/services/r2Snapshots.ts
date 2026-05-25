import crypto from "node:crypto";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import type { Env } from "../config/env";
import type { MarketSummary, NewPairsPayload, TrendingMarketsPayload } from "../web/markets";
import type { ChainSlug, PoolKey, TokenMetadata } from "../types";
import type { TrackedMarketPoolRecord } from "../store/storage";

interface R2SnapshotConfig {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  prefix: string;
  cacheSeconds: number;
}

type R2RequestMethod = "GET" | "PUT" | "DELETE";

const R2_REQUEST_MAX_ATTEMPTS = 6;
const R2_RETRY_BASE_DELAY_MS = 500;
const R2_RETRY_MAX_DELAY_MS = 10_000;

export interface R2WriteResult {
  key: string;
  objectKey: string;
  uncompressedBytes: number;
  compressedBytes: number;
  cacheSeconds: number;
}

export interface R2ArchiveObject {
  key: string;
  objectKey: string;
  chain: string;
  poolId: string;
  pairLabel: string;
  compressedBytes: number;
  uncompressedBytes: number;
  generatedAt: string;
  firstBlock: number;
  lastBlock: number;
}

export interface R2ArchiveManifest {
  schemaVersion: 1;
  generatedAt: string;
  source: "raw-rpc";
  retentionDays: number;
  objectCount: number;
  poolCount: number;
  totalCompressedBytes: number;
  totalUncompressedBytes: number;
  objects: R2ArchiveObject[];
}

export interface MarketArchiveChunk {
  schemaVersion: 1;
  generatedAt: string;
  retainedForDays: number;
  chain: MarketSummary["chain"];
  poolId: string;
  poolAddress?: string;
  dex: string;
  protocol: string;
  pairLabel: string;
  baseToken: MarketSummary["baseToken"];
  quoteToken: MarketSummary["quoteToken"];
  price: number;
  priceUsd?: number;
  marketCapUsd?: number;
  fdvUsd?: number;
  volumeUsd?: number;
  quoteVolume?: number;
  swapCount: number;
  windowStats: MarketSummary["windowStats"];
  firstBlock: number;
  lastBlock: number;
  candles: MarketSummary["candles"];
  events: MarketSummary["events"];
}

export interface CompactSwapEvent {
  poolId: string;
  blockNumber: number;
  logIndex: number;
  txHash: string;
  address: string;
  topics: string[];
  data: string;
}

export interface ArchivedPoolInfo {
  poolId: string;
  pool: PoolKey;
  baseToken: TokenMetadata;
  quoteToken: TokenMetadata;
  quoteUsd?: number;
}

export interface ArchivedSwapTrade {
  poolId: string;
  blockNumber: number;
  logIndex: number;
  txHash: string;
  side: "buy" | "sell";
  price: number;
  priceUsd?: number;
  baseAmount: number;
  quoteAmount: number;
  volumeUsd?: number;
}

export interface SwapEventArchiveChunk {
  schemaVersion: 1;
  generatedAt: string;
  retainedForDays: number;
  source: "raw-rpc";
  chain: ChainSlug;
  fromBlock: number;
  toBlock: number;
  partIndex: number;
  partCount: number;
  eventCount: number;
  tradeCount: number;
  poolCount: number;
  pools: Record<string, ArchivedPoolInfo>;
  trades: ArchivedSwapTrade[];
  events: CompactSwapEvent[];
}

export interface R2SwapArchiveObject {
  key: string;
  objectKey: string;
  chain: ChainSlug;
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

export interface R2SwapArchiveManifest {
  schemaVersion: 1;
  generatedAt: string;
  source: "raw-rpc";
  retentionDays: number;
  objectCount: number;
  eventCount: number;
  tradeCount: number;
  totalCompressedBytes: number;
  totalUncompressedBytes: number;
  latestToBlock?: number;
  objects: R2SwapArchiveObject[];
}

export interface R2MarketPoolRegistry {
  schemaVersion: 1;
  generatedAt: string;
  source: "raw-rpc";
  chain: ChainSlug;
  poolCount: number;
  pools: TrackedMarketPoolRecord[];
}

export class R2SnapshotStore {
  private readonly endpoint: string;
  // Per-key fingerprint of the last payload we successfully PUT, so we skip duplicate writes.
  private readonly lastPublished = new Map<string, string>();

  constructor(private readonly config: R2SnapshotConfig) {
    this.endpoint = `https://${config.accountId}.r2.cloudflarestorage.com`;
  }

  static fromEnv(env: Env): R2SnapshotStore | undefined {
    if (!env.marketSnapshotsEnabled && !env.marketArchiveEnabled) return undefined;
    if (!env.r2AccountId || !env.r2AccessKeyId || !env.r2SecretAccessKey || !env.r2Bucket) return undefined;
    return new R2SnapshotStore({
      accountId: env.r2AccountId,
      accessKeyId: env.r2AccessKeyId,
      secretAccessKey: env.r2SecretAccessKey,
      bucket: env.r2Bucket,
      prefix: env.marketSnapshotPrefix,
      cacheSeconds: env.marketSnapshotCacheSeconds
    });
  }

  async publishTrending(payload: TrendingMarketsPayload): Promise<R2WriteResult[]> {
    const latest = await this.putJson(`${payload.chain}/trending/latest.json.br`, payload, payload.cacheMs);
    const markets = await Promise.all(payload.markets.map((market) => this.publishMarket(market)));
    return [latest, ...markets];
  }

  async publishNewPairs(payload: NewPairsPayload): Promise<R2WriteResult[]> {
    return [await this.putJson(`${payload.chain}/new-pairs/latest.json.br`, payload, payload.cacheMs)];
  }

  async publishMarket(market: MarketSummary): Promise<R2WriteResult> {
    const key = `${market.chain}/pools/${encodeKeyPart(market.poolId)}/market/latest.json.br`;
    return this.putJson(key, { chain: market.chain, source: "r2-snapshot", market }, 8_000);
  }

  async getTrendingSnapshot(chain: ChainSlug): Promise<TrendingMarketsPayload | undefined> {
    return this.getJson<TrendingMarketsPayload>(`${chain}/trending/latest.json.br`);
  }

  async getNewPairsSnapshot(chain: ChainSlug): Promise<NewPairsPayload | undefined> {
    return this.getJson<NewPairsPayload>(`${chain}/new-pairs/latest.json.br`);
  }

  async getMarketSnapshot(chain: ChainSlug, poolId: string): Promise<MarketSummary | undefined> {
    const payload = await this.getJson<{ chain: ChainSlug; source: string; market?: MarketSummary }>(
      `${chain}/pools/${encodeKeyPart(poolId)}/market/latest.json.br`
    );
    return payload?.market;
  }

  async publishMarketHistory(market: MarketSummary, generatedAt: Date, retentionDays: number): Promise<R2ArchiveObject> {
    const stamp = archiveStamp(generatedAt);
    const key = `${market.chain}/pools/${encodeKeyPart(market.poolId)}/history/${stamp}.json.br`;
    const chunk = createMarketArchiveChunk(market, generatedAt, retentionDays);
    const write = await this.putJson(key, chunk, retentionDays * 24 * 60 * 60 * 1000);
    return {
      key: write.key,
      objectKey: write.objectKey,
      chain: market.chain,
      poolId: market.poolId,
      pairLabel: market.pairLabel,
      compressedBytes: write.compressedBytes,
      uncompressedBytes: write.uncompressedBytes,
      generatedAt: generatedAt.toISOString(),
      firstBlock: market.firstBlock,
      lastBlock: market.lastBlock
    };
  }

  async publishArchiveManifest(manifest: R2ArchiveManifest, chain?: string): Promise<R2WriteResult> {
    const resolvedChain = chain ?? manifest.objects[0]?.chain;
    if (!resolvedChain) {
      throw new Error("publishArchiveManifest requires a chain (pass it explicitly or include objects).");
    }
    return this.putJson(`${resolvedChain}/archive/latest-manifest.json.br`, manifest, 60_000);
  }

  async publishSwapEventChunk(chunk: SwapEventArchiveChunk): Promise<R2SwapArchiveObject> {
    const key = swapEventChunkKey(chunk);
    const write = await this.putJson(key, chunk, chunk.retainedForDays * 24 * 60 * 60 * 1000);
    return {
      key: write.key,
      objectKey: write.objectKey,
      chain: chunk.chain,
      fromBlock: chunk.fromBlock,
      toBlock: chunk.toBlock,
      partIndex: chunk.partIndex,
      partCount: chunk.partCount,
      eventCount: chunk.eventCount,
      tradeCount: chunk.tradeCount,
      poolCount: chunk.poolCount,
      compressedBytes: write.compressedBytes,
      uncompressedBytes: write.uncompressedBytes,
      generatedAt: chunk.generatedAt
    };
  }

  async publishSwapArchiveManifest(manifest: R2SwapArchiveManifest, chain?: ChainSlug): Promise<R2WriteResult> {
    const resolvedChain = chain ?? manifest.objects[0]?.chain;
    if (!resolvedChain) {
      throw new Error("publishSwapArchiveManifest requires a chain (pass it explicitly or include objects).");
    }
    return this.putJson(`${resolvedChain}/swaps/latest-manifest.json.br`, manifest, 60_000);
  }

  async publishMarketPoolRegistry(registry: R2MarketPoolRegistry): Promise<R2WriteResult> {
    return this.putJson(`${registry.chain}/pools/latest-registry.json.br`, registry, 60_000);
  }

  async getMarketPoolRegistry(chain: ChainSlug): Promise<R2MarketPoolRegistry | undefined> {
    return this.getJson<R2MarketPoolRegistry>(`${chain}/pools/latest-registry.json.br`);
  }

  async getJson<T>(key: string): Promise<T | undefined> {
    return this.getJsonByObjectKey(`${this.config.prefix}/${key}`);
  }

  async getJsonByObjectKey<T>(objectKey: string): Promise<T | undefined> {
    const body = Buffer.alloc(0);
    const headers: Record<string, string> = {
      "x-amz-content-sha256": sha256Hex(body)
    };
    const response = await this.signedFetch("GET", objectKey, headers, body);
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(`R2 snapshot read failed ${response.status}: ${await response.text()}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    return JSON.parse(decodeJsonBuffer(buffer)) as T;
  }

  async getSwapArchiveManifest(chain: ChainSlug): Promise<R2SwapArchiveManifest | undefined> {
    return this.getJson<R2SwapArchiveManifest>(`${chain}/swaps/latest-manifest.json.br`);
  }

  async getSwapEventChunk(objectKey: string): Promise<SwapEventArchiveChunk | undefined> {
    return this.getJsonByObjectKey<SwapEventArchiveChunk>(objectKey);
  }

  async deleteObjectByKey(objectKey: string): Promise<boolean> {
    const body = Buffer.alloc(0);
    const headers: Record<string, string> = {
      "x-amz-content-sha256": sha256Hex(body)
    };
    const response = await this.signedFetch("DELETE", objectKey, headers, body);
    if (response.status === 404) return false;
    if (!response.ok && response.status !== 204) {
      throw new Error(`R2 snapshot delete failed ${response.status}: ${await response.text()}`);
    }
    this.lastPublished.delete(objectKey);
    return true;
  }

  static measureJson(payload: unknown): Pick<R2WriteResult, "uncompressedBytes" | "compressedBytes"> {
    const raw = Buffer.from(JSON.stringify(payload));
    const body = brotliCompressSync(raw);
    return { uncompressedBytes: raw.byteLength, compressedBytes: body.byteLength };
  }

  private async putJson(key: string, payload: unknown, cacheMs: number): Promise<R2WriteResult> {
    const raw = Buffer.from(JSON.stringify(payload));
    const body = brotliCompressSync(raw);
    const objectKey = `${this.config.prefix}/${key}`;
    const plainObjectKey = plainJsonAliasObjectKey(objectKey);
    const cacheSeconds = Math.max(5, Math.floor(Math.min(cacheMs, this.config.cacheSeconds * 1000) / 1000));
    const fingerprint = sha256Hex(raw);
    if (this.lastPublished.get(objectKey) !== fingerprint) {
      const headers: Record<string, string> = {
        "cache-control": `public, max-age=${cacheSeconds}`,
        "content-encoding": "br",
        "content-type": "application/json; charset=utf-8",
        "x-amz-content-sha256": sha256Hex(body)
      };
      const response = await this.signedFetch("PUT", objectKey, headers, body);
      if (!response.ok) {
        throw new Error(`R2 snapshot write failed ${response.status}: ${await response.text()}`);
      }
      this.lastPublished.set(objectKey, fingerprint);
    }
    if (plainObjectKey && this.lastPublished.get(plainObjectKey) !== fingerprint) {
      const headers: Record<string, string> = {
        "cache-control": `public, max-age=${cacheSeconds}`,
        "content-type": "application/json; charset=utf-8",
        "x-amz-content-sha256": fingerprint
      };
      const response = await this.signedFetch("PUT", plainObjectKey, headers, raw);
      if (!response.ok) {
        throw new Error(`R2 snapshot plain alias write failed ${response.status}: ${await response.text()}`);
      }
      this.lastPublished.set(plainObjectKey, fingerprint);
    }
    return {
      key,
      objectKey,
      uncompressedBytes: raw.byteLength,
      compressedBytes: body.byteLength,
      cacheSeconds
    };
  }

  private async signedFetch(
    method: R2RequestMethod,
    objectKey: string,
    headers: Record<string, string>,
    body: Buffer
  ): Promise<Response> {
    const url = new URL(`${this.endpoint}/${this.config.bucket}/${encodePath(objectKey)}`);
    let lastError: unknown;

    for (let attempt = 1; attempt <= R2_REQUEST_MAX_ATTEMPTS; attempt++) {
      const requestHeaders = { ...headers, "x-amz-date": amzDate(new Date()) };
      const authorization = signRequest(method, url, requestHeaders, body, this.config);
      try {
        const response = await fetch(url, {
          method,
          headers: { ...requestHeaders, authorization },
          body: method === "PUT" ? (body as unknown as BodyInit) : undefined
        });
        if (!isRetryableR2Status(response.status) || attempt === R2_REQUEST_MAX_ATTEMPTS) return response;

        const detail = await response.text().catch(() => response.statusText);
        warnR2Retry(method, objectKey, attempt, response.status, detail);
        await sleep(retryDelayMs(attempt, response));
      } catch (error) {
        lastError = error;
        if (attempt === R2_REQUEST_MAX_ATTEMPTS) break;
        warnR2Retry(method, objectKey, attempt, undefined, formatError(error));
        await sleep(retryDelayMs(attempt));
      }
    }

    throw new Error(
      `R2 snapshot ${method} request failed after ${R2_REQUEST_MAX_ATTEMPTS} attempts for ${objectKey}: ${formatError(lastError)}`
    );
  }
}

function plainJsonAliasObjectKey(objectKey: string): string | undefined {
  if (!objectKey.endsWith(".json.br")) return undefined;
  if (
    objectKey.endsWith("/trending/latest.json.br") ||
    objectKey.endsWith("/new-pairs/latest.json.br") ||
    objectKey.endsWith("/market/latest.json.br") ||
    objectKey.endsWith("/archive/latest-manifest.json.br") ||
    objectKey.endsWith("/swaps/latest-manifest.json.br")
  ) {
    return objectKey.slice(0, -3);
  }
  return undefined;
}

function isRetryableR2Status(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function retryDelayMs(attempt: number, response?: Response): number {
  const retryAfter = parseRetryAfterMs(response?.headers.get("retry-after"));
  const exponential = Math.min(R2_RETRY_MAX_DELAY_MS, R2_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * 250);
  return Math.max(retryAfter ?? 0, exponential + jitter);
}

function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

function warnR2Retry(method: R2RequestMethod, objectKey: string, attempt: number, status: number | undefined, detail: string): void {
  const statusLabel = status === undefined ? "network error" : `HTTP ${status}`;
  console.warn(
    `[r2] ${method} ${objectKey} failed with ${statusLabel}; retrying attempt ${attempt + 1}/${R2_REQUEST_MAX_ATTEMPTS}: ${trimForLog(detail)}`
  );
}

function trimForLog(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 300 ? `${normalized.slice(0, 300)}...` : normalized;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signRequest(method: string, url: URL, headers: Record<string, string>, body: Buffer, config: R2SnapshotConfig): string {
  const signedHeaders = Object.keys(headers)
    .concat("host")
    .map((header) => header.toLowerCase())
    .sort();
  const allHeaders: Record<string, string> = { ...headers, host: url.host };
  const canonicalHeaders = signedHeaders.map((header) => `${header}:${allHeaders[header]?.trim() ?? ""}\n`).join("");
  const canonicalRequest = [
    method,
    url.pathname,
    url.searchParams.toString(),
    canonicalHeaders,
    signedHeaders.join(";"),
    sha256Hex(body)
  ].join("\n");
  const date = headers["x-amz-date"]!.slice(0, 8);
  const scope = `${date}/auto/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", headers["x-amz-date"], scope, sha256Hex(Buffer.from(canonicalRequest))].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(Buffer.from(`AWS4${config.secretAccessKey}`), date), "auto"), "s3"), "aws4_request");
  const signature = hmac(signingKey, stringToSign).toString("hex");
  return `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(";")}, Signature=${signature}`;
}

function encodePath(value: string): string {
  return value
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function encodeKeyPart(value: string): string {
  return encodeURIComponent(value.toLowerCase()).replace(/%/g, "~");
}

function decodeJsonBuffer(buffer: Buffer): string {
  try {
    return brotliDecompressSync(buffer).toString("utf8");
  } catch {
    return buffer.toString("utf8");
  }
}

export function createMarketArchiveChunk(market: MarketSummary, generatedAt: Date, retentionDays: number): MarketArchiveChunk {
  return {
    schemaVersion: 1,
    generatedAt: generatedAt.toISOString(),
    retainedForDays: retentionDays,
    chain: market.chain,
    poolId: market.poolId,
    poolAddress: market.poolAddress,
    dex: market.dex,
    protocol: market.protocol,
    pairLabel: market.pairLabel,
    baseToken: market.baseToken,
    quoteToken: market.quoteToken,
    price: market.price,
    priceUsd: market.priceUsd,
    marketCapUsd: market.marketCapUsd,
    fdvUsd: market.fdvUsd,
    volumeUsd: market.volumeUsd,
    quoteVolume: market.quoteVolume,
    swapCount: market.swapCount,
    windowStats: market.windowStats,
    firstBlock: market.firstBlock,
    lastBlock: market.lastBlock,
    candles: market.candles,
    events: market.events
  };
}

function archiveStamp(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 4)}/${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(11, 13)}-${iso.slice(14, 16)}-${iso.slice(17, 19)}`;
}

function swapEventChunkKey(chunk: SwapEventArchiveChunk): string {
  const range = `${padBlock(chunk.fromBlock)}-${padBlock(chunk.toBlock)}`;
  if (chunk.partCount > 1) {
    return `${chunk.chain}/swaps/blocks/${range}/part-${String(chunk.partIndex).padStart(4, "0")}.json.br`;
  }
  return `${chunk.chain}/swaps/blocks/${range}.json.br`;
}

function padBlock(block: number): string {
  return String(Math.max(0, Math.floor(block))).padStart(12, "0");
}

function sha256Hex(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return crypto.createHmac("sha256", key).update(value).digest();
}

function amzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}
