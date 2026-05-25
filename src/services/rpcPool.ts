import { AsyncLocalStorage } from "node:async_hooks";
import { Contract, JsonRpcProvider, Log, TransactionResponse } from "ethers";
import type { Interface, InterfaceAbi, Network } from "ethers";
import type { Logger } from "pino";
import { cancelProviderInflight, runProviderRequestScope } from "./abortableRpcProvider";
import { rpcCallTimeoutMs } from "./rpcTimeout";

export interface LogFilter {
  address?: string | string[];
  topics?: Array<string | string[] | null>;
  fromBlock?: number;
  toBlock?: number;
}

interface RpcCallContext {
  blockNumber?: number;
  fromBlock?: number;
  toBlock?: number;
  note?: string;
}

interface RpcCancelScope {
  cancelled: boolean;
  cancels: Set<() => number>;
}

interface InternalProviderStats {
  label: string;
  weight: number;
  maxRps?: number;
  nextAvailableAt?: number;
  attempts: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  cooldownUntil?: number;
  logBlockLimit?: number;
  avoidHistoricalLogsUntil?: number;
  lastCall?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastSuccessBlock?: string;
  lastFailureBlock?: string;
  lastError?: string;
}

export interface RpcProviderHealth {
  index: number;
  label: string;
  active: boolean;
  weight: number;
  maxRps?: number;
  attempts: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  failurePct: number;
  cooldownUntil?: string;
  logBlockLimit?: number;
  avoidHistoricalLogsUntil?: string;
  policyNotes: string[];
  lastCall?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastSuccessBlock?: string;
  lastFailureBlock?: string;
  lastError?: string;
}

export interface RpcPoolHealth {
  providerCount: number;
  activeIndex: number;
  stickyUntil?: string;
  recommendations: string[];
  providers: RpcProviderHealth[];
}

export interface RpcProviderOptions {
  label?: string;
  maxRps?: number;
  logBlockLimit?: number;
  weight?: number;
}

export interface RpcPoolOptions {
  strategy?: "fallback" | "balanced";
  providers?: RpcProviderOptions[];
}

/**
 * Holds an ordered list of JsonRpcProvider instances and runs every call against
 * provider[0] first, falling back to provider[1], provider[2], ... only on error.
 * Failures are *not* broadcast - we want to preserve free-tier RPC budgets, so a
 * healthy primary handles every call by itself.
 *
 * After a primary failure, the pool sticks with the new working provider for
 * `stickyDurationMs` before retrying the higher-priority ones, so a flaky primary
 * doesn't burn budget on the first call of every method.
 */
export class RpcPool {
  private cachedBlockNumber?: { value: number; expiresAt: number };
  private static readonly BLOCK_NUMBER_TTL_MS = 3_000;
  private stickyIndex = 0;
  private stickyUntil = 0;
  private static readonly STICKY_MS = 60_000;
  private readonly providerStats: InternalProviderStats[];
  private readonly cancelScopes = new AsyncLocalStorage<RpcCancelScope>();
  private readonly strategy: "fallback" | "balanced";

  constructor(private readonly providers: JsonRpcProvider[], private readonly logger?: Logger, providerLabelsOrOptions: string[] | RpcPoolOptions = []) {
    if (providers.length === 0) throw new Error("RpcPool requires at least one provider");
    const options: RpcPoolOptions = Array.isArray(providerLabelsOrOptions)
      ? { strategy: "fallback", providers: providerLabelsOrOptions.map((label): RpcProviderOptions => ({ label })) }
      : providerLabelsOrOptions;
    const providerOptions = options.providers ?? [];
    this.strategy = options.strategy ?? "fallback";
    this.providerStats = providers.map((_, index) => ({
      label: sanitizeRpcLabel(providerOptions[index]?.label ?? `provider ${index}`),
      weight: Math.max(0.1, providerOptions[index]?.weight ?? 1),
      maxRps: providerOptions[index]?.maxRps && providerOptions[index]!.maxRps! > 0 ? providerOptions[index]!.maxRps : undefined,
      attempts: 0,
      successes: 0,
      failures: 0,
      consecutiveFailures: 0,
      ...defaultProviderPolicy(providerOptions[index]?.label ?? ""),
      ...(providerOptions[index]?.logBlockLimit ? { logBlockLimit: providerOptions[index]!.logBlockLimit } : {})
    }));
  }

  size(): number {
    return this.providers.length;
  }

  /** First provider; used for one-shot Contract construction at startup. */
  primary(): JsonRpcProvider {
    return this.providers[this.activeIndex()]!;
  }

