import pino from "pino";
import { getChain, isChainSlug } from "../chains/registry";
import { backfillRpcProvidersEnvName, loadEnv } from "../config/env";
import { createAbortableJsonRpcProvider } from "../services/abortableRpcProvider";
import { createBackfillRpcPool } from "../services/backfillRpc";
import { BlockscoutClient } from "../services/blockscout";
import { MarketArchiveIndexer, type MarketArchiveBackfillProgress, type MarketArchiveBackfillSummary } from "../services/marketArchive";
import { PriceService } from "../services/price";
import { R2SnapshotStore } from "../services/r2Snapshots";
import { RpcPool } from "../services/rpcPool";
import { createStorage } from "../store/store";
import type { ChainSlug } from "../types";

interface ArchiveBackfillArgs {
  chains: ChainSlug[];
  days: number;
  fromBlock?: number;
  toBlock?: number;
  factoryStepBlocks?: number;
  swapStepBlocks?: number;
  maxPools?: number;
  resume: boolean;
  publishDerived: boolean;
}

const DEFAULT_CHAINS: ChainSlug[] = ["base", "ethereum"];
const BLOCKS_PER_DAY: Partial<Record<ChainSlug, number>> = {
  base: 43_200,
  ethereum: 7_200
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  seedScriptEnv(args);
  const env = loadEnv();
  const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
  const snapshotStore = R2SnapshotStore.fromEnv(env);
  if (!snapshotStore) {
    throw new Error("Archive backfill requires R2 credentials. Set MARKET_SNAPSHOTS_ENABLED=true plus R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET.");
  }

  const store = createStorage({
    backend: env.storageBackend,
    dataFile: env.dataFile,
    defaultBackfillBlocks: env.defaultBackfillBlocks
  });
  await store.load();

  const rpcs = new Map<ChainSlug, RpcPool>();
  try {
    for (const chain of args.chains) {
      const rpc = await createRpcForChain(env, chain, logger);
      rpcs.set(chain, rpc);
    }

    const priceService = new PriceService({ ethUsdOverride: env.ethUsdOverride, disableCoinGecko: env.disableCoinGecko, rpcs });
    const blockscoutClient = BlockscoutClient.fromEnv(env, logger);
    if (env.blockscoutLogSource !== "disabled" && !blockscoutClient) {
      logLine("Blockscout fallback requested but BLOCKSCOUT_API_KEY is not configured", { source: env.blockscoutLogSource });
    }
    const indexer = new MarketArchiveIndexer({ env, rpcs, store, snapshotStore, blockscoutClient, priceService, logger });
    const summaries: MarketArchiveBackfillSummary[] = [];

    for (const chain of args.chains) {
      const rpc = rpcs.get(chain);
      if (!rpc) throw new Error(`No RPC configured for ${chain}`);
      const plan = await backfillPlanForChain(args, chain, rpc, env.marketArchiveHeadLagBlocks);
      logLine("Starting archive backfill", {
        chain,
        fromBlock: plan.fromBlock,
        toBlock: plan.toBlock,
        days: args.fromBlock === undefined ? args.days : undefined,
        resume: args.resume,
        publishDerived: args.publishDerived
      });
      const summary = await indexer.runBackfillRange({
        chain,
        fromBlock: plan.fromBlock,
        toBlock: plan.toBlock,
        factoryStepBlocks: args.factoryStepBlocks,
        swapStepBlocks: args.swapStepBlocks,
        maxPools: args.maxPools ?? 0,
        resume: args.resume,
        publishDerived: args.publishDerived,
        onProgress: (progress) => logProgress(progress)
      });
      summaries.push(summary);
      logLine("Finished archive backfill", summary);
    }

    await store.save();
    logLine("Archive backfill complete", { chains: summaries.map((summary) => summary.chain), summaries });
  } finally {
    for (const rpc of rpcs.values()) rpc.destroy();
  }
}

async function createRpcForChain(env: ReturnType<typeof loadEnv>, chain: ChainSlug, logger: pino.Logger): Promise<RpcPool> {
  const chainConfig = getChain(chain);
  if (chainConfig.kind !== "evm" || !chainConfig.chainId) {
    throw new Error(`Archive backfill supports EVM chains only. Got ${chain}.`);
  }
  const backfillRpc = createBackfillRpcPool(env, chain, logger);
  const urls = env.rpcUrlsByChain[chain] ?? [];
  if (!backfillRpc && urls.length === 0) {
    throw new Error(`Missing RPC URL for ${chain}. Set ${chainConfig.rpcEnv} or ${backfillRpcProvidersEnvName(chain)}.`);
  }
  const rpc = backfillRpc ?? new RpcPool(
    urls.map((url) => createAbortableJsonRpcProvider(url, { name: chain, chainId: chainConfig.chainId! }, { staticNetwork: true })),
    logger,
    urls
  );
  const network = await rpc.getNetwork();
  if (Number(network.chainId) !== chainConfig.chainId) {
    rpc.destroy();
    throw new Error(`RPC is not ${chainConfig.name}. Expected ${chainConfig.chainId}, got ${network.chainId}.`);
  }
  logLine("RPC ready", { chain, providers: rpc.size(), strategy: backfillRpc ? "balanced-backfill" : "fallback" });
  return rpc;
}

