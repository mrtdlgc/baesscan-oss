import { Telegraf } from "telegraf";
import pino from "pino";
import type { Logger } from "pino";
import { loadEnv } from "./config/env";
import type { ChainSlug } from "./types";
import { getChain } from "./chains/registry";
import { createStorage } from "./store/store";
import { TokenService } from "./services/token";
import { PriceService } from "./services/price";
import { RpcPool } from "./services/rpcPool";
import { createAbortableJsonRpcProvider } from "./services/abortableRpcProvider";
import { registerCommands, installBotCommands } from "./bot/commands";
import { registerLifecycle } from "./bot/lifecycle";
import { SwapTracker } from "./dex/tracker";
import { startWebServer } from "./web/server";
import { SolanaRpcClient } from "./solana/activity";
import { R2SnapshotStore } from "./services/r2Snapshots";
import { MarketArchiveIndexer } from "./services/marketArchive";
import { BlockscoutClient } from "./services/blockscout";
import { createBackfillRpcPools } from "./services/backfillRpc";
import { WalletPnlIndexer } from "./services/walletPnl";
import { CopyShadowSimulator } from "./services/copyShadow";

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

  const rpcs = new Map<ChainSlug, RpcPool>();
  const tokenServices = new Map<ChainSlug, TokenService>();
  for (const chain of env.enabledChains) {
    const chainConfig = getChain(chain);
    if (chainConfig.kind !== "evm") continue;
    const urls = env.rpcUrlsByChain[chain] ?? [];
    if (urls.length === 0) continue;
    const providers = urls.map(
      (url) => createAbortableJsonRpcProvider(url, { name: chain, chainId: chainConfig.chainId! }, { staticNetwork: true })
    );
    const rpc = new RpcPool(providers, logger, urls);
    const chainId = Number((await rpc.getNetwork()).chainId);
    if (chainId !== chainConfig.chainId) {
      throw new Error(`RPC is not ${chainConfig.name}. Expected ${chainConfig.chainId}, got ${chainId}.`);
    }
    rpcs.set(chain, rpc);
    tokenServices.set(chain, new TokenService(rpc, chain));
    logger.info({ chain, providerCount: providers.length }, "rpc pool initialized");
  }
  const backfillRpcs = createBackfillRpcPools(env, logger);
  for (const [chain, rpc] of backfillRpcs) {
    logger.info({ chain, providerCount: rpc.size() }, "backfill rpc scheduler initialized");
  }
  const solanaClient = env.rpcUrlsByChain.solana?.length
    ? new SolanaRpcClient(env.rpcUrlsByChain.solana, logger)
    : undefined;
  const primaryRpc = rpcs.get(env.primaryChain) ?? rpcs.values().next().value;
  if (!primaryRpc && backfillRpcs.size === 0) {
    throw new Error("No EVM RPC configured. Set ENABLED_CHAINS and provide at least one supported *_RPC_URLS value.");
  }
  if (env.telegramEnabled && !primaryRpc) {
    throw new Error("Telegram runtime requires a live RPC URL. Set *_RPC_URLS for live bot scans, or set TELEGRAM_ENABLED=false for archive-only backfill.");
  }

  const store = createStorage({
    backend: env.storageBackend,
    dataFile: env.dataFile,
    defaultBackfillBlocks: env.defaultBackfillBlocks
  });
  await store.load();

  const priceService = new PriceService({ ethUsdOverride: env.ethUsdOverride, disableCoinGecko: env.disableCoinGecko, rpcs });
  const snapshotStore = R2SnapshotStore.fromEnv(env);
  if ((env.marketSnapshotsEnabled || env.marketArchiveEnabled) && !snapshotStore) {
    logger.warn("market snapshots/archive enabled but R2 credentials are incomplete; public snapshots/archive disabled");
  }
  const blockscoutClient = BlockscoutClient.fromEnv(env, logger);
  if (env.blockscoutLogSource !== "disabled" && !blockscoutClient) {
    logger.warn({ source: env.blockscoutLogSource }, "Blockscout log source requested but BLOCKSCOUT_API_KEY is not configured");
  }
  const archiveRpcs = new Map(rpcs);
  for (const [chain, rpc] of backfillRpcs) archiveRpcs.set(chain, rpc);
  const marketArchive = env.marketArchiveEnabled
    ? new MarketArchiveIndexer({ env, rpcs: archiveRpcs, store, snapshotStore, blockscoutClient, priceService, logger })
    : undefined;
  marketArchive?.start();
  let tracker: SwapTracker | undefined;
  let bot: Telegraf | undefined;
  let telegramWebhookPath: string | undefined;
  let telegramWebhook: ReturnType<Telegraf["webhookCallback"]> | undefined;
  let startTelegramRuntime: (() => { stop: (signal: string) => void }) | undefined;
  if (env.telegramEnabled) {
    const telegramBot = new Telegraf(env.telegramBotToken);
    bot = telegramBot;
    registerLifecycle(telegramBot, { env, store, logger });
    registerCommands(telegramBot, { rpc: primaryRpc, rpcs, store, tokenServices, solanaClient, priceService, env, logger });
    tracker = new SwapTracker(rpcs, telegramBot, store, tokenServices, priceService, env, logger, solanaClient);
    tracker.start();
    if (env.telegramMode === "webhook") {
      if (!env.webEnabled) throw new Error("TELEGRAM_MODE=webhook requires WEB_ENABLED=true");
      telegramWebhookPath = env.telegramWebhookPath;
      telegramWebhook = telegramBot.webhookCallback(env.telegramWebhookPath, { secretToken: env.telegramWebhookSecret });
      startTelegramRuntime = () => startTelegramWebhookWithRetry(telegramBot, env, logger, () => installBotCommands(telegramBot));
    } else {
      startTelegramRuntime = () => startTelegramPollingWithRetry(telegramBot, logger, () => installBotCommands(telegramBot));
    }
  } else {
    logger.warn("telegram disabled; bot polling/webhook and swap tracker are not started");
  }
  const walletPnl = env.walletPnlEnabled
    ? new WalletPnlIndexer({ env, rpcs: archiveRpcs, store, priceService, blockscoutClient, bot, logger })
    : undefined;
  walletPnl?.start();
  const copyShadow = new CopyShadowSimulator({ env, store, logger });
  copyShadow.start();
  const webServer = env.webEnabled
    ? startWebServer({ env, store, rpcs, solanaClient, priceService, snapshotStore, blockscoutClient, walletPnlIndexer: walletPnl, logger, telegramWebhookPath, telegramWebhook })
    : undefined;
  const telegramRuntime = startTelegramRuntime?.() ?? { stop: () => undefined };

  logger.info(
    {
      poolManagers: env.poolManagerAddresses,
      dataFile: env.dataFile,
      storage: env.storageBackend,
      publicMode: env.publicMode,
      telegramEnabled: env.telegramEnabled,
      telegramMode: env.telegramEnabled ? env.telegramMode : "disabled",
      marketsEnabled: env.marketsEnabled,
      maxChats: env.maxChats
    },
    "buybot runtime started"
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    telegramRuntime.stop(signal);
    tracker?.stop();
    marketArchive?.stop();
    walletPnl?.stop();
    copyShadow?.stop();
    await webServer?.stop();
    for (const rpc of new Set([...rpcs.values(), ...backfillRpcs.values()])) rpc.destroy();
    await store.save();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

function startTelegramWebhookWithRetry(
  bot: Telegraf,
  env: ReturnType<typeof loadEnv>,
  logger: Logger,
  installCommands: () => Promise<void>
): { stop: (signal: string) => void } {
  let stopped = false;
  let registered = false;
  let timer: NodeJS.Timeout | undefined;

  const retry = (attempt: number) => {
    if (stopped || registered) return;
    void register(attempt);
  };

  const scheduleRetry = (attempt: number) => {
    const delayMs = telegramLaunchRetryDelayMs(attempt);
    if (shouldLogTelegramAttempt(attempt)) {
      logger.warn({ attempt, retryInMs: delayMs }, "telegram webhook registration failed; retrying");
    } else {
      logger.debug({ attempt, retryInMs: delayMs }, "telegram webhook registration failed; retrying");
    }
    timer = setTimeout(() => retry(attempt + 1), delayMs);
  };

  const register = async (attempt: number) => {
    try {
      const webhookOptions: { drop_pending_updates: boolean; secret_token?: string } = { drop_pending_updates: false };
      if (env.telegramWebhookSecret) webhookOptions.secret_token = env.telegramWebhookSecret;
      await bot.telegram.setWebhook(env.telegramWebhookUrl!, webhookOptions);
      registered = true;
      logger.info({ attempt, path: env.telegramWebhookPath }, "telegram webhook registered");
      await installCommands().catch((error) => logger.warn({ error: (error as Error).message }, "failed to install Telegram commands"));
    } catch (error) {
      if (stopped) return;
      const maxAttempts = telegramLaunchMaxAttempts();
      if (shouldLogTelegramAttempt(attempt)) {
        logger.warn({ attempt, error: (error as Error).message }, "telegram webhook registration failed");
      } else {
        logger.debug({ attempt, error: (error as Error).message }, "telegram webhook registration failed");
      }
      if (maxAttempts > 0 && attempt >= maxAttempts) {
        logger.error({ attempt, maxAttempts }, "telegram webhook registration disabled after max attempts; web service remains online");
        return;
      }
      scheduleRetry(attempt);
    }
  };

  retry(1);

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    }
  };
}

