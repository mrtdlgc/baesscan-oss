import { poolProtocol } from "../dex/uniswap";
import type { ChainSlug, PoolKey } from "../types";
import { poolV4Hook, trustedV4Hook } from "./v4HookRisk";

export type WalletPnlHookPolicyReason =
  | "not-base-uniswap-v4"
  | "trusted-base-v4-hook"
  | "missing-base-v4-pool"
  | "missing-base-v4-hook"
  | "untrusted-base-v4-hook";

export interface WalletPnlHookPolicyDecision {
  allowed: boolean;
  reason: WalletPnlHookPolicyReason;
  hook?: string;
}

export function walletPnlBaseV4HookPolicy(
  chain: ChainSlug,
  pool: PoolKey,
  trustedV4Hooks?: readonly string[]
): WalletPnlHookPolicyDecision {
  if (!isBaseUniswapV4Pool(chain, pool)) return { allowed: true, reason: "not-base-uniswap-v4" };
  const hook = poolV4Hook(pool);
  if (!hook) return { allowed: false, reason: "missing-base-v4-hook" };
  if (trustedV4Hook(pool, trustedV4Hooks)) return { allowed: true, reason: "trusted-base-v4-hook", hook };
  return { allowed: false, reason: "untrusted-base-v4-hook", hook };
}

export interface WalletPnlTradeHookPolicyInput {
  chain?: ChainSlug;
  dex?: string;
  protocol?: string;
}

export function walletPnlTradeHookPolicy(
  chain: ChainSlug,
  trade: WalletPnlTradeHookPolicyInput,
  pool: PoolKey | undefined,
  trustedV4Hooks?: readonly string[]
): WalletPnlHookPolicyDecision {
  if (!isBaseUniswapV4Trade(chain, trade)) return { allowed: true, reason: "not-base-uniswap-v4" };
  if (!pool) return { allowed: false, reason: "missing-base-v4-pool" };
  return walletPnlBaseV4HookPolicy(chain, pool, trustedV4Hooks);
}

export function isBaseUniswapV4Pool(chain: ChainSlug, pool: PoolKey): boolean {
  return chain === "base" && isUniswapV4Pool(pool);
}

export function isUniswapV4Pool(pool: PoolKey): boolean {
  return (pool.dex ?? "uniswap") === "uniswap" && poolProtocol(pool) === "v4";
}

export function isBaseUniswapV4Trade(chain: ChainSlug, trade: WalletPnlTradeHookPolicyInput): boolean {
  return chain === "base" && trade.dex === "uniswap" && trade.protocol === "v4";
}
