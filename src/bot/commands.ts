import { Markup, type Context, type Telegraf } from "telegraf";
import { isAddress } from "ethers";
import type { Address, BuyEvent, ChainSlug, ChatState } from "../types";
import { adminOnly, chatGate, isAdmin, isOwner, ownerOnly } from "./admin";
import { OWNER_COMMANDS } from "./ownerCommands";
import {
  HELP_TEXT,
  backfillKeyboard,
  backfillMenuText,
  emojiMenuText,
  emojiKeyboard,
  emojiStepKeyboard,
  emojiStepMenuText,
  mediaInstructionsText,
  mediaKeyboard,
  maxEmojisKeyboard,
  maxEmojisMenuText,
  minQuoteKeyboard,
  minQuoteMenuText,
  minUsdKeyboard,
  minUsdMenuText,
  poolsSummary,
  sendBuyNotification,
  settingsKeyboard,
  settingsSummary,
  topicKeyboard,
  topicMenuText,
  welcomeText,
  EMOJI_PRESETS,
  BACKFILL_PRESETS,
  EMOJI_STEP_PRESETS,
  MAX_EMOJI_PRESETS,
  MIN_QUOTE_PRESETS,
  MIN_USD_PRESETS
} from "./messages";
import { getOtherCurrency, manualPoolKey } from "../dex/uniswap";
import { discoverPools } from "../dex/discovery";
import { normalizeAddress, shortHex } from "../utils/address";
import { formatTokenAmount } from "../utils/format";
import { formatWalletPnlSnapshot } from "../services/walletPnl";
import { getChain, isChainSlug, PUBLIC_CHAIN_SLUGS } from "../chains/registry";
import {
  isTrackingActive,
  notifyOwnersAboutTrackingStarted,
  resolveOwnerChatSummary,
  type OwnerChatSummary
} from "./ownerAlerts";
import {
  SOLANA_DISABLED_MESSAGE,
  applySetting,
  assertSupportedUserChain,
  assertCanTrackToken,
  chatTitle,
  createProgressReporter,
  effectiveDexes,
  effectiveProtocols,
  isPoolCurrency,
  parseOptionalChain,
  parsePoolIdentifierArg,
  parseWatchArgs,
  poolMatchesSelection,
  rangeLimitNote,
  replyLong,
  resolveHookDiscoveryFilter,
  scanRange,
  selectionLabel,
  tenPow
} from "./commandHelpers";
import type { CommandDeps } from "./commands/types";
import { argsOf, configuredRpcChains, evmRpcScanSection, evmRuntime } from "./commands/runtime";
import { addPoolByAddress, addPoolById, isCurrentTrackedChat } from "./commands/poolActions";
export { installBotCommands } from "./commands/install";

type CustomSettingKey =
  | "minusd"
  | "minquote"
  | "emoji"
  | "emojistep"
  | "maxemojis"
  | "media"
  | "mediaupload"
  | "topic"
  | "backfill";

type GuidedSetupState =
  | { flow: "watch"; step: "token"; chain: ChainSlug }
  | { flow: "watch"; step: "block"; chain: ChainSlug; token: Address }
  | { flow: "pool"; step: "pool"; chain: ChainSlug }
  | { flow: "pool"; step: "target"; chain: ChainSlug; poolAddress: Address };

