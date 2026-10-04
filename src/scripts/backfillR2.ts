import pino from "pino";
import { getChain, isChainSlug } from "../chains/registry";
import { backfillRpcProvidersEnvName, loadEnv } from "../config/env";
import { createBackfillRpcPool } from "../services/backfillRpc";
import { createAbortableJsonRpcProvider } from "../services/abortableRpcProvider";
import { PriceService } from "../services/price";
import { DexscreenerClient } from "../services/dexscreener";
import { R2SnapshotStore, createMarketArchiveChunk } from "../services/r2Snapshots";
import type { R2ArchiveManifest, R2ArchiveObject } from "../services/r2Snapshots";
import { RpcPool } from "../services/rpcPool";
import type { ChainSlug } from "../types";
import { getNewPairs, getTrendingMarkets } from "../web/markets";

interface BackfillArgs {
  chain: ChainSlug;
  dryRun: boolean;
  lookbackBlocks: number;
  maxPools: number;
  timeoutMs: number;
}

interface EstimatedWrite {
  key: string;
  objectKey: string;
  compressedBytes: number;
  uncompressedBytes: number;
}

const DEFAULT_BASE_RPC = "https://mainnet.base.org";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  seedScriptEnv(args);

  const env = loadEnv();
  const logger = pino({ level: process.env.LOG_LEVEL ?? "warn" });
  const chainConfig = getChain(args.chain);
  if (chainConfig.kind !== "evm" || !chainConfig.chainId) throw new Error(`R2 backfill currently supports EVM chains only. Got ${args.chain}.`);

  const urls = env.rpcUrlsByChain[args.chain] ?? [];
  const backfillRpc = createBackfillRpcPool(env, args.chain, logger);
  if (!backfillRpc && urls.length === 0) throw new Error(`Missing RPC URL for ${args.chain}. Set ${chainConfig.rpcEnv} or ${backfillRpcProvidersEnvName(args.chain)}.`);

  const rpc = backfillRpc ?? new RpcPool(
    urls.map((url) => createAbortableJsonRpcProvider(url, { name: args.chain, chainId: chainConfig.chainId }, { staticNetwork: true })),
    logger,
    urls
  );
  const rpcs = new Map<ChainSlug, RpcPool>([[args.chain, rpc]]);
  const priceService = new PriceService({
    ethUsdOverride: env.ethUsdOverride,
    disableCoinGecko: env.disableCoinGecko,
    rpcs,
    dexscreener: new DexscreenerClient({ enabled: !env.disableDexscreener })
  });
  const generatedAt = new Date();
  const retentionDays = env.marketHistoryRetentionDays;

  try {
    const network = await withTimeout(rpc.getNetwork(), args.timeoutMs, "rpc network check", () => rpc.cancelInflight());
    if (Number(network.chainId) !== chainConfig.chainId) {
      throw new Error(`RPC is not ${chainConfig.name}. Expected ${chainConfig.chainId}, got ${network.chainId}.`);
    }

    const trending = await withTimeout(getTrendingMarkets({ env, rpcs, priceService }, args.chain), args.timeoutMs, "trending raw-rpc scan", () => rpc.cancelInflight());
    const newPairs = await withTimeout(getNewPairs({ env, rpcs, priceService }, args.chain), args.timeoutMs, "new-pairs raw-rpc scan", () => rpc.cancelInflight());

    if (args.dryRun) {
      const estimates = estimateWrites(env.marketSnapshotPrefix, trending, newPairs, generatedAt, retentionDays);
      const totals = summarizeEstimates(estimates);
      const report = {
        mode: "dry-run",
        chain: args.chain,
        generatedAt: generatedAt.toISOString(),
        retentionDays,
        lookbackBlocks: args.lookbackBlocks,
        maxPools: args.maxPools,
        markets: trending.markets.length,
        newPairs: newPairs.pairs.length,
        objectCount: estimates.length,
        totalCompressedBytes: totals.compressedBytes,
        totalUncompressedBytes: totals.uncompressedBytes,
        estimatedRetentionCompressedBytesAt2Min: totals.compressedBytes * 30 * 24 * retentionDays,
        estimatedRetentionUncompressedBytesAt2Min: totals.uncompressedBytes * 30 * 24 * retentionDays,
        largestObjects: estimates
          .slice()
          .sort((a, b) => b.compressedBytes - a.compressedBytes)
          .slice(0, 8)
      };
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    const store = R2SnapshotStore.fromEnv(env);
    if (!store) throw new Error("R2 credentials are incomplete. Set MARKET_SNAPSHOTS_ENABLED=true plus R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET, or run with --dry-run.");

    const latestWrites = [
      ...(await store.publishTrending(trending)),
      ...(await store.publishNewPairs(newPairs))
    ];
    const archiveObjects: R2ArchiveObject[] = [];
    for (const market of trending.markets) {
      archiveObjects.push(await store.publishMarketHistory(market, generatedAt, retentionDays));
    }
    const manifest = buildManifest(generatedAt, retentionDays, archiveObjects);
    const manifestWrite = await store.publishArchiveManifest(manifest, args.chain);
    const allWrites = [...latestWrites, ...archiveObjects, manifestWrite];
    const totalCompressedBytes = allWrites.reduce((sum, item) => sum + item.compressedBytes, 0);
    const totalUncompressedBytes = allWrites.reduce((sum, item) => sum + item.uncompressedBytes, 0);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      mode: "write",
      chain: args.chain,
      generatedAt: generatedAt.toISOString(),
      retentionDays,
      markets: trending.markets.length,
      newPairs: newPairs.pairs.length,
      objectCount: allWrites.length,
      totalCompressedBytes,
      totalUncompressedBytes,
      manifestKey: manifestWrite.objectKey
    }, null, 2));
  } finally {
    rpc.destroy();
  }
}

