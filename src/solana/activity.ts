import { formatUnits } from "ethers";
import type { Logger } from "pino";
import type { Env } from "../config/env";
import type { PoolDex, PoolKey, TokenMetadata } from "../types";
import { CHAINS, getChain } from "../chains/registry";
import { dexLabel } from "../dex/discovery";
import { rpcCallTimeoutMs } from "../services/rpcTimeout";

interface RpcError {
  code?: number;
  message?: string;
}

interface RpcResponse<T> {
  result?: T;
  error?: RpcError;
}

interface InternalSolanaRpcStats {
  label: string;
  attempts: number;
  successes: number;
  failures: number;
  lastCall?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastSuccessSlot?: string;
  lastFailureSlot?: string;
  lastError?: string;
}

export interface SolanaRpcEndpointHealth {
  index: number;
  label: string;
  attempts: number;
  successes: number;
  failures: number;
  failurePct: number;
  lastCall?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastSuccessSlot?: string;
  lastFailureSlot?: string;
  lastError?: string;
}

export interface SolanaRpcHealth {
  providerCount: number;
  endpoints: SolanaRpcEndpointHealth[];
}

export interface SolanaSignatureInfo {
  signature: string;
  slot: number;
  blockTime?: number | null;
  err?: unknown;
}

interface SolanaTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: {
    amount: string;
    decimals: number;
  };
}

interface SolanaParsedTransaction {
  slot: number;
  blockTime?: number | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: Array<string | { pubkey: string }>;
      instructions?: unknown[];
    };
  };
  meta?: {
    err?: unknown;
    fee?: number;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: SolanaTokenBalance[];
    postTokenBalances?: SolanaTokenBalance[];
    innerInstructions?: Array<{ instructions?: unknown[] }>;
  };
}

export interface SolanaActivityEvent {
  signature: string;
  slot: number;
  blockTime?: number | null;
  buyer?: string;
  tokenMint: string;
  quoteMint: string;
  tokenAmountRaw: bigint;
  quoteAmountRaw: bigint;
  tokenDecimals: number;
  quoteDecimals: number;
  tokenAmount: string;
  quoteAmount: string;
  programIds: string[];
  dexes: PoolDex[];
}

export interface SolanaTokenActivity {
  mint: string;
  signatures: SolanaSignatureInfo[];
  transactionsChecked: number;
  events: SolanaActivityEvent[];
  newestSignature?: string;
}

export class SolanaRpcClient {
  private readonly stats: InternalSolanaRpcStats[];

  constructor(
    private readonly urls: string[],
    private readonly logger?: Logger
  ) {
    this.stats = urls.map((url) => ({
      label: sanitizeRpcLabel(url),
      attempts: 0,
      successes: 0,
      failures: 0
    }));
  }

  isConfigured(): boolean {
    return this.urls.length > 0;
  }

  healthSnapshot(): SolanaRpcHealth {
    return {
      providerCount: this.urls.length,
      endpoints: this.stats.map((stats, index) => ({
        index,
        label: stats.label,
        attempts: stats.attempts,
        successes: stats.successes,
        failures: stats.failures,
        failurePct: stats.attempts > 0 ? (stats.failures / stats.attempts) * 100 : 0,
        lastCall: stats.lastCall,
        lastSuccessAt: stats.lastSuccessAt,
        lastFailureAt: stats.lastFailureAt,
        lastSuccessSlot: stats.lastSuccessSlot,
        lastFailureSlot: stats.lastFailureSlot,
        lastError: stats.lastError
      }))
    };
  }

  async getSlot(signal?: AbortSignal): Promise<number> {
    return this.call<number>("getSlot", [], signal);
  }

  async getSignaturesForAddress(
    address: string,
    limit: number,
    until?: string,
    signal?: AbortSignal
  ): Promise<SolanaSignatureInfo[]> {
    const opts: Record<string, unknown> = { limit };
    if (until) opts.until = until;
    return this.call<SolanaSignatureInfo[]>("getSignaturesForAddress", [address, opts], signal);
  }

  async getParsedTransaction(signature: string, signal?: AbortSignal): Promise<SolanaParsedTransaction | null> {
    return this.call<SolanaParsedTransaction | null>("getTransaction", [
      signature,
      { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }
    ], signal);
  }

