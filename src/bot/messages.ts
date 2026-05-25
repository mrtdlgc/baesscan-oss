import { Markup, Telegram } from "telegraf";
import type { InlineKeyboardMarkup } from "telegraf/types";
import type { BuyEvent, ChatState, PoolKey } from "../types";
import type { Env } from "../config/env";
import { chainLabel, getChain } from "../chains/registry";
import { dexLabel, poolDex, poolVersionLabel } from "../dex/discovery";
import { escapeHtml, formatCompactNumber, formatFee, formatPrice, formatUsd, trimDecimals, wrapEmojiBar } from "../utils/format";
import { shortAddress, shortHex } from "../utils/address";

export function welcomeText(env: Env): string {
  const support = env.supportUrl ? `\nSupport: ${env.supportUrl}` : "";
  return [
    `*${env.brandName}*`,
    "",
    `Thanks for adding me. I track raw DEX pool buys on ${env.enabledChains.map(chainLabel).join(", ")}.`,
    "",
    "Quick start (group admins only):",
    "1. `/watch` - open guided setup with chain, token, pool, and block-number help.",
    "2. `/settings` - tune minimum buys, media, emoji, topics, and links.",
    "3. `/testbuy` - send a sample alert.",
    "",
    "Type /help for all commands." + support
  ].join("\n");
}

export const HELP_TEXT = `baes scan buybot

Admin commands:
/watch
  Open guided setup. Choose a chain, then add a token contract or known pool contract with explanatory buttons.

/watch [chain] <token> [quote|any] <tokenDeploymentBlock> [dex] [v2|v3|v4|solidly|algebra|curve|balancer] [clanker|flaunch|hooks] [next|all]
  Power-user form: discover pools for a token and start tracking buys.
  chain can be base, ethereum, bsc, monad, megaeth, arbitrum, optimism, polygon, or avalanche.
  quote can be native, weth/wbnb, fleth, virtual, usdc, usdt, any, or a token address.
  EVM token discovery requires the token deployment block and scans at most 50k blocks.
  Example: /watch arbitrum 0xToken weth 30000000 camelot

/scan [chain] <token> [quote|any] <tokenDeploymentBlock> [dex] [v2|v3|v4|solidly|algebra|curve|balancer] [clanker|flaunch|hooks]
  Find matching pools without changing tracking.

/pool [chain] <poolAddress|poolId> [targetToken] [poolCreationBlock]
  Add a discovered pool directly, without Dexscreener. Send just /pool to open guided pool setup.
  Pool addresses do not need a block. V4 pool-id lookup needs a pool creation block.

/pool <currency0or1> <currency1or0> <fee> <tickSpacing> <hooks> <targetToken>
  Manually add a Uniswap v4 pool key.

/pools
/settings
/status
/pause
/resume
/unwatch
/testbuy
/topic [here|off]
/chatid

/set <key> <value>
  Keys: minusd, minquote, emoji, emojistep, maxemojis, media, tx, chart, topic, backfill, clanker

Notes:
- Each Telegram group has its own chain, token, pool set, and settings.
- EVM discovery uses raw factory and PoolManager logs via RPC, capped to a 50k-block window from the user-supplied deployment block.
- Pool discovery and alerts use raw RPC data. Chart links open Dexscreener.
- For feedback or setup help, DM @mrtdlgc on Telegram.`;

interface PoolsSummaryOptions {
  fullIdentifiers?: boolean;
}

