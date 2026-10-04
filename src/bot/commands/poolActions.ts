import type { Context } from "telegraf";
import { discoverPoolByAddress } from "../../dex/discovery";
import { discoverPoolById, getOtherCurrency } from "../../dex/uniswap";
import { getChain } from "../../chains/registry";
import type { Address, ChainSlug, ChatState, Hex32, TokenId } from "../../types";
import { normalizeAddress } from "../../utils/address";
import { assertCanTrackToken, chatTitle, createProgressReporter, inferTargetTokenFromPool, isPoolCurrency, parsePoolIdArgs, poolDisplayLabel, rangeLimitNote, scanRange } from "../commandHelpers";
import { isTrackingActive, notifyOwnersAboutTrackingStarted } from "../ownerAlerts";
import { evmRuntime } from "./runtime";
import type { CommandDeps } from "./types";

export async function addPoolById(ctx: Context, deps: CommandDeps, chain: ChainSlug, poolId: Hex32, args: string[]): Promise<void> {
  const runtime = evmRuntime(deps, chain);
  const parsed = parsePoolIdArgs(args);
  const targetHint = parsed.targetToken;
  if (parsed.fromBlock === undefined) {
    throw new Error("Pool creation block is required for v4 pool id lookup. Use /pool <poolId> <targetToken> <poolCreationBlock>, or add the full v4 pool tuple manually.");
  }
  const { fromBlock, toBlock } = await scanRange(runtime.rpc, deps.env, parsed.fromBlock);

  await ctx.reply(`Looking up ${getChain(chain).name} v4 pool ${poolId} from block ${fromBlock} to ${toBlock}${rangeLimitNote(fromBlock, toBlock)}.`);
  const reporter = createProgressReporter(ctx, deps.logger, {
    chatId: ctx.chat!.id,
    token: targetHint ?? poolId,
    action: "pool"
  });

  const pool = await discoverPoolById(runtime.rpc, {
    chain,
    poolManagerAddress: deps.env.poolManagerAddresses[chain]!,
    poolId,
    fromBlock,
    toBlock,
    chunkSize: deps.env.logChunkSize,
    blockscoutClient: deps.blockscoutClient,
    logger: deps.logger,
    onProgress: reporter.onProgress
  });
  await reporter.finish(pool ? 1 : 0);

  if (!pool) {
    throw new Error(
      "Pool id was not found in the 50k-block range. Check the pool creation block or add the full pool tuple manually."
    );
  }

  const targetToken = parsed.targetToken ?? inferTargetTokenFromPool(pool, chain);
  if (!targetToken) {
    throw new Error(
      "Could not infer which side to track. Use /pool <poolId> <targetToken> <poolCreationBlock>."
    );
  }
  if (!isPoolCurrency(pool, targetToken)) {
    throw new Error("targetToken must be one of the pool currencies.");
  }

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

  const quoteAddress = getOtherCurrency(pool, token.address);
  await ctx.reply(
    `Added ${poolDisplayLabel(pool)} pool ${pool.id} for ${token.symbol} (${token.address}), paired with ${quoteAddress}.`
  );
  if (!wasActive) {
    await notifyOwnersAboutTrackingStarted(ctx.telegram, deps.env, deps.logger, {
      chat,
      action: "/pool",
      actor: ctx.from,
      maxPoolsPerChat: deps.env.maxPoolsPerChat
    });
  }
}

export async function addPoolByAddress(ctx: Context, deps: CommandDeps, chain: ChainSlug, poolAddress: Address, args: string[]): Promise<void> {
  const runtime = evmRuntime(deps, chain);
  const parsed = parsePoolIdArgs(args);

  await ctx.reply(`Looking up pool ${poolAddress} on ${getChain(chain).name}.`);
  const pool = await discoverPoolByAddress(runtime.rpc, { chain, poolAddress });
  if (!pool) throw new Error("Pool address was not found or does not expose token0/token1.");

  const targetToken = parsed.targetToken ?? inferTargetTokenFromPool(pool, chain);
  if (!targetToken) {
    throw new Error("Could not infer which side to track. Use /pool <poolAddress> <targetToken>.");
  }
  if (!isPoolCurrency(pool, targetToken)) {
    throw new Error("targetToken must be one of the pool currencies.");
  }

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

  const quoteAddress = getOtherCurrency(pool, token.address);
  await ctx.reply(
    `Added ${poolDisplayLabel(pool)} pool ${pool.id} for ${token.symbol} (${token.address}), paired with ${quoteAddress}.`
  );
  if (!wasActive) {
    await notifyOwnersAboutTrackingStarted(ctx.telegram, deps.env, deps.logger, {
      chat,
      action: "/pool",
      actor: ctx.from,
      maxPoolsPerChat: deps.env.maxPoolsPerChat
    });
  }
}

export function isCurrentTrackedChat(
  chat: ChatState | undefined,
  chain: ChainSlug,
  tokenAddress: TokenId,
  opts: { requireEnabled?: boolean } = {}
): chat is ChatState {
  return Boolean(
    chat &&
      (!opts.requireEnabled || chat.enabled) &&
      (chat.chain ?? "base") === chain &&
      chat.tokenAddress &&
      String(chat.tokenAddress).toLowerCase() === String(tokenAddress).toLowerCase()
  );
}