  async getTokenSupply(mint: string, signal?: AbortSignal): Promise<{ amount: string; decimals: number } | undefined> {
    const result = await this.call<{ value?: { amount: string; decimals: number } }>("getTokenSupply", [mint], signal);
    return result.value;
  }

  private async call<T>(method: string, params: unknown[], signal?: AbortSignal): Promise<T> {
    let lastError: unknown;
    for (let index = 0; index < this.urls.length; index++) {
      throwIfAborted(signal, method);
      const url = this.urls[index]!;
      const timeoutMs = rpcCallTimeoutMs();
      const controller = new AbortController();
      let timedOut = false;
      const onAbort = () => controller.abort();
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      timeout.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const response = await fetch(url, {
          method: "POST",
          signal: controller.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params })
        });
        if (!response.ok) throw new Error(`Solana RPC ${response.status} for ${method}`);
        const json = (await response.json()) as RpcResponse<T>;
        if (json.error) throw new Error(json.error.message ?? `Solana RPC error ${json.error.code}`);
        if (json.result === undefined) throw new Error(`Solana RPC ${method} returned no result`);
        this.recordSuccess(index, method, solanaSlotLabel(json.result));
        return json.result;
      } catch (error) {
        const normalized = timedOut
          ? new Error(`Solana RPC call timed out after ${timeoutMs}ms: ${method}`)
          : signal?.aborted
            ? new Error(`Solana RPC call cancelled: ${method}`)
            : error;
        if (signal?.aborted) throw normalized;
        lastError = normalized;
        this.recordFailure(index, method, normalized);
        this.logger?.warn({ error: normalized, method }, "solana rpc call failed, trying fallback");
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`Solana RPC ${method} failed`);
  }

  private recordSuccess(index: number, method: string, slot?: string): void {
    const stats = this.stats[index]!;
    stats.attempts++;
    stats.successes++;
    stats.lastCall = method;
    stats.lastSuccessAt = new Date().toISOString();
    stats.lastSuccessSlot = slot;
  }

  private recordFailure(index: number, method: string, error: unknown): void {
    const stats = this.stats[index]!;
    stats.attempts++;
    stats.failures++;
    stats.lastCall = method;
    stats.lastFailureAt = new Date().toISOString();
    stats.lastFailureSlot = "slot unknown";
    stats.lastError = error instanceof Error ? error.message.slice(0, 220) : String(error).slice(0, 220);
  }
}

function solanaSlotLabel(result: unknown): string | undefined {
  if (typeof result === "number") return `slot ${result}`;
  if (Array.isArray(result)) {
    const first = result.find((item) => item && typeof item === "object" && "slot" in item) as { slot?: unknown } | undefined;
    return typeof first?.slot === "number" ? `slot ${first.slot}` : undefined;
  }
  if (result && typeof result === "object" && "slot" in result) {
    const slot = (result as { slot?: unknown }).slot;
    return typeof slot === "number" ? `slot ${slot}` : undefined;
  }
  return undefined;
}