export function registerCommands(bot: Telegraf, deps: CommandDeps): void {
  bot.use(chatGate(deps.env, deps.store));

  bot.use(async (ctx, next) => {
    const text = ctx.message && "text" in ctx.message ? ctx.message.text : undefined;
    if (text && text.startsWith("/")) {
      const command = text.split(/\s+/)[0]?.split("@")[0];
      deps.logger.info(
        {
          command,
          chatId: ctx.chat?.id,
          chatType: ctx.chat?.type,
          chatTitle: ctx.chat && "title" in ctx.chat ? ctx.chat.title : undefined,
          userId: ctx.from?.id,
          username: ctx.from?.username
        },
        "command received"
      );
    }
    return next();
  });

  const lastScan = new Map<number, number>();
  function assertScanCooldown(chatId: number): void {
    const last = lastScan.get(chatId);
    const now = Date.now();
    if (last && now - last < deps.env.scanCooldownMs) {
      const wait = Math.ceil((deps.env.scanCooldownMs - (now - last)) / 1000);
      throw new Error(`Please wait ${wait}s before scanning again.`);
    }
  }

  function markScanCooldown(chatId: number): void {
    const now = Date.now();
    lastScan.set(chatId, now);
  }

  const pendingSettings = new Map<string, { key: CustomSettingKey }>();
  const pendingGuidedSetup = new Map<string, GuidedSetupState>();

  bot.use(async (ctx, next) => {
    const text = ctx.message && "text" in ctx.message ? ctx.message.text.trim() : undefined;
    if (!text || !ctx.chat || !ctx.from) return next();
    const pendingKey = pendingSetupId(ctx.chat.id, ctx.from.id);
    const pending = pendingGuidedSetup.get(pendingKey);
    if (!pending) return next();

    if (/^\/cancel(@\w+)?$/i.test(text)) {
      pendingGuidedSetup.delete(pendingKey);
      await ctx.reply("Setup cancelled.");
      return;
    }

    if (text.startsWith("/")) {
      pendingGuidedSetup.delete(pendingKey);
      return next();
    }

    if (!(await isAdmin(ctx, deps.env, deps.store))) {
      pendingGuidedSetup.delete(pendingKey);
      await ctx.reply("Only a group admin can set up buy alerts.");
      return;
    }

    try {
      await handleGuidedSetupText(ctx, deps, pendingGuidedSetup, pendingKey, pending, text, {
        assertScanCooldown,
        markScanCooldown
      });
    } catch (error) {
      await ctx.reply(`Setup failed: ${(error as Error).message}\n\nSend /watch to start again, or /cancel to stop.`);
    }
  });

  bot.use(async (ctx, next) => {
    const text = ctx.message && "text" in ctx.message ? ctx.message.text.trim() : undefined;
    if (!text || !ctx.chat || !ctx.from) return next();
    const pendingKey = pendingSettingId(ctx.chat.id, ctx.from.id);
    const pending = pendingSettings.get(pendingKey);
    if (!pending) return next();

    if (/^\/cancel(@\w+)?$/i.test(text)) {
      pendingSettings.delete(pendingKey);
      await ctx.reply("Custom setting cancelled.");
      return;
    }

    if (text.startsWith("/")) {
      pendingSettings.delete(pendingKey);
      return next();
    }

    if (!(await isAdmin(ctx, deps.env, deps.store))) {
      pendingSettings.delete(pendingKey);
      await ctx.reply("Only a group admin can change settings.");
      return;
    }

    try {
      const chat = deps.store.ensureChat(ctx.chat.id, chatTitle(ctx));
      const message = applyCustomSetting(chat, pending.key, text, ctx);
      deps.store.setChat(chat);
      await deps.store.save();
      pendingSettings.delete(pendingKey);
      await ctx.reply(`${message}\n\n${settingsSummary(chat)}`, settingsKeyboard(chat));
    } catch (error) {
      await ctx.reply(
        `Custom setting failed: ${(error as Error).message}\n\nSend another value, or send /cancel to stop.`
      );
    }
  });

  bot.start((ctx) => ctx.reply(welcomeText(deps.env), { parse_mode: "Markdown" }));
  bot.help((ctx) => ctx.reply(HELP_TEXT));
  bot.command("help", (ctx) => ctx.reply(HELP_TEXT));

  bot.command("scan", adminOnly(deps.env, deps.store), async (ctx) => {
    try {
      const args = argsOf(ctx);
      const parsed = parseWatchArgs(args, deps.env);
      assertSupportedUserChain(parsed.chain);
      assertScanCooldown(ctx.chat!.id);
      markScanCooldown(ctx.chat!.id);
      const runtime = evmRuntime(deps, parsed.chain);
      const hookFilter = resolveHookDiscoveryFilter(parsed, deps.store.getChat(ctx.chat!.id));
      const onlyClankerHooks = hookFilter === "clanker";
      const protocols = effectiveProtocols(parsed.protocols, Boolean(hookFilter));
      const dexes = effectiveDexes(parsed.dexes, Boolean(hookFilter));
      const tokenAddress = normalizeAddress(parsed.token);
      const quoteAddress = parsed.quote && isAddress(parsed.quote) ? normalizeAddress(parsed.quote) : undefined;
      const { fromBlock, toBlock } = await scanRange(runtime.rpc, deps.env, parsed.deploymentBlock!);
      const cappedNote = rangeLimitNote(fromBlock, toBlock);
      await ctx.reply(`Scanning ${selectionLabel(protocols, dexes, parsed.chain)} pools on ${getChain(parsed.chain).name} from token deployment block ${fromBlock} to ${toBlock}${cappedNote}...`);
      const reporter = createProgressReporter(ctx, deps.logger, {
        chatId: ctx.chat!.id,
        token: parsed.token,
        action: "scan"
      });
      const pools = await discoverPools(runtime.rpc, {
        chain: parsed.chain,
        poolManagerAddress: deps.env.poolManagerAddresses[parsed.chain],
        token: tokenAddress,
        quote: quoteAddress,
        protocols,
        dexes,
        fromBlock,
        toBlock,
        chunkSize: deps.env.logChunkSize,
        onlyClankerHooks,
        hookFilter,
        onProgress: reporter.onProgress
      });
      await reporter.finish(pools.length);
      await replyLong(ctx, `Found ${pools.length} pool(s).\n\n${poolsSummary(pools, 10, { fullIdentifiers: true })}`);
    } catch (error) {
      await ctx.reply(`Scan failed: ${(error as Error).message}`);
    }
  });

  bot.command("watch", adminOnly(deps.env, deps.store), async (ctx) => {
    try {
      const args = argsOf(ctx);
      if (args.length === 0) {
        clearGuidedSetup(pendingGuidedSetup, ctx);
        await ctx.reply(guidedSetupIntroText("watch", deps), guidedSetupMainKeyboard(deps));
        return;
      }
      const parsed = parseWatchArgs(args, deps.env);
      assertSupportedUserChain(parsed.chain);
      assertScanCooldown(ctx.chat!.id);
      markScanCooldown(ctx.chat!.id);
      const runtime = evmRuntime(deps, parsed.chain);
      const existingChat = deps.store.getChat(ctx.chat!.id);
      const wasActive = isTrackingActive(existingChat);

      if (!existingChat && deps.store.getChatCount() >= deps.env.maxChats) {
        throw new Error(`Bot is at capacity (${deps.env.maxChats} chats). Please try later.`);
      }

      const hookFilter = resolveHookDiscoveryFilter(parsed, existingChat);
      const onlyClankerHooks = hookFilter === "clanker";
      const protocols = effectiveProtocols(parsed.protocols, Boolean(hookFilter));
      const dexes = effectiveDexes(parsed.dexes, Boolean(hookFilter));
      const tokenAddress = normalizeAddress(parsed.token);
      const quoteAddress = parsed.quote && isAddress(parsed.quote) ? normalizeAddress(parsed.quote) : undefined;
      const token = await runtime.tokenService.getToken(tokenAddress);
      assertCanTrackToken(existingChat, token.address);
      let { fromBlock, toBlock } = await scanRange(runtime.rpc, deps.env, parsed.deploymentBlock!);
      const existingMatchingPools = Object.values(existingChat?.pools ?? {}).filter((pool) =>
        poolMatchesSelection(pool, tokenAddress, quoteAddress, protocols, dexes)
      );
      const appendMode = parsed.scanMode === "next" && existingMatchingPools.length > 0;
      const excludePoolIds = appendMode ? existingMatchingPools.map((pool) => pool.id.toLowerCase()) : [];
      if (fromBlock > toBlock) {
        throw new Error("No blocks to scan in this range.");
      }
      const cappedNote = rangeLimitNote(fromBlock, toBlock);
      const modeNote =
        parsed.scanMode === "next"
          ? " Looking for the next matching pool."
          : parsed.scanMode === "all"
            ? " Looking for all matching pools in this range."
            : "";
      await ctx.reply(`Scanning ${selectionLabel(protocols, dexes, parsed.chain)} pools on ${getChain(parsed.chain).name} from token deployment block ${fromBlock} to ${toBlock}${cappedNote}.${modeNote}`);

      // Resolve token metadata first so discovered pools can be persisted during
      // the scan. New chats stay disabled until at least one pool is found.
      const latest = await runtime.rpc.getBlockNumber();
      const currentBeforeSeed = deps.store.getChat(ctx.chat!.id);
      if (!currentBeforeSeed && deps.store.getChatCount() >= deps.env.maxChats) {
        throw new Error(`Bot is at capacity (${deps.env.maxChats} chats). Please try later.`);
      }
      assertCanTrackToken(currentBeforeSeed, token.address);
      const chat = deps.store.ensureChat(ctx.chat!.id, chatTitle(ctx));
      chat.chain = parsed.chain;
      chat.tokenAddress = token.address;
      chat.token = token;
      chat.enabled = Boolean(currentBeforeSeed?.enabled && Object.keys(currentBeforeSeed.pools).length > 0);
      chat.settings.onlyClankerHooks = onlyClankerHooks;
      chat.lastBlock = Math.max(0, latest - deps.env.confirmations - chat.settings.backfillBlocks);
      deps.store.setChat(chat);
      await deps.store.save();

      const reporter = createProgressReporter(ctx, deps.logger, {
        chatId: ctx.chat!.id,
        token: parsed.token,
        action: "watch"
      });
      let droppedAtCap = 0;
      const pools = await discoverPools(runtime.rpc, {
        chain: parsed.chain,
        poolManagerAddress: deps.env.poolManagerAddresses[parsed.chain],
        token: tokenAddress,
        quote: quoteAddress,
        protocols,
        dexes,
        fromBlock,
        toBlock,
        chunkSize: deps.env.logChunkSize,
        onlyClankerHooks,
        hookFilter,
        stopOnFirst: parsed.scanMode !== "all",
        excludePoolIds,
        onProgress: reporter.onProgress,
        onPoolFound: async (pool) => {
          const current = deps.store.getChat(ctx.chat!.id);
          if (!isCurrentTrackedChat(current, parsed.chain, token.address)) return;
          if (Object.keys(current.pools).length >= deps.env.maxPoolsPerChat) {
            droppedAtCap++;
            return;
          }
          current.pools[pool.id.toLowerCase()] = pool;
          deps.store.setChat(current);
          await deps.store.save();
          deps.logger.info(
            { chatId: ctx.chat!.id, token: token.address, poolId: pool.id, createdBlock: pool.createdBlock },
            "pool added incrementally"
          );
        }
      });
      await reporter.finish(pools.length);

      if (pools.length === 0) {
        if (appendMode) {
          await ctx.reply(
            "No additional matching pools found in the 50k-block deployment window. Check the deployment block, remove the quote filter, or add the pool manually with /pool."
          );
          return;
        }
        if (!existingChat) {
          const current = deps.store.getChat(ctx.chat!.id);
          if (isCurrentTrackedChat(current, parsed.chain, token.address) && Object.keys(current.pools).length === 0) {
            deps.store.deleteChat(ctx.chat!.id);
            await deps.store.save();
          }
        }
        await ctx.reply(
          "No matching pools found in the 50k-block deployment window. Check the deployment block, remove the quote filter, or add the pool manually with /pool."
        );
        return;
      }

      const final = deps.store.getChat(ctx.chat!.id);
      if (!isCurrentTrackedChat(final, parsed.chain, token.address)) {
        await ctx.reply("Watch scan finished, but this chat changed before completion. Ignored stale scan results.");
        return;
      }
      final.enabled = true;
      deps.store.setChat(final);
      await deps.store.save();
      const stored = final ? Object.keys(final.pools).length : 0;
      const truncatedNote =
        droppedAtCap > 0
          ? `\n\n(Stored ${stored} of ${pools.length} pools; capped at ${deps.env.maxPoolsPerChat} per chat - ${droppedAtCap} dropped.)`
          : "";
      await replyLong(
        ctx,
        `Now watching ${token.symbol} (${token.address}) across ${stored} pool(s).\n` +
          `Swap tracker started from block ${chat.lastBlock}.\n\n${poolsSummary(Object.values(final?.pools ?? {}), 10, { fullIdentifiers: true })}${truncatedNote}`
      );
      if (!wasActive) {
        await notifyOwnersAboutTrackingStarted(ctx.telegram, deps.env, deps.logger, {
          chat: final,
          action: "/watch",
          actor: ctx.from,
          maxPoolsPerChat: deps.env.maxPoolsPerChat
        });
      }
    } catch (error) {
      await ctx.reply(`Watch failed: ${(error as Error).message}`);
    }
  });

  bot.command("pool", adminOnly(deps.env, deps.store), async (ctx) => {
    try {
      const rawArgs = argsOf(ctx);
      if (rawArgs.length === 0) {
        clearGuidedSetup(pendingGuidedSetup, ctx);
        await ctx.reply(guidedSetupIntroText("pool", deps), guidedSetupMainKeyboard(deps));
        return;
      }
      const chainArgs = parseOptionalChain(rawArgs, deps.env, deps.store.getChat(ctx.chat!.id));
      const chain = chainArgs.chain;
      const args = chainArgs.args;
      assertSupportedUserChain(chain);
      const poolIdentifier = args[0] ? parsePoolIdentifierArg(args[0]) : undefined;
      if (poolIdentifier?.kind === "v4") {
        await addPoolById(ctx, deps, chain, poolIdentifier.poolId, args.slice(1));
        return;
      }
      if (poolIdentifier?.kind === "address" && args.length < 6) {
        await addPoolByAddress(ctx, deps, chain, poolIdentifier.poolAddress, args.slice(1));
        return;
      }
      if (args.length < 6) {
        throw new Error("Usage: /pool <poolAddress> [targetToken] OR /pool <v4PoolId> <targetToken> <poolCreationBlock> OR /pool <currency0or1> <currency1or0> <fee> <tickSpacing> <hooks> <targetToken>");
      }
      const pool = manualPoolKey({
        chain,
        currencyA: normalizeAddress(args[0]!),
        currencyB: normalizeAddress(args[1]!),
        fee: Number(args[2]),
        tickSpacing: Number(args[3]),
        hooks: normalizeAddress(args[4]!)
      });
      const targetToken = normalizeAddress(args[5]!);
      if (!isPoolCurrency(pool, targetToken)) throw new Error("targetToken must be one of the two pool currencies.");

      const runtime = evmRuntime(deps, chain);
      const token = await runtime.tokenService.getToken(targetToken);
      const existingChat = deps.store.getChat(ctx.chat!.id);
      const wasActive = isTrackingActive(existingChat);
      if (!existingChat && deps.store.getChatCount() >= deps.env.maxChats) {
        throw new Error(`Bot is at capacity (${deps.env.maxChats} chats). Please try later.`);
      }
      assertCanTrackToken(existingChat, token.address);
      const latest = await runtime.rpc.getBlockNumber();
      const currentBeforeSave = deps.store.getChat(ctx.chat!.id);
      if (!currentBeforeSave && deps.store.getChatCount() >= deps.env.maxChats) {
        throw new Error(`Bot is at capacity (${deps.env.maxChats} chats). Please try later.`);
      }
      assertCanTrackToken(currentBeforeSave, token.address);
      const chat = deps.store.ensureChat(ctx.chat!.id, chatTitle(ctx));
      if (Object.keys(chat.pools).length >= deps.env.maxPoolsPerChat && !chat.pools[pool.id.toLowerCase()]) {
        throw new Error(`Pool limit reached for this chat (${deps.env.maxPoolsPerChat}). Use /unwatch to reset.`);
      }
      chat.chain = chain;
      chat.tokenAddress = token.address;
      chat.token = token;
      chat.enabled = true;
      chat.pools[pool.id.toLowerCase()] = pool;
      chat.lastBlock = Math.max(0, latest - deps.env.confirmations - chat.settings.backfillBlocks);
      deps.store.setChat(chat);
      await deps.store.save();

      await ctx.reply(`Added manual pool for ${token.symbol}:\n${poolsSummary([pool], 10, { fullIdentifiers: true })}`);
      if (!wasActive) {
        await notifyOwnersAboutTrackingStarted(ctx.telegram, deps.env, deps.logger, {
          chat,
          action: "/pool",
          actor: ctx.from,
          maxPoolsPerChat: deps.env.maxPoolsPerChat
        });
      }
    } catch (error) {
      await ctx.reply(`Add pool failed: ${(error as Error).message}`);
    }
  });

  bot.command("pools", adminOnly(deps.env, deps.store), async (ctx) => {
    const chat = deps.store.getChat(ctx.chat!.id);
    if (!chat || Object.keys(chat.pools).length === 0) return ctx.reply("No pools configured yet. Use /watch or /pool.");
    if (chat.chain === "solana") return ctx.reply(`${SOLANA_DISABLED_MESSAGE}\n\nUse /unwatch before setting up a supported EVM chain.`);
    return replyLong(ctx, poolsSummary(Object.values(chat.pools), 25, { fullIdentifiers: true }));
  });

  bot.command("settings", adminOnly(deps.env, deps.store), async (ctx) => {
    const chat = deps.store.getChat(ctx.chat!.id);
    if (!chat) return ctx.reply("No settings yet. Use /watch first.");
    if (chat.chain === "solana") return ctx.reply(`${SOLANA_DISABLED_MESSAGE}\n\nUse /unwatch before setting up a supported EVM chain.`);
    return ctx.reply(settingsSummary(chat), settingsKeyboard(chat));
  });

  bot.command("status", adminOnly(deps.env, deps.store), async (ctx) => {
    const chat = deps.store.getChat(ctx.chat!.id);
    const chain = chat?.chain ?? deps.env.primaryChain;
    if (chain === "solana") return ctx.reply(`${SOLANA_DISABLED_MESSAGE}\n\nUse /unwatch before setting up a supported EVM chain.`);
    const runtime = evmRuntime(deps, chain);
    const latest = await runtime.rpc.getBlockNumber();
    const local = chat ? settingsSummary(chat) : "This chat is not configured.";
    return ctx.reply(`${getChain(chain).name} latest block: ${latest}\nPoolManager: ${deps.env.poolManagerAddresses[chain] ?? "n/a"}\n\n${local}`);
  });

  bot.command("rpcscan", ownerOnly(deps.env), async (ctx) => {
    try {
      const args = argsOf(ctx).map((arg) => arg.toLowerCase());
      const probe = !args.includes("cached");
      const requestedChain = args.find((arg): arg is ChainSlug => isChainSlug(arg));
      if (requestedChain === "solana") {
        await ctx.reply(SOLANA_DISABLED_MESSAGE);
        return;
      }
      const includeAll = args.includes("all") || !requestedChain;
      const chains = includeAll ? configuredRpcChains(deps) : [requestedChain];
      if (chains.length === 0) {
        await ctx.reply("No configured RPC pools. Check ENABLED_CHAINS and *_RPC_URLS.");
        return;
      }

      const sections = [`RPC scan${probe ? " (live block probe)" : " (cached stats)"}`];
      for (const chain of chains) {
        sections.push(await evmRpcScanSection(deps, chain, probe));
      }
      sections.push("Tip: use `/rpcscan cached` to avoid live probes, or `/rpcscan base` for one chain.");
      await replyLong(ctx, sections.join("\n\n"));
    } catch (error) {
      await ctx.reply(`RPC scan failed: ${(error as Error).message}`);
    }
  });

  bot.command("topic", adminOnly(deps.env, deps.store), async (ctx) => {
    try {
      const args = argsOf(ctx);
      const chat = deps.store.ensureChat(ctx.chat!.id, chatTitle(ctx));
      const message = applyAlertThreadSetting(chat, args[0] ?? "here", ctx);
      deps.store.setChat(chat);
      await deps.store.save();
      await ctx.reply(`${message}\n\n${settingsSummary(chat)}`);
    } catch (error) {
      await ctx.reply(`Topic update failed: ${(error as Error).message}`);
    }
  });

  bot.command("pause", adminOnly(deps.env, deps.store), async (ctx) => {
    const chat = deps.store.ensureChat(ctx.chat!.id, chatTitle(ctx));
    chat.enabled = false;
    deps.store.setChat(chat);
    await deps.store.save();
    await ctx.reply("Paused buy notifications for this chat.");
  });

  bot.command("resume", adminOnly(deps.env, deps.store), async (ctx) => {
    const chat = deps.store.getChat(ctx.chat!.id);
    if (!chat || !chat.tokenAddress || Object.keys(chat.pools).length === 0) {
      await ctx.reply("Nothing to resume. Use /watch first.");
      return;
    }
    if ((chat.chain ?? deps.env.primaryChain) === "solana") {
      await ctx.reply(`${SOLANA_DISABLED_MESSAGE}\n\nUse /unwatch before setting up a supported EVM chain.`);
      return;
    }
    const runtime = evmRuntime(deps, chat.chain ?? deps.env.primaryChain);
    const latest = await runtime.rpc.getBlockNumber();
    const current = deps.store.getChat(ctx.chat!.id);
    if (!isCurrentTrackedChat(current, chat.chain ?? deps.env.primaryChain, chat.tokenAddress)) {
      await ctx.reply("Chat configuration changed before resume completed. Run /status and try again.");
      return;
    }
    current.enabled = true;
    current.lastBlock = Math.max(0, latest - deps.env.confirmations - current.settings.backfillBlocks);
    deps.store.setChat(current);
    await deps.store.save();
    await ctx.reply(`Resumed from block ${current.lastBlock}.`);
  });

  bot.command("unwatch", adminOnly(deps.env, deps.store), async (ctx) => {
    deps.store.deleteChat(ctx.chat!.id);
    await deps.store.save();
    await ctx.reply("Removed all configuration for this chat.");
  });

  bot.command("set", adminOnly(deps.env, deps.store), async (ctx) => {
    try {
      const args = argsOf(ctx);
      if (args.length < 2) throw new Error("Usage: /set <key> <value>");
      const chat = deps.store.ensureChat(ctx.chat!.id, chatTitle(ctx));
      const value = args.slice(1).join(" ");
      const message = isTopicSettingKey(args[0]!)
        ? applyAlertThreadSetting(chat, value, ctx)
        : "Updated setting.";
      if (!isTopicSettingKey(args[0]!)) applySetting(chat, args[0]!, value);
      deps.store.setChat(chat);
      await deps.store.save();
      await ctx.reply(`${message}\n\n${settingsSummary(chat)}`);
    } catch (error) {
      await ctx.reply(`Set failed: ${(error as Error).message}`);
    }
  });

  // Direct media upload: user sends a photo or GIF with caption "/setmedia" or
  // "/set media" - bot saves Telegram's file_id and uses it for buy alerts.
  const handleMediaUpload = async (
    ctx: Context,
    kind: "photo" | "animation",
    fileId: string,
    caption: string | undefined
  ): Promise<void> => {
    const pendingKey = ctx.chat && ctx.from ? pendingSettingId(ctx.chat.id, ctx.from.id) : undefined;
    const pending = pendingKey ? pendingSettings.get(pendingKey) : undefined;
    const isSettingsUpload = pending?.key === "mediaupload" || pending?.key === "media";
    const isCaptionUpload = Boolean(caption && /^\/?set\s*media\b/i.test(caption.trim()));
    if (!isSettingsUpload && !isCaptionUpload) return;
    if (!(await isAdmin(ctx, deps.env, deps.store))) {
      if (pendingKey) pendingSettings.delete(pendingKey);
      await ctx.reply("Only a group admin can change settings.");
      return;
    }
    const chat = deps.store.ensureChat(ctx.chat!.id, chatTitle(ctx));
    delete chat.settings.mediaUrl;
    chat.settings.media = { kind, ref: fileId };
    deps.store.setChat(chat);
    await deps.store.save();
    if (pendingKey) pendingSettings.delete(pendingKey);
    const saved = `Saved ${kind === "animation" ? "animation/GIF" : "photo"} as the buy alert media.`;
    if (isSettingsUpload) {
      await ctx.reply(`${saved}\n\n${settingsSummary(chat)}`, settingsKeyboard(chat));
    } else {
      await ctx.reply(saved);
    }
  };

  bot.on("photo", async (ctx) => {
    try {
      const msg = ctx.message;
      if (!msg || !("photo" in msg) || !msg.photo.length) return;
      const largest = msg.photo[msg.photo.length - 1]!;
      const caption = "caption" in msg ? msg.caption : undefined;
      await handleMediaUpload(ctx, "photo", largest.file_id, caption);
    } catch (error) {
      deps.logger.error({ error }, "photo upload handler failed");
    }
  });

  bot.on("animation", async (ctx) => {
    try {
      const msg = ctx.message;
      if (!msg || !("animation" in msg) || !msg.animation) return;
      const caption = "caption" in msg ? msg.caption : undefined;
      await handleMediaUpload(ctx, "animation", msg.animation.file_id, caption);
    } catch (error) {
      deps.logger.error({ error }, "animation upload handler failed");
    }
  });

  bot.command("testbuy", adminOnly(deps.env, deps.store), async (ctx) => {
    try {
      const chat = deps.store.getChat(ctx.chat!.id);
      if (!chat || !chat.tokenAddress || !chat.token || Object.keys(chat.pools).length === 0) {
        throw new Error("Use /watch or /pool first.");
      }
      const pool = Object.values(chat.pools)[0]!;
      const chain = chat.chain ?? "base";
      if (chain === "solana") {
        throw new Error(SOLANA_DISABLED_MESSAGE);
      }
      const quoteAddress = getOtherCurrency(pool, chat.tokenAddress);
      const runtime = evmRuntime(deps, chain);
      const quote = await runtime.tokenService.getToken(quoteAddress);
      const quoteRaw = tenPow(quote.decimals) / 100n;
      const tokenRaw = 1000n * tenPow(chat.token.decimals);
      const usdMultiplier = await deps.priceService.quoteUsdMultiplier(quote.address, chain);
      const quoteUsd =
        usdMultiplier !== undefined
          ? (Number(quoteRaw) / Number(tenPow(quote.decimals))) * usdMultiplier
          : undefined;
      const priceUsd = quoteUsd !== undefined ? quoteUsd / 1000 : undefined;
      const event: BuyEvent = {
        chatId: chat.chatId,
        chain,
        pool,
        token: chat.token,
        quote,
        tokenAmountRaw: tokenRaw,
        quoteAmountRaw: quoteRaw,
        tokenAmount: formatTokenAmount(tokenRaw, chat.token.decimals, 4),
        quoteAmount: formatTokenAmount(quoteRaw, quote.decimals, 6),
        quoteUsd,
        priceUsd,
        fdvUsd:
          priceUsd && chat.token.totalSupply
            ? (Number(chat.token.totalSupply) / Number(tenPow(chat.token.decimals))) * priceUsd
            : undefined,
        buyer: "0x000000000000000000000000000000000000bEEF" as Address,
        txHash: "0x000000000000000000000000000000000000000000000000000000000000bEEF",
        blockNumber: await runtime.rpc.getBlockNumber(),
        logIndex: 0
      };
      await sendBuyNotification(ctx.telegram, chat, event);
    } catch (error) {
      await ctx.reply(`Test failed: ${(error as Error).message}`);
    }
  });

  // --- Owner-only operational commands -----------------------------------

  bot.command(OWNER_COMMANDS.stats, ownerOnly(deps.env), async (ctx) => {
    const chats = deps.store.getAllChats();
    const active = chats.filter((c) => c.enabled && c.tokenAddress && Object.keys(c.pools).length > 0);
    const totalPools = chats.reduce((acc, c) => acc + Object.keys(c.pools).length, 0);
    const banned = deps.store.getBannedChatIds().length;
    const lines = [
      `Chats: ${chats.length} (active: ${active.length})`,
      `Tracked pools: ${totalPools}`,
      `Banned chats: ${banned}`,
      `Capacity: ${chats.length}/${deps.env.maxChats}`,
      `Public mode: ${deps.env.publicMode ? "on" : "off"}`
    ];
    await ctx.reply(lines.join("\n"));
  });

  bot.command(OWNER_COMMANDS.listChats, ownerOnly(deps.env), async (ctx) => {
    const chats = deps.store.getAllChats();
    if (chats.length === 0) return ctx.reply("No chats yet.");
    const lines = await dbChatLines(ctx, deps, chats.slice(0, 50));
    if (chats.length > 50) lines.push(`...and ${chats.length - 50} more.`);
    await replyLong(ctx, lines.join("\n"));
  });

  bot.command(OWNER_COMMANDS.walletPnl, ownerOnly(deps.env), async (ctx) => {
    const snapshot = deps.store.getWalletPnlSnapshot(deps.env.walletPnlChain);
    if (!snapshot) {
      await ctx.reply(
        deps.env.walletPnlEnabled
          ? "Wallet PnL snapshot is not ready yet. The background indexer is still building its first window."
          : "Wallet PnL is disabled. Set WALLET_PNL_ENABLED=true to build the background ledger."
      );
      return;
    }
    await replyLong(ctx, formatWalletPnlSnapshot(snapshot, deps.env.walletPnlSnapshotLimit));
  });

  bot.command(OWNER_COMMANDS.db, ownerOnly(deps.env), async (ctx) => {
    try {
      const args = argsOf(ctx);
      const view = (args[0] ?? "overview").toLowerCase();
      if (view === "overview" || view === "summary") {
        await replyLong(ctx, `${dbRuntimeView(deps.env)}\n\n${dbOverview(deps.store.getAllChats(), deps.store.getBannedChatIds())}`);
        return;
      }
      if (view === "runtime" || view === "where") {
        await replyLong(ctx, dbRuntimeView(deps.env));
        return;
      }
      if (view === "chats") {
        await replyLong(ctx, await dbChatsView(ctx, deps, deps.store.getAllChats()));
        return;
      }
      if (view === "chat") {
        const chatId = Number(args[1]);
        if (!Number.isFinite(chatId)) throw new Error(`Usage: /${OWNER_COMMANDS.db} chat <chatId>`);
        const chat = deps.store.getChat(chatId);
        await replyLong(ctx, chat ? await dbChatDetail(ctx, deps, chat) : `No chat row for ${chatId}.`);
        return;
      }
      if (view === "pools") {
        const chatId = Number(args[1] ?? ctx.chat?.id);
        if (!Number.isFinite(chatId)) throw new Error(`Usage: /${OWNER_COMMANDS.db} pools <chatId>`);
        const chat = deps.store.getChat(chatId);
        await replyLong(ctx, chat ? poolsSummary(Object.values(chat.pools), 100, { fullIdentifiers: true }) : `No chat row for ${chatId}.`);
        return;
      }
      if (view === "banned") {
        const ids = deps.store.getBannedChatIds();
        await replyLong(ctx, ids.length ? ids.map(String).join("\n") : "No banned chats.");
        return;
      }
      throw new Error(`Usage: /${OWNER_COMMANDS.db} [chats|chat <id>|pools <id>|banned|runtime]`);
    } catch (error) {
      await ctx.reply(`DB view failed: ${(error as Error).message}`);
    }
  });

  bot.command(OWNER_COMMANDS.ban, ownerOnly(deps.env), async (ctx) => {
    try {
      const args = argsOf(ctx);
      if (args.length < 1) throw new Error(`Usage: /${OWNER_COMMANDS.ban} <chatId> [reason]`);
      const chatId = Number(args[0]);
      if (!Number.isFinite(chatId)) throw new Error("chatId must be a number");
      const reason = args.slice(1).join(" ") || undefined;
      deps.store.banChat(chatId, reason);
      await deps.store.save();
      try { await ctx.telegram.leaveChat(chatId); } catch { /* ignore */ }
      await ctx.reply(`Banned chat ${chatId}${reason ? ` (${reason})` : ""}.`);
    } catch (error) {
      await ctx.reply(`Ban failed: ${(error as Error).message}`);
    }
  });

  bot.command(OWNER_COMMANDS.unban, ownerOnly(deps.env), async (ctx) => {
    try {
      const args = argsOf(ctx);
      if (args.length < 1) throw new Error(`Usage: /${OWNER_COMMANDS.unban} <chatId>`);
      const chatId = Number(args[0]);
      if (!Number.isFinite(chatId)) throw new Error("chatId must be a number");
      deps.store.unbanChat(chatId);
      await deps.store.save();
      await ctx.reply(`Unbanned chat ${chatId}.`);
    } catch (error) {
      await ctx.reply(`Unban failed: ${(error as Error).message}`);
    }
  });

  bot.command(OWNER_COMMANDS.broadcast, ownerOnly(deps.env), async (ctx) => {
    try {
      const message = ctx.message;
      if (!message || !("text" in message)) throw new Error("Reply with text only.");
      const body = message.text.replace(new RegExp(`^/${OWNER_COMMANDS.broadcast}(@\\w+)?\\s*`, "i"), "").trim();
      if (!body) throw new Error(`Usage: /${OWNER_COMMANDS.broadcast} <message>`);
      const chats = deps.store.getAllChats();
      let ok = 0;
      let fail = 0;
      for (const chat of chats) {
        try {
          await ctx.telegram.sendMessage(chat.chatId, body);
          ok++;
        } catch {
          fail++;
        }
      }
      await ctx.reply(`Broadcast sent. Delivered: ${ok}, failed: ${fail}.`);
    } catch (error) {
      await ctx.reply(`Broadcast failed: ${(error as Error).message}`);
    }
  });

  bot.command("chatid", async (ctx) => {
    if (!ctx.chat) return;
    const threadId = currentMessageThreadId(ctx);
    const threadLine = threadId ? `\nTopic/thread id: \`${threadId}\`` : "";
    await ctx.reply(`Chat id: \`${ctx.chat.id}\`${threadLine}\nYour user id: \`${ctx.from?.id ?? "?"}\``, {
      parse_mode: "Markdown"
    });
  });

  bot.action(/^setup:(.+)$/, async (ctx) => {
    try {
      if (!(await isAdmin(ctx, deps.env, deps.store))) {
        await ctx.answerCbQuery("Admins only", { show_alert: true });
        return;
      }
      const action = ctx.match[1] ?? "";
      await handleGuidedSetupAction(ctx, deps, pendingGuidedSetup, action);
    } catch (error) {
      const message = (error as Error).message || "Setup action failed.";
      deps.logger.error({ error }, "guided setup action failed");
      try { await ctx.answerCbQuery(message.slice(0, 180), { show_alert: true }); } catch { /* ignore */ }
    }
  });

  // Inline keyboard actions for /settings.
  bot.action(/^cfg:(.+)$/, async (ctx) => {
    try {
      if (!(await isAdmin(ctx, deps.env, deps.store))) {
        await ctx.answerCbQuery("Admins only", { show_alert: true });
        return;
      }
      const action = ctx.match[1] ?? "";
      const chat = deps.store.ensureChat(ctx.chat!.id, chatTitle(ctx));
      let view:
        | "settings"
        | "minusd"
        | "minquote"
        | "emoji"
        | "emojistep"
        | "maxemojis"
        | "media"
        | "topic"
        | "backfill" = "settings";
      let toast = "";

      if (action === "refresh") {
        // no-op, just re-render
      } else if (action === "pause") {
        chat.enabled = false;
        toast = "Paused.";
      } else if (action === "resume") {
        if (!chat.tokenAddress || Object.keys(chat.pools).length === 0) {
          await ctx.answerCbQuery("Run /watch first", { show_alert: true });
          return;
        }
        if ((chat.chain ?? deps.env.primaryChain) === "solana") {
          await ctx.answerCbQuery("Solana support is disabled.", { show_alert: true });
          return;
        } else {
          const runtime = evmRuntime(deps, chat.chain ?? deps.env.primaryChain);
          const latest = await runtime.rpc.getBlockNumber();
          const current = deps.store.getChat(ctx.chat!.id);
          if (!isCurrentTrackedChat(current, chat.chain ?? deps.env.primaryChain, chat.tokenAddress)) {
            await ctx.answerCbQuery("Chat changed; refresh settings.", { show_alert: true });
            return;
          }
          current.enabled = true;
          current.lastBlock = Math.max(0, latest - deps.env.confirmations - current.settings.backfillBlocks);
          deps.store.setChat(current);
          await deps.store.save();
          await ctx.editMessageText(settingsSummary(current), settingsKeyboard(current));
          await ctx.answerCbQuery("Resumed.");
          return;
        }
      } else if (action === "toggle:tx") {
        chat.settings.showTxLink = !chat.settings.showTxLink;
        toast = `Tx links ${chat.settings.showTxLink ? "on" : "off"}.`;
      } else if (action === "toggle:chart") {
        chat.settings.showChartLink = !chat.settings.showChartLink;
        toast = `Chart links ${chat.settings.showChartLink ? "on" : "off"}.`;
      } else if (action === "toggle:clanker") {
        chat.settings.onlyClankerHooks = !chat.settings.onlyClankerHooks;
        toast = `Clanker-only discovery ${chat.settings.onlyClankerHooks ? "on" : "off"}.`;
      } else if (action === "menu:minusd") {
        view = "minusd";
      } else if (action === "menu:minquote") {
        view = "minquote";
      } else if (action === "menu:emoji") {
        view = "emoji";
      } else if (action === "menu:emojistep") {
        view = "emojistep";
      } else if (action === "menu:maxemojis") {
        view = "maxemojis";
      } else if (action === "menu:media") {
        view = "media";
      } else if (action === "menu:topic") {
        view = "topic";
      } else if (action === "menu:backfill") {
        view = "backfill";
      } else if (action.startsWith("custom:")) {
        const rawKey = action.slice("custom:".length);
        if (!isCustomSettingKey(rawKey)) {
          await ctx.answerCbQuery("Unknown setting", { show_alert: true });
          return;
        }
        pendingSettings.set(pendingSettingId(ctx.chat!.id, ctx.from!.id), { key: rawKey });
        await ctx.reply(customSettingPrompt(rawKey, chat));
        await ctx.answerCbQuery("Send the custom value.");
        return;
      } else if (action.startsWith("set:minusd:")) {
        const v = Number(action.slice("set:minusd:".length));
        if (Number.isFinite(v) && v >= 0 && MIN_USD_PRESETS.includes(v)) {
          chat.settings.minUsd = v;
          toast = `Min USD set to $${v}.`;
        }
      } else if (action.startsWith("set:minquote:")) {
        const v = Number(action.slice("set:minquote:".length));
        if (Number.isFinite(v) && v >= 0 && MIN_QUOTE_PRESETS.includes(v)) {
          chat.settings.minQuote = v;
          toast = `Min quote set to ${v}.`;
        }
      } else if (action.startsWith("set:emoji:")) {
        const raw = decodeURIComponent(action.slice("set:emoji:".length));
        if (EMOJI_PRESETS.includes(raw)) {
          chat.settings.emoji = raw;
          toast = `Emoji set to ${raw}.`;
        }
      } else if (action.startsWith("set:emojistep:")) {
        const v = Number(action.slice("set:emojistep:".length));
        if (Number.isFinite(v) && v > 0 && EMOJI_STEP_PRESETS.includes(v)) {
          chat.settings.emojiStepUsd = v;
          toast = `Emoji step set to $${v}.`;
        }
      } else if (action.startsWith("set:maxemojis:")) {
        const v = Number(action.slice("set:maxemojis:".length));
        if (Number.isInteger(v) && v > 0 && MAX_EMOJI_PRESETS.includes(v)) {
          chat.settings.maxEmojis = v;
          toast = `Max emojis set to ${v}.`;
        }
      } else if (action.startsWith("set:backfill:")) {
        const v = Number(action.slice("set:backfill:".length));
        if (Number.isInteger(v) && v >= 0 && BACKFILL_PRESETS.includes(v)) {
          chat.settings.backfillBlocks = v;
          toast = `Backfill set to ${v} blocks.`;
        }
      } else if (action === "set:topic:off") {
        delete chat.alertThreadId;
        toast = "Alert topic cleared.";
      } else if (action === "set:topic:here") {
        toast = applyAlertThreadSetting(chat, "here", ctx);
      } else if (action === "set:media:off") {
        delete chat.settings.mediaUrl;
        delete chat.settings.media;
        toast = "Media removed.";
      }

      deps.store.setChat(chat);
      await deps.store.save();

      if (view === "minusd") {
        await ctx.editMessageText(minUsdMenuText(chat), minUsdKeyboard());
      } else if (view === "minquote") {
        await ctx.editMessageText(minQuoteMenuText(chat), minQuoteKeyboard());
      } else if (view === "emoji") {
        await ctx.editMessageText(emojiMenuText(chat), emojiKeyboard());
      } else if (view === "emojistep") {
        await ctx.editMessageText(emojiStepMenuText(chat), emojiStepKeyboard());
      } else if (view === "maxemojis") {
        await ctx.editMessageText(maxEmojisMenuText(chat), maxEmojisKeyboard());
      } else if (view === "media") {
        await ctx.editMessageText(mediaInstructionsText(), { parse_mode: "Markdown", ...mediaKeyboard() });
      } else if (view === "topic") {
        await ctx.editMessageText(topicMenuText(chat), topicKeyboard());
      } else if (view === "backfill") {
        await ctx.editMessageText(backfillMenuText(chat), backfillKeyboard());
      } else {
        await ctx.editMessageText(settingsSummary(chat), settingsKeyboard(chat));
      }
      await ctx.answerCbQuery(toast || undefined);
    } catch (error) {
      const msg = (error as Error).message ?? "";
      if (/message is not modified/i.test(msg)) {
        await ctx.answerCbQuery();
        return;
      }
      deps.logger.error({ error }, "settings action failed");
      try { await ctx.answerCbQuery(msg ? msg.slice(0, 180) : "Something went wrong", { show_alert: true }); } catch { /* ignore */ }
    }
  });

  bot.catch((error, ctx) => {
    deps.logger.error({ error, updateType: ctx.updateType }, "bot handler failed");
  });

  // suppress unused-import warning on isOwner (helper kept exported for tests)
  void isOwner;
}

