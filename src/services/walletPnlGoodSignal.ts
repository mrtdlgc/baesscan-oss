import type {
  WalletPnlAnalyticsPnlLeader,
  WalletPnlAnalyticsSignalToken,
  WalletPnlAnalyticsSignalWallet,
  WalletPnlAnalyticsTokenSummary,
  WalletPnlAnalyticsWalletSummary
} from "../store/storage";
import type { ChainSlug } from "../types";
import { isWalletPnlIgnoredToken } from "./walletPnlFilters";

const GOOD_SIGNAL_MIN_ROW_COST_USD = 25;
const GOOD_SIGNAL_MIN_ROW_PROCEEDS_USD = 50;
const GOOD_SIGNAL_MIN_TOTAL_COST_USD = 50;
const GOOD_SIGNAL_MIN_TOTAL_PNL_USD = 10;
const GOOD_SIGNAL_LOSSLESS_PROFIT_FACTOR = 999;
const GOOD_SIGNAL_TOP_TOKEN_LIMIT = 5;
const DEFAULT_GOOD_SIGNAL_LIMIT = 1_000;

interface MutableGoodSignalWallet {
  wallet: string;
  profitableTokenCount: number;
  losingTokenCount: number;
  neutralTokenCount: number;
  grossProfitUsd: number;
  grossLossUsd: number;
  realizedPnlUsd: number;
  realizedCostUsd: number;
  realizedProceedsUsd: number;
  trustedV4HookTradeCount: number;
  buyCount: number;
  sellCount: number;
  volumeUsd: number;
  firstBlock: number;
  lastBlock: number;
  topTokens: WalletPnlAnalyticsSignalToken[];
  tokenAddresses: Set<string>;
}

export function buildWalletPnlGoodSignalWallets(options: {
  chain: ChainSlug;
  pnlRows: WalletPnlAnalyticsPnlLeader[];
  walletSummaries?: WalletPnlAnalyticsWalletSummary[];
  tokenSummaries?: WalletPnlAnalyticsTokenSummary[];
  limit?: number;
}): WalletPnlAnalyticsSignalWallet[] {
  const walletSummaries = new Map(
    (options.walletSummaries ?? []).map((wallet) => [wallet.wallet.toLowerCase(), wallet])
  );
  const tokenSummaries = new Map(
    (options.tokenSummaries ?? []).map((token) => [token.tokenAddress.toLowerCase(), token])
  );
  const wallets = new Map<string, MutableGoodSignalWallet>();

  for (const row of options.pnlRows) {
    if (!isMeaningfulSignalRow(options.chain, row, tokenSummaries)) continue;
    const walletAddress = row.wallet.toLowerCase();
    const wallet = wallets.get(walletAddress) ?? {
      wallet: walletAddress,
      profitableTokenCount: 0,
      losingTokenCount: 0,
      neutralTokenCount: 0,
      grossProfitUsd: 0,
      grossLossUsd: 0,
      realizedPnlUsd: 0,
      realizedCostUsd: 0,
      realizedProceedsUsd: 0,
      trustedV4HookTradeCount: 0,
      buyCount: 0,
      sellCount: 0,
      volumeUsd: 0,
      firstBlock: Number.POSITIVE_INFINITY,
      lastBlock: 0,
      topTokens: [],
      tokenAddresses: new Set()
    };

    if (row.realizedPnlUsd > 0) {
      wallet.profitableTokenCount += 1;
      wallet.grossProfitUsd += row.realizedPnlUsd;
    } else if (row.realizedPnlUsd < 0) {
      wallet.losingTokenCount += 1;
      wallet.grossLossUsd += Math.abs(row.realizedPnlUsd);
    } else {
      wallet.neutralTokenCount += 1;
    }
    wallet.realizedPnlUsd += row.realizedPnlUsd;
    wallet.realizedCostUsd += row.realizedCostUsd;
    wallet.realizedProceedsUsd += row.realizedProceedsUsd;
    wallet.trustedV4HookTradeCount += row.trustedV4HookTradeCount ?? 0;
    wallet.buyCount += row.buyCount;
    wallet.sellCount += row.sellCount;
    wallet.volumeUsd += row.volumeUsd;
    wallet.firstBlock = Math.min(wallet.firstBlock, row.firstBlock);
    wallet.lastBlock = Math.max(wallet.lastBlock, row.lastBlock);
    wallet.tokenAddresses.add(row.tokenAddress.toLowerCase());
    if (row.realizedPnlUsd > 0) {
      wallet.topTokens.push({
        tokenAddress: row.tokenAddress.toLowerCase(),
        tokenSymbol: row.tokenSymbol,
        realizedPnlUsd: row.realizedPnlUsd,
        roiPct: row.roiPct
      });
    }
    wallets.set(walletAddress, wallet);
  }

  return [...wallets.values()]
    .map((wallet) => finalizeGoodSignalWallet(wallet, walletSummaries.get(wallet.wallet)))
    .filter((wallet): wallet is WalletPnlAnalyticsSignalWallet => Boolean(wallet))
    .sort((a, b) =>
      b.goodSignalScore - a.goodSignalScore ||
      b.profitableTokenCount - a.profitableTokenCount ||
      b.realizedPnlUsd - a.realizedPnlUsd
    )
    .slice(0, Math.max(1, Math.floor(options.limit ?? DEFAULT_GOOD_SIGNAL_LIMIT)));
}