export function poolsSummary(pools: PoolKey[], max = 10, options: PoolsSummaryOptions = {}): string {
  if (pools.length === 0) return "No pools.";
  const lines = pools.slice(0, max).map((pool, index) => {
    const protocol = `${chainLabel(pool.chain ?? "base")} / ${dexLabel(poolDex(pool))} ${poolVersionLabel(pool)}`;
    const poolId = options.fullIdentifiers ? pool.id : shortHex(pool.id);
    const token0 = options.fullIdentifiers ? pool.currency0 : shortToken(pool.currency0);
    const token1 = options.fullIdentifiers ? pool.currency1 : shortToken(pool.currency1);
    const tick = pool.tickSpacing !== undefined ? ` tick ${pool.tickSpacing}` : "";
    const hook = pool.hooks ? `\n   hook ${options.fullIdentifiers ? pool.hooks : shortAddress(pool.hooks)}` : "";
    const poolAddress = options.fullIdentifiers && pool.poolAddress && pool.poolAddress.toLowerCase() !== String(pool.id).toLowerCase()
      ? `\n   pool address ${pool.poolAddress}`
      : "";
    const vaultAddress = options.fullIdentifiers && pool.vaultAddress ? `\n   vault ${pool.vaultAddress}` : "";
    const programId = options.fullIdentifiers && pool.programId ? `\n   program ${pool.programId}` : "";
    return `${index + 1}. ${protocol} id ${poolId} fee ${formatFee(pool.fee)}${tick}\n   ${token0} / ${token1}${poolAddress}${vaultAddress}${programId}${hook}\n   block ${pool.createdBlock ?? "manual"}`;
  });
  if (pools.length > max) lines.push(`...and ${pools.length - max} more.`);
  return lines.join("\n");
}

export const MIN_USD_PRESETS = [0, 5, 10, 25, 50, 100, 250, 500];
export const MIN_QUOTE_PRESETS = [0, 0.01, 0.05, 0.1, 0.5, 1, 5, 10];
export const EMOJI_STEP_PRESETS = [1, 5, 10, 25, 50, 100, 250, 500];
export const MAX_EMOJI_PRESETS = [5, 10, 20, 40, 60, 80];
export const BACKFILL_PRESETS = [0, 5, 25, 50, 100, 250, 500, 1000];
export const EMOJI_PRESETS = [
  "🟢",
  "💚",
  "🔥",
  "🚀",
  "🌕",
  "💎",
  "⚡",
  "✨",
  "💰",
  "🤑",
  "📈",
  "🟣",
  "🔵",
  "🟡",
  "🔴",
  "🧨",
  "+",
  "$",
  "BUY",
  "UP"
];

export function settingsKeyboard(chat: ChatState): { reply_markup: InlineKeyboardMarkup } {
  const s = chat.settings;
  const onOff = (b: boolean) => (b ? "on" : "off");
  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback(chat.enabled ? "⏸ Pause" : "▶️ Resume", chat.enabled ? "cfg:pause" : "cfg:resume"),
      Markup.button.callback("🔄 Refresh", "cfg:refresh")
    ],
    [
      Markup.button.callback(`💵 Min USD: ${formatUsdPreset(s.minUsd)}`, "cfg:menu:minusd"),
      Markup.button.callback(`🪙 Min quote: ${formatQuotePreset(s.minQuote)}`, "cfg:menu:minquote")
    ],
    [
      Markup.button.callback(`🎨 Emoji: ${settingPreview(s.emoji)}`, "cfg:menu:emoji"),
      Markup.button.callback(`📏 Step: ${formatUsdPreset(s.emojiStepUsd)}`, "cfg:menu:emojistep")
    ],
    [
      Markup.button.callback(`🔢 Max: ${s.maxEmojis}`, "cfg:menu:maxemojis"),
      Markup.button.callback(`⏪ Backfill: ${s.backfillBlocks}`, "cfg:menu:backfill")
    ],
    [
      Markup.button.callback(`🖼 Media: ${describeMediaKind(chat)}`, "cfg:menu:media"),
      Markup.button.callback(`🧵 Topic: ${chat.alertThreadId ? `#${chat.alertThreadId}` : "main"}`, "cfg:menu:topic")
    ],
    [
      Markup.button.callback(`🧾 Tx: ${onOff(s.showTxLink)}`, "cfg:toggle:tx"),
      Markup.button.callback(`📈 Chart: ${onOff(s.showChartLink)}`, "cfg:toggle:chart")
    ],
    [Markup.button.callback(`🪝 Clanker-only: ${onOff(s.onlyClankerHooks)}`, "cfg:toggle:clanker")]
  ]);
  return { reply_markup: kb.reply_markup };
}

