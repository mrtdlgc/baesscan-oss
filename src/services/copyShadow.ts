import type { Logger } from "pino";
import type { Env } from "../config/env";
import type {
  CopyShadowConfig,
  CopyShadowPosition,
  CopyShadowSettings,
  CopyShadowSignal,
  CopyShadowSnapshot,
  CopyShadowWalletSummary,
  Storage,
  WalletPnlTradeRecord
} from "../store/storage";
import type { ChainSlug } from "../types";

type CopyShadowEnvSettings = Pick<
  Env,
  | "copyShadowTradeSizeUsd"
  | "copyShadowMaxPositionUsd"
  | "copyShadowExecutionDelayBlocks"
  | "copyShadowMaxPriceLookaheadBlocks"
  | "copyShadowSlippageBps"
  | "copyShadowGasUsd"
  | "copyShadowMinSourceVolumeUsd"
>;

type CopyShadowEnvConfig = CopyShadowEnvSettings & Pick<
  Env,
  | "copyShadowEnabled"
  | "copyShadowChain"
  | "copyShadowWallets"
  | "copyShadowIntervalMs"
  | "copyShadowRecentSignalsLimit"
  | "copyShadowPositionLimit"
>;

interface MutableCopyPosition {
  wallet: string;
  tokenAddress: string;
  tokenSymbol: string;
  quantity: number;
  costUsd: number;
  lastBlock: number;
}

interface MutableSourcePosition {
  quantity: number;
}

interface ExecutionPrice {
  blockNumber: number;
  priceUsd: number;
}

interface SimulationState {
  sourcePositions: Map<string, MutableSourcePosition>;
  copyPositions: Map<string, MutableCopyPosition>;
  walletSummaries: Map<string, CopyShadowWalletSummary>;
  signals: CopyShadowSignal[];
  totalGasUsd: number;
  totalSlippageUsd: number;
}

const COPY_SHADOW_SCHEMA_VERSION = 1;

export class CopyShadowSimulator {
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastIntervalRunAtMs = 0;

  constructor(
    private readonly deps: {
      env: Env;
      store: Storage;
      logger: Logger;
    }
  ) {}

