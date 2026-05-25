import type { RpcPool } from "../../services/rpcPool";

export function sumDefined(values: Array<number | undefined>): number | undefined {
  let sum = 0;
  let any = false;
  for (const value of values) {
    if (value === undefined || !Number.isFinite(value)) continue;
    sum += value;
    any = true;
  }
  return any ? sum : undefined;
}

export function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

export class MarketArchiveUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = "market_archive_unavailable";

  constructor(route: string, chain: string) {
    super(`Archived ${route} data is not available for ${chain} yet.`);
    this.name = "MarketArchiveUnavailableError";
  }
}

export function rpcHealthSummary(rpc: RpcPool): Array<{ url: string; attempts: number; failures: number; failurePct: number; active: boolean }> {
  return rpc.healthSnapshot().providers.map((p) => ({
    url: p.label,
    attempts: p.attempts,
    failures: p.failures,
    failurePct: Number(p.failurePct.toFixed(1)),
    active: p.active
  }));
}
