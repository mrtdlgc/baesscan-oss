import type { Log } from "ethers";
import type { Env } from "../../config/env";
import { getChain } from "../../chains/registry";
import { poolIdForSwapLog } from "../../dex/swapLogs";
import { poolCurrencies } from "../../dex/uniswap";
import type { Address, ChainSlug, PoolKey } from "../../types";
import { isSameAddress, normalizeAddress } from "../../utils/address";
import type { MarketSide } from "./types";

export function uniquePools(pools: PoolKey[]): PoolKey[] {
  const out: PoolKey[] = [];
  const seen = new Set<string>();
  for (const pool of pools) {
    const key = pool.id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pool);
  }
  return out;
}

export function groupLogsByPool(logs: Log[], pools: PoolKey[], env: Env, chain: ChainSlug): Map<string, Log[]> {
  const byPool = new Map(pools.map((pool) => [pool.id.toLowerCase(), pool]));
  const out = new Map<string, Log[]>();
  for (const log of logs) {
    const poolId = poolIdForSwapLog(log, env, chain)?.toLowerCase();
    if (!poolId) continue;
    if (!byPool.has(poolId)) continue;
    const bucket = out.get(poolId);
    if (bucket) {
      bucket.push(log);
    } else {
      out.set(poolId, [log]);
    }
  }
  return out;
}

export function chooseMarketSide(pool: PoolKey, chainSlug: ChainSlug): MarketSide | undefined {
  const chain = getChain(chainSlug);
  const tokens = uniquePoolTokenAddresses(pool);
  if (tokens.length < 2) return undefined;
  const usd = tokens.find((token) => chain.usdLikeQuotes.some((quote) => isSameAddress(quote, token)));
  if (usd) {
    const base = tokens.find((token) => !isSameAddress(token, usd));
    if (base) return { base, quote: usd };
  }
  const native = tokens.find((token) => chain.nativeLikeQuotes.some((quote) => isSameAddress(quote, token)));
  if (native) {
    const base = tokens.find((token) => !isSameAddress(token, native));
    if (base) return { base, quote: native };
  }
  return { base: tokens[0]!, quote: tokens[1]! };
}

export function uniquePoolTokenAddresses(pool: PoolKey): Address[] {
  const out: Address[] = [];
  for (const token of [...poolCurrencies(pool), ...(pool.poolTokens ?? [])]) {
    if (typeof token !== "string" || !token.startsWith("0x")) continue;
    const normalized = normalizeAddress(token);
    if (!out.some((existing) => isSameAddress(existing, normalized))) out.push(normalized);
  }
  return out;
}
