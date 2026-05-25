import { formatUnits, type Log, type LogDescription } from "ethers";
import { BALANCER_VAULT_IFACE } from "../../dex/balancer";
import { CURVE_TOKEN_EXCHANGE_INT_IFACE, CURVE_TOKEN_EXCHANGE_UINT_IFACE } from "../../dex/curve";
import { AERODROME_POOL_IFACE } from "../../dex/aerodrome";
import { HYDREX_POOL_IFACE } from "../../dex/hydrex";
import { LB_PAIR_IFACE, decodeLbAmounts } from "../../dex/liquidityBook";
import { poolProtocol } from "../../dex/uniswap";
import { FLAUNCH_HOOK_IFACE, FLAUNCH_HOOK_SWAP_TOPIC, PANCAKE_V3_POOL_IFACE, POOL_MANAGER_IFACE, V2_PAIR_IFACE, V3_POOL_IFACE } from "../../uniswap/abis";
import { BASE_FLAUNCH_HOOKS } from "../../uniswap/constants";
import type { PoolKey, TokenMetadata } from "../../types";
import { isSameAddress, normalizeAddress } from "../../utils/address";
import { uniquePoolTokenAddresses } from "./poolUtils";
import type { MarketSide, MarketTrade, ParseableInterface, ParsedTradeRaw } from "./types";
import { abs } from "./utils";

export function parseMarketTrades(
  pool: PoolKey,
  side: MarketSide,
  baseToken: TokenMetadata,
  quoteToken: TokenMetadata,
  quoteUsd: number | undefined,
  logs: Log[]
): MarketTrade[] {
  const trades: MarketTrade[] = [];
  for (const log of tradeSourceLogs(pool, logs)) {
    const parsed = parseTradeRaw(pool, side, log);
    if (!parsed || parsed.baseAmountRaw === 0n || parsed.quoteAmountRaw === 0n) continue;
    const targetAmount = Number(formatUnits(parsed.baseAmountRaw, baseToken.decimals));
    const quoteAmount = Number(formatUnits(parsed.quoteAmountRaw, quoteToken.decimals));
    if (!Number.isFinite(targetAmount) || !Number.isFinite(quoteAmount) || targetAmount <= 0 || quoteAmount <= 0) continue;
    const price = quoteAmount / targetAmount;
    const priceUsd = quoteUsd !== undefined ? price * quoteUsd : undefined;
    const volumeUsd = quoteUsd !== undefined ? quoteAmount * quoteUsd : undefined;
    trades.push({
      blockNumber: log.blockNumber,
      logIndex: log.index,
      txHash: log.transactionHash,
      side: parsed.side,
      price,
      priceUsd,
      targetAmount,
      quoteAmount,
      volumeUsd
    });
  }
  return trades.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
}

function parseTradeRaw(
  pool: PoolKey,
  side: MarketSide,
  log: Log
): ParsedTradeRaw | undefined {
  const protocol = poolProtocol(pool);
  if (protocol === "v4") return parseV4Swap(pool, side, log);
  if (protocol === "v3") return parseV3LikeSwap(pool, side, log, pool.dex === "pancakeswap" ? PANCAKE_V3_POOL_IFACE : V3_POOL_IFACE);
  if (protocol === "v2" || protocol === "solidly") return parseV2LikeSwap(pool, side, log, protocol === "solidly" ? AERODROME_POOL_IFACE : V2_PAIR_IFACE);
  if (protocol === "algebra") return parseV3LikeSwap(pool, side, log, pool.dex === "hydrex" ? HYDREX_POOL_IFACE : V3_POOL_IFACE);
  if (protocol === "lb") return parseLiquidityBookSwap(pool, side, log);
  if (protocol === "balancer") return parseBalancerSwap(pool, side, log);
  if (protocol === "curve") return parseCurveSwap(pool, side, log);
  return undefined;
}