function pendingSetupId(chatId: number, userId: number): string {
  return `setup:${chatId}:${userId}`;
}

function clearGuidedSetup(pending: Map<string, GuidedSetupState>, ctx: Context): void {
  if (!ctx.chat || !ctx.from) return;
  pending.delete(pendingSetupId(ctx.chat.id, ctx.from.id));
}

function availableSetupChains(deps: CommandDeps): ChainSlug[] {
  const configured = PUBLIC_CHAIN_SLUGS.filter((chain) => deps.rpcs.has(chain));
  return configured.length > 0 ? configured : PUBLIC_CHAIN_SLUGS;
}

function guidedSetupIntroText(preferred: "watch" | "pool", deps: CommandDeps): string {
  const chainList = availableSetupChains(deps).map((chain) => getChain(chain).name).join(", ");
  const firstLine = preferred === "pool"
    ? "Let's add a known pool without making you memorize the /pool command."
    : "Let's set up buy alerts without making you memorize the /watch command.";
  return [
    firstLine,
    "",
    "Choose the path that matches what you have:",
    "",
    "Token contract: I will scan for pools. You will need the token contract and the first-mint/deployment block.",
    "Pool contract: fastest when you already have the exact pool/pair address from a chart or explorer.",
    "",
    `Configured chains here: ${chainList}.`,
    "",
    "Power users can still type the full /watch or /pool command directly."
  ].join("\n");
}