export function minUsdKeyboard(): { reply_markup: InlineKeyboardMarkup } {
  return presetKeyboard(MIN_USD_PRESETS.map((v) => Markup.button.callback(formatUsdPreset(v), `cfg:set:minusd:${v}`)), {
    customAction: "cfg:custom:minusd",
    customLabel: "⌨️ Custom USD"
  });
}

export function minQuoteKeyboard(): { reply_markup: InlineKeyboardMarkup } {
  return presetKeyboard(MIN_QUOTE_PRESETS.map((v) => Markup.button.callback(formatQuotePreset(v), `cfg:set:minquote:${v}`)), {
    customAction: "cfg:custom:minquote",
    customLabel: "⌨️ Custom quote"
  });
}

export function emojiKeyboard(): { reply_markup: InlineKeyboardMarkup } {
  const buttons = EMOJI_PRESETS.map((e) => Markup.button.callback(e, `cfg:set:emoji:${encodeURIComponent(e)}`));
  return presetKeyboard(buttons, {
    customAction: "cfg:custom:emoji",
    customLabel: "⌨️ Custom emoji/text"
  });
}

export function emojiStepKeyboard(): { reply_markup: InlineKeyboardMarkup } {
  return presetKeyboard(EMOJI_STEP_PRESETS.map((v) => Markup.button.callback(formatUsdPreset(v), `cfg:set:emojistep:${v}`)), {
    customAction: "cfg:custom:emojistep",
    customLabel: "⌨️ Custom step"
  });
}

export function maxEmojisKeyboard(): { reply_markup: InlineKeyboardMarkup } {
  return presetKeyboard(MAX_EMOJI_PRESETS.map((v) => Markup.button.callback(String(v), `cfg:set:maxemojis:${v}`)), {
    columns: 3,
    customAction: "cfg:custom:maxemojis",
    customLabel: "⌨️ Custom max"
  });
}

export function backfillKeyboard(): { reply_markup: InlineKeyboardMarkup } {
  return presetKeyboard(BACKFILL_PRESETS.map((v) => Markup.button.callback(String(v), `cfg:set:backfill:${v}`)), {
    customAction: "cfg:custom:backfill",
    customLabel: "⌨️ Custom blocks"
  });
}

export function topicKeyboard(): { reply_markup: InlineKeyboardMarkup } {
  return {
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback("🧵 Use this topic", "cfg:set:topic:here")],
      [Markup.button.callback("💬 Main chat", "cfg:set:topic:off")],
      [Markup.button.callback("⌨️ Custom topic id", "cfg:custom:topic")],
      [Markup.button.callback("⬅️ Back", "cfg:refresh")]
    ]).reply_markup
  };
}

export function mediaInstructionsText(): string {
  return [
    "🖼 Buy alert media",
    "",
    "To set buy alert media:",
    "  - Tap Upload photo/GIF, then send an image from your device.",
    "  - Or send a photo or GIF to this chat with caption `/setmedia`.",
    "  - Or run `/set media https://example.com/image.gif` for a URL.",
    "  - Use `/set media off` to remove."
  ].join("\n");
}

export function mediaKeyboard(): { reply_markup: InlineKeyboardMarkup } {
  return {
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback("📤 Upload photo/GIF", "cfg:custom:mediaupload")],
      [Markup.button.callback("⌨️ Custom media URL", "cfg:custom:media")],
      [Markup.button.callback("🗑 Remove media", "cfg:set:media:off")],
      [Markup.button.callback("⬅️ Back", "cfg:refresh")]
    ]).reply_markup
  };
}

