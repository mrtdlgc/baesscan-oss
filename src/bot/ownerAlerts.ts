import type { Telegram } from "telegraf";
import type { Logger } from "pino";
import type { Env } from "../config/env";
import { chainLabel } from "../chains/registry";
import type { ChatState } from "../types";

interface ActorLike {
  id?: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface ChatLike {
  id: number;
  type?: string;
  title?: string;
  username?: string;
  invite_link?: string;
  first_name?: string;
  last_name?: string;
}

export interface OwnerChatSummary {
  id: number;
  type?: string;
  title?: string;
  username?: string;
  inviteLink?: string;
}

interface ChatAlertInput {
  chatId: number;
  fallbackTitle?: string;
  fallbackType?: string;
  actor?: ActorLike;
  chatCount?: number;
  maxChats?: number;
}

interface TrackingAlertInput {
  chat: ChatState;
  action: string;
  actor?: ActorLike;
  maxPoolsPerChat: number;
}

export function isTrackingActive(chat: ChatState | undefined): boolean {
  return Boolean(chat?.enabled && chat.tokenAddress && Object.keys(chat.pools).length > 0);
}

export async function notifyOwnersAboutChatAdded(
  telegram: Telegram,
  env: Env,
  logger: Logger,
  input: ChatAlertInput
): Promise<void> {
  const summary = await resolveOwnerChatSummary(telegram, input.chatId, input, logger);
  const lines = [
    "BAESBuybot added to a chat",
    ...formatChatSummary(summary),
    input.actor ? `Added by: ${formatActor(input.actor)}` : undefined,
    formatCapacityLine(input.chatCount, input.maxChats)
  ].filter((line): line is string => Boolean(line));
  await notifyOwners(telegram, env, logger, lines.join("\n"));
}

export async function notifyOwnersAboutChatRemoved(
  telegram: Telegram,
  env: Env,
  logger: Logger,
  input: ChatAlertInput & { status: string }
): Promise<void> {
  const summary = await resolveOwnerChatSummary(telegram, input.chatId, input, logger);
  const lines = [
    "BAESBuybot removed from a chat",
    `Status: ${input.status}`,
    ...formatChatSummary(summary),
    input.actor ? `Changed by: ${formatActor(input.actor)}` : undefined,
    formatCapacityLine(input.chatCount, input.maxChats)
  ].filter((line): line is string => Boolean(line));
  await notifyOwners(telegram, env, logger, lines.join("\n"));
}

export async function notifyOwnersAboutTrackingStarted(
  telegram: Telegram,
  env: Env,
  logger: Logger,
  input: TrackingAlertInput
): Promise<void> {
  const summary = await resolveOwnerChatSummary(
    telegram,
    input.chat.chatId,
    { chatId: input.chat.chatId, fallbackTitle: input.chat.title, fallbackType: "chat" },
    logger
  );
  const token = input.chat.token?.symbol ?? "-";
  const tokenId = input.chat.tokenAddress ? ` (${input.chat.tokenAddress})` : "";
  const lines = [
    "BAESBuybot tracking started",
    ...formatChatSummary(summary),
    `Action: ${input.action}`,
    input.actor ? `Started by: ${formatActor(input.actor)}` : undefined,
    `Chain: ${chainLabel(input.chat.chain ?? env.primaryChain)}`,
    `Token: ${token}${tokenId}`,
    `Pools: ${Object.keys(input.chat.pools).length}/${input.maxPoolsPerChat}`
  ].filter((line): line is string => Boolean(line));
  await notifyOwners(telegram, env, logger, lines.join("\n"));
}

async function notifyOwners(telegram: Telegram, env: Env, logger: Logger, text: string): Promise<void> {
  if (env.ownerUserIds.length === 0) return;
  for (const ownerId of env.ownerUserIds) {
    try {
      await telegram.sendMessage(ownerId, text, { link_preview_options: { is_disabled: true } });
    } catch (error) {
      logger.warn({ error, ownerId }, "failed to send owner alert");
    }
  }
}

export async function resolveOwnerChatSummary(
  telegram: Telegram,
  chatId: number,
  fallback: ChatAlertInput,
  logger: Logger
): Promise<OwnerChatSummary> {
  try {
    const chat = (await telegram.getChat(chatId)) as ChatLike;
    return {
      id: chat.id,
      type: chat.type ?? fallback.fallbackType,
      title: chat.title ?? fullName(chat) ?? fallback.fallbackTitle,
      username: chat.username,
      inviteLink: chat.invite_link
    };
  } catch (error) {
    logger.warn({ error, chatId }, "failed to resolve chat metadata");
    return {
      id: chatId,
      type: fallback.fallbackType,
      title: fallback.fallbackTitle
    };
  }
}

function formatChatSummary(summary: OwnerChatSummary): string[] {
  const lines = [
    `Chat: ${summary.title ?? "unknown"}`,
    `ID: ${summary.id}`,
    summary.type ? `Type: ${summary.type}` : undefined,
    summary.username ? `Username: @${summary.username}` : undefined,
    summary.username ? `Public link: https://t.me/${summary.username}` : undefined,
    summary.inviteLink ? `Invite link: ${summary.inviteLink}` : undefined
  ];
  return lines.filter((line): line is string => Boolean(line));
}

function formatActor(actor: ActorLike): string {
  const handle = actor.username ? `@${actor.username}` : fullName(actor);
  return handle ? `${handle} (${actor.id ?? "unknown"})` : String(actor.id ?? "unknown");
}

function fullName(value: { first_name?: string; last_name?: string }): string | undefined {
  const name = [value.first_name, value.last_name].filter(Boolean).join(" ").trim();
  return name || undefined;
}

function formatCapacityLine(chatCount?: number, maxChats?: number): string | undefined {
  if (chatCount === undefined || maxChats === undefined) return undefined;
  return `Stored chats: ${chatCount}/${maxChats}`;
}
