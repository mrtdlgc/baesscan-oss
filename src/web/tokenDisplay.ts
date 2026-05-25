import { shortAddress } from "../utils/address";

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const ZERO_WIDTH_CHARS = /[\u200b-\u200d\ufeff]/g;
const SHORT_ADDRESS_LIKE = /^0x[0-9a-fA-F]{2,12}\.\.\.[0-9a-fA-F]{2,12}$/;
const FULL_ADDRESS_LIKE = /^0x[0-9a-fA-F]{40}$/;

export function displayTokenTicker(symbol: string | undefined, address?: string, maxLength = 18): string {
  const cleaned = cleanTokenTicker(symbol);
  const fallback = address ? shortAddress(address, 4) : "unknown";
  if (!cleaned || isAddressLikeTicker(cleaned)) return fallback;
  if (cleaned.length <= maxLength) return cleaned;
  if (maxLength <= 4) return cleaned.slice(0, maxLength);
  return `${cleaned.slice(0, maxLength - 3)}...`;
}

export function tokenTickerTitle(symbol: string | undefined, address?: string): string {
  const cleaned = cleanTokenTicker(symbol);
  const fallback = address ? shortAddress(address) : "unknown";
  if (!cleaned) return fallback;
  if (!address) return cleaned;
  if (isAddressLikeTicker(cleaned)) return address;
  return `${cleaned} (${address})`;
}

function cleanTokenTicker(symbol: string | undefined): string {
  return String(symbol ?? "")
    .replace(CONTROL_CHARS, "")
    .replace(ZERO_WIDTH_CHARS, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isAddressLikeTicker(symbol: string): boolean {
  const compact = symbol.replace(/\s+/g, "");
  return FULL_ADDRESS_LIKE.test(compact) || SHORT_ADDRESS_LIKE.test(compact);
}