function guidedSetupMainKeyboard(deps: CommandDeps) {
  const hasChains = availableSetupChains(deps).length > 0;
  return Markup.inlineKeyboard([
    [Markup.button.callback("Find pools from token contract", hasChains ? "setup:flow:watch" : "setup:help:nochains")],
    [Markup.button.callback("Add known pool contract", hasChains ? "setup:flow:pool" : "setup:help:nochains")],
    [
      Markup.button.callback("What do I need?", "setup:help:overview"),
      Markup.button.callback("Examples", "setup:help:examples")
    ]
  ]);
}

function guidedChainKeyboard(deps: CommandDeps, flow: "watch" | "pool") {
  const rows = chunk(availableSetupChains(deps), 2).map((row) =>
    row.map((chain) => Markup.button.callback(getChain(chain).name, `setup:chain:${flow}:${chain}`))
  );
  rows.push([
    Markup.button.callback("What is a chain?", "setup:help:chain"),
    Markup.button.callback("Cancel", "setup:cancel")
  ]);
  return Markup.inlineKeyboard(rows);
}

function guidedInputKeyboard(topic: "token" | "pool" | "block" | "target") {
  const helpLabel = topic === "target" ? "Why target token?" : topic === "block" ? "Where find block?" : `What is ${topic}?`;
  return Markup.inlineKeyboard([
    [Markup.button.callback(helpLabel, `setup:help:${topic}`)],
    [Markup.button.callback("Cancel", "setup:cancel")]
  ]);
}

