import type { Logger } from "pino";
import type { ChatState } from "../types";
import type { Storage } from "../store/storage";

function isConfigured(chat: ChatState | undefined): boolean {
  return Boolean(chat && chat.tokenAddress && Object.keys(chat.pools).length > 0);
}

/**
 * Telegram issues a brand new chat id when a basic group is upgraded to a supergroup.
 * The old id stops accepting messages, so a chat record left behind on it is dead weight:
 * every send fails with "group chat was upgraded to a supergroup chat", forever.
 *
 * Moves the stored record onto the new id, keeping whichever side actually holds the
 * tracking config, and drops the stale one. Safe to call repeatedly.
 */
export async function migrateChatId(
  store: Storage,
  logger: Logger,
  fromChatId: number,
  toChatId: number
): Promise<boolean> {
  if (!Number.isFinite(fromChatId) || !Number.isFinite(toChatId)) return false;
  if (fromChatId === toChatId) return false;

  const source = store.getChat(fromChatId);
  // Already migrated by an earlier update; nothing left to move.
  if (!source) return false;

  const target = store.getChat(toChatId);
  const carriedConfig = !isConfigured(target);

  if (carriedConfig) {
    // The supergroup either has no record yet, or only an empty stub from ensureChat.
    // Carry the old chat's tracking config across so alerts survive the upgrade.
    store.setChat({
      ...source,
      chatId: toChatId,
      title: target?.title ?? source.title
    });
  }

  store.deleteChat(fromChatId);
  await store.save();

  logger.info(
    {
      fromChatId,
      toChatId,
      carriedConfig,
      tokenAddress: source.tokenAddress,
      poolCount: Object.keys(source.pools).length
    },
    "chat migrated to supergroup id"
  );
  return true;
}

/** Pulls the new chat id out of a Telegram 400 "upgraded to a supergroup" error, if present. */
export function migrateTargetFromError(error: unknown): number | undefined {
  const response = (error as { response?: { parameters?: { migrate_to_chat_id?: number } } })?.response;
  const target = response?.parameters?.migrate_to_chat_id;
  return typeof target === "number" ? target : undefined;
}