  destroy(): void {
    for (const provider of this.providers) provider.destroy();
  }

  cancelInflight(): number {
    return this.providers.reduce((count, provider) => count + cancelProviderInflight(provider), 0);
  }

  runWithCancelScope<T>(work: () => Promise<T>): { promise: Promise<T>; cancel: () => number } {
    const existing = this.cancelScopes.getStore();
    if (existing) {
      return {
        promise: Promise.resolve().then(work),
        cancel: () => cancelScope(existing)
      };
    }
    const scope: RpcCancelScope = { cancelled: false, cancels: new Set() };
    const promise = this.cancelScopes.run(scope, () => Promise.resolve().then(work)).finally(() => {
      scope.cancels.clear();
    });
    return {
      promise,
      cancel: () => cancelScope(scope)
    };
  }

  healthSnapshot(): RpcPoolHealth {
    const activeIndex = this.activeIndex();
    return {
      providerCount: this.providers.length,
      activeIndex,
      stickyUntil: this.strategy === "fallback" && this.stickyUntil > Date.now() ? new Date(this.stickyUntil).toISOString() : undefined,
      recommendations: this.recommendations(),
      providers: this.providerStats.map((stats, index) => ({
        index,
        label: stats.label,
        active: index === activeIndex,
        weight: stats.weight,
        maxRps: stats.maxRps,
        attempts: stats.attempts,
        successes: stats.successes,
        failures: stats.failures,
        consecutiveFailures: stats.consecutiveFailures,
        failurePct: stats.attempts > 0 ? (stats.failures / stats.attempts) * 100 : 0,
        cooldownUntil: stats.cooldownUntil && stats.cooldownUntil > Date.now() ? new Date(stats.cooldownUntil).toISOString() : undefined,
        logBlockLimit: stats.logBlockLimit,
        avoidHistoricalLogsUntil:
          stats.avoidHistoricalLogsUntil && stats.avoidHistoricalLogsUntil > Date.now()
            ? new Date(stats.avoidHistoricalLogsUntil).toISOString()
            : undefined,
        policyNotes: this.policyNotes(index),
        lastCall: stats.lastCall,
        lastSuccessAt: stats.lastSuccessAt,
        lastFailureAt: stats.lastFailureAt,
        lastSuccessBlock: stats.lastSuccessBlock,
        lastFailureBlock: stats.lastFailureBlock,
        lastError: stats.lastError
      }))
    };
  }

  private activeIndex(): number {
    if (this.strategy === "fallback" && this.stickyUntil > Date.now()) return this.stickyIndex;
    return this.providerOrder("health", {})[0] ?? 0;
  }

  async withFallback<T>(
    label: string,
    fn: (provider: JsonRpcProvider) => Promise<T>,
    context: RpcCallContext = {},
    successBlock?: (result: T) => number | undefined
  ): Promise<T> {
    const order = this.providerOrder(label, context);
    const first = order[0] ?? 0;
    let lastError: unknown;
    for (let offset = 0; offset < order.length; offset++) {
      const cancelScope = this.cancelScopes.getStore();
      if (cancelScope?.cancelled) throw new Error(`RPC operation cancelled: ${label}`);
      const idx = order[offset]!;
      const provider = this.providers[idx]!;
      try {
        const waitMs = this.reserveProviderSlot(idx);
        if (waitMs > 0) await delay(waitMs);
        const scoped = runProviderRequestScope(provider, () => fn(provider));
        cancelScope?.cancels.add(scoped.cancel);
        const result = await withTimeout(
          scoped.promise,
          rpcCallTimeoutMs(),
          `${label} provider ${idx}`,
          scoped.cancel
        ).finally(() => {
          cancelScope?.cancels.delete(scoped.cancel);
        });
        this.recordSuccess(idx, label, context, successBlock?.(result));
        if (this.strategy === "fallback" && idx !== first) {
          this.stickyIndex = idx;
          this.stickyUntil = Date.now() + RpcPool.STICKY_MS;
          this.logger?.warn({ label, providerIndex: idx }, "rpc call fell over to backup provider");
        }
        return result;
      } catch (error) {
        if (this.cancelScopes.getStore()?.cancelled) throw error;
        if (isDeterministicContractCallFailure(label, error)) throw error;
        lastError = error;
        this.recordFailure(idx, label, error, context);
        this.logger?.warn({ label, providerIndex: idx, error: errorMessage(error) }, "rpc provider failed; trying next");
      }
    }
    throw lastError;
  }

  async getNetwork(): Promise<Network> {
    return this.withFallback("getNetwork", (p) => p.getNetwork(), { note: "network" });
  }

