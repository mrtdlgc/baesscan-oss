import { formatUnits } from "ethers";
import { getChain } from "../../chains/registry";
import { dexLabel, poolDex, poolVersionLabel } from "../../dex/discovery";
import type { ChainSlug, PoolKey, TokenMetadata } from "../../types";
import { shortAddress } from "../../utils/address";
import { blockSecondsFor } from "./config";
import type { MarketCandle, MarketChartPoint, MarketSummary, MarketToken, MarketTrade, MarketTradeEvent, MarketWindowStats } from "./types";
import { sumDefined } from "./utils";

const MIN_TRENDING_VOLUME_USD = 25;
const MIN_MEANINGFUL_TRADE_USD = 5;
const MIN_MEANINGFUL_SWAPS = 2;
const TX_CONCENTRATION_PENALTY_START = 0.45;
const REPEATED_SIZE_PENALTY_START = 0.4;

export function buildMarketSummary(
  pool: PoolKey,
  chain: ChainSlug,
  baseToken: TokenMetadata,
  quoteToken: TokenMetadata,
  trades: MarketTrade[],
  quoteUsd: number | undefined,
  toBlock: number
): MarketSummary {
  const first = trades[0]!;
  const last = trades[trades.length - 1]!;
  const points = buildChartPoints(trades);
  const volumeUsd = sumDefined(trades.map((trade) => trade.volumeUsd));
  const quoteVolume = trades.reduce((sum, trade) => sum + trade.quoteAmount, 0);
  const priceChangePct = first.price > 0 ? ((last.price - first.price) / first.price) * 100 : undefined;
  const fdvUsd = marketCapForToken(baseToken, quoteUsd !== undefined ? last.price * quoteUsd : undefined);
  const blockSeconds = blockSecondsFor(chain);
  const windowStats = buildWindowStats(trades, toBlock, blockSeconds);
  const recency = Math.max(0, 1 - (toBlock - last.blockNumber) / Math.max(1, toBlock - first.blockNumber + 1));
  const score = buildTrendingScore(trades, windowStats, priceChangePct, volumeUsd, quoteVolume, recency);
  const poolAddress = pool.poolAddress ?? (pool.id.startsWith("0x") && pool.id.length === 42 ? pool.id : undefined);
  return {
    chain,
    poolId: pool.id,
    poolAddress,
    blockSeconds,
    dex: dexLabel(poolDex(pool)),
    protocol: poolVersionLabel(pool),
    pairLabel: `${baseToken.symbol}/${quoteToken.symbol}`,
    baseToken: marketToken(baseToken),
    quoteToken: marketToken(quoteToken),
    price: last.price,
    priceUsd: quoteUsd !== undefined ? last.price * quoteUsd : undefined,
    priceChangePct,
    marketCapUsd: fdvUsd,
    fdvUsd,
    volumeUsd,
    quoteVolume,
    swapCount: trades.length,
    windowStats,
    score,
    firstBlock: first.blockNumber,
    lastBlock: last.blockNumber,
    ageMinutes: Math.max(0, (toBlock - last.blockNumber) * blockSeconds) / 60,
    explorerUrl: poolAddress ? `${getChain(chain).explorerBaseUrl}/address/${poolAddress}` : undefined,
    chartPath: `/chart/${chain}/${encodeURIComponent(pool.id)}`,
    points,
    candles: buildCandles(trades),
    events: buildTradeEvents(trades, chain, toBlock)
  };
}

function buildTrendingScore(
  trades: MarketTrade[],
  windowStats: MarketSummary["windowStats"],
  priceChangePct: number | undefined,
  volumeUsd: number | undefined,
  quoteVolume: number,
  recency: number
): number {
  const quality = analyzeTradeQuality(trades, volumeUsd, priceChangePct);
  if (!quality.eligible) return 0;

  const scoringTrades = quality.meaningfulTrades.length > 0 ? quality.meaningfulTrades : trades;
  const activeTradeCount = Math.min(scoringTrades.length, Math.max(1, uniqueTransactionCount(scoringTrades) * 2));
  const effectiveVolume = quality.effectiveVolumeUsd ?? (quality.effectiveQuoteVolume || quoteVolume);
  const volumeScale = quality.effectiveVolumeUsd !== undefined ? 26 : 18;
  const swapScore = Math.log1p(activeTradeCount) * 35;
  const volumeScore = Math.log1p(Math.max(0, effectiveVolume)) * volumeScale;
  const momentumScore = buildMomentumScore(windowStats);
  const priceScore = buildPriceQualityScore(priceChangePct);
  const recencyScore = recency * 35;

  return Math.max(0, (swapScore + volumeScore + momentumScore + priceScore + recencyScore) * quality.manipulationPenalty);
}

