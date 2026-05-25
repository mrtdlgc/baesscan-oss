import { getAddress, isAddress, zeroPadValue } from "ethers";
import type { Address, ChainSlug, Hex32, TokenId } from "../types";
import { getChain, ZERO_ADDRESS } from "../chains/registry";

export function normalizeAddress(input: string): Address {
  if (input.toLowerCase() === "0x0") return ZERO_ADDRESS;
  return getAddress(input) as Address;
}

export function maybeAddressOrAlias(input: string, chain: ChainSlug = "base"): TokenId | undefined {
  const lowered = input.toLowerCase();
  const alias = getChain(chain).quoteAliases[lowered];
  if (alias) return alias;
  if (lowered === "any") return undefined;
  if (isAddress(input)) return normalizeAddress(input);
  return undefined;
}

export function isSameAddress(a: string, b: string): boolean {
  return normalizeAddress(a).toLowerCase() === normalizeAddress(b).toLowerCase();
}

export function addressToTopic(address: string): Hex32 {
  return zeroPadValue(normalizeAddress(address), 32) as Hex32;
}

export function shortAddress(address?: string, chars = 6): string {
  if (!address) return "unknown";
  const value = address.startsWith("0x") ? address : `0x${address}`;
  return `${value.slice(0, chars + 2)}...${value.slice(-chars)}`;
}

export function shortHex(hex?: string, left = 8, right = 6): string {
  if (!hex) return "unknown";
  return `${hex.slice(0, left + 2)}...${hex.slice(-right)}`;
}

export function sortedCurrencies(a: Address, b: Address): [Address, Address] {
  const left = BigInt(a);
  const right = BigInt(b);
  return left <= right ? [a, b] : [b, a];
}