  async getBlockNumber(): Promise<number> {
    const cached = this.cachedBlockNumber;
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.value;
    const value = await this.withFallback("getBlockNumber", (p) => p.getBlockNumber(), latestKnownBlockContext(cached?.value), (block) => block);
    const monotonic = Math.max(cached?.value ?? 0, value);
    this.cachedBlockNumber = { value: monotonic, expiresAt: now + RpcPool.BLOCK_NUMBER_TTL_MS };
    return monotonic;
  }

  async getLogs(filter: LogFilter): Promise<Log[]> {
    const balancedLimit = this.balancedLogChunkLimit(filter);
    if (balancedLimit !== undefined && filter.fromBlock !== undefined && filter.toBlock !== undefined) {
      const range = Math.max(1, filter.toBlock - filter.fromBlock + 1);
      if (range > balancedLimit) {
        const logs: Log[] = [];
        for (let start = filter.fromBlock; start <= filter.toBlock; start += balancedLimit) {
          const end = Math.min(filter.toBlock, start + balancedLimit - 1);
          logs.push(...await this.getLogs({ ...filter, fromBlock: start, toBlock: end }));
        }
        return logs;
      }
    }
    return this.withFallback("getLogs", (p) => p.getLogs(filter), blockRangeContext(filter));
  }

  async getTransaction(hash: string): Promise<TransactionResponse | null> {
    return this.withFallback("getTransaction", (p) => p.getTransaction(hash), { note: shortHash(hash) });
  }

  async send<T = unknown>(method: string, params: unknown[] = [], context: RpcCallContext = {}): Promise<T> {
    return this.withFallback(`rpc:${method}`, (p) => p.send(method, params) as Promise<T>, context);
  }

  async getBalance(address: string): Promise<bigint> {
    return this.withFallback("getBalance", (p) => p.getBalance(address), { note: shortAddress(address) });
  }

  async getCode(address: string, blockNumber?: number): Promise<string> {
    return this.withFallback("getCode", (p) => p.getCode(address, blockNumber), { blockNumber, note: shortAddress(address) });
  }

  async callContract<T>(
    address: string,
    abi: Interface | InterfaceAbi,
    method: string,
    args: unknown[] = []
  ): Promise<T> {
    return this.withFallback(`contract:${method}`, async (p) => {
      const contract = new Contract(address, abi, p);
      const fn = (contract as unknown as Record<string, (...args: unknown[]) => Promise<T>>)[method];
      if (typeof fn !== "function") throw new Error(`Contract method not found: ${method}`);
      return fn.apply(contract, args);
    }, { note: shortAddress(address) });
  }

  private recordSuccess(index: number, label: string, context: RpcCallContext, blockNumber?: number): void {
    const stats = this.providerStats[index]!;
    stats.attempts++;
    stats.successes++;
    stats.consecutiveFailures = 0;
    stats.cooldownUntil = undefined;
    if (label === "getLogs") stats.avoidHistoricalLogsUntil = undefined;
    stats.lastCall = label;
    stats.lastSuccessAt = new Date().toISOString();
    stats.lastSuccessBlock = blockNumber !== undefined ? `block ${blockNumber}` : blockContextLabel(context);
  }

  private recordFailure(index: number, label: string, error: unknown, context: RpcCallContext): void {
    const stats = this.providerStats[index]!;
    stats.attempts++;
    stats.failures++;
    stats.consecutiveFailures++;
    const logLimit = detectLogBlockLimit(error);
    if (label === "getLogs" && logLimit !== undefined) {
      stats.logBlockLimit = stats.logBlockLimit === undefined ? logLimit : Math.min(stats.logBlockLimit, logLimit);
    }
    const cooldownMs = providerCooldownMs(label, error, stats.consecutiveFailures);
    if (cooldownMs > 0) stats.cooldownUntil = Date.now() + cooldownMs;
    if (label === "getLogs" && isHistoricalStateUnavailable(error)) {
      stats.avoidHistoricalLogsUntil = Date.now() + 30 * 60_000;
    }
    stats.lastCall = label;
    stats.lastFailureAt = new Date().toISOString();
    stats.lastFailureBlock = blockContextLabel(context);
    stats.lastError = errorMessage(error).slice(0, 220);
  }