export function settingsSummary(chat: ChatState): string {
  const poolCount = Object.keys(chat.pools).length;
  const chainName = chat.chain === "solana" ? "unsupported hidden adapter" : chainLabel(chat.chain ?? "base");
  return [
    "⚙️ baes scan settings",
    "",
    "Tracking",
    `${chat.enabled ? "🟢" : "⏸"} Alerts: ${chat.enabled ? "enabled" : "paused"}`,
    `🔗 Chain: ${chainName}`,
    `🧬 Token: ${chat.token?.symbol ?? "not set"} ${chat.tokenAddress ? `(${chat.tokenAddress})` : ""}`,
    `🧺 Pools: ${poolCount}`,
    `⛓ Last block: ${chat.lastBlock ?? "not set"}`,
    `✍️ Last signature: ${chat.lastSignature ? shortHex(chat.lastSignature, 6, 6) : "not set"}`,
    "",
    "Alert filters",
    `💵 Min USD: ${formatUsdPreset(chat.settings.minUsd)}`,
    `🪙 Min quote: ${formatQuotePreset(chat.settings.minQuote)}`,
    `🎨 Emoji bar: ${chat.settings.emoji}`,
    `📏 Emoji step: ${formatUsdPreset(chat.settings.emojiStepUsd)}`,
    `🔢 Max emojis: ${chat.settings.maxEmojis}`,
    `🖼 Media: ${describeMedia(chat)}`,
    "",
    "Delivery",
    `🧾 Tx link: ${chat.settings.showTxLink ? "on" : "off"}`,
    `📈 Chart link: ${chat.settings.showChartLink ? "on" : "off"}`,
    `🧵 Alert topic: ${chat.alertThreadId ? `#${chat.alertThreadId}` : "main chat"}`,
    `⏪ Backfill blocks: ${chat.settings.backfillBlocks}`,
    `🪝 Clanker-only discovery: ${chat.settings.onlyClankerHooks ? "on" : "off"}`
  ].join("\n");
}

export function minUsdMenuText(chat: ChatState): string {
  return [
    "💵 Minimum USD buy",
    "",
    `Current: ${formatUsdPreset(chat.settings.minUsd)}`,
    "Pick a preset, tap Custom USD, or send /set minusd <number>."
  ].join("\n");
}

export function minQuoteMenuText(chat: ChatState): string {
  return [
    "🪙 Minimum quote-token buy",
    "",
    `Current: ${formatQuotePreset(chat.settings.minQuote)}`,
    "Pick a preset, tap Custom quote, or send /set minquote <number>."
  ].join("\n");
}

export function emojiMenuText(chat: ChatState): string {
  return [
    "🎨 Buy alert emoji",
    "",
    `Current: ${chat.settings.emoji}`,
    "Pick a preset, tap Custom emoji/text, or send /set emoji <emoji-or-text>."
  ].join("\n");
}

export function emojiStepMenuText(chat: ChatState): string {
  return [
    "📏 Emoji step",
    "",
    `Current: ${formatUsdPreset(chat.settings.emojiStepUsd)} per emoji`,
    "Pick a preset, tap Custom step, or send /set emojistep <number>."
  ].join("\n");
}

export function maxEmojisMenuText(chat: ChatState): string {
  return [
    "🔢 Max emojis",
    "",
    `Current: ${chat.settings.maxEmojis}`,
    "Pick a preset, tap Custom max, or send /set maxemojis <number>."
  ].join("\n");
}

export function backfillMenuText(chat: ChatState): string {
  return [
    "⏪ Resume backfill",
    "",
    `Current: ${chat.settings.backfillBlocks} blocks`,
    "Pick a preset, tap Custom blocks, or send /set backfill <blocks>."
  ].join("\n");
}

export function topicMenuText(chat: ChatState): string {
  return [
    "🧵 Alert topic",
    "",
    `Current: ${chat.alertThreadId ? `topic #${chat.alertThreadId}` : "main chat"}`,
    "Use this topic from inside a Telegram forum topic, clear back to the main chat, tap Custom topic id, or send /set topic <id>."
  ].join("\n");
}