function guidedTokenPrompt(chain: ChainSlug): string {
  return [
    `${getChain(chain).name} selected.`,
    "",
    "Send the token contract address you want buy alerts for.",
    "",
    "It should look like `0x...` and it is the token contract, not the pool/pair contract.",
    "Paste only the address."
  ].join("\n");
}

function guidedBlockPrompt(chain: ChainSlug, token: Address): string {
  return [
    `Token saved for ${getChain(chain).name}: ${token}`,
    "",
    "Now send the first-mint or deployment block number.",
    "",
    "This tells the bot where to start scanning, so setup stays fast and avoids wasting RPC. Paste digits only.",
    "",
    "If you already know the exact pool/pair contract, cancel this and use /pool."
  ].join("\n");
}

function guidedPoolPrompt(chain: ChainSlug): string {
  return [
    `${getChain(chain).name} selected.`,
    "",
    "Send the pool or pair contract address.",
    "",
    "This is the market contract from a chart/explorer, not the token contract. Paste only the `0x...` pool address."
  ].join("\n");
}

function guidedTargetPrompt(chain: ChainSlug, poolAddress: Address): string {
  return [
    `Pool saved for ${getChain(chain).name}: ${poolAddress}`,
    "",
    "Now send the token contract you want alerts for inside that pool.",
    "",
    "Pools have two tokens. This tells the bot which side counts as the bought token."
  ].join("\n");
}

