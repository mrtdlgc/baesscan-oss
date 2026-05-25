import type { Address, PoolKey } from "../types";
import { BASE_LAUNCHPAD_HOOKS, ZERO_ADDRESS } from "../uniswap/constants";
import { normalizeAddress } from "../utils/address";

const DEFAULT_TRUSTED_V4_HOOKS = new Set<string>([
  ZERO_ADDRESS.toLowerCase(),
  ...BASE_LAUNCHPAD_HOOKS
]);

export interface V4HookRiskSummary {
  untrustedV4HookCount: number;
  untrustedV4Hooks: string[];
}

export function trustedV4HookSet(extraHooks: readonly string[] | undefined): Set<string> {
  const out = new Set(DEFAULT_TRUSTED_V4_HOOKS);
  for (const hook of extraHooks ?? []) {
    const normalized = normalizeV4HookAddress(hook);
    if (normalized) out.add(normalized);
  }
  return out;
}

export function poolV4Hook(pool: PoolKey | undefined): string | undefined {
  if (!pool) return undefined;
  if ((pool.dex ?? "uniswap") !== "uniswap") return undefined;
  if ((pool.protocol ?? "v4") !== "v4") return undefined;
  const hook = normalizeV4HookAddress(pool.hooks);
  if (!hook || hook === ZERO_ADDRESS.toLowerCase()) return undefined;
  return hook;
}

export function untrustedV4Hook(pool: PoolKey | undefined, extraTrustedHooks?: readonly string[]): string | undefined {
  const hook = poolV4Hook(pool);
  if (!hook) return undefined;
  return trustedV4HookSet(extraTrustedHooks).has(hook) ? undefined : hook;
}

export function trustedV4Hook(pool: PoolKey | undefined, extraTrustedHooks?: readonly string[]): string | undefined {
  const hook = poolV4Hook(pool);
  if (!hook) return undefined;
  return trustedV4HookSet(extraTrustedHooks).has(hook) ? hook : undefined;
}

export function untrustedV4HookRiskScore(untrustedHookCount: number | undefined): number {
  const count = Math.max(0, Math.floor(untrustedHookCount ?? 0));
  if (count <= 0) return 0;
  return Math.min(90, 72 + count * 6);
}

export function normalizeV4HookAddress(hook: string | undefined): string | undefined {
  if (!hook) return undefined;
  try {
    return normalizeAddress(hook).toLowerCase();
  } catch {
    return undefined;
  }
}

export function summarizeV4HookRisk(hooks: Iterable<string | undefined>, extraTrustedHooks?: readonly string[]): V4HookRiskSummary {
  const trusted = trustedV4HookSet(extraTrustedHooks);
  const untrusted = new Set<string>();
  for (const hook of hooks) {
    const normalized = normalizeV4HookAddress(hook);
    if (!normalized || normalized === ZERO_ADDRESS.toLowerCase()) continue;
    if (!trusted.has(normalized)) untrusted.add(normalized);
  }
  return {
    untrustedV4HookCount: untrusted.size,
    untrustedV4Hooks: [...untrusted].sort()
  };
}