  private providerOrder(label: string, context: RpcCallContext): number[] {
    const now = Date.now();
    const all = this.providers.map((_, index) => index);
    const eligible = all.filter((index) => this.canUseProvider(index, label, context, now));
    const candidates = eligible.length > 0 ? eligible : all;
    if (this.strategy === "balanced") {
      return candidates.sort((a, b) => this.balancedProviderScore(a, now) - this.balancedProviderScore(b, now) || a - b);
    }
    const sorted = candidates.sort((a, b) => this.providerScore(a, now) - this.providerScore(b, now) || a - b);
    if (this.stickyUntil > now && sorted.includes(this.stickyIndex)) {
      return [this.stickyIndex, ...sorted.filter((index) => index !== this.stickyIndex)];
    }
    return sorted;
  }

  private reserveProviderSlot(index: number): number {
    const stats = this.providerStats[index]!;
    if (!stats.maxRps) return 0;
    const now = Date.now();
    const waitMs = Math.max(0, (stats.nextAvailableAt ?? 0) - now);
    const reservedAt = now + waitMs;
    stats.nextAvailableAt = reservedAt + Math.ceil(1000 / stats.maxRps);
    return waitMs;
  }

  private canUseProvider(index: number, label: string, context: RpcCallContext, now: number): boolean {
    const stats = this.providerStats[index]!;
    if (stats.cooldownUntil && stats.cooldownUntil > now) return false;
    if (label === "getLogs") {
      const range = blockRangeSize(context);
      if (this.strategy === "balanced" && range !== undefined && stats.logBlockLimit !== undefined && range > stats.logBlockLimit) return false;
      if (stats.avoidHistoricalLogsUntil && stats.avoidHistoricalLogsUntil > now) return false;
    }
    return true;
  }

  private providerScore(index: number, now: number): number {
    const stats = this.providerStats[index]!;
    if (stats.cooldownUntil && stats.cooldownUntil > now) return 10_000 + index;
    if (stats.attempts === 0) return 50 + index * 0.01;
    const failurePct = (stats.failures / stats.attempts) * 100;
    const successBonus = Math.min(2, stats.successes / 20);
    return failurePct + stats.consecutiveFailures * 15 - successBonus + index * 0.01;
  }

  private balancedProviderScore(index: number, now: number): number {
    const stats = this.providerStats[index]!;
    const waitMs = Math.max(0, (stats.nextAvailableAt ?? 0) - now);
    const failurePct = stats.attempts > 0 ? (stats.failures / stats.attempts) * 100 : 0;
    const normalizedUse = stats.attempts / stats.weight;
    return waitMs / 100 + normalizedUse + failurePct + stats.consecutiveFailures * 20;
  }

  private balancedLogChunkLimit(filter: LogFilter): number | undefined {
    if (this.strategy !== "balanced") return undefined;
    const context = blockRangeContext(filter);
    const range = blockRangeSize(context);
    if (range === undefined) return undefined;
    const ordered = this.providerOrder("getLogs", context);
    const limits = (ordered.length > 0 ? ordered : this.providers.map((_, index) => index))
      .map((index) => this.providerStats[index]?.logBlockLimit)
      .filter((limit): limit is number => limit !== undefined && limit > 0);
    if (limits.length === 0) return undefined;
    const supportingLimits = limits.filter((limit) => limit >= range);
    if (supportingLimits.length > 0) return Math.min(...supportingLimits);
    return Math.max(...limits);
  }

  private recommendations(): string[] {
    const out: string[] = [];
    const active = this.activeIndex();
    if (active !== 0) out.push(`runtime is preferring provider #${active}; consider moving it earlier in *_RPC_URLS if it stays healthy`);
    for (let index = 0; index < this.providerStats.length; index++) {
      const stats = this.providerStats[index]!;
      if (stats.attempts >= 10 && stats.failures / stats.attempts >= 0.25) out.push(`#${index} is unstable; remove it or leave it as a last fallback`);
      if (stats.logBlockLimit !== undefined) out.push(`#${index} getLogs cap learned: ${stats.logBlockLimit} blocks`);
      if (stats.avoidHistoricalLogsUntil && stats.avoidHistoricalLogsUntil > Date.now()) out.push(`#${index} is cooling down for historical getLogs`);
    }
    return out.slice(0, 5);
  }

  private policyNotes(index: number): string[] {
    const stats = this.providerStats[index]!;
    const notes: string[] = [];
    const now = Date.now();
    if (stats.cooldownUntil && stats.cooldownUntil > now) notes.push(`cooldown until ${new Date(stats.cooldownUntil).toISOString()}`);
    if (stats.logBlockLimit !== undefined) notes.push(`getLogs cap ${stats.logBlockLimit} blocks`);
    if (stats.avoidHistoricalLogsUntil && stats.avoidHistoricalLogsUntil > now) notes.push(`historical logs cooldown until ${new Date(stats.avoidHistoricalLogsUntil).toISOString()}`);
    if (stats.consecutiveFailures > 0) notes.push(`${stats.consecutiveFailures} consecutive failures`);
    return notes;
  }
}