async function handleGuidedSetupAction(
  ctx: Context,
  deps: CommandDeps,
  pending: Map<string, GuidedSetupState>,
  action: string
): Promise<void> {
  if (!ctx.chat || !ctx.from) return;
  const key = pendingSetupId(ctx.chat.id, ctx.from.id);
  if (action === "cancel") {
    pending.delete(key);
    await editOrReply(ctx, "Setup cancelled. Send /watch when you want to start again.");
    await ctx.answerCbQuery("Cancelled.");
    return;
  }
  if (action === "menu") {
    pending.delete(key);
    await editOrReply(ctx, guidedSetupIntroText("watch", deps), guidedSetupMainKeyboard(deps));
    await ctx.answerCbQuery();
    return;
  }
  if (action === "flow:watch" || action === "flow:pool") {
    const flow = action.endsWith(":watch") ? "watch" : "pool";
    await editOrReply(
      ctx,
      `Pick the chain for this ${flow === "watch" ? "token scan" : "pool"}. Only configured chains are shown.`,
      guidedChainKeyboard(deps, flow)
    );
    await ctx.answerCbQuery();
    return;
  }
  if (action.startsWith("chain:")) {
    const [, flowRaw, chainRaw] = action.split(":");
    if ((flowRaw !== "watch" && flowRaw !== "pool") || !isChainSlug(chainRaw)) {
      throw new Error("Unknown setup choice.");
    }
    assertSupportedUserChain(chainRaw);
    if (!availableSetupChains(deps).includes(chainRaw)) {
      throw new Error(`${getChain(chainRaw).name} is not configured on this bot.`);
    }
    if (flowRaw === "watch") {
      pending.set(key, { flow: "watch", step: "token", chain: chainRaw });
      await editOrReply(ctx, guidedTokenPrompt(chainRaw), guidedInputKeyboard("token"));
    } else {
      pending.set(key, { flow: "pool", step: "pool", chain: chainRaw });
      await editOrReply(ctx, guidedPoolPrompt(chainRaw), guidedInputKeyboard("pool"));
    }
    await ctx.answerCbQuery();
    return;
  }
  if (action.startsWith("help:")) {
    await editOrReply(ctx, guidedHelpText(action.slice("help:".length), deps), guidedHelpKeyboard(deps));
    await ctx.answerCbQuery();
    return;
  }
  throw new Error("Unknown setup action.");
}

async function handleGuidedSetupText(
  ctx: Context,
  deps: CommandDeps,
  pending: Map<string, GuidedSetupState>,
  pendingKey: string,
  state: GuidedSetupState,
  text: string,
  controls: WatchExecutionControls
): Promise<void> {
  if (state.flow === "watch" && state.step === "token") {
    if (!isAddress(text)) {
      await ctx.reply("That does not look like an EVM token contract. Paste the `0x...` token address, or tap help below.", guidedInputKeyboard("token"));
      return;
    }
    const token = normalizeAddress(text);
    pending.set(pendingKey, { flow: "watch", step: "block", chain: state.chain, token });
    await ctx.reply(guidedBlockPrompt(state.chain, token), guidedInputKeyboard("block"));
    return;
  }

  if (state.flow === "watch" && state.step === "block") {
    if (!/^\d+$/.test(text.trim())) {
      await ctx.reply("Please send only the block number, for example `23456789`.", guidedInputKeyboard("block"));
      return;
    }
    pending.delete(pendingKey);
    await executeGuidedWatch(ctx, deps, [state.chain, state.token, "any", text.trim(), "all"], controls);
    return;
  }

  if (state.flow === "pool" && state.step === "pool") {
    if (!isAddress(text)) {
      await ctx.reply("That does not look like an EVM pool contract. Paste the `0x...` pool/pair address, or tap help below.", guidedInputKeyboard("pool"));
      return;
    }
    const poolAddress = normalizeAddress(text);
    pending.set(pendingKey, { flow: "pool", step: "target", chain: state.chain, poolAddress });
    await ctx.reply(guidedTargetPrompt(state.chain, poolAddress), guidedInputKeyboard("target"));
    return;
  }

  if (state.flow === "pool" && state.step === "target") {
    if (!isAddress(text)) {
      await ctx.reply("That does not look like an EVM token contract. Paste the `0x...` token address you want alerts for.", guidedInputKeyboard("target"));
      return;
    }
    pending.delete(pendingKey);
    await addPoolByAddress(ctx, deps, state.chain, state.poolAddress, [normalizeAddress(text)]);
  }
}

function guidedHelpKeyboard(deps: CommandDeps) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Start token scan", "setup:flow:watch")],
    [Markup.button.callback("Add known pool", "setup:flow:pool")],
    [Markup.button.callback("Back to setup menu", "setup:menu")]
  ]);
}

function guidedHelpText(topic: string, deps: CommandDeps): string {
  if (topic === "nochains") {
    return "No EVM RPC chains are configured for guided setup on this bot. Ask the owner to configure ENABLED_CHAINS and the matching *_RPC_URLS.";
  }
  if (topic === "overview") {
    return [
      "There are two easy setup paths:",
      "",
      "1. Token contract path: choose chain, paste token contract, paste first-mint/deployment block. The bot scans for matching pools.",
      "",
      "2. Pool contract path: choose chain, paste pool/pair contract, paste the token contract inside that pool. This skips block-number discovery.",
      "",
      "If you are unsure, the pool contract path is usually easiest when you already have a Dexscreener or explorer link."
    ].join("\n");
  }
  if (topic === "chain") {
    return [
      "A chain is the network where the token trades, like Base, Ethereum, BNB Smart Chain, Arbitrum, Polygon, or Avalanche.",
      "",
      `This bot currently shows: ${availableSetupChains(deps).map((chain) => getChain(chain).name).join(", ")}.`
    ].join("\n");
  }
  if (topic === "token" || topic === "target") {
    return [
      "The token contract is the `0x...` address for the token you want alerts for.",
      "",
      "Good places to copy it:",
      "- The token page on the chain explorer, such as Basescan, Etherscan, BscScan, Arbiscan, Polygonscan, or Snowtrace.",
      "- The token's official site/docs.",
      "- A chart page's token details panel.",
      "",
      "Do not paste the ticker, name, or Telegram handle."
    ].join("\n");
  }
  if (topic === "pool") {
    return [
      "The pool contract is the market/pair address where swaps happen.",
      "",
      "Good places to copy it:",
      "- A Dexscreener or GeckoTerminal pair page.",
      "- The pool/pair page on the chain explorer.",
      "- The deployer's launch notes if they provide a known pool.",
      "",
      "If you paste a pool contract, the bot can skip the block-number scan."
    ].join("\n");
  }
  if (topic === "block") {
    return [
      "The first-mint/deployment block is the block number near the token's beginning.",
      "",
      "How to find it:",
      "1. Open the token contract on the chain explorer.",
      "2. Use the contract creation transaction block, or the earliest mint/transfer block if the deployer gives one.",
      "3. Paste only the number, like `23456789`.",
      "",
      "If this feels annoying, use the known pool path instead. `/pool` does not need a deployment block."
    ].join("\n");
  }
  if (topic === "examples") {
    return [
      "Power-user examples:",
      "",
      "/watch base 0xToken any 23456789 all",
      "/watch base 0xToken weth 23456789 uniswap v4",
      "/watch arbitrum 0xToken any 30000000 camelot",
      "",
      "/pool base 0xPoolAddress 0xTargetToken",
      "/pool polygon 0xBalancerOrCurvePool 0xTargetToken",
      "/pool base 0xV4PoolId 0xTargetToken 23457000"
    ].join("\n");
  }
  return "Send /watch to start guided setup, or type the full /watch or /pool command if you already know the details.";
}