type CallbackButton = ReturnType<typeof Markup.button.callback>;

interface PresetKeyboardOptions {
  columns?: number;
  customAction?: string;
  customLabel?: string;
}

function presetKeyboard(buttons: CallbackButton[], options: PresetKeyboardOptions = {}): { reply_markup: InlineKeyboardMarkup } {
  const columns = options.columns ?? 4;
  const rows: CallbackButton[][] = [];
  for (let i = 0; i < buttons.length; i += columns) rows.push(buttons.slice(i, i + columns));
  if (options.customAction) {
    rows.push([Markup.button.callback(options.customLabel ?? "⌨️ Custom", options.customAction)]);
  }
  rows.push([Markup.button.callback("⬅️ Back", "cfg:refresh")]);
  return { reply_markup: Markup.inlineKeyboard(rows).reply_markup };
}

function formatUsdPreset(value: number): string {
  return value === 0 ? "off" : `$${formatCompactNumber(value)}`;
}

function formatQuotePreset(value: number): string {
  return value === 0 ? "off" : formatCompactNumber(value);
}

function settingPreview(value: string, maxChars = 14): string {
  const chars = [...value];
  return chars.length <= maxChars ? value : `${chars.slice(0, maxChars).join("")}...`;
}

function describeMediaKind(chat: ChatState): string {
  if (chat.settings.media) return chat.settings.media.kind === "animation" ? "gif" : "photo";
  if (chat.settings.mediaUrl) return "url";
  return "off";
}

export function buildBuyMessage(event: BuyEvent, chat: ChatState): string {
  const emojiCount = computeEmojiCount(event.quoteUsd, chat);
  const emojiBar = wrapEmojiBar(chat.settings.emoji, emojiCount, 10);
  const tokenSymbol = escapeHtml(event.token.symbol);
  const quoteSymbol = escapeHtml(event.quote.symbol);
  const tokenAmount = formatCompactNumber(event.tokenAmount);
  const quoteAmount = formatCompactNumber(event.quoteAmount);
  const usdSuffix = event.quoteUsd !== undefined ? ` (${formatUsd(event.quoteUsd)})` : "";
  const chain = event.chain ?? event.pool.chain ?? chat.chain ?? "base";
  const chainConfig = getChain(chain);
  const txUrl = chainConfig.explorerBaseUrl ? `${chainConfig.explorerBaseUrl}/tx/${event.txHash}` : undefined;
  const walletUrl = event.buyer && chainConfig.explorerBaseUrl
    ? `${chainConfig.explorerBaseUrl}/${chain === "solana" ? "account" : "address"}/${event.buyer}`
    : undefined;
  const chartUrl = dexscreenerChartUrl(chain, event.pool);

  const lines: string[] = [];
  if (emojiBar) lines.push(emojiBar, "");
  lines.push(`<b>${tokenSymbol} BUY</b>`, "");
  lines.push(`🪙 Token: <b>${tokenAmount}</b> ${tokenSymbol}`);
  lines.push(`💸 Paid: ${quoteAmount} ${quoteSymbol}${usdSuffix}`);
  if (event.priceUsd !== undefined) lines.push(`💵 Price: ${formatPrice(event.priceUsd)}`);
  lines.push(`🏦 FDV: ${formatUsd(event.fdvUsd)}`);
  if (event.buyerEthBalance !== undefined) lines.push(formatBuyerWalletLine(event.buyerEthBalance, chainConfig.nativeSymbol));

  const footer: string[] = [];
  if (chat.settings.showTxLink && txUrl) {
    const walletPart = walletUrl ? `<a href="${walletUrl}">👛 Wallet</a>` : "👛 Wallet";
    footer.push(walletPart, `<a href="${txUrl}">🔗 Tx</a>`);
  }
  if (chat.settings.showChartLink) footer.push(`<a href="${chartUrl}">📈 Chart</a>`);
  if (footer.length > 0) lines.push("", footer.join(" - "));
  return lines.join("\n");
}