function analyzeTradeQuality(
  trades: MarketTrade[],
  volumeUsd: number | undefined,
  priceChangePct: number | undefined
): {
  eligible: boolean;
  meaningfulTrades: MarketTrade[];
  effectiveVolumeUsd?: number;
  effectiveQuoteVolume: number;
  manipulationPenalty: number;
} {
  const hasUsdVolume = volumeUsd !== undefined;
  const meaningfulTrades = hasUsdVolume
    ? trades.filter((trade) => (trade.volumeUsd ?? 0) >= MIN_MEANINGFUL_TRADE_USD)
    : trades;
  const effectiveVolumeUsd = hasUsdVolume ? (sumDefined(meaningfulTrades.map((trade) => trade.volumeUsd)) ?? 0) : undefined;
  const effectiveQuoteVolume = meaningfulTrades.reduce((sum, trade) => sum + trade.quoteAmount, 0);
  const eligible = hasUsdVolume
    ? (effectiveVolumeUsd ?? 0) >= MIN_TRENDING_VOLUME_USD && meaningfulTrades.length >= MIN_MEANINGFUL_SWAPS
    : meaningfulTrades.length >= MIN_MEANINGFUL_SWAPS && effectiveQuoteVolume > 0;
  const manipulationPenalty = buildManipulationPenalty(trades, meaningfulTrades, hasUsdVolume, priceChangePct);

  return {
    eligible,
    meaningfulTrades,
    effectiveVolumeUsd,
    effectiveQuoteVolume,
    manipulationPenalty
  };
}

function buildManipulationPenalty(
  trades: MarketTrade[],
  meaningfulTrades: MarketTrade[],
  hasUsdVolume: boolean,
  priceChangePct: number | undefined
): number {
  const scoringTrades = meaningfulTrades.length > 0 ? meaningfulTrades : trades;
  let penalty = 1;

  if (hasUsdVolume && trades.length > 0) {
    const dustRatio = (trades.length - meaningfulTrades.length) / trades.length;
    penalty *= ratioPenalty(dustRatio, 0.35, 0.9, 0.45);
  }

  const concentration = maxTransactionVolumeShare(scoringTrades, hasUsdVolume);
  penalty *= ratioPenalty(concentration, TX_CONCENTRATION_PENALTY_START, 0.9, 0.5);

  const repeatedSizeRatio = mostRepeatedTradeSizeRatio(scoringTrades);
  if (scoringTrades.length >= 8) {
    penalty *= ratioPenalty(repeatedSizeRatio, REPEATED_SIZE_PENALTY_START, 0.8, 0.6);
  }

  if (scoringTrades.length >= 10 && sideBalanceRatio(scoringTrades) > 0.7 && Math.abs(priceChangePct ?? 0) < 3) {
    penalty *= 0.72;
  }

  return Math.max(0.2, Math.min(1, penalty));
}

function ratioPenalty(value: number, start: number, slope: number, floor: number): number {
  if (!Number.isFinite(value) || value <= start) return 1;
  return Math.max(floor, 1 - (value - start) * slope);
}

function maxTransactionVolumeShare(trades: MarketTrade[], preferUsd: boolean): number {
  const byTx = new Map<string, number>();
  let total = 0;
  for (const trade of trades) {
    const volume = preferUsd ? (trade.volumeUsd ?? 0) : trade.quoteAmount;
    if (!Number.isFinite(volume) || volume <= 0) continue;
    total += volume;
    const key = trade.txHash.toLowerCase();
    byTx.set(key, (byTx.get(key) ?? 0) + volume);
  }
  if (total <= 0) return 0;
  let max = 0;
  for (const value of byTx.values()) max = Math.max(max, value);
  return max / total;
}

function uniqueTransactionCount(trades: MarketTrade[]): number {
  return new Set(trades.map((trade) => trade.txHash.toLowerCase())).size;
}