async function editOrReply(ctx: Context, text: string, extra?: Parameters<Context["reply"]>[1]): Promise<void> {
  try {
    await ctx.editMessageText(text, extra as Parameters<Context["editMessageText"]>[1]);
  } catch {
    await ctx.reply(text, extra);
  }
}

function chunk<T>(values: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < values.length; index += size) rows.push(values.slice(index, index + size));
  return rows;
}

interface WatchExecutionControls {
  assertScanCooldown(chatId: number): void;
  markScanCooldown(chatId: number): void;
}

async function executeGuidedWatch(
  ctx: Context,
  deps: CommandDeps,
  args: string[],
  controls: WatchExecutionControls
): Promise<void> {
  const parsed = parseWatchArgs(args, deps.env);
  assertSupportedUserChain(parsed.chain);
  controls.assertScanCooldown(ctx.chat!.id);
  controls.markScanCooldown(ctx.chat!.id);
  const runtime = evmRuntime(deps, parsed.chain);
  const existingChat = deps.store.getChat(ctx.chat!.id);
  const wasActive = isTrackingActive(existingChat);

  if (!existingChat && deps.store.getChatCount() >= deps.env.maxChats) {
    throw new Error(`Bot is at capacity (${deps.env.maxChats} chats). Please try later.`);
  }

  const hookFilter = resolveHookDiscoveryFilter(parsed, existingChat);
  const onlyClankerHooks = hookFilter === "clanker";
  const protocols = effectiveProtocols(parsed.protocols, Boolean(hookFilter));
  const dexes = effectiveDexes(parsed.dexes, Boolean(hookFilter));
  const tokenAddress = normalizeAddress(parsed.token);
  const quoteAddress = parsed.quote && isAddress(parsed.quote) ? normalizeAddress(parsed.quote) : undefined;
  const token = await runtime.tokenService.getToken(tokenAddress);
  assertCanTrackToken(existingChat, token.address);
  const { fromBlock, toBlock } = await scanRange(runtime.rpc, deps.env, parsed.deploymentBlock!);
  const existingMatchingPools = Object.values(existingChat?.pools ?? {}).filter((pool) =>
    poolMatchesSelection(pool, tokenAddress, quoteAddress, protocols, dexes)
  );
  const appendMode = parsed.scanMode === "next" && existingMatchingPools.length > 0;
  const excludePoolIds = appendMode ? existingMatchingPools.map((pool) => pool.id.toLowerCase()) : [];
  if (fromBlock > toBlock) throw new Error("No blocks to scan in this range.");

  const cappedNote = rangeLimitNote(fromBlock, toBlock);
  await ctx.reply(
    `Scanning ${selectionLabel(protocols, dexes, parsed.chain)} pools on ${getChain(parsed.chain).name} from block ${fromBlock} to ${toBlock}${cappedNote}.`
  );

  const latest = await runtime.rpc.getBlockNumber();
  const currentBeforeSeed = deps.store.getChat(ctx.chat!.id);
  if (!currentBeforeSeed && deps.store.getChatCount() >= deps.env.maxChats) {
    throw new Error(`Bot is at capacity (${deps.env.maxChats} chats). Please try later.`);
  }
  assertCanTrackToken(currentBeforeSeed, token.address);
  const chat = deps.store.ensureChat(ctx.chat!.id, chatTitle(ctx));
  chat.chain = parsed.chain;
  chat.tokenAddress = token.address;
  chat.token = token;
  chat.enabled = Boolean(currentBeforeSeed?.enabled && Object.keys(currentBeforeSeed.pools).length > 0);
  chat.settings.onlyClankerHooks = onlyClankerHooks;
  chat.lastBlock = Math.max(0, latest - deps.env.confirmations - chat.settings.backfillBlocks);
  deps.store.setChat(chat);
  await deps.store.save();

  const reporter = createProgressReporter(ctx, deps.logger, {
    chatId: ctx.chat!.id,
    token: parsed.token,
    action: "watch"
  });
  let droppedAtCap = 0;
  const pools = await discoverPools(runtime.rpc, {
    chain: parsed.chain,
    poolManagerAddress: deps.env.poolManagerAddresses[parsed.chain],
    token: tokenAddress,
    quote: quoteAddress,
    protocols,
    dexes,
    fromBlock,
    toBlock,
    chunkSize: deps.env.logChunkSize,
    onlyClankerHooks,
    hookFilter,
    stopOnFirst: parsed.scanMode !== "all",
    excludePoolIds,
    onProgress: reporter.onProgress,
    onPoolFound: async (pool) => {
      const current = deps.store.getChat(ctx.chat!.id);
      if (!isCurrentTrackedChat(current, parsed.chain, token.address)) return;
      if (Object.keys(current.pools).length >= deps.env.maxPoolsPerChat) {
        droppedAtCap++;
        return;
      }
      current.pools[pool.id.toLowerCase()] = pool;
      deps.store.setChat(current);
      await deps.store.save();
      deps.logger.info(
        { chatId: ctx.chat!.id, token: token.address, poolId: pool.id, createdBlock: pool.createdBlock },
        "pool added incrementally"
      );
    }
  });
  await reporter.finish(pools.length);

  if (pools.length === 0) {
    if (!existingChat) {
      const current = deps.store.getChat(ctx.chat!.id);
      if (isCurrentTrackedChat(current, parsed.chain, token.address) && Object.keys(current.pools).length === 0) {
        deps.store.deleteChat(ctx.chat!.id);
        await deps.store.save();
      }
    }
    throw new Error(
      appendMode
        ? "No additional matching pools found in the 50k-block deployment window. Try the known pool path with /pool."
        : "No matching pools found in the 50k-block deployment window. Check the block number or try the known pool path with /pool."
    );
  }

  const final = deps.store.getChat(ctx.chat!.id);
  if (!isCurrentTrackedChat(final, parsed.chain, token.address)) {
    await ctx.reply("Watch scan finished, but this chat changed before completion. Ignored stale scan results.");
    return;
  }
  final.enabled = true;
  deps.store.setChat(final);
  await deps.store.save();
  const stored = final ? Object.keys(final.pools).length : 0;
  const truncatedNote =
    droppedAtCap > 0
      ? `\n\n(Stored ${stored} of ${pools.length} pools; capped at ${deps.env.maxPoolsPerChat} per chat - ${droppedAtCap} dropped.)`
      : "";
  await replyLong(
    ctx,
    `Now watching ${token.symbol} (${token.address}) across ${stored} pool(s).\n` +
      `Swap tracker started from block ${chat.lastBlock}.\n\n${poolsSummary(Object.values(final?.pools ?? {}), 10, { fullIdentifiers: true })}${truncatedNote}`
  );
  if (!wasActive) {
    await notifyOwnersAboutTrackingStarted(ctx.telegram, deps.env, deps.logger, {
      chat: final,
      action: "/watch guided",
      actor: ctx.from,
      maxPoolsPerChat: deps.env.maxPoolsPerChat
    });
  }
}

function isTopicSettingKey(key: string): boolean {
  return ["topic", "thread", "alerttopic", "alert_topic", "alertthread", "alert_thread"].includes(key.toLowerCase());
}

function isCustomSettingKey(key: string): key is CustomSettingKey {
  return ["minusd", "minquote", "emoji", "emojistep", "maxemojis", "media", "mediaupload", "topic", "backfill"].includes(key);
}

function pendingSettingId(chatId: number, userId: number): string {
  return `${chatId}:${userId}`;
}

function applyCustomSetting(chat: ChatState, key: CustomSettingKey, value: string, ctx: Context): string {
  if (key === "topic") return applyAlertThreadSetting(chat, value, ctx);
  if (key === "mediaupload") throw new Error("Upload a photo or GIF from your device, or send /cancel to stop.");
  applySetting(chat, key, value);
  return `${customSettingName(key)} updated.`;
}

function customSettingName(key: CustomSettingKey): string {
  switch (key) {
    case "minusd":
      return "Minimum USD";
    case "minquote":
      return "Minimum quote";
    case "emoji":
      return "Emoji";
    case "emojistep":
      return "Emoji step";
    case "maxemojis":
      return "Max emojis";
    case "media":
      return "Media";
    case "mediaupload":
      return "Media upload";
    case "topic":
      return "Alert topic";
    case "backfill":
      return "Backfill";
  }
}

