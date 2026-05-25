import type { Context } from "telegraf";
import { getChain } from "../../chains/registry";
import { getSolanaTokenActivity, getSolanaTokenMetadata, solanaActivitySummary, solanaPoolForMint } from "../../solana/activity";
import type { SolanaRpcClient } from "../../solana/activity";
import type { PoolDex, TokenId } from "../../types";
import { assertCanTrackToken, chatTitle, replyLong } from "../commandHelpers";
import { isTrackingActive, notifyOwnersAboutTrackingStarted } from "../ownerAlerts";
import { solanaRuntime } from "./runtime";
import type { CommandDeps } from "./types";

export async function scanSolanaToken(ctx: Context, deps: CommandDeps, token: TokenId): Promise<void> {
  const mint = String(token);
  const client = solanaRuntime(deps);
  await ctx.reply(`Scanning recent Solana transactions for ${mint} using raw RPC.`);
  const activity = await getSolanaTokenActivity(client, mint, deps.env);
  await replyLong(ctx, solanaActivitySummary(activity));
}

export async function watchSolanaToken(
  ctx: Context,
  deps: CommandDeps,
  token: TokenId,
  quote?: TokenId,
  dexes?: PoolDex[]
): Promise<void> {
  const mint = String(token);
  const quoteMint = quote ? String(quote) : getChain("solana").nativeLikeQuotes[0]!;
  const client = solanaRuntime(deps);
  const existingChat = deps.store.getChat(ctx.chat!.id);
  const wasActive = isTrackingActive(existingChat);
  if (!existingChat && deps.store.getChatCount() >= deps.env.maxChats) {
    throw new Error(`Bot is at capacity (${deps.env.maxChats} chats). Please try later.`);
  }
  const metadata = await getSolanaTokenMetadata(client, mint);
  assertCanTrackToken(existingChat, metadata.address);
  const activity = await getSolanaTokenActivity(client, mint, deps.env);
  const pool = solanaPoolForMint(mint, quoteMint, dexes?.[0] ?? activity.events[0]?.dexes[0]);
  const currentBeforeSave = deps.store.getChat(ctx.chat!.id);
  if (!currentBeforeSave && deps.store.getChatCount() >= deps.env.maxChats) {
    throw new Error(`Bot is at capacity (${deps.env.maxChats} chats). Please try later.`);
  }
  assertCanTrackToken(currentBeforeSave, metadata.address);
  const chat = deps.store.ensureChat(ctx.chat!.id, chatTitle(ctx));
  chat.chain = "solana";
  chat.tokenAddress = mint;
  chat.token = metadata;
  chat.enabled = true;
  chat.lastSignature = activity.newestSignature;
  chat.pools[pool.id.toLowerCase()] = pool;
  deps.store.setChat(chat);
  await deps.store.save();
  await replyLong(
    ctx,
    `Now watching Solana mint ${mint} from latest signature ${chat.lastSignature?.slice(0, 8) ?? "unknown"}.\n\n` +
      `${solanaActivitySummary(activity)}`
  );
  if (!wasActive) {
    await notifyOwnersAboutTrackingStarted(ctx.telegram, deps.env, deps.logger, {
      chat,
      action: "/watch",
      actor: ctx.from,
      maxPoolsPerChat: deps.env.maxPoolsPerChat
    });
  }
}

export async function latestSolanaSignature(client: SolanaRpcClient, mint: string): Promise<string | undefined> {
  return (await client.getSignaturesForAddress(mint, 1))[0]?.signature;
}
