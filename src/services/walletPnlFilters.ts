import { getChain } from "../chains/registry";
import type { ChainSlug } from "../types";

export const WALLET_PNL_IGNORED_TOKEN_SYMBOLS = [
  "WETH",
  "FLETH",
  "VIRTUAL",
  "WBNB",
  "WMATIC",
  "WAVAX",
  "WMON",
  "USDC",
  "USDC.E",
  "USDBC",
  "USDT",
  "DAI",
  "BUSD",
  "FDUSD",
  "EURC",
  "EUROC",
  "PYUSD",
  "FRAX",
  "LUSD",
  "TUSD",
  "USDE",
  "USDS",
  "GHO",
  "CRVUSD",
  "SUSD",
  "MIM",
  "DOLA"
] as const;

const IGNORED_SYMBOLS = new Set<string>(WALLET_PNL_IGNORED_TOKEN_SYMBOLS);

export function isWalletPnlIgnoredToken(chain: ChainSlug, address: string | undefined, symbol?: string): boolean {
  const normalized = address?.toLowerCase();
  if (normalized && walletPnlIgnoredTokenAddresses(chain).includes(normalized)) return true;
  const normalizedSymbol = symbol?.trim().toUpperCase();
  return Boolean(normalizedSymbol && IGNORED_SYMBOLS.has(normalizedSymbol));
}

export function walletPnlIgnoredTokenAddresses(chain: ChainSlug): string[] {
  return getChain(chain).canonicalPairTokens
    .filter((value) => value.startsWith("0x"))
    .map((value) => value.toLowerCase());
}

export function gmgnTokenUrl(chain: ChainSlug, address: string): string | undefined {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined;
  const gmgnChain = gmgnChainSlug(chain);
  if (!gmgnChain) return undefined;
  return `https://gmgn.ai/${encodeURIComponent(gmgnChain)}/token/${encodeURIComponent(address)}`;
}

export function gmgnWalletUrl(chain: ChainSlug, address: string): string | undefined {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined;
  const gmgnChain = gmgnChainSlug(chain);
  if (!gmgnChain) return undefined;
  return `https://gmgn.ai/${encodeURIComponent(gmgnChain)}/address/${encodeURIComponent(address)}`;
}

export function blockscoutWalletUrl(chain: ChainSlug, address: string): string | undefined {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined;
  const explorerBaseUrl = getChain(chain).explorerBaseUrl?.replace(/\/+$/g, "");
  if (!explorerBaseUrl || !explorerBaseUrl.includes("blockscout.")) return undefined;
  return `${explorerBaseUrl}/address/${encodeURIComponent(address)}`;
}

export function dexscreenerTokenUrl(chain: ChainSlug, address: string): string | undefined {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined;
  const dexscreenerChain = dexscreenerChainSlug(chain);
  if (!dexscreenerChain) return undefined;
  return `https://dexscreener.com/${encodeURIComponent(dexscreenerChain)}/${encodeURIComponent(address)}`;
}

function gmgnChainSlug(chain: ChainSlug): string | undefined {
  if (chain === "base") return "base";
  if (chain === "ethereum") return "eth";
  if (chain === "bsc") return "bsc";
  if (chain === "arbitrum") return "arb";
  return undefined;
}

function dexscreenerChainSlug(chain: ChainSlug): string | undefined {
  if (chain === "base") return "base";
  if (chain === "ethereum") return "ethereum";
  if (chain === "bsc") return "bsc";
  if (chain === "arbitrum") return "arbitrum";
  if (chain === "optimism") return "optimism";
  if (chain === "polygon") return "polygon";
  if (chain === "avalanche") return "avalanche";
  return undefined;
}