function parseArgs(argv: string[]): BackfillArgs {
  const getValue = (name: string, fallback: string): string => {
    const index = argv.indexOf(name);
    if (index === -1) return fallback;
    return argv[index + 1] ?? fallback;
  };
  const chain = getValue("--chain", process.env.MARKET_BACKFILL_CHAIN ?? "base").toLowerCase();
  if (!isChainSlug(chain)) throw new Error(`Invalid backfill chain: ${chain}`);
  const explicitWrite = argv.includes("--write");
  const dryRun = argv.includes("--dry-run") || process.env.MARKET_BACKFILL_DRY_RUN === "true" || !explicitWrite;
  return {
    chain,
    dryRun,
    lookbackBlocks: boundedInt(getValue("--lookback-blocks", process.env.MARKET_BACKFILL_LOOKBACK_BLOCKS ?? "2400"), 250, 10_000),
    maxPools: boundedInt(getValue("--max-pools", process.env.MARKET_BACKFILL_MAX_POOLS ?? "12"), 1, 32),
    timeoutMs: boundedInt(getValue("--timeout-ms", process.env.MARKET_BACKFILL_TIMEOUT_MS ?? "110000"), 10_000, 120_000)
  };
}

function seedScriptEnv(args: BackfillArgs): void {
  process.env.TELEGRAM_BOT_TOKEN ||= "r2-backfill-local";
  process.env.PRIMARY_CHAIN ||= args.chain;
  process.env.ENABLED_CHAINS ||= args.chain;
  process.env.TRENDING_LOOKBACK_BLOCKS = String(args.lookbackBlocks);
  process.env.TRENDING_MAX_POOLS = String(args.maxPools);
  process.env.NEW_PAIRS_MAX_POOLS ||= String(Math.min(24, Math.max(args.maxPools, 12)));
  process.env.NEW_PAIRS_LOOKBACK_BLOCKS ||= String(Math.max(args.lookbackBlocks, 3600));
  process.env.MARKET_DETAIL_LOOKBACK_BLOCKS ||= String(Math.min(3600, args.lookbackBlocks));
  process.env.MARKET_HISTORY_RETENTION_DAYS ||= "30";
  if (!process.env.BASE_RPC_URL && !process.env.BASE_RPC_URLS && !process.env.BASE_BACKFILL_RPC_PROVIDERS && args.chain === "base") {
    process.env.BASE_RPC_URLS = DEFAULT_BASE_RPC;
  }
  const hasR2Creds = Boolean(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET);
  if (hasR2Creds) {
    process.env.MARKETS_ENABLED = "true";
    process.env.MARKET_SNAPSHOTS_ENABLED ||= "true";
  }
}