function parseV4Swap(pool: PoolKey, side: MarketSide, log: Log): ParsedTradeRaw | undefined {
  const parsed = safeParseLog(POOL_MANAGER_IFACE, log, "Swap") ?? safeParseLog(FLAUNCH_HOOK_IFACE, log, "HookSwap");
  if (!parsed) return undefined;
  if (String(parsed.args.id ?? "").toLowerCase() !== pool.id.toLowerCase()) return undefined;
  const token0 = normalizeAddress(pool.currency0);
  const token1 = normalizeAddress(pool.currency1);
  const amount0 = BigInt(parsed.args.amount0);
  const amount1 = BigInt(parsed.args.amount1);
  if (isSameAddress(side.base, token0) && isSameAddress(side.quote, token1)) {
    return parseSignedDeltas(amount0, amount1);
  }
  if (isSameAddress(side.base, token1) && isSameAddress(side.quote, token0)) {
    return parseSignedDeltas(amount1, amount0);
  }
  return undefined;
}

function tradeSourceLogs(pool: PoolKey, logs: Log[]): Log[] {
  if (poolProtocol(pool) !== "v4" || !pool.hooks || !BASE_FLAUNCH_HOOKS.has(pool.hooks.toLowerCase())) return logs;
  const hookLogs = logs.filter((log) => log.topics[0]?.toLowerCase() === FLAUNCH_HOOK_SWAP_TOPIC.toLowerCase());
  return hookLogs.length > 0 ? hookLogs : logs;
}

function parseSignedDeltas(baseDelta: bigint, quoteDelta: bigint): ParsedTradeRaw | undefined {
  // In v4 swap events, positive deltas mean the PoolManager sent that token out.
  if (baseDelta > 0n && quoteDelta < 0n) {
    return { baseAmountRaw: baseDelta, quoteAmountRaw: -quoteDelta, side: "buy" };
  }
  if (baseDelta < 0n && quoteDelta > 0n) {
    return { baseAmountRaw: -baseDelta, quoteAmountRaw: quoteDelta, side: "sell" };
  }
  return undefined;
}

function parseV3LikeSwap(
  pool: PoolKey,
  side: MarketSide,
  log: Log,
  iface: ParseableInterface
): ParsedTradeRaw | undefined {
  const parsed = safeParseLog(iface, log, "Swap");
  if (!parsed) return undefined;
  const token0 = normalizeAddress(pool.currency0);
  const token1 = normalizeAddress(pool.currency1);
  const amount0 = BigInt(parsed.args.amount0);
  const amount1 = BigInt(parsed.args.amount1);
  if (isSameAddress(side.base, token0) && isSameAddress(side.quote, token1)) {
    return { baseAmountRaw: abs(amount0), quoteAmountRaw: abs(amount1), side: amount0 < 0n ? "buy" : "sell" };
  }
  if (isSameAddress(side.base, token1) && isSameAddress(side.quote, token0)) {
    return { baseAmountRaw: abs(amount1), quoteAmountRaw: abs(amount0), side: amount1 < 0n ? "buy" : "sell" };
  }
  return undefined;
}

function parseV2LikeSwap(
  pool: PoolKey,
  side: MarketSide,
  log: Log,
  iface: ParseableInterface
): ParsedTradeRaw | undefined {
  const parsed = safeParseLog(iface, log, "Swap");
  if (!parsed) return undefined;
  const token0 = normalizeAddress(pool.currency0);
  const token1 = normalizeAddress(pool.currency1);
  const amount0In = BigInt(parsed.args.amount0In);
  const amount1In = BigInt(parsed.args.amount1In);
  const amount0Out = BigInt(parsed.args.amount0Out);
  const amount1Out = BigInt(parsed.args.amount1Out);
  if (isSameAddress(side.base, token0) && isSameAddress(side.quote, token1)) {
    return {
      baseAmountRaw: amount0In + amount0Out,
      quoteAmountRaw: amount1In + amount1Out,
      side: amount0Out > 0n ? "buy" : "sell"
    };
  }
  if (isSameAddress(side.base, token1) && isSameAddress(side.quote, token0)) {
    return {
      baseAmountRaw: amount1In + amount1Out,
      quoteAmountRaw: amount0In + amount0Out,
      side: amount1Out > 0n ? "buy" : "sell"
    };
  }
  return undefined;
}