export async function sendBuyNotification(telegram: Telegram, chat: ChatState, event: BuyEvent): Promise<void> {
  const message = buildBuyMessage(event, chat);
  const media = resolveMedia(chat);
  const threadOpts = telegramThreadOptions(chat);
  const htmlOpts = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true }, ...threadOpts };
  if (media) {
    const caption = message.length > 1024 ? `${message.slice(0, 1000)}...` : message;
    try {
      if (media.kind === "animation") {
        await telegram.sendAnimation(chat.chatId, media.ref, { caption, parse_mode: "HTML", ...threadOpts });
      } else {
        await telegram.sendPhoto(chat.chatId, media.ref, { caption, parse_mode: "HTML", ...threadOpts });
      }
      if (message.length > 1024) await telegram.sendMessage(chat.chatId, message, htmlOpts);
      return;
    } catch {
      // Fall through to text if Telegram rejects the media reference.
    }
  }
  await telegram.sendMessage(chat.chatId, message, htmlOpts);
}

function describeMedia(chat: ChatState): string {
  if (chat.settings.media) {
    const isUrl = /^https?:\/\//i.test(chat.settings.media.ref);
    return `${chat.settings.media.kind}${isUrl ? ` ${chat.settings.media.ref}` : " (uploaded)"}`;
  }
  if (chat.settings.mediaUrl) return chat.settings.mediaUrl;
  return "off";
}

function resolveMedia(chat: ChatState): { kind: "photo" | "animation"; ref: string } | undefined {
  if (chat.settings.media) return chat.settings.media;
  if (chat.settings.mediaUrl) return { kind: "photo", ref: chat.settings.mediaUrl };
  return undefined;
}

function telegramThreadOptions(chat: ChatState): { message_thread_id?: number } {
  return chat.alertThreadId ? { message_thread_id: chat.alertThreadId } : {};
}

function formatEthBalance(balance: number, symbol: string): string {
  if (!Number.isFinite(balance)) return "unknown";
  if (balance >= 1000) return `${formatCompactNumber(balance)} ${symbol}`;
  if (balance >= 1) return `${trimDecimals(balance.toFixed(2), 2)} ${symbol}`;
  if (balance >= 0.01) return `${trimDecimals(balance.toFixed(4), 4)} ${symbol}`;
  if (balance > 0) return `${trimDecimals(balance.toFixed(6), 6)} ${symbol}`;
  return `0 ${symbol}`;
}

function formatBuyerWalletLine(balance: number, symbol: string): string {
  const buyerLabel = balance >= 5 ? "Buyer wallet (large)" : "Buyer wallet";
  return `👛 ${buyerLabel}: ${formatEthBalance(balance, symbol)}`;
}

function computeEmojiCount(usd: number | undefined, chat: ChatState): number {
  const step = Math.max(chat.settings.emojiStepUsd || 1, 1);
  const max = Math.max(chat.settings.maxEmojis || 1, 1);
  if (!usd || !Number.isFinite(usd)) return 1;
  return Math.min(max, Math.max(1, Math.floor(usd / step)));
}

function dexscreenerChartUrl(chain: string, pool: PoolKey): string {
  const network = DEXSCREENER_CHAIN_SLUGS[chain] ?? chain;
  const pairId = pool.poolAddress ?? pool.id;
  return `https://dexscreener.com/${encodeURIComponent(network)}/${encodeURIComponent(pairId)}`;
}

const DEXSCREENER_CHAIN_SLUGS: Record<string, string> = {
  ethereum: "ethereum",
  bsc: "bsc",
  base: "base",
  arbitrum: "arbitrum",
  optimism: "optimism",
  monad: "monad",
  megaeth: "megaeth",
  polygon: "polygon",
  avalanche: "avalanche",
  solana: "solana"
};

function shortToken(value: string): string {
  return value.startsWith("0x") ? shortAddress(value) : shortHex(value, 6, 6);
}