function estimateWrites(
  prefix: string,
  trending: Awaited<ReturnType<typeof getTrendingMarkets>>,
  newPairs: Awaited<ReturnType<typeof getNewPairs>>,
  generatedAt: Date,
  retentionDays: number
): EstimatedWrite[] {
  const estimates: EstimatedWrite[] = [];
  const add = (key: string, payload: unknown): void => {
    const measured = R2SnapshotStore.measureJson(payload);
    estimates.push({ key, objectKey: `${prefix}/${key}`, ...measured });
  };

  add(`${trending.chain}/trending/latest.json.br`, trending);
  for (const market of trending.markets) {
    add(`${market.chain}/pools/${encodeKeyPart(market.poolId)}/market/latest.json.br`, { chain: market.chain, source: "r2-snapshot", market });
    add(`${market.chain}/pools/${encodeKeyPart(market.poolId)}/history/${archiveStamp(generatedAt)}.json.br`, createMarketArchiveChunk(market, generatedAt, retentionDays));
  }
  add(`${newPairs.chain}/new-pairs/latest.json.br`, newPairs);
  const archiveObjects = trending.markets.map((market) => {
    const key = `${market.chain}/pools/${encodeKeyPart(market.poolId)}/history/${archiveStamp(generatedAt)}.json.br`;
    const measured = R2SnapshotStore.measureJson(createMarketArchiveChunk(market, generatedAt, retentionDays));
    return {
      key,
      objectKey: `${prefix}/${key}`,
      chain: market.chain,
      poolId: market.poolId,
      pairLabel: market.pairLabel,
      compressedBytes: measured.compressedBytes,
      uncompressedBytes: measured.uncompressedBytes,
      generatedAt: generatedAt.toISOString(),
      firstBlock: market.firstBlock,
      lastBlock: market.lastBlock
    };
  });
  add(`${trending.chain}/archive/latest-manifest.json.br`, buildManifest(generatedAt, retentionDays, archiveObjects));
  return estimates;
}

function buildManifest(generatedAt: Date, retentionDays: number, objects: R2ArchiveObject[]): R2ArchiveManifest {
  return {
    schemaVersion: 1,
    generatedAt: generatedAt.toISOString(),
    source: "raw-rpc",
    retentionDays,
    objectCount: objects.length,
    poolCount: objects.length,
    totalCompressedBytes: objects.reduce((sum, item) => sum + item.compressedBytes, 0),
    totalUncompressedBytes: objects.reduce((sum, item) => sum + item.uncompressedBytes, 0),
    objects
  };
}

function summarizeEstimates(estimates: EstimatedWrite[]): { compressedBytes: number; uncompressedBytes: number } {
  return {
    compressedBytes: estimates.reduce((sum, item) => sum + item.compressedBytes, 0),
    uncompressedBytes: estimates.reduce((sum, item) => sum + item.uncompressedBytes, 0)
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => number
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        const cancelled = onTimeout?.() ?? 0;
        const suffix = cancelled > 0 ? `; cancelled ${cancelled} inflight request${cancelled === 1 ? "" : "s"}` : "";
        reject(new Error(`${label} timed out after ${timeoutMs}ms${suffix}`));
      }, timeoutMs);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function boundedInt(raw: string, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function encodeKeyPart(value: string): string {
  return encodeURIComponent(value.toLowerCase()).replace(/%/g, "~");
}

function archiveStamp(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 4)}/${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(11, 13)}-${iso.slice(14, 16)}-${iso.slice(17, 19)}`;
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
