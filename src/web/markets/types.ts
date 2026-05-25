import type { Log, LogDescription } from "ethers";
import type { Logger } from "pino";
import type { Env } from "../../config/env";
import type { PriceService } from "../../services/price";
import type { RpcPool } from "../../services/rpcPool";
import type { R2SnapshotStore } from "../../services/r2Snapshots";
import type { Address, ChainSlug, PoolDex, PoolProtocol } from "../../types";

export type ParseableInterface = { parseLog(log: Log): LogDescription | null };
export type RecentFactorySource = {
  kind: "factory";
  dex: PoolDex;
  protocol: PoolProtocol;
  address: Address;
  topic: string;
  iface: ParseableInterface;
};
export type RecentPoolManagerSource = {
  kind: "poolManager";
  dex: "uniswap";
  protocol: "v4";
  address: Address;
  topic: string;
};
export type RecentPoolSource = RecentFactorySource | RecentPoolManagerSource;
export type ParsedTradeRaw = { baseAmountRaw: bigint; quoteAmountRaw: bigint; side: "buy" | "sell" };

export interface MarketToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  totalSupply?: string;
}

export interface MarketChartPoint {
  blockNumber: number;
  price: number;
  priceUsd?: number;
  volumeUsd?: number;
  swaps: number;
}

export interface MarketCandle {
  blockStart: number;
  blockEnd: number;
  open: number;
  high: number;
  low: number;
  close: number;
  openUsd?: number;
  highUsd?: number;
  lowUsd?: number;
  closeUsd?: number;
  volumeUsd?: number;
  swaps: number;
}

export interface MarketTradeEvent {
  blockNumber: number;
  logIndex: number;
  txHash: string;
  side: "buy" | "sell";
  price: number;
  priceUsd?: number;
  baseAmount: number;
  quoteAmount: number;
  volumeUsd?: number;
  ageSeconds: number;
  explorerUrl?: string;
}

export interface MarketWindowStats {
  seconds: number;
  priceChangePct?: number;
  volumeUsd?: number;
  quoteVolume?: number;
  swapCount: number;
  buys: number;
  sells: number;
  buyVolumeUsd?: number;
  sellVolumeUsd?: number;
}

export interface MarketSummary {
  chain: ChainSlug;
  source?: "raw-rpc" | "r2-archive";
  poolId: string;
  poolAddress?: string;
  blockSeconds: number;
  dex: string;
  protocol: string;
  pairLabel: string;
  baseToken: MarketToken;
  quoteToken: MarketToken;
  price: number;
  priceUsd?: number;
  priceChangePct?: number;
  marketCapUsd?: number;
  fdvUsd?: number;
  volumeUsd?: number;
  quoteVolume?: number;
  swapCount: number;
  windowStats: {
    m15: MarketWindowStats;
    h1: MarketWindowStats;
    h6: MarketWindowStats;
    h12: MarketWindowStats;
    h24: MarketWindowStats;
  };
  score: number;
  firstBlock: number;
  lastBlock: number;
  ageMinutes: number;
  explorerUrl?: string;
  chartPath: string;
  points: MarketChartPoint[];
  candles: MarketCandle[];
  events: MarketTradeEvent[];
}

export interface TrendingMarketsPayload {
  chain: ChainSlug;
  generatedAt: string;
  fromBlock: number;
  toBlock: number;
  lookbackBlocks: number;
  cacheMs: number;
  source: "raw-rpc" | "r2-archive";
  markets: MarketSummary[];
}

export interface NewPairSummary {
  chain: ChainSlug;
  poolId: string;
  poolAddress?: string;
  dex: string;
  protocol: string;
  pairLabel: string;
  baseToken: MarketToken;
  quoteToken: MarketToken;
  createdBlock: number;
  ageMinutes: number;
  swapCount: number;
  firstSwap?: MarketTradeEvent;
  firstBuy?: MarketTradeEvent;
  explorerUrl?: string;
  chartPath: string;
}

export interface NewPairsPayload {
  chain: ChainSlug;
  generatedAt: string;
  fromBlock: number;
  toBlock: number;
  lookbackBlocks: number;
  cacheMs: number;
  source: "raw-rpc" | "r2-archive";
  pairs: NewPairSummary[];
}

export interface TrendingMarketDeps {
  env: Env;
  rpcs: Map<ChainSlug, RpcPool>;
  priceService: PriceService;
  snapshotStore?: R2SnapshotStore;
  logger?: Logger;
}

export interface MarketSide {
  base: Address;
  quote: Address;
}

export interface MarketTrade {
  blockNumber: number;
  logIndex: number;
  txHash: string;
  side: "buy" | "sell";
  price: number;
  priceUsd?: number;
  targetAmount: number;
  quoteAmount: number;
  volumeUsd?: number;
}