async function backfillPlanForChain(
  args: ArchiveBackfillArgs,
  chain: ChainSlug,
  rpc: RpcPool,
  headLagBlocks: number
): Promise<{ fromBlock: number; toBlock: number }> {
  const latest = await rpc.getBlockNumber();
  const toBlock = args.toBlock ?? Math.max(0, latest - headLagBlocks);
  const fallbackBlocks = Math.ceil(args.days * (BLOCKS_PER_DAY[chain] ?? 7_200));
  const fromBlock = args.fromBlock ?? Math.max(0, toBlock - fallbackBlocks + 1);
  if (fromBlock > toBlock) throw new Error(`Invalid backfill range for ${chain}: fromBlock ${fromBlock} > toBlock ${toBlock}`);
  return { fromBlock, toBlock };
}

function parseArgs(argv: string[]): ArchiveBackfillArgs {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    process.exit(0);
  }
  const getValue = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  const chainRaw = getValue("--chain") ?? process.env.MARKET_ARCHIVE_BACKFILL_CHAIN ?? "base";
  const chains = parseChains(chainRaw);
  return {
    chains,
    days: boundedNumber(getValue("--days") ?? process.env.MARKET_ARCHIVE_BACKFILL_DAYS, 1, 60, 30),
    fromBlock: optionalBoundedInt(getValue("--from-block") ?? process.env.MARKET_ARCHIVE_BACKFILL_FROM_BLOCK, 0, Number.MAX_SAFE_INTEGER),
    toBlock: optionalBoundedInt(getValue("--to-block") ?? process.env.MARKET_ARCHIVE_BACKFILL_TO_BLOCK, 0, Number.MAX_SAFE_INTEGER),
    factoryStepBlocks: optionalBoundedInt(getValue("--factory-step-blocks") ?? process.env.MARKET_ARCHIVE_BACKFILL_FACTORY_STEP_BLOCKS, 1, 100_000),
    swapStepBlocks: optionalBoundedInt(getValue("--swap-step-blocks") ?? process.env.MARKET_ARCHIVE_BACKFILL_SWAP_STEP_BLOCKS, 1, 100_000),
    maxPools: optionalBoundedInt(getValue("--max-pools") ?? process.env.MARKET_ARCHIVE_BACKFILL_MAX_POOLS, 0, 100_000),
    resume: !argv.includes("--no-resume") && process.env.MARKET_ARCHIVE_BACKFILL_RESUME !== "false",
    publishDerived: !argv.includes("--skip-derived") && process.env.MARKET_ARCHIVE_BACKFILL_SKIP_DERIVED !== "true"
  };
}

function parseChains(raw: string): ChainSlug[] {
  const values = raw.toLowerCase() === "all" ? DEFAULT_CHAINS : raw.split(",").map((value) => value.trim()).filter(Boolean);
  const out: ChainSlug[] = [];
  for (const value of values) {
    if (!isChainSlug(value)) throw new Error(`Invalid archive backfill chain: ${value}`);
    const chain = getChain(value);
    if (chain.kind !== "evm") throw new Error(`Archive backfill supports EVM chains only. Got ${value}.`);
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

function seedScriptEnv(args: ArchiveBackfillArgs): void {
  const chains = args.chains.join(",");
  process.env.TELEGRAM_ENABLED ||= "false";
  process.env.PRIMARY_CHAIN ||= args.chains[0] ?? "base";
  process.env.ENABLED_CHAINS ||= chains;
  process.env.MARKETS_ENABLED = "true";
  process.env.MARKET_ARCHIVE_ENABLED ||= "true";
  process.env.MARKET_ARCHIVE_CHAINS ||= chains;
  process.env.MARKET_SNAPSHOTS_ENABLED ||= "true";
}

function logProgress(progress: MarketArchiveBackfillProgress): void {
  const { chain, stage, ...details } = progress;
  logLine(`Backfill ${stage}`, { chain, ...details });
}

function logLine(message: string, details?: unknown): void {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  // eslint-disable-next-line no-console
  console.log(`[${new Date().toISOString()}] ${message}${suffix}`);
}

function boundedNumber(raw: string | undefined, min: number, max: number, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function optionalBoundedInt(raw: string | undefined, min: number, max: number): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Invalid integer value: ${raw}`);
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(`Archive backfill to R2

Usage:
  npm run archive:backfill:dev -- --chain base --days 30
  npm run archive:backfill:dev -- --chain base,ethereum --from-block 29000000 --to-block 30300000

Options:
  --chain <base|ethereum|all|csv>       Chain(s) to backfill. Default: base
  --days <n>                           Lookback when --from-block is omitted. Default: 30
  --from-block <n>                     Explicit start block
  --to-block <n>                       Explicit end block, defaults to latest minus head lag
  --factory-step-blocks <n>            Factory discovery range size
  --swap-step-blocks <n>               Swap ingestion range size
  --max-pools <n>                      Limit tracked pools scanned; 0/all when omitted
  --no-resume                          Ignore stored archive cursors and replay the range
  --skip-derived                       Skip latest trending/new-pairs/detail snapshot publish
`);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(`[${new Date().toISOString()}] Archive backfill failed:`, error);
  process.exit(1);
});