function throwIfAborted(signal: AbortSignal | undefined, method: string): void {
  if (signal?.aborted) throw new Error(`Solana RPC call cancelled: ${method}`);
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

export async function getSolanaTokenMetadata(client: SolanaRpcClient, mint: string): Promise<TokenMetadata> {
  const supply = await client.getTokenSupply(mint).catch(() => undefined);
  return {
    address: mint,
    chain: "solana",
    name: `Solana token ${mint.slice(0, 6)}`,
    symbol: mint.slice(0, 4).toUpperCase(),
    decimals: supply?.decimals ?? 6,
    totalSupply: supply?.amount
  };
}

export async function getSolanaTokenActivity(
  client: SolanaRpcClient,
  mint: string,
  env: Env,
  until?: string,
  signal?: AbortSignal
): Promise<SolanaTokenActivity> {
  const signatures = await client.getSignaturesForAddress(mint, env.solanaSignatureLimit, until, signal);
  const newestSignature = signatures[0]?.signature;
  const usable = signatures.filter((item) => !item.err).slice(0, env.solanaTransactionLimit);
  const events: SolanaActivityEvent[] = [];
  for (const item of usable) {
    throwIfAborted(signal, "getSolanaTokenActivity");
    const tx = await client.getParsedTransaction(item.signature, signal);
    if (!tx?.meta || tx.meta.err) continue;
    events.push(...extractTokenBuyEvents(tx, mint));
  }
  return { mint, signatures, transactionsChecked: usable.length, events, newestSignature };
}

export function solanaPoolForMint(mint: string, quoteMint?: string, dex?: PoolDex): PoolKey {
  const chain = getChain("solana");
  const quote = quoteMint ?? chain.nativeLikeQuotes[0]!;
  return {
    id: `mint:${mint}`,
    chain: "solana",
    dex: dex ?? "solana",
    protocol: "solana",
    currency0: mint,
    currency1: quote,
    fee: 0,
    source: "manual"
  };
}

export function solanaQuoteMetadata(mint: string, decimals: number): TokenMetadata {
  const aliases = CHAINS.solana.quoteAliases;
  const label =
    Object.entries(aliases).find(([, value]) => value.toLowerCase() === mint.toLowerCase())?.[0]?.toUpperCase() ??
    mint.slice(0, 4).toUpperCase();
  return {
    address: mint,
    chain: "solana",
    name: label,
    symbol: label,
    decimals,
    isNative: CHAINS.solana.nativeLikeQuotes.some((value) => value.toLowerCase() === mint.toLowerCase())
  };
}

export function solanaActivitySummary(activity: SolanaTokenActivity): string {
  const lines = [
    `Mint: ${activity.mint}`,
    `Signatures checked: ${activity.signatures.length}`,
    `Transactions decoded: ${activity.transactionsChecked}`,
    `Detected buy-like events: ${activity.events.length}`
  ];
  for (const event of activity.events.slice(0, 8)) {
    const dexes = event.dexes.length ? event.dexes.map(dexLabel).join("/") : "unknown program";
    lines.push(
      `- ${event.tokenAmount} token for ${event.quoteAmount} ${solanaQuoteMetadata(event.quoteMint, event.quoteDecimals).symbol} via ${dexes} (${event.signature.slice(0, 8)}...)`
    );
  }
  return lines.join("\n");
}

function extractTokenBuyEvents(tx: SolanaParsedTransaction, mint: string): SolanaActivityEvent[] {
  const quoteMints = new Set([
    ...CHAINS.solana.usdLikeQuotes,
    ...CHAINS.solana.nativeLikeQuotes
  ].map((value) => value.toLowerCase()));
  const programIds = collectProgramIds(tx);
  const dexes = inferDexes(programIds);
  const before = balancesByOwnerAndMint(tx.meta?.preTokenBalances ?? []);
  const after = balancesByOwnerAndMint(tx.meta?.postTokenBalances ?? []);
  const keys = new Set([...before.keys(), ...after.keys()]);
  const nativeDeltas = nativeSolDeltasByOwner(tx);
  const tokenDeltas = [...keys]
    .map((key) => deltaForKey(key, before, after))
    .filter((delta) => delta.mint.toLowerCase() === mint.toLowerCase() && delta.amount > 0n);

  const events: SolanaActivityEvent[] = [];
  for (const tokenDelta of tokenDeltas) {
    let quoteDelta = [...keys]
      .map((key) => deltaForKey(key, before, after))
      .filter(
        (delta) =>
          delta.owner === tokenDelta.owner &&
          quoteMints.has(delta.mint.toLowerCase()) &&
          delta.amount < 0n
      )
      .sort((a, b) => compareBigInts(absBigInt(b.amount), absBigInt(a.amount)))[0];
    if (!quoteDelta && dexes.length > 0) {
      const nativeDelta = nativeDeltas.get(tokenDelta.owner);
      if (nativeDelta !== undefined && nativeDelta < 0n) {
        quoteDelta = {
          owner: tokenDelta.owner,
          mint: CHAINS.solana.nativeLikeQuotes[0]!,
          amount: nativeDelta,
          decimals: 9
        };
      }
    }
    if (!quoteDelta) continue;
    events.push({
      signature: tx.transaction.signatures[0] ?? "",
      slot: tx.slot,
      blockTime: tx.blockTime,
      buyer: tokenDelta.owner,
      tokenMint: mint,
      quoteMint: quoteDelta.mint,
      tokenAmountRaw: tokenDelta.amount,
      quoteAmountRaw: -quoteDelta.amount,
      tokenDecimals: tokenDelta.decimals,
      quoteDecimals: quoteDelta.decimals,
      tokenAmount: formatUnits(tokenDelta.amount, tokenDelta.decimals),
      quoteAmount: formatUnits(-quoteDelta.amount, quoteDelta.decimals),
      programIds,
      dexes
    });
  }
  return events;
}

function balancesByOwnerAndMint(balances: SolanaTokenBalance[]): Map<string, SolanaTokenBalance> {
  const out = new Map<string, SolanaTokenBalance>();
  for (const balance of balances) {
    const owner = balance.owner ?? `account:${balance.accountIndex}`;
    out.set(balanceKey(owner, balance.mint), balance);
  }
  return out;
}

function deltaForKey(
  key: string,
  before: Map<string, SolanaTokenBalance>,
  after: Map<string, SolanaTokenBalance>
): { owner: string; mint: string; amount: bigint; decimals: number } {
  const [owner, mint] = parseBalanceKey(key);
  const pre = before.get(key);
  const post = after.get(key);
  const decimals = post?.uiTokenAmount.decimals ?? pre?.uiTokenAmount.decimals ?? 0;
  return {
    owner,
    mint,
    amount: BigInt(post?.uiTokenAmount.amount ?? "0") - BigInt(pre?.uiTokenAmount.amount ?? "0"),
    decimals
  };
}

function balanceKey(owner: string, mint: string): string {
  return JSON.stringify([owner, mint]);
}

function parseBalanceKey(key: string): [string, string] {
  try {
    const value = JSON.parse(key) as unknown;
    if (Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "string") {
      return [value[0], value[1]];
    }
  } catch {
    // Fall through to the legacy parser for any in-memory key that predates this helper.
  }
  const [owner = "", mint = ""] = key.split(":");
  return [owner, mint];
}

function collectProgramIds(tx: SolanaParsedTransaction): string[] {
  const accountKeys = accountKeyStrings(tx);
  const ids = new Set<string>();
  collectInstructionIds(tx.transaction.message.instructions ?? [], ids, accountKeys);
  for (const inner of tx.meta?.innerInstructions ?? []) collectInstructionIds(inner.instructions ?? [], ids, accountKeys);
  for (const key of accountKeys) {
    if (SOLANA_PROGRAM_TO_DEX.has(key)) ids.add(key);
  }
  return [...ids].filter((id) => SOLANA_PROGRAM_TO_DEX.has(id));
}

function collectInstructionIds(instructions: unknown[], ids: Set<string>, accountKeys: string[]): void {
  for (const instruction of instructions) {
    if (!instruction || typeof instruction !== "object") continue;
    const maybe = instruction as { programId?: string; programIdIndex?: number };
    if (maybe.programId) ids.add(maybe.programId);
    if (typeof maybe.programIdIndex === "number") {
      const key = accountKeys[maybe.programIdIndex];
      if (key) ids.add(key);
    }
  }
}

function accountKeyStrings(tx: SolanaParsedTransaction): string[] {
  return (tx.transaction.message.accountKeys ?? []).map((key) => (typeof key === "string" ? key : key.pubkey));
}

function nativeSolDeltasByOwner(tx: SolanaParsedTransaction): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const accountKeys = accountKeyStrings(tx);
  const pre = tx.meta?.preBalances ?? [];
  const post = tx.meta?.postBalances ?? [];
  const feePayer = accountKeys[0];
  for (let index = 0; index < accountKeys.length; index++) {
    const owner = accountKeys[index];
    const preLamports = pre[index];
    const postLamports = post[index];
    if (!owner || preLamports === undefined || postLamports === undefined) continue;
    let delta = BigInt(Math.trunc(postLamports)) - BigInt(Math.trunc(preLamports));
    if (owner === feePayer && tx.meta?.fee) delta += BigInt(Math.trunc(tx.meta.fee));
    if (delta === 0n) continue;
    out.set(owner, (out.get(owner) ?? 0n) + delta);
  }
  return out;
}

function inferDexes(programIds: string[]): PoolDex[] {
  const out: PoolDex[] = [];
  for (const programId of programIds) {
    const dex = SOLANA_PROGRAM_TO_DEX.get(programId);
    if (dex && !out.includes(dex)) out.push(dex);
  }
  return out;
}

function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function compareBigInts(a: bigint, b: bigint): number {
  if (a === b) return 0;
  return a > b ? 1 : -1;
}

const SOLANA_PROGRAM_TO_DEX = new Map<string, PoolDex>(
  CHAINS.solana.dexes.flatMap((dex) => (dex.programIds ?? []).map((programId) => [programId, dex.dex] as [string, PoolDex]))
);