function mostRepeatedTradeSizeRatio(trades: MarketTrade[]): number {
  const buckets = new Map<string, number>();
  let usable = 0;
  for (const trade of trades) {
    const amount = trade.volumeUsd ?? trade.quoteAmount;
    const bucket = tradeSizeBucket(amount);
    if (!bucket) continue;
    usable += 1;
    const key = `${trade.side}:${bucket}`;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  if (usable === 0) return 0;
  let max = 0;
  for (const count of buckets.values()) max = Math.max(max, count);
  return max / usable;
}

function tradeSizeBucket(value: number): string | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const exponent = Math.floor(Math.log10(value));
  const scaled = value / 10 ** exponent;
  return `${exponent}:${Math.round(scaled * 10)}`;
}

function sideBalanceRatio(trades: MarketTrade[]): number {
  let buys = 0;
  let sells = 0;
  for (const trade of trades) {
    if (trade.side === "buy") buys += 1;
    if (trade.side === "sell") sells += 1;
  }
  const dominant = Math.max(buys, sells);
  if (dominant === 0) return 0;
  return Math.min(buys, sells) / dominant;
}

function buildMomentumScore(windowStats: MarketSummary["windowStats"]): number {
  const m15Volume = windowVolume(windowStats.m15);
  const h1Volume = windowVolume(windowStats.h1);
  const h6Volume = windowVolume(windowStats.h6);
  const activeWindows = [windowStats.m15, windowStats.h1, windowStats.h6]
    .filter((stats) => stats.swapCount >= MIN_MEANINGFUL_SWAPS && windowVolume(stats) > 0)
    .length;
  const m15Share = h1Volume > 0 ? m15Volume / h1Volume : 0;
  const h1Share = h6Volume > 0 ? h1Volume / h6Volume : 0;
  const accelerationScore = Math.max(0, Math.min(18, (m15Share - 0.12) * 40))
    + Math.max(0, Math.min(18, (h1Share - 0.18) * 34));

  return Math.min(50, activeWindows * 8 + accelerationScore);
}

function windowVolume(stats: MarketWindowStats): number {
  return stats.volumeUsd ?? stats.quoteVolume ?? 0;
}

function buildPriceQualityScore(priceChangePct: number | undefined): number {
  if (priceChangePct === undefined || !Number.isFinite(priceChangePct)) return 0;
  const capped = Math.min(Math.abs(priceChangePct), 80);
  return priceChangePct >= 0 ? capped * 0.9 : capped * 0.25;
}

function buildChartPoints(trades: MarketTrade[]): MarketChartPoint[] {
  if (trades.length <= 80) {
    return trades.map((trade) => ({
      blockNumber: trade.blockNumber,
      price: trade.price,
      priceUsd: trade.priceUsd,
      volumeUsd: trade.volumeUsd,
      swaps: 1
    }));
  }
  const firstBlock = trades[0]!.blockNumber;
  const lastBlock = trades[trades.length - 1]!.blockNumber;
  const span = Math.max(1, lastBlock - firstBlock);
  const bucketCount = 80;
  const buckets = new Map<number, MarketChartPoint>();
  for (const trade of trades) {
    const idx = Math.min(bucketCount - 1, Math.floor(((trade.blockNumber - firstBlock) / span) * bucketCount));
    const existing = buckets.get(idx);
    buckets.set(idx, {
      blockNumber: trade.blockNumber,
      price: trade.price,
      priceUsd: trade.priceUsd,
      volumeUsd: (existing?.volumeUsd ?? 0) + (trade.volumeUsd ?? 0),
      swaps: (existing?.swaps ?? 0) + 1
    });
  }
  return [...buckets.values()].sort((a, b) => a.blockNumber - b.blockNumber);
}

function buildCandles(trades: MarketTrade[], bucketCount = 64): MarketCandle[] {
  if (trades.length === 0) return [];
  const firstBlock = trades[0]!.blockNumber;
  const lastBlock = trades[trades.length - 1]!.blockNumber;
  const span = Math.max(1, lastBlock - firstBlock);
  const buckets = new Map<number, MarketTrade[]>();
  for (const trade of trades) {
    const idx = Math.min(bucketCount - 1, Math.floor(((trade.blockNumber - firstBlock) / span) * bucketCount));
    const bucket = buckets.get(idx);
    if (bucket) {
      bucket.push(trade);
    } else {
      buckets.set(idx, [trade]);
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, bucket]) => {
      const sorted = bucket.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
      const prices = sorted.map((trade) => trade.price);
      const usdPrices = sorted.map((trade) => trade.priceUsd).filter((value): value is number => value !== undefined);
      const volumeUsd = sumDefined(sorted.map((trade) => trade.volumeUsd));
      return {
        blockStart: sorted[0]!.blockNumber,
        blockEnd: sorted[sorted.length - 1]!.blockNumber,
        open: sorted[0]!.price,
        high: Math.max(...prices),
        low: Math.min(...prices),
        close: sorted[sorted.length - 1]!.price,
        openUsd: sorted[0]!.priceUsd,
        highUsd: usdPrices.length ? Math.max(...usdPrices) : undefined,
        lowUsd: usdPrices.length ? Math.min(...usdPrices) : undefined,
        closeUsd: sorted[sorted.length - 1]!.priceUsd,
        volumeUsd,
        swaps: sorted.length
      };
    });
}