function customSettingPrompt(key: CustomSettingKey, chat: ChatState): string {
  switch (key) {
    case "minusd":
      return [
        "💵 Send a custom minimum USD buy.",
        `Current: ${chat.settings.minUsd}`,
        "Example: 37.5",
        "Send /cancel to stop."
      ].join("\n");
    case "minquote":
      return [
        "🪙 Send a custom minimum quote-token buy.",
        `Current: ${chat.settings.minQuote}`,
        "Example: 0.25",
        "Send /cancel to stop."
      ].join("\n");
    case "emoji":
      return [
        "🎨 Send the emoji or text to repeat in the buy bar.",
        `Current: ${chat.settings.emoji}`,
        "Example: 🐸 or APE",
        "Send /cancel to stop."
      ].join("\n");
    case "emojistep":
      return [
        "📏 Send the USD value represented by one emoji.",
        `Current: ${chat.settings.emojiStepUsd}`,
        "Example: 15",
        "Send /cancel to stop."
      ].join("\n");
    case "maxemojis":
      return [
        "🔢 Send the maximum number of emojis in a buy alert.",
        `Current: ${chat.settings.maxEmojis}`,
        "Example: 33",
        "Send /cancel to stop."
      ].join("\n");
    case "media":
      return [
        "🖼 Send a custom media URL, or send off to remove media.",
        "To upload from your device, go back and tap Upload photo/GIF.",
        "Example: https://example.com/buy.gif",
        "Send /cancel to stop."
      ].join("\n");
    case "mediaupload":
      return [
        "📤 Upload a photo or GIF from your device now.",
        "The next image or animation you send in this chat will become the buy alert media.",
        "Send /cancel to stop."
      ].join("\n");
    case "topic":
      return [
        "🧵 Send a custom Telegram forum topic id.",
        `Current: ${chat.alertThreadId ? `#${chat.alertThreadId}` : "main chat"}`,
        "Example: 123, here, or off",
        "Send /cancel to stop."
      ].join("\n");
    case "backfill":
      return [
        "⏪ Send custom resume backfill blocks.",
        `Current: ${chat.settings.backfillBlocks}`,
        "Example: 750",
        "Send /cancel to stop."
      ].join("\n");
  }
}

function applyAlertThreadSetting(chat: ChatState, rawValue: string, ctx: Context): string {
  const value = rawValue.trim().toLowerCase();
  if (["off", "none", "false", "0", "clear", "main", "general"].includes(value)) {
    delete chat.alertThreadId;
    return "Alert topic cleared. Buy alerts will go to the main supergroup chat.";
  }

  if (["", "here", "this", "current"].includes(value)) {
    const threadId = currentMessageThreadId(ctx);
    if (!threadId) {
      throw new Error("Run /topic or /set topic here inside the forum topic where buy alerts should be posted.");
    }
    chat.alertThreadId = threadId;
    return `Alert topic set to this thread (#${threadId}).`;
  }

  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) {
    chat.alertThreadId = parsed;
    return `Alert topic set to thread #${parsed}.`;
  }

  throw new Error("Use /topic in the desired forum topic, /topic off, /set topic here, or /set topic <threadId>.");
}

function currentMessageThreadId(ctx: Context): number | undefined {
  const callbackMessage =
    ctx.callbackQuery && "message" in ctx.callbackQuery
      ? (ctx.callbackQuery.message as { message_thread_id?: unknown } | undefined)
      : undefined;
  const message = (ctx.message as { message_thread_id?: unknown } | undefined) ?? callbackMessage;
  const raw = message?.message_thread_id;
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : undefined;
}

function dbOverview(chats: ChatState[], bannedChatIds: number[]): string {
  const active = chats.filter((chat) => chat.enabled && chat.tokenAddress && Object.keys(chat.pools).length > 0);
  const totalPools = chats.reduce((sum, chat) => sum + Object.keys(chat.pools).length, 0);
  const topics = chats.filter((chat) => chat.alertThreadId).length;
  const chains = new Map<string, number>();
  for (const chat of chats) {
    const chain = chat.chain ?? "base";
    chains.set(chain, (chains.get(chain) ?? 0) + 1);
  }
  const chainLine = [...chains.entries()].sort().map(([chain, count]) => `${chain}:${count}`).join(", ") || "-";
  return [
    "DB snapshot",
    `Chats: ${chats.length}`,
    `Active chats: ${active.length}`,
    `Tracked pools: ${totalPools}`,
    `Chats with alert topic: ${topics}`,
    `Banned chats: ${bannedChatIds.length}`,
    `Chains: ${chainLine}`,
    "",
    "Views:",
    `/${OWNER_COMMANDS.db} chats`,
    `/${OWNER_COMMANDS.db} chat <chatId>`,
    `/${OWNER_COMMANDS.db} pools <chatId>`,
    `/${OWNER_COMMANDS.db} banned`,
    `/${OWNER_COMMANDS.db} runtime`
  ].join("\n");
}

function dbRuntimeView(env: CommandDeps["env"]): string {
  return [
    "Runtime",
    `PID: ${process.pid}`,
    `CWD: ${process.cwd()}`,
    `Storage backend: ${env.storageBackend}`,
    `Data file: ${env.dataFile}`,
    `Primary chain: ${env.primaryChain}`,
    `Enabled chains: ${env.enabledChains.join(", ")}`,
    `Telegram mode: ${env.telegramMode}`,
    `Web enabled: ${env.webEnabled ? "yes" : "no"}`,
    `Markets enabled: ${env.marketsEnabled ? "yes" : "no"}`,
    `Market archive: ${env.marketArchiveEnabled ? "on" : "off"}`,
    `Wallet PnL: ${env.walletPnlEnabled ? `on (${env.walletPnlChain}, ${env.walletPnlRetentionDays}d retention)` : "off"}`,
    `Uptime: ${Math.floor(process.uptime())}s`
  ].join("\n");
}

async function dbChatsView(ctx: Context, deps: CommandDeps, chats: ChatState[]): Promise<string> {
  if (chats.length === 0) return "No chats yet.";
  const selected = chats
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 100);
  const lines = await dbChatLines(ctx, deps, selected);
  if (chats.length > 100) lines.push(`...and ${chats.length - 100} more.`);
  return lines.join("\n");
}

async function dbChatLines(ctx: Context, deps: CommandDeps, chats: ChatState[]): Promise<string[]> {
  const lines: string[] = [];
  for (const chat of chats) {
    lines.push(dbChatLine(chat, await resolveStoredChatSummary(ctx, deps, chat)));
  }
  return lines;
}

async function resolveStoredChatSummary(ctx: Context, deps: CommandDeps, chat: ChatState): Promise<OwnerChatSummary> {
  return resolveOwnerChatSummary(
    ctx.telegram,
    chat.chatId,
    { chatId: chat.chatId, fallbackTitle: chat.title },
    deps.logger
  );
}

function dbChatLine(chat: ChatState, summary?: OwnerChatSummary): string {
  const status = chat.enabled ? "ON" : "PAUSED";
  const token = chat.token?.symbol ?? "-";
  const tokenId = chat.tokenAddress ? ` ${chat.tokenAddress}` : "";
  const pools = Object.keys(chat.pools).length;
  const topic = chat.alertThreadId ? ` topic #${chat.alertThreadId}` : "";
  const title = summary?.title ?? chat.title ?? "?";
  const links = compactChatLinks(summary);
  return `${status} ${chat.chatId}${topic} | ${chat.chain ?? "base"} | ${token}${tokenId} | ${pools} pool(s) | ${title}${links}`;
}

async function dbChatDetail(ctx: Context, deps: CommandDeps, chat: ChatState): Promise<string> {
  const summary = await resolveStoredChatSummary(ctx, deps, chat);
  const pools = Object.keys(chat.pools).length;
  return [
    `Chat id: ${chat.chatId}`,
    `Title: ${summary.title ?? chat.title ?? "?"}`,
    `Type: ${summary.type ?? "-"}`,
    `Username: ${summary.username ? `@${summary.username}` : "-"}`,
    `Public link: ${summary.username ? `https://t.me/${summary.username}` : "-"}`,
    `Invite link: ${summary.inviteLink ?? "-"}`,
    `Enabled: ${chat.enabled ? "yes" : "no"}`,
    `Chain: ${chat.chain ?? "base"}`,
    `Alert topic: ${chat.alertThreadId ? `#${chat.alertThreadId}` : "main chat"}`,
    `Token: ${chat.token?.symbol ?? "-"} ${chat.tokenAddress ? `(${chat.tokenAddress})` : ""}`,
    `Pools: ${pools}`,
    `Last block: ${chat.lastBlock ?? "-"}`,
    `Last signature: ${chat.lastSignature ? shortHex(chat.lastSignature, 6, 6) : "-"}`,
    `Min USD: ${chat.settings.minUsd}`,
    `Min quote: ${chat.settings.minQuote}`,
    `Tx link: ${chat.settings.showTxLink ? "on" : "off"}`,
    `Chart link: ${chat.settings.showChartLink ? "on" : "off"}`,
    `Media: ${chat.settings.media ? chat.settings.media.kind : chat.settings.mediaUrl ? "url" : "off"}`,
    `Backfill blocks: ${chat.settings.backfillBlocks}`,
    `Only Clanker hooks: ${chat.settings.onlyClankerHooks ? "on" : "off"}`,
    `Created: ${chat.createdAt}`,
    `Updated: ${chat.updatedAt}`,
    "",
    `Run /${OWNER_COMMANDS.db} pools ${chat.chatId} to inspect pool rows.`
  ].join("\n");
}

function compactChatLinks(summary: OwnerChatSummary | undefined): string {
  if (!summary) return "";
  const parts = [
    summary.username ? `@${summary.username}` : undefined,
    summary.username ? `https://t.me/${summary.username}` : undefined,
    summary.inviteLink ? `invite ${summary.inviteLink}` : undefined
  ].filter((part): part is string => Boolean(part));
  return parts.length ? ` | ${parts.join(" | ")}` : "";
}
