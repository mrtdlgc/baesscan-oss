import type { ChainSlug } from "../../types";
import { boundedNumber, DEFAULT_MARKET_BUILD_TIMEOUT_MS } from "./config";
import type { TrendingMarketDeps } from "./types";

function buildTimeoutMs(): number {
  return boundedNumber("MARKET_BUILD_TIMEOUT_MS", DEFAULT_MARKET_BUILD_TIMEOUT_MS, 5_000, 60_000);
}

function withBuildTimeout<T>(
  label: string,
  start: (signal: AbortSignal) => { promise: Promise<T>; cancel?: () => number }
): Promise<T> {
  const ms = buildTimeoutMs();
  const controller = new AbortController();
  let task: { promise: Promise<T>; cancel?: () => number };
  try {
    task = start(controller.signal);
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      const cancelled = task.cancel?.() ?? 0;
      const suffix = cancelled > 0 ? `; cancelled ${cancelled} inflight request${cancelled === 1 ? "" : "s"}` : "";
      reject(new Error(`${label} timed out after ${ms}ms${suffix}`));
    }, ms);
    task.promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export function withTimedMarketBuild<T>(
  deps: TrendingMarketDeps,
  chain: ChainSlug,
  label: string,
  work: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  return withBuildTimeout(label, (signal) => {
    const rpc = deps.rpcs.get(chain);
    if (!rpc) return { promise: Promise.resolve().then(() => work(signal)), cancel: () => 0 };
    return rpc.runWithCancelScope(() => work(signal));
  });
}

export function throwIfAborted(signal: AbortSignal, label: string): void {
  if (signal.aborted) throw new Error(`${label} cancelled`);
}