function buildTradeEvents(trades: MarketTrade[], chain: ChainSlug, toBlock: number): MarketTradeEvent[] {
  return trades
    .slice(-80)
    .reverse()
    .map((trade) => marketTradeToEvent(trade, chain, toBlock));
}

function buildWindowStats(trades: MarketTrade[], toBlock: number, blockSeconds: number): MarketSummary["windowStats"] {
  return {
    m15: buildSingleWindowStats(trades, toBlock, 15 * 60, blockSeconds),
    h1: buildSingleWindowStats(trades, toBlock, 60 * 60, blockSeconds),
    h6: buildSingleWindowStats(trades, toBlock, 6 * 60 * 60, blockSeconds),
    h12: buildSingleWindowStats(trades, toBlock, 12 * 60 * 60, blockSeconds),
    h24: buildSingleWindowStats(trades, toBlock, 24 * 60 * 60, blockSeconds)
  };
}

function buildSingleWindowStats(trades: MarketTrade[], toBlock: number, seconds: number, blockSeconds: number): MarketWindowStats {
  const fromBlock = Math.max(0, toBlock - Math.ceil(seconds / blockSeconds));
  const windowTrades = trades.filter((trade) => trade.blockNumber >= fromBlock);
  const first = windowTrades[0];
  const last = windowTrades[windowTrades.length - 1];
  const priceChangePct = first && last && first.price > 0 ? ((last.price - first.price) / first.price) * 100 : undefined;
  const buyTrades = windowTrades.filter((trade) => trade.side === "buy");
  const sellTrades = windowTrades.filter((trade) => trade.side === "sell");
  return {
    seconds,
    priceChangePct,
    volumeUsd: sumDefined(windowTrades.map((trade) => trade.volumeUsd)),
    quoteVolume: windowTrades.reduce((sum, trade) => sum + trade.quoteAmount, 0),
    swapCount: windowTrades.length,
    buys: buyTrades.length,
    sells: sellTrades.length,
    buyVolumeUsd: sumDefined(buyTrades.map((trade) => trade.volumeUsd)),
    sellVolumeUsd: sumDefined(sellTrades.map((trade) => trade.volumeUsd))
  };
}

export function marketTradeToEvent(trade: MarketTrade, chain: ChainSlug, toBlock: number): MarketTradeEvent {
  const explorerBaseUrl = getChain(chain).explorerBaseUrl;
  const blockSeconds = blockSecondsFor(chain);
  return {
    blockNumber: trade.blockNumber,
    logIndex: trade.logIndex,
    txHash: trade.txHash,
    side: trade.side,
    price: trade.price,
    priceUsd: trade.priceUsd,
    baseAmount: trade.targetAmount,
    quoteAmount: trade.quoteAmount,
    volumeUsd: trade.volumeUsd,
    ageSeconds: Math.max(0, (toBlock - trade.blockNumber) * blockSeconds),
    explorerUrl: explorerBaseUrl ? `${explorerBaseUrl}/tx/${trade.txHash}` : undefined
  };
}

export function marketToken(token: TokenMetadata): MarketToken {
  return {
    address: token.address,
    symbol: token.symbol || shortAddress(token.address),
    name: token.name || token.symbol || shortAddress(token.address),
    decimals: token.decimals,
    totalSupply: token.totalSupply
  };
}

function marketCapForToken(token: TokenMetadata, priceUsd: number | undefined): number | undefined {
  if (priceUsd === undefined || !token.totalSupply) return undefined;
  try {
    const supply = Number(formatUnits(BigInt(token.totalSupply), token.decimals));
    if (!Number.isFinite(supply) || supply <= 0) return undefined;
    return supply * priceUsd;
  } catch {
    return undefined;
  }
}
