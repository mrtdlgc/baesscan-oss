import type { Context, MiddlewareFn } from "telegraf";
import type { Logger } from "pino";
import type { Env } from "../config/env";
import type { Storage } from "../store/storage";

/** Telegram routes posts from admins with "Remain Anonymous" enabled through this account. */
const GROUP_ANONYMOUS_BOT_ID = 1087968824;
/** ...and posts made under a channel's identity through this one. */
const CHANNEL_BOT_ID = 136817688;

export function isOwner(ctx: Context, env: Env): boolean {
  const userId = ctx.from?.id;
  if (!userId) return false;
  return env.ownerUserIds.includes(userId);
}

export async function isAdmin(ctx: Context, env: Env, store?: Storage, logger?: Logger): Promise<boolean> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  if (!userId || !chatId) return false;

  if (store?.isChatBanned(chatId)) return false;

  // Owners can always run admin commands.
  if (env.ownerUserIds.includes(userId)) return true;

  // ALLOWED_CHAT_IDS, when set, restricts where the bot may operate.
  if (!env.publicMode && env.allowedChatIds.length > 0 && !env.allowedChatIds.includes(chatId)) return false;
  // ADMIN_USER_IDS, when set, restricts which users may run admin commands globally.
  if (env.adminUserIds.length > 0 && !env.adminUserIds.includes(userId)) {
    logger?.warn(
      { chatId, userId, anonymous: userId === GROUP_ANONYMOUS_BOT_ID },
      userId === GROUP_ANONYMOUS_BOT_ID
        ? "admin denied: anonymous admins cannot be matched against ADMIN_USER_IDS"
        : "admin denied: user not in ADMIN_USER_IDS"
    );
    return false;
  }

  if (ctx.chat?.type === "private") {
    // In private chats, anyone configuring is the de facto admin of their own DM.
    return true;
  }

  // Anonymous admins arrive as GroupAnonymousBot with the group itself in sender_chat.
  // Telegram only ever routes real admins through that account, and getChatMember cannot
  // resolve it, so accept it before falling through to the lookup below.
  if (userId === GROUP_ANONYMOUS_BOT_ID) return true;

  if (userId === CHANNEL_BOT_ID) {
    // Posting under a channel identity says nothing about group admin rights.
    logger?.warn({ chatId, senderChatId: ctx.senderChat?.id }, "admin denied: sent under a channel identity");
    return false;
  }

  try {
    const member = await ctx.telegram.getChatMember(chatId, userId);
    const allowed = member.status === "creator" || member.status === "administrator";
    if (!allowed) {
      logger?.warn({ chatId, userId, status: member.status }, "admin denied: not a group admin");
    }
    return allowed;
  } catch (error) {
    // Never silently deny: a transient getChatMember failure looks identical to a real
    // rejection from the user's side, so leave a trace to diagnose it.
    logger?.warn({ error, chatId, userId }, "admin denied: getChatMember lookup failed");
    return false;
  }
}

export function adminOnly(env: Env, store?: Storage, logger?: Logger): MiddlewareFn<Context> {
  return async (ctx, next) => {
    if (await isAdmin(ctx, env, store, logger)) return next();
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