function isMeaningfulSignalRow(
  chain: ChainSlug,
  row: WalletPnlAnalyticsPnlLeader,
  tokenSummaries: Map<string, WalletPnlAnalyticsTokenSummary>
): boolean {
  if (row.sellCount <= 0) return false;
  if (row.realizedCostUsd < GOOD_SIGNAL_MIN_ROW_COST_USD) return false;
  if (row.realizedPnlUsd >= 0 && row.realizedProceedsUsd < GOOD_SIGNAL_MIN_ROW_PROCEEDS_USD) return false;
  if ((row.trustedV4HookTradeCount ?? 0) <= 0) return false;
  if (isWalletPnlIgnoredToken(chain, row.tokenAddress, row.tokenSymbol)) return false;
  const token = tokenSummaries.get(row.tokenAddress.toLowerCase());
  return (token?.untrustedV4HookCount ?? 0) <= 0;
}

function finalizeGoodSignalWallet(
  wallet: MutableGoodSignalWallet,
  walletSummary: WalletPnlAnalyticsWalletSummary | undefined
): WalletPnlAnalyticsSignalWallet | undefined {
  const tokenCount = wallet.profitableTokenCount + wallet.losingTokenCount + wallet.neutralTokenCount;
  const outcomeTokenCount = wallet.profitableTokenCount + wallet.losingTokenCount;
  if (tokenCount <= 0 || outcomeTokenCount <= 0) return undefined;
  if (wallet.realizedPnlUsd < GOOD_SIGNAL_MIN_TOTAL_PNL_USD) return undefined;
  if (wallet.realizedCostUsd < GOOD_SIGNAL_MIN_TOTAL_COST_USD) return undefined;
  if (wallet.profitableTokenCount < 2 && wallet.realizedPnlUsd < 500) return undefined;

  const winRatePct = roundPct((wallet.profitableTokenCount / outcomeTokenCount) * 100);
  const roiPct = wallet.realizedCostUsd > 0
    ? roundPct((wallet.realizedPnlUsd / wallet.realizedCostUsd) * 100)
    : undefined;
  const profitFactor = wallet.grossLossUsd > 0
    ? wallet.grossProfitUsd / wallet.grossLossUsd
    : wallet.grossProfitUsd > 0
      ? GOOD_SIGNAL_LOSSLESS_PROFIT_FACTOR
      : 0;
  const goodSignalScore = clampScore(
    pressureScore(wallet.profitableTokenCount, 6) * 0.22 +
    winRatePct * 0.23 +
    pressureScore(Math.max(0, roiPct ?? 0), 350) * 0.18 +
    pressureScore(Math.max(0, wallet.realizedPnlUsd), 25_000) * 0.16 +
    pressureScore(profitFactor, 4) * 0.12 +
    pressureScore(outcomeTokenCount, 10) * 0.09 -
    (walletSummary?.suspiciousScore ?? 0) * 0.25
  );
  if (goodSignalScore <= 0) return undefined;

  return {
    wallet: wallet.wallet,
    goodSignalScore,
    profitableTokenCount: wallet.profitableTokenCount,
    losingTokenCount: wallet.losingTokenCount,
    tokenCount,
    winRatePct,
    realizedPnlUsd: roundMoney(wallet.realizedPnlUsd),
    realizedCostUsd: roundMoney(wallet.realizedCostUsd),
    realizedProceedsUsd: roundMoney(wallet.realizedProceedsUsd),
    roiPct,
    profitFactor: roundRatio(profitFactor),
    trustedV4HookTradeCount: wallet.trustedV4HookTradeCount,
    buyCount: wallet.buyCount,
    sellCount: wallet.sellCount,
    volumeUsd: roundMoney(wallet.volumeUsd),
    firstBlock: blockOrZero(wallet.firstBlock),
    lastBlock: wallet.lastBlock,
    topTokens: wallet.topTokens
      .sort((a, b) => b.realizedPnlUsd - a.realizedPnlUsd)
      .slice(0, GOOD_SIGNAL_TOP_TOKEN_LIMIT)
      .map((token) => ({
        ...token,
        realizedPnlUsd: roundMoney(token.realizedPnlUsd)
      })),
    tokenAddresses: [...wallet.tokenAddresses].sort(),
    suspiciousScore: walletSummary?.suspiciousScore
  };
}

function pressureScore(value: number, fullScoreAt: number): number {
  if (!Number.isFinite(value) || value <= 0 || fullScoreAt <= 0) return 0;
  return clampScore((value / fullScoreAt) * 100);
}

function clampScore(value: number): number {
  return roundPct(Math.max(0, Math.min(100, value)));
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundPct(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundRatio(value: number): number {
  return Math.round(value * 100) / 100;
}

function blockOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