  start(): void {
    if (this.timer) return;
    this.runSafely("startup");
    this.timer = setInterval(() => this.runSafely("interval"), 30_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async runOnce(reason = "manual"): Promise<void> {
    if (this.running) {
      this.deps.logger.debug({ reason }, "copy shadow tick skipped; previous tick still running");
      return;
    }
    this.running = true;
    try {
      const config = this.deps.store.getCopyShadowConfig() ?? copyShadowConfigFromEnv(this.deps.env);
      if (reason === "interval" && !this.intervalDue(config)) {
        return;
      }
      if (!config.enabled || config.wallets.length === 0) {
        this.deps.logger.debug({ reason, enabled: config.enabled, wallets: config.wallets.length }, "copy shadow tick skipped; disabled or no wallets configured");
        return;
      }
      const snapshot = buildCopyShadowSnapshotFromConfig({
        config,
        trades: this.deps.store.getWalletPnlTrades(config.chain, undefined, {
          trustedV4Hooks: this.deps.env.walletPnlTrustedV4Hooks
        })
      });
      this.deps.store.setCopyShadowSnapshot(snapshot);
      if (reason === "startup" || reason === "interval") this.lastIntervalRunAtMs = Date.now();
      this.deps.logger.info(
        {
          reason,
          chain: snapshot.chain,
          watchedWallets: snapshot.watchedWallets.length,
          sourceTradeCount: snapshot.sourceTradeCount,
          copiedBuyCount: snapshot.copiedBuyCount,
          copiedSellCount: snapshot.copiedSellCount,
          skippedSignalCount: snapshot.skippedSignalCount,
          realizedPnlUsd: snapshot.realizedPnlUsd,
          unrealizedPnlUsd: snapshot.unrealizedPnlUsd
        },
        "copy shadow snapshot rebuilt"
      );
    } finally {
      this.running = false;
    }
  }

  private intervalDue(config: CopyShadowConfig): boolean {
    if (this.lastIntervalRunAtMs === 0) return true;
    return Date.now() - this.lastIntervalRunAtMs >= copyShadowIntervalMs(config, this.deps.env);
  }

  private runSafely(reason: string): void {
    this.runOnce(reason).catch((error) => {
      this.deps.logger.warn({ reason, error: (error as Error).message }, "copy shadow tick failed");
    });
  }
}

export function copyShadowConfigFromEnv(env: CopyShadowEnvConfig): CopyShadowConfig {
  return {
    schemaVersion: COPY_SHADOW_SCHEMA_VERSION,
    enabled: env.copyShadowEnabled,
    chain: env.copyShadowChain,
    wallets: env.copyShadowWallets.map((wallet) => wallet.toLowerCase()),
    intervalMs: env.copyShadowIntervalMs,
    settings: copyShadowSettings(env),
    recentSignalsLimit: env.copyShadowRecentSignalsLimit,
    positionLimit: env.copyShadowPositionLimit,
    updatedAt: new Date().toISOString()
  };
}

export function buildCopyShadowSnapshot(options: {
  env: Pick<
    Env,
    | "copyShadowWallets"
    | "copyShadowTradeSizeUsd"
    | "copyShadowMaxPositionUsd"
    | "copyShadowExecutionDelayBlocks"
    | "copyShadowMaxPriceLookaheadBlocks"
    | "copyShadowSlippageBps"
    | "copyShadowGasUsd"
    | "copyShadowMinSourceVolumeUsd"
    | "copyShadowRecentSignalsLimit"
    | "copyShadowPositionLimit"
  >;
  chain: ChainSlug;
  trades: WalletPnlTradeRecord[];
}): CopyShadowSnapshot {
  return buildCopyShadowSnapshotFromConfig({
    config: {
      schemaVersion: COPY_SHADOW_SCHEMA_VERSION,
      enabled: true,
      chain: options.chain,
      wallets: options.env.copyShadowWallets.map((wallet) => wallet.toLowerCase()),
      intervalMs: undefined,
      settings: copyShadowSettings(options.env),
      recentSignalsLimit: options.env.copyShadowRecentSignalsLimit,
      positionLimit: options.env.copyShadowPositionLimit,
      updatedAt: new Date().toISOString()
    },
    trades: options.trades
  });
}

export function buildCopyShadowSnapshotFromConfig(options: {
  config: CopyShadowConfig;
  trades: WalletPnlTradeRecord[];
}): CopyShadowSnapshot {
  const settings = options.config.settings;
  const watchedWallets = options.config.wallets.map((wallet) => wallet.toLowerCase());
  const watched = new Set(watchedWallets);
  const orderedTrades = options.trades
    .filter((trade) => trade.chain === options.config.chain)
    .sort(compareTrades);
  const pricedTrades = orderedTrades.filter(isPricedTrade);
  const sourceTrades = orderedTrades.filter((trade) => watched.has(trade.wallet.toLowerCase()));
  const pricedByToken = groupPricedTradesByToken(pricedTrades);
  const state: SimulationState = {
    sourcePositions: new Map(),
    copyPositions: new Map(),
    walletSummaries: new Map(),
    signals: [],
    totalGasUsd: 0,
    totalSlippageUsd: 0
  };

  for (const trade of sourceTrades) {
    simulateSourceTrade(state, trade, pricedByToken, settings);
  }

  const positions = buildPositions(state.copyPositions, pricedByToken, options.config.positionLimit);
  const walletSummaries = buildWalletSummaries(state.walletSummaries, positions);
  const blockBounds = tradeBlockBounds(orderedTrades);
  const copiedBuyCount = state.signals.filter((signal) => signal.status === "copied" && signal.side === "buy").length;
  const copiedSellCount = state.signals.filter((signal) => signal.status === "copied" && signal.side === "sell").length;
  const skippedSignalCount = state.signals.filter((signal) => signal.status === "skipped").length;
  const realizedPnlUsd = sum(walletSummaries.map((wallet) => wallet.realizedPnlUsd));
  const unrealizedPnlUsd = sum(positions.map((position) => position.unrealizedPnlUsd ?? 0));

  return {
    schemaVersion: COPY_SHADOW_SCHEMA_VERSION,
    chain: options.config.chain,
    generatedAt: new Date().toISOString(),
    fromBlock: blockBounds?.earliest,
    toBlock: blockBounds?.latest,
    watchedWallets,
    settings,
    sourceTradeCount: sourceTrades.length,
    pricedTradeCount: pricedTrades.length,
    copiedBuyCount,
    copiedSellCount,
    skippedSignalCount,
    realizedPnlUsd: roundMoney(realizedPnlUsd),
    unrealizedPnlUsd: roundMoney(unrealizedPnlUsd),
    openPositionCount: positions.length,
    totalGasUsd: roundMoney(state.totalGasUsd),
    totalSlippageUsd: roundMoney(state.totalSlippageUsd),
    wallets: walletSummaries,
    positions,
    recentSignals: state.signals
      .sort((a, b) => b.sourceBlock - a.sourceBlock || b.sourceLogIndex - a.sourceLogIndex)
      .slice(0, options.config.recentSignalsLimit)
  };
}

function simulateSourceTrade(
  state: SimulationState,
  trade: WalletPnlTradeRecord,
  pricedByToken: Map<string, WalletPnlTradeRecord[]>,
  settings: CopyShadowSettings
): void {
  const wallet = trade.wallet.toLowerCase();
  const tokenAddress = trade.tokenAddress.toLowerCase();
  const sourceKey = positionKey(wallet, tokenAddress);
  const sourcePosition = state.sourcePositions.get(sourceKey) ?? { quantity: 0 };
  const summary = summaryFor(state.walletSummaries, wallet);
  summary.lastBlock = Math.max(summary.lastBlock, trade.blockNumber);

  if (trade.side === "buy") {
    sourcePosition.quantity += Math.max(0, trade.baseAmount);
    state.sourcePositions.set(sourceKey, sourcePosition);
    simulateBuy(state, trade, pricedByToken, settings);
    return;
  }

  const sourceQuantityBeforeSell = sourcePosition.quantity;
  if (sourcePosition.quantity > 0) {
    sourcePosition.quantity = Math.max(0, sourcePosition.quantity - Math.max(0, trade.baseAmount));
    state.sourcePositions.set(sourceKey, sourcePosition);
  }
  simulateSell(state, trade, pricedByToken, settings, sourceQuantityBeforeSell);
}

function simulateBuy(
  state: SimulationState,
  trade: WalletPnlTradeRecord,
  pricedByToken: Map<string, WalletPnlTradeRecord[]>,
  settings: CopyShadowSettings
): void {
  const signal = baseSignal(trade, "buy");
  const sourceVolumeUsd = finiteNumber(trade.volumeUsd);
  if (sourceVolumeUsd !== undefined && sourceVolumeUsd < settings.minSourceVolumeUsd) {
    pushSkipped(state, signal, "source trade below minimum volume");
    return;
  }

  const execution = executionPriceFor(trade, pricedByToken, settings);
  if (!execution) {
    pushSkipped(state, signal, "no execution price after configured delay");
    return;
  }

  const key = positionKey(trade.wallet, trade.tokenAddress);
  const position = state.copyPositions.get(key) ?? {
    wallet: trade.wallet.toLowerCase(),
    tokenAddress: trade.tokenAddress.toLowerCase(),
    tokenSymbol: trade.tokenSymbol,
    quantity: 0,
    costUsd: 0,
    lastBlock: trade.blockNumber
  };
  const remainingCapacity = Math.max(0, settings.maxPositionUsd - position.costUsd);
  const spendUsd = Math.min(settings.tradeSizeUsd, remainingCapacity);
  if (spendUsd <= 0) {
    pushSkipped(state, signal, "max simulated position reached");
    return;
  }

  const slippageUsd = spendUsd * bps(settings.slippageBps);
  const effectiveTokenAmount = Math.max(0, spendUsd - slippageUsd) / execution.priceUsd;
  const simulatedCostUsd = spendUsd + settings.gasUsd;
  position.quantity += effectiveTokenAmount;
  position.costUsd += simulatedCostUsd;
  position.lastBlock = trade.blockNumber;
  state.copyPositions.set(key, position);
  state.totalGasUsd += settings.gasUsd;
  state.totalSlippageUsd += slippageUsd;

  const summary = summaryFor(state.walletSummaries, trade.wallet);
  summary.copiedBuyCount += 1;
  summary.lastBlock = Math.max(summary.lastBlock, trade.blockNumber);

  state.signals.push({
    ...signal,
    status: "copied",
    executionBlock: execution.blockNumber,
    executionPriceUsd: roundPrice(execution.priceUsd),
    simulatedTokenAmount: roundAmount(effectiveTokenAmount),
    simulatedCostUsd: roundMoney(simulatedCostUsd)
  });
}

function simulateSell(
  state: SimulationState,
  trade: WalletPnlTradeRecord,
  pricedByToken: Map<string, WalletPnlTradeRecord[]>,
  settings: CopyShadowSettings,
  sourceQuantityBeforeSell: number
): void {
  const signal = baseSignal(trade, "sell");
  if (sourceQuantityBeforeSell <= 0) {
    pushSkipped(state, signal, "source position not established in retained history");
    return;
  }
  const key = positionKey(trade.wallet, trade.tokenAddress);
  const position = state.copyPositions.get(key);
  if (!position || position.quantity <= 0 || position.costUsd <= 0) {
    pushSkipped(state, signal, "no simulated position to sell");
    return;
  }
  const execution = executionPriceFor(trade, pricedByToken, settings);
  if (!execution) {
    pushSkipped(state, signal, "no execution price after configured delay");
    return;
  }

  const sourceSellRatio = Math.min(1, Math.max(0, trade.baseAmount / sourceQuantityBeforeSell));
  if (sourceSellRatio <= 0) {
    pushSkipped(state, signal, "source sell amount is zero");
    return;
  }

  const sellQuantity = Math.min(position.quantity, position.quantity * sourceSellRatio);
  const grossProceedsUsd = sellQuantity * execution.priceUsd;
  const slippageUsd = grossProceedsUsd * bps(settings.slippageBps);
  const proceedsUsd = Math.max(0, grossProceedsUsd - slippageUsd - settings.gasUsd);
  const costBasisUsd = position.costUsd * (sellQuantity / position.quantity);
  const pnlUsd = proceedsUsd - costBasisUsd;
  position.quantity = Math.max(0, position.quantity - sellQuantity);
  position.costUsd = Math.max(0, position.costUsd - costBasisUsd);
  position.lastBlock = trade.blockNumber;
  if (position.quantity <= 1e-12 || position.costUsd <= 1e-8) {
    state.copyPositions.delete(key);
  } else {
    state.copyPositions.set(key, position);
  }
  state.totalGasUsd += settings.gasUsd;
  state.totalSlippageUsd += slippageUsd;

  const summary = summaryFor(state.walletSummaries, trade.wallet);
  summary.copiedSellCount += 1;
  summary.realizedPnlUsd += pnlUsd;
  summary.lastBlock = Math.max(summary.lastBlock, trade.blockNumber);

  state.signals.push({
    ...signal,
    status: "copied",
    executionBlock: execution.blockNumber,
    executionPriceUsd: roundPrice(execution.priceUsd),
    simulatedTokenAmount: roundAmount(sellQuantity),
    simulatedProceedsUsd: roundMoney(proceedsUsd),
    simulatedPnlUsd: roundMoney(pnlUsd),
    sourceSellRatio: roundPct(sourceSellRatio * 100)
  });
}

function executionPriceFor(
  sourceTrade: WalletPnlTradeRecord,
  pricedByToken: Map<string, WalletPnlTradeRecord[]>,
  settings: CopyShadowSettings
): ExecutionPrice | undefined {
  const tokenTrades = pricedByToken.get(sourceTrade.tokenAddress.toLowerCase());
  if (!tokenTrades || tokenTrades.length === 0) return undefined;
  const minBlock = sourceTrade.blockNumber + settings.executionDelayBlocks;
  const maxBlock = sourceTrade.blockNumber + settings.executionDelayBlocks + settings.maxPriceLookaheadBlocks;
  const start = lowerBoundByBlock(tokenTrades, minBlock);
  for (let index = start; index < tokenTrades.length; index += 1) {
    const candidate = tokenTrades[index]!;
    if (candidate.blockNumber > maxBlock) return undefined;
    if (settings.executionDelayBlocks === 0 && candidate.blockNumber === sourceTrade.blockNumber && candidate.logIndex < sourceTrade.logIndex) continue;
    const priceUsd = finiteNumber(candidate.priceUsd);
    if (priceUsd !== undefined && priceUsd > 0) {
      return { blockNumber: candidate.blockNumber, priceUsd };
    }
  }
  return undefined;
}

function buildPositions(
  positions: Map<string, MutableCopyPosition>,
  pricedByToken: Map<string, WalletPnlTradeRecord[]>,
  limit: number
): CopyShadowPosition[] {
  return [...positions.values()]
    .filter((position) => position.quantity > 0 && position.costUsd > 0)
    .map((position): CopyShadowPosition => {
      const latest = latestPriceFor(position.tokenAddress, pricedByToken);
      const marketValueUsd = latest !== undefined ? position.quantity * latest : undefined;
      const unrealizedPnlUsd = marketValueUsd !== undefined ? marketValueUsd - position.costUsd : undefined;
      return {
        wallet: position.wallet,
        tokenAddress: position.tokenAddress,
        tokenSymbol: position.tokenSymbol,
        quantity: roundAmount(position.quantity),
        costUsd: roundMoney(position.costUsd),
        latestPriceUsd: latest !== undefined ? roundPrice(latest) : undefined,
        marketValueUsd: marketValueUsd !== undefined ? roundMoney(marketValueUsd) : undefined,
        unrealizedPnlUsd: unrealizedPnlUsd !== undefined ? roundMoney(unrealizedPnlUsd) : undefined,
        lastBlock: position.lastBlock
      };
    })
    .sort((a, b) => (b.marketValueUsd ?? b.costUsd) - (a.marketValueUsd ?? a.costUsd))
    .slice(0, limit);
}

function tradeBlockBounds(trades: WalletPnlTradeRecord[]): { earliest: number; latest: number } | undefined {
  let earliest: number | undefined;
  let latest: number | undefined;
  for (const trade of trades) {
    if (earliest === undefined || trade.blockNumber < earliest) earliest = trade.blockNumber;
    if (latest === undefined || trade.blockNumber > latest) latest = trade.blockNumber;
  }
  return earliest === undefined || latest === undefined ? undefined : { earliest, latest };
}

function buildWalletSummaries(
  summaries: Map<string, CopyShadowWalletSummary>,
  positions: CopyShadowPosition[]
): CopyShadowWalletSummary[] {
  const positionsByWallet = new Map<string, CopyShadowPosition[]>();
  for (const position of positions) {
    const bucket = positionsByWallet.get(position.wallet) ?? [];
    bucket.push(position);
    positionsByWallet.set(position.wallet, bucket);
  }
  return [...summaries.values()]
    .map((summary): CopyShadowWalletSummary => {
      const walletPositions = positionsByWallet.get(summary.wallet) ?? [];
      return {
        ...summary,
        realizedPnlUsd: roundMoney(summary.realizedPnlUsd),
        unrealizedPnlUsd: roundMoney(sum(walletPositions.map((position) => position.unrealizedPnlUsd ?? 0))),
        openPositionCount: walletPositions.length
      };
    })
    .sort((a, b) => b.realizedPnlUsd + b.unrealizedPnlUsd - (a.realizedPnlUsd + a.unrealizedPnlUsd));
}

function groupPricedTradesByToken(trades: WalletPnlTradeRecord[]): Map<string, WalletPnlTradeRecord[]> {
  const out = new Map<string, WalletPnlTradeRecord[]>();
  for (const trade of trades) {
    const key = trade.tokenAddress.toLowerCase();
    const bucket = out.get(key) ?? [];
    bucket.push(trade);
    out.set(key, bucket);
  }
  for (const bucket of out.values()) bucket.sort(compareTrades);
  return out;
}

function latestPriceFor(tokenAddress: string, pricedByToken: Map<string, WalletPnlTradeRecord[]>): number | undefined {
  const trades = pricedByToken.get(tokenAddress.toLowerCase());
  if (!trades || trades.length === 0) return undefined;
  for (let index = trades.length - 1; index >= 0; index -= 1) {
    const priceUsd = finiteNumber(trades[index]?.priceUsd);
    if (priceUsd !== undefined && priceUsd > 0) return priceUsd;
  }
  return undefined;
}

function baseSignal(trade: WalletPnlTradeRecord, side: "buy" | "sell"): Omit<CopyShadowSignal, "status"> {
  return {
    id: `${trade.chain}:${trade.wallet.toLowerCase()}:${trade.txHash.toLowerCase()}:${trade.logIndex}:${trade.poolId.toLowerCase()}`,
    wallet: trade.wallet.toLowerCase(),
    side,
    tokenAddress: trade.tokenAddress.toLowerCase(),
    tokenSymbol: trade.tokenSymbol,
    sourceTxHash: trade.txHash.toLowerCase(),
    sourceBlock: trade.blockNumber,
    sourceLogIndex: trade.logIndex,
    sourceAmount: roundAmount(trade.baseAmount),
    sourcePriceUsd: finiteNumber(trade.priceUsd) !== undefined ? roundPrice(trade.priceUsd!) : undefined,
    sourceVolumeUsd: finiteNumber(trade.volumeUsd) !== undefined ? roundMoney(trade.volumeUsd!) : undefined
  };
}

function pushSkipped(state: SimulationState, signal: Omit<CopyShadowSignal, "status">, reason: string): void {
  const summary = summaryFor(state.walletSummaries, signal.wallet);
  summary.skippedSignalCount += 1;
  summary.lastBlock = Math.max(summary.lastBlock, signal.sourceBlock);
  state.signals.push({ ...signal, status: "skipped", reason });
}

function summaryFor(summaries: Map<string, CopyShadowWalletSummary>, walletInput: string): CopyShadowWalletSummary {
  const wallet = walletInput.toLowerCase();
  let summary = summaries.get(wallet);
  if (!summary) {
    summary = {
      wallet,
      copiedBuyCount: 0,
      copiedSellCount: 0,
      skippedSignalCount: 0,
      realizedPnlUsd: 0,
      unrealizedPnlUsd: 0,
      openPositionCount: 0,
      lastBlock: 0
    };
    summaries.set(wallet, summary);
  }
  return summary;
}

function copyShadowSettings(env: CopyShadowEnvSettings): CopyShadowSettings {
  return {
    tradeSizeUsd: env.copyShadowTradeSizeUsd,
    maxPositionUsd: env.copyShadowMaxPositionUsd,
    executionDelayBlocks: env.copyShadowExecutionDelayBlocks,
    maxPriceLookaheadBlocks: env.copyShadowMaxPriceLookaheadBlocks,
    slippageBps: env.copyShadowSlippageBps,
    gasUsd: env.copyShadowGasUsd,
    minSourceVolumeUsd: env.copyShadowMinSourceVolumeUsd
  };
}

function copyShadowIntervalMs(config: CopyShadowConfig, env: Pick<Env, "copyShadowIntervalMs">): number {
  return Math.min(15 * 60_000, Math.max(30_000, Math.floor(config.intervalMs ?? env.copyShadowIntervalMs)));
}

function lowerBoundByBlock(trades: WalletPnlTradeRecord[], blockNumber: number): number {
  let lo = 0;
  let hi = trades.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (trades[mid]!.blockNumber < blockNumber) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function compareTrades(a: WalletPnlTradeRecord, b: WalletPnlTradeRecord): number {
  return a.blockNumber - b.blockNumber || a.logIndex - b.logIndex || a.txHash.localeCompare(b.txHash);
}

function isPricedTrade(trade: WalletPnlTradeRecord): boolean {
  const priceUsd = finiteNumber(trade.priceUsd);
  return priceUsd !== undefined && priceUsd > 0 && trade.baseAmount > 0;
}

function finiteNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

function positionKey(wallet: string, tokenAddress: string): string {
  return `${wallet.toLowerCase()}:${tokenAddress.toLowerCase()}`;
}

function bps(value: number): number {
  return value / 10_000;
}

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + (Number.isFinite(value) ? value : 0), 0);
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundPrice(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value >= 1) return Math.round(value * 1_000_000) / 1_000_000;
  return Number(value.toPrecision(8));
}

function roundAmount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (Math.abs(value) >= 1) return Math.round(value * 1_000_000) / 1_000_000;
  return Number(value.toPrecision(8));
}

function roundPct(value: number): number {
  return Math.round(value * 100) / 100;
}