function startTelegramPollingWithRetry(
  bot: Telegraf,
  logger: Logger,
  installCommands: () => Promise<void>
): { stop: (signal: string) => void } {
  let stopped = false;
  let launched = false;
  let timer: NodeJS.Timeout | undefined;

  const retry = (attempt: number) => {
    if (stopped || launched) return;
    void launch(attempt);
  };

  const scheduleRetry = (attempt: number) => {
    const delayMs = telegramLaunchRetryDelayMs(attempt);
    if (shouldLogTelegramAttempt(attempt)) {
      logger.warn({ attempt, retryInMs: delayMs }, "telegram launch failed; retrying");
    } else {
      logger.debug({ attempt, retryInMs: delayMs }, "telegram launch failed; retrying");
    }
    timer = setTimeout(() => retry(attempt + 1), delayMs);
  };

  const launch = async (attempt: number) => {
    try {
      await bot.launch();
      launched = true;
      logger.info({ attempt }, "telegram polling started");
      await installCommands().catch((error) => logger.warn({ error: (error as Error).message }, "failed to install Telegram commands"));
    } catch (error) {
      if (stopped) return;
      const maxAttempts = telegramLaunchMaxAttempts();
      if (shouldLogTelegramAttempt(attempt)) {
        logger.warn({ attempt, error: (error as Error).message }, "telegram polling launch failed");
      } else {
        logger.debug({ attempt, error: (error as Error).message }, "telegram polling launch failed");
      }
      if (maxAttempts > 0 && attempt >= maxAttempts) {
        logger.error({ attempt, maxAttempts }, "telegram polling launch disabled after max attempts; web service remains online");
        return;
      }
      scheduleRetry(attempt);
    }
  };

  retry(1);

  return {
    stop: (signal: string) => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (!launched) return;
      try {
        bot.stop(signal);
      } catch (error) {
        logger.warn({ error: (error as Error).message }, "telegram polling stop failed");
      }
    }
  };
}

function telegramLaunchRetryDelayMs(attempt: number): number {
  const raw = process.env.TELEGRAM_LAUNCH_RETRY_MS;
  const configured = raw && raw.trim() !== "" ? Number(raw) : undefined;
  const base = configured && Number.isFinite(configured) ? configured : 10_000;
  const cappedBase = Math.max(1_000, Math.min(120_000, Math.floor(base)));
  const multiplier = Math.min(6, Math.max(1, attempt));
  return Math.min(120_000, cappedBase * multiplier);
}

function telegramLaunchMaxAttempts(): number {
  const raw = process.env.TELEGRAM_LAUNCH_MAX_RETRIES;
  if (!raw || raw.trim() === "") return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

function shouldLogTelegramAttempt(attempt: number): boolean {
  return attempt <= 3 || attempt % 10 === 0;
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
