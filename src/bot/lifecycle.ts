import type { Telegraf } from "telegraf";
import type { Logger } from "pino";
import type { Env } from "../config/env";
import type { Storage } from "../store/storage";
import { welcomeText } from "./messages";
import { notifyOwnersAboutChatAdded, notifyOwnersAboutChatRemoved } from "./ownerAlerts";
import { migrateChatId } from "./chatMigration";

interface Deps {
  env: Env;
  store: Storage;
  logger: Logger;
}

export function registerLifecycle(bot: Telegraf, deps: Deps): void {
  const { env, store, logger } = deps;

  // Upgrading a basic group to a supergroup changes its chat id. Telegram announces it with a
  // service message in both chats: migrate_to_chat_id in the old one, migrate_from_chat_id in
  // the new one. Catch either so the stored record follows the group instead of going stale.
  bot.use(async (ctx, next) => {
    const message = ctx.message as
      | { migrate_to_chat_id?: number; migrate_from_chat_id?: number }
      | undefined;
    const chatId = ctx.chat?.id;
    if (message && chatId !== undefined) {
      try {
        if (typeof message.migrate_to_chat_id === "number") {
          await migrateChatId(store, logger, chatId, message.migrate_to_chat_id);
        } else if (typeof message.migrate_from_chat_id === "number") {
          await migrateChatId(store, logger, message.migrate_from_chat_id, chatId);
        }
      } catch (error) {
        logger.error({ error, chatId }, "chat migration handler failed");
      }
    }
    return next();
  });

  // Fires when the bot's own membership in a chat changes (added, promoted, kicked, left).
  bot.on("my_chat_member", async (ctx) => {
    try {
      const update = ctx.myChatMember;
      const chat = update.chat;
      const newStatus = update.new_chat_member.status;
      const oldStatus = update.old_chat_member.status;

      if (newStatus === "kicked" || newStatus === "left") {
        const stored = store.getChat(chat.id);
        const title = "title" in chat ? chat.title : stored?.title;
        store.deleteChat(chat.id);
        await store.save();
        await notifyOwnersAboutChatRemoved(ctx.telegram, env, logger, {
          chatId: chat.id,
          fallbackTitle: title,
          fallbackType: chat.type,
          actor: update.from,
          status: newStatus,
          chatCount: store.getChatCount(),
          maxChats: env.maxChats
        });
        logger.info({ chatId: chat.id, status: newStatus }, "bot removed from chat; state cleared");
        return;
      }

      const becameMember =
        (oldStatus === "left" || oldStatus === "kicked") &&
        (newStatus === "member" || newStatus === "administrator");
      if (!becameMember) return;

      if (store.isChatBanned(chat.id)) {
        try { await ctx.telegram.leaveChat(chat.id); } catch { /* ignore */ }
        logger.info({ chatId: chat.id }, "left banned chat on join");
        return;
      }

      if (!env.publicMode && env.allowedChatIds.length > 0 && !env.allowedChatIds.includes(chat.id)) {
        try {
          await ctx.telegram.sendMessage(
            chat.id,
            "This bot instance is in private mode and is not configured for this chat. The bot will now leave."
          );
          await ctx.telegram.leaveChat(chat.id);
        } catch { /* ignore */ }
        logger.info({ chatId: chat.id }, "left non-allowed chat in private mode");
        return;
      }

      if (store.getChatCount() >= env.maxChats && !store.getChat(chat.id)) {
        try {
          await ctx.telegram.sendMessage(
            chat.id,
            `This bot has reached its capacity (MAX_CHATS=${env.maxChats}). Please try again later or run your own instance.`
          );
          await ctx.telegram.leaveChat(chat.id);
        } catch { /* ignore */ }
        logger.warn({ chatId: chat.id, max: env.maxChats }, "rejected new chat at capacity");
        return;
      }

      const title = "title" in chat ? chat.title : undefined;
      store.ensureChat(chat.id, title);
      await store.save();
      await notifyOwnersAboutChatAdded(ctx.telegram, env, logger, {
        chatId: chat.id,
        fallbackTitle: title,
        fallbackType: chat.type,
        actor: update.from,
        chatCount: store.getChatCount(),
        maxChats: env.maxChats
      });

      try {
        await ctx.telegram.sendMessage(chat.id, welcomeText(env), { parse_mode: "Markdown" });
      } catch (error) {
        logger.warn({ error, chatId: chat.id }, "failed to send welcome message");
      }
    } catch (error) {
      logger.error({ error }, "my_chat_member handler failed");
    }
  });
}
