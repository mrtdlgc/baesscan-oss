import { formatUnits } from "ethers";

export function formatTokenAmount(raw: bigint, decimals: number, maxDecimals = 6): string {
  const text = formatUnits(raw < 0n ? -raw : raw, decimals);
  return trimDecimals(text, maxDecimals);
}

export function trimDecimals(text: string, maxDecimals = 6): string {
  if (!text.includes(".")) return text;
  const parts = text.split(".");
  const whole = parts[0] ?? "0";
  const frac = parts[1] ?? "";
  const trimmed = frac.slice(0, maxDecimals).replace(/0+$/, "");
  return trimmed.length > 0 ? `${whole}.${trimmed}` : whole;
}

export function formatUsd(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "unknown";
  if (Math.abs(value) >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
  if (Math.abs(value) >= 1) return `$${value.toFixed(2)}`;
  if (Math.abs(value) >= 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toExponential(3)}`;
}

export function formatPrice(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "unknown";
  if (value >= 1) return `$${value.toFixed(4)}`;
  if (value >= 0.01) return `$${value.toFixed(6)}`;
  if (value <= 0) return "$0";
  if (value < 1e-12) return "<$0.000000000001";
  const decimals = Math.min(12, Math.max(8, Math.ceil(-Math.log10(value)) + 4));
  return `$${trimDecimals(value.toFixed(decimals), decimals)}`;
}

export function parsePositiveNumber(raw: string, name: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return parsed;
}

export function formatFee(fee: number): string {
  // Uniswap v4 LP fees are uint24 hundredths of a bip for static-fee pools.
  // Dynamic-fee sentinel values can be larger; show raw in that case.
  if (fee > 1_000_000) return `${fee} dynamic/raw`;
  return `${fee / 10_000}%`;
}

/**
 * Compact display number: 1234 -> "1.23K", 1_500_000 -> "1.5M", 0.0001234 -> "0.0001234".
 * Used for token amounts in buy alerts.
 */
export function formatCompactNumber(input: number | string): string {
  const n = typeof input === "string" ? Number(input) : input;
  if (!Number.isFinite(n)) return "?";
  const abs = Math.abs(n);
  if (abs >= 1e12) return trimZeros(`${(n / 1e12).toFixed(2)}T`);
  if (abs >= 1e9) return trimZeros(`${(n / 1e9).toFixed(2)}B`);
  if (abs >= 1e6) return trimZeros(`${(n / 1e6).toFixed(2)}M`);
  if (abs >= 1e3) return trimZeros(`${(n / 1e3).toFixed(2)}K`);
  if (abs >= 1) return trimZeros(n.toFixed(2));
  if (abs >= 0.01) return trimZeros(n.toFixed(4));
  if (abs === 0) return "0";
  return n.toPrecision(3);
}

function trimZeros(text: string): string {
  if (!text.includes(".")) return text;
  return text.replace(/(\.\d*?)0+($|[A-Z])/, "$1$2").replace(/\.($|[A-Z])/, "$1");
}

/**
 * Size tier label based on USD value of the buy. When USD is unknown, falls back to a default.
 */
export function buySizeEmoji(usd?: number): string {
  if (!usd || !Number.isFinite(usd)) return "BUY";
  if (usd >= 25_000) return "WHALE WHALE WHALE";
  if (usd >= 5_000) return "WHALE";
  if (usd >= 1_000) return "LARGE";
  if (usd >= 250) return "MID";
  if (usd >= 50) return "SMALL";
  return "BUY";
}
/**
 * Wraps a long emoji string into rows of N for readability.
 */
export function wrapEmojiBar(emoji: string, count: number, perRow = 10): string {
  if (count <= 0) return "";
  const rows: string[] = [];
  for (let i = 0; i < count; i += perRow) {
    rows.push(emoji.repeat(Math.min(perRow, count - i)));
  }
  return rows.join("\n");
}

/** Escape user-controlled text for Telegram HTML parse mode. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
