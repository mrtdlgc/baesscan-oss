import type { Context, MiddlewareFn } from "telegraf";
import type { Env } from "../config/env";
import type { Storage } from "../store/storage";

export function isOwner(ctx: Context, env: Env): boolean {
  const userId = ctx.from?.id;
  if (!userId) return false;
  return env.ownerUserIds.includes(userId);
}

export async function isAdmin(ctx: Context, env: Env, store?: Storage): Promise<boolean> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  if (!userId || !chatId) return false;

  if (store?.isChatBanned(chatId)) return false;

  // Owners can always run admin commands.
  if (env.ownerUserIds.includes(userId)) return true;

  // ALLOWED_CHAT_IDS, when set, restricts where the bot may operate.
  if (!env.publicMode && env.allowedChatIds.length > 0 && !env.allowedChatIds.includes(chatId)) return false;
  // ADMIN_USER_IDS, when set, restricts which users may run admin commands globally.
  if (env.adminUserIds.length > 0 && !env.adminUserIds.includes(userId)) return false;

  if (ctx.chat?.type === "private") {
    // In private chats, anyone configuring is the de facto admin of their own DM.
    return true;
  }

  try {
    const member = await ctx.telegram.getChatMember(chatId, userId);
    return member.status === "creator" || member.status === "administrator";
  } catch {
    return false;
  }
}

export function adminOnly(env: Env, store?: Storage): MiddlewareFn<Context> {
  return async (ctx, next) => {
    if (await isAdmin(ctx, env, store)) return next();
    await ctx.reply("Only a group admin can use that command.");
  };
}

export function ownerOnly(env: Env): MiddlewareFn<Context> {
  return async (ctx, next) => {
    if (isOwner(ctx, env)) return next();
    await ctx.reply("Owner-only command.");
  };
}

export function chatGate(env: Env, store: Storage): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return next();
    if (store.isChatBanned(chatId)) {
      // Silently ignore banned chats.
      return;
    }
    if (!env.publicMode && env.allowedChatIds.length > 0 && !env.allowedChatIds.includes(chatId)) {
      // Allow owners to recover access.
      if (!isOwner(ctx, env)) return;
    }
    return next();
  };
}
