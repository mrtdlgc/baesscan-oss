import { poolProtocol } from "../dex/uniswap";
import { walletPnlBaseV4HookPolicy } from "../services/walletPnlHookPolicy";
import { trustedV4Hook } from "../services/v4HookRisk";
import type { WalletPnlPoolRecord, WalletPnlPoolScanOptions, WalletPnlPoolSource } from "./storage";

const ALL_WALLET_PNL_POOL_SOURCES: readonly WalletPnlPoolSource[] = ["seed", "factory", "blockscout"];

export function walletPnlScanSources(sources: readonly WalletPnlPoolSource[] | undefined): Set<WalletPnlPoolSource> {
  return new Set(sources && sources.length > 0 ? sources : ALL_WALLET_PNL_POOL_SOURCES);
}

export function isFactoryUniswapV4WalletPnlPool(record: WalletPnlPoolRecord): boolean {
  return record.source === "factory" && (record.pool.dex ?? "uniswap") === "uniswap" && poolProtocol(record.pool) === "v4";
}

export function walletPnlPoolMatchesScan(
  record: WalletPnlPoolRecord,
  lastTradeBlock: number | undefined,
  options: WalletPnlPoolScanOptions | undefined
): boolean {
  if (!walletPnlScanSources(options?.sources).has(record.source)) return false;
  if (!walletPnlBaseV4HookPolicy(record.chain, record.pool, options?.trustedV4Hooks).allowed) return false;
  if (record.source === "seed") return true;
  if (lastTradeBlock !== undefined && (options?.activeFromBlock === undefined || lastTradeBlock >= options.activeFromBlock)) return true;
  if (record.source === "blockscout") return true;
  if (!isFactoryUniswapV4WalletPnlPool(record)) return true;
  return Boolean(trustedV4Hook(record.pool, options?.trustedV4Hooks));
}

export function compareWalletPnlScanPools(
  a: { record: WalletPnlPoolRecord; lastTradeBlock?: number },
  b: { record: WalletPnlPoolRecord; lastTradeBlock?: number }
): number {
  return walletPnlScanRank(a) - walletPnlScanRank(b)
    || (b.lastTradeBlock ?? b.record.lastSeenBlock ?? b.record.firstSeenBlock ?? 0)
      - (a.lastTradeBlock ?? a.record.lastSeenBlock ?? a.record.firstSeenBlock ?? 0)
    || a.record.poolId.localeCompare(b.record.poolId);
}

function walletPnlScanRank(candidate: { record: WalletPnlPoolRecord; lastTradeBlock?: number }): number {
  if (candidate.record.source === "seed") return 0;
  if (candidate.lastTradeBlock !== undefined) return 1;
  if (candidate.record.source === "blockscout") return 2;
  return 3;
}