function latestKnownBlockContext(blockNumber: number | undefined): RpcCallContext {
  return blockNumber === undefined ? { note: "latest" } : { blockNumber, note: "cached latest" };
}

function cancelScope(scope: RpcCancelScope): number {
  scope.cancelled = true;
  let cancelled = 0;
  for (const cancel of [...scope.cancels]) cancelled += cancel();
  return cancelled;
}

function blockRangeContext(filter: LogFilter): RpcCallContext {
  return {
    fromBlock: typeof filter.fromBlock === "number" ? filter.fromBlock : undefined,
    toBlock: typeof filter.toBlock === "number" ? filter.toBlock : undefined
  };
}

function blockContextLabel(context: RpcCallContext): string | undefined {
  if (context.fromBlock !== undefined || context.toBlock !== undefined) {
    return `blocks ${context.fromBlock ?? "?"}-${context.toBlock ?? "?"}`;
  }
  if (context.blockNumber !== undefined) return `block ${context.blockNumber}`;
  return context.note;
}

function blockRangeSize(context: RpcCallContext): number | undefined {
  if (context.fromBlock === undefined || context.toBlock === undefined) return undefined;
  return Math.max(1, context.toBlock - context.fromBlock + 1);
}

function defaultProviderPolicy(label: string): Pick<InternalProviderStats, "logBlockLimit"> {
  const lower = label.toLowerCase();
  if (lower.includes("nodies.app")) return { logBlockLimit: 500 };
  return {};
}

function detectLogBlockLimit(error: unknown): number | undefined {
  const message = errorMessage(error).toLowerCase();
  if (!/block range|range too large|maximum allowed|limit/.test(message)) return undefined;
  const match = message.match(/(?:maximum allowed is|at most|maximum)\s*(\d{2,7})\s*blocks?/) ?? message.match(/(\d{2,7})\s*blocks?/);
  if (!match?.[1]) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 500;
}

function isHistoricalStateUnavailable(error: unknown): boolean {
  return /historical state is not available/i.test(errorMessage(error));
}

function providerCooldownMs(label: string, error: unknown, consecutiveFailures: number): number {
  const message = errorMessage(error).toLowerCase();
  if (label === "getLogs" && /block range|range too large|maximum allowed/.test(message)) return 15_000;
  if (/historical state is not available/.test(message)) return 30 * 60_000;
  if (/rate limit|too many requests|429/.test(message)) return 60_000;
  if (/503|service unavailable|500 internal|bad gateway|gateway timeout/.test(message)) return 5 * 60_000;
  if (/timed out|timeout|etimedout/.test(message)) return 2 * 60_000;
  return Math.min(5 * 60_000, consecutiveFailures * 30_000);
}

function isDeterministicContractCallFailure(label: string, error: unknown): boolean {
  if (!label.startsWith("contract:") && !label.startsWith("curve:")) return false;
  const message = errorMessage(error).toLowerCase();
  if (isTransientRpcFailureMessage(message)) return false;
  return /missing revert data|execution reverted|call_exception|could not decode result data/.test(message);
}

function isTransientRpcFailureMessage(message: string): boolean {
  return /rate limit|too many requests|429|503|service unavailable|500 internal|bad gateway|gateway timeout|timed out|timeout|etimedout|econnreset|socket|network error|fetch failed/.test(message);
}

function sanitizeRpcLabel(value: string): string {
  try {
    const url = new URL(value);
    const hasPath = url.pathname && url.pathname !== "/";
    return `${url.protocol}//${url.host}${hasPath ? "/..." : ""}`;
  } catch {
    return value.replace(/[A-Za-z0-9_-]{16,}/g, "***").slice(0, 80);
  }
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeRpcError(message);
}

function sanitizeRpcError(message: string): string {
  return message.replace(/https?:\/\/[^\s"',)\\]+/g, (value) => sanitizeRpcLabel(value));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortAddress(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function shortHash(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string, onTimeout?: () => number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        const cancelled = onTimeout?.() ?? 0;
        const suffix = cancelled > 0 ? `; cancelled ${cancelled} inflight request${cancelled === 1 ? "" : "s"}` : "";
        reject(new Error(`RPC call timed out after ${timeoutMs}ms: ${label}${suffix}`));
      }, timeoutMs);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
