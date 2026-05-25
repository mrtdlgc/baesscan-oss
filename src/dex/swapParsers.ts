import { Log } from "ethers";
import type { LogDescription } from "ethers";
import type { Address, PoolKey } from "../types";
import { isSameAddress, normalizeAddress } from "../utils/address";
import { FLAUNCH_HOOK_IFACE, PANCAKE_V3_POOL_IFACE, POOL_MANAGER_IFACE, V2_PAIR_IFACE, V3_POOL_IFACE } from "../uniswap/abis";
import { poolCurrencies, poolProtocol } from "./uniswap";
import { AERODROME_POOL_IFACE } from "./aerodrome";
import { parseBalancerBuySwap } from "./balancer";
import { parseCurveBuySwap } from "./curve";
import { HYDREX_POOL_IFACE } from "./hydrex";
import { parseLiquidityBookBuySwap } from "./liquidityBook";

export interface ParsedBuySwap {
  tokenAmountRaw: bigint;
  quoteAmountRaw: bigint;
  quoteAddress?: Address;
  sender?: Address;
}

export function parseBuySwap(pool: PoolKey, log: Log, tokenAddress: Address): ParsedBuySwap | undefined {
  if (poolProtocol(pool) === "balancer") {
    return parseBalancerBuySwap(pool, log, tokenAddress);
  }

  if (poolProtocol(pool) === "curve") {
    return parseCurveBuySwap(pool, log, tokenAddress);
  }

  if (poolProtocol(pool) === "lb") {
    return parseLiquidityBookBuySwap(pool, log, tokenAddress);
  }

  const tokenIs0 = isSameAddress(pool.currency0, tokenAddress);
  const tokenIs1 = isSameAddress(pool.currency1, tokenAddress);
  if (!tokenIs0 && !tokenIs1) return undefined;
  if (!poolCurrencies(pool).some((currency) => isSameAddress(currency, tokenAddress))) return undefined;

  if (poolProtocol(pool) === "solidly") {
    return parseV2LikeBuy(pool, log, tokenIs0, AERODROME_POOL_IFACE);
  }

  if (pool.dex === "hydrex") {
    return parseV3LikeBuy(log, tokenIs0, HYDREX_POOL_IFACE);
  }

  if (poolProtocol(pool) === "algebra") {
    return parseV3LikeBuy(log, tokenIs0, V3_POOL_IFACE);
  }

  if (poolProtocol(pool) === "v4") {
    const parsed = safeParseLog(POOL_MANAGER_IFACE, log, "Swap") ?? safeParseLog(FLAUNCH_HOOK_IFACE, log, "HookSwap");
    if (!parsed) return undefined;
    const amount0 = BigInt(parsed.args.amount0);
    const amount1 = BigInt(parsed.args.amount1);
    const tokenDelta = tokenIs0 ? amount0 : amount1;
    const quoteDelta = tokenIs0 ? amount1 : amount0;

    // In Uniswap v4 deltas, positive means PoolManager sends that token to the caller.
    if (tokenDelta <= 0n || quoteDelta >= 0n) return undefined;
    return {
      tokenAmountRaw: tokenDelta,
      quoteAmountRaw: -quoteDelta,
      sender: parsed.args.sender ? normalizeAddress(parsed.args.sender as string) : undefined
    };
  }

  if (poolProtocol(pool) === "v3") {
    if (pool.dex === "pancakeswap") return parseV3LikeBuy(log, tokenIs0, PANCAKE_V3_POOL_IFACE);
    return parseV3LikeBuy(log, tokenIs0, V3_POOL_IFACE);
  }

  return parseV2LikeBuy(pool, log, tokenIs0, V2_PAIR_IFACE);
}

function safeParseLog(iface: typeof POOL_MANAGER_IFACE | typeof FLAUNCH_HOOK_IFACE, log: Log, name: string): LogDescription | undefined {
  try {
    const parsed = iface.parseLog(log);
    return parsed?.name === name ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseV3LikeBuy(
  log: Log,
  tokenIs0: boolean,
  iface: typeof V3_POOL_IFACE | typeof HYDREX_POOL_IFACE | typeof PANCAKE_V3_POOL_IFACE
): ParsedBuySwap | undefined {
  const parsed = iface.parseLog(log);
  if (!parsed || parsed.name !== "Swap") return undefined;
  const amount0 = BigInt(parsed.args.amount0);
  const amount1 = BigInt(parsed.args.amount1);
  const tokenDelta = tokenIs0 ? amount0 : amount1;
  const quoteDelta = tokenIs0 ? amount1 : amount0;

  // In v3/Algebra-style swap events, negative amount is token sent out by the pool.
  if (tokenDelta >= 0n || quoteDelta <= 0n) return undefined;
  return {
    tokenAmountRaw: -tokenDelta,
    quoteAmountRaw: quoteDelta,
    sender: parsed.args.sender ? normalizeAddress(parsed.args.sender as string) : undefined
  };
}

function parseV2LikeBuy(
  _pool: PoolKey,
  log: Log,
  tokenIs0: boolean,
  iface: typeof V2_PAIR_IFACE | typeof AERODROME_POOL_IFACE
): ParsedBuySwap | undefined {
  const parsed = iface.parseLog(log);
  if (!parsed || parsed.name !== "Swap") return undefined;
  const amount0In = BigInt(parsed.args.amount0In);
  const amount1In = BigInt(parsed.args.amount1In);
  const amount0Out = BigInt(parsed.args.amount0Out);
  const amount1Out = BigInt(parsed.args.amount1Out);
  const tokenAmountRaw = tokenIs0 ? amount0Out : amount1Out;
  const quoteAmountRaw = tokenIs0 ? amount1In : amount0In;
  if (tokenAmountRaw <= 0n || quoteAmountRaw <= 0n) return undefined;
  return {
    tokenAmountRaw,
    quoteAmountRaw,
    sender: parsed.args.sender ? normalizeAddress(parsed.args.sender as string) : undefined
  };
}