function parseBalancerSwap(pool: PoolKey, side: MarketSide, log: Log): ParsedTradeRaw | undefined {
  const parsed = safeParseLog(BALANCER_VAULT_IFACE, log, "Swap");
  if (!parsed || String(parsed.args.poolId).toLowerCase() !== pool.id.toLowerCase()) return undefined;
  const tokenIn = normalizeAddress(parsed.args.tokenIn as string);
  const tokenOut = normalizeAddress(parsed.args.tokenOut as string);
  const amountIn = BigInt(parsed.args.amountIn);
  const amountOut = BigInt(parsed.args.amountOut);
  if (isSameAddress(tokenIn, side.quote) && isSameAddress(tokenOut, side.base)) return { baseAmountRaw: amountOut, quoteAmountRaw: amountIn, side: "buy" };
  if (isSameAddress(tokenIn, side.base) && isSameAddress(tokenOut, side.quote)) return { baseAmountRaw: amountIn, quoteAmountRaw: amountOut, side: "sell" };
  return undefined;
}

function parseCurveSwap(pool: PoolKey, side: MarketSide, log: Log): ParsedTradeRaw | undefined {
  const parsed = safeParseLog(CURVE_TOKEN_EXCHANGE_INT_IFACE, log, "TokenExchange") ?? safeParseLog(CURVE_TOKEN_EXCHANGE_UINT_IFACE, log, "TokenExchange");
  if (!parsed) return undefined;
  const tokens = uniquePoolTokenAddresses(pool);
  const sold = tokens[Number(parsed.args.sold_id)];
  const bought = tokens[Number(parsed.args.bought_id)];
  if (!sold || !bought) return undefined;
  const tokensSold = BigInt(parsed.args.tokens_sold);
  const tokensBought = BigInt(parsed.args.tokens_bought);
  if (isSameAddress(sold, side.quote) && isSameAddress(bought, side.base)) return { baseAmountRaw: tokensBought, quoteAmountRaw: tokensSold, side: "buy" };
  if (isSameAddress(sold, side.base) && isSameAddress(bought, side.quote)) return { baseAmountRaw: tokensSold, quoteAmountRaw: tokensBought, side: "sell" };
  return undefined;
}

function safeParseLog(iface: ParseableInterface, log: Log, name: string): LogDescription | undefined {
  try {
    const parsed = iface.parseLog(log);
    return parsed?.name === name ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseLiquidityBookSwap(pool: PoolKey, side: MarketSide, log: Log): ParsedTradeRaw | undefined {
  const parsed = safeParseLog(LB_PAIR_IFACE, log, "Swap");
  if (!parsed) return undefined;
  const tokenX = normalizeAddress(pool.currency0);
  const tokenY = normalizeAddress(pool.currency1);
  const amountsIn = decodeLbAmounts(parsed.args.amountsIn as string);
  const amountsOut = decodeLbAmounts(parsed.args.amountsOut as string);
  if (isSameAddress(side.base, tokenX) && isSameAddress(side.quote, tokenY)) {
    if (amountsOut.x > 0n && amountsIn.y > 0n) return { baseAmountRaw: amountsOut.x, quoteAmountRaw: amountsIn.y, side: "buy" };
    if (amountsIn.x > 0n && amountsOut.y > 0n) return { baseAmountRaw: amountsIn.x, quoteAmountRaw: amountsOut.y, side: "sell" };
  }
  if (isSameAddress(side.base, tokenY) && isSameAddress(side.quote, tokenX)) {
    if (amountsOut.y > 0n && amountsIn.x > 0n) return { baseAmountRaw: amountsOut.y, quoteAmountRaw: amountsIn.x, side: "buy" };
    if (amountsIn.y > 0n && amountsOut.x > 0n) return { baseAmountRaw: amountsIn.y, quoteAmountRaw: amountsOut.x, side: "sell" };
  }
  return undefined;
}
