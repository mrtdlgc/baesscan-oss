import type { Logger } from "pino";
import type { BlockscoutClient } from "./blockscout";
import { lookupContractCreator } from "./contractCreator";
import type { RpcPool } from "./rpcPool";
import type {
  Storage,
  WalletPnlAnalyticsSignalWallet,
  WalletPnlAnalyticsSnapshot,
  WalletPnlAnalyticsTokenSummary,
  WalletPnlTokenCreatorRecord
} from "../store/storage";
import type { Address } from "../types";
import { normalizeAddress } from "../utils/address";

const TOKEN_CREATOR_CACHE_TTL_MS = 7 * 24 * 60 * 60_000;
const BLOCKSCOUT_CONTRACT_CREATION_BATCH_SIZE = 5;
const TOKEN_CREATOR_RECORD_FLUSH_SIZE = 25;

type TokenCreatorLookupStatus = NonNullable<WalletPnlAnalyticsTokenSummary["creatorLookupStatus"]>;
interface TokenCreatorLookup {
  status: TokenCreatorLookupStatus;
  record?: WalletPnlTokenCreatorRecord;
}

const tokenCreatorCache = new Map<string, { expiresAt: number; lookup: TokenCreatorLookup }>();
type TokenCreatorStore = Pick<Storage, "getWalletPnlTokenCreator" | "upsertWalletPnlTokenCreators">;
interface TokenCreatorResolutionOptions {
  chain: WalletPnlAnalyticsSnapshot["chain"];
  tokenAddresses: string[];
  blockscoutClient?: BlockscoutClient;
  rpc?: RpcPool;
  store?: TokenCreatorStore;
  deniedTokenFactoryContracts?: readonly Address[];
  lookupDeadlineMs?: number;
  logger?: Logger;
}

export async function enrichWalletPnlAnalyticsTokenCreators(options: {
  snapshot: WalletPnlAnalyticsSnapshot;
  blockscoutClient?: BlockscoutClient;
  rpc?: RpcPool;
  store?: TokenCreatorStore;
  deniedTokenFactoryContracts: readonly Address[];
  lookupDeadlineMs?: number;
  logger?: Logger;
}): Promise<WalletPnlAnalyticsSnapshot> {
  const tokens = await enrichWalletPnlTokenSummaries({
    chain: options.snapshot.chain,
    tokens: options.snapshot.tokens,
    blockscoutClient: options.blockscoutClient,
    rpc: options.rpc,
    store: options.store,
    deniedTokenFactoryContracts: options.deniedTokenFactoryContracts,
    lookupDeadlineMs: options.lookupDeadlineMs,
    logger: options.logger
  });
  const goodSignalWallets = filterGoodSignalWalletsByDeniedCreators(options.snapshot.goodSignalWallets, tokens);
  const deniedTokenCount = tokens.filter((token) => token.createdThroughDeniedFactory ?? token.creatorDenied).length;
  if (deniedTokenCount > 0 && goodSignalWallets.length !== (options.snapshot.goodSignalWallets ?? []).length) {
    options.logger?.info(
      {
        chain: options.snapshot.chain,
        deniedTokens: deniedTokenCount,
        before: options.snapshot.goodSignalWallets?.length ?? 0,
        after: goodSignalWallets.length
      },
      "wallet pnl signal denied creator filter applied"
    );
  }
  return {
    ...options.snapshot,
    tokens,
    goodSignalWallets
  };
}

export async function filterWalletPnlAnalyticsDeniedTokenCreators(
  options: Parameters<typeof enrichWalletPnlAnalyticsTokenCreators>[0]
): Promise<WalletPnlAnalyticsSnapshot> {
  return enrichWalletPnlAnalyticsTokenCreators(options);
}

export async function enrichWalletPnlTokenSummaries(options: {
  chain: WalletPnlAnalyticsSnapshot["chain"];
  tokens: WalletPnlAnalyticsTokenSummary[];
  blockscoutClient?: BlockscoutClient;
  rpc?: RpcPool;
  store?: TokenCreatorStore;
  deniedTokenFactoryContracts: readonly Address[];
  lookupDeadlineMs?: number;
  logger?: Logger;
}): Promise<WalletPnlAnalyticsTokenSummary[]> {
  if (options.tokens.length === 0) return options.tokens;
  const deniedTokenFactoryContracts = new Set(options.deniedTokenFactoryContracts.map((address) => address.toLowerCase()));
  const lookups = await resolveWalletPnlTokenCreators({
    chain: options.chain,
    tokenAddresses: options.tokens.map((token) => token.tokenAddress),
    blockscoutClient: options.blockscoutClient,
    rpc: options.rpc,
    store: options.store,
    lookupDeadlineMs: options.lookupDeadlineMs,
    logger: options.logger
  });

  return options.tokens.map((token) => {
    const lookup = lookups.get(token.tokenAddress.toLowerCase());
    return enrichTokenSummaryWithCreator(token, lookup, deniedTokenFactoryContracts);
  });
}

async function resolveWalletPnlTokenCreators(options: TokenCreatorResolutionOptions): Promise<Map<string, TokenCreatorLookup>> {
  const tokenAddresses = uniqueNormalizedAddresses(options.tokenAddresses);
  const lookups = new Map<string, TokenCreatorLookup>();
  const missing: string[] = [];
  const deadlineAt = creatorLookupDeadlineAt(options.lookupDeadlineMs);
  const now = Date.now();
  for (const tokenAddress of tokenAddresses) {
    const key = `${options.chain}:${tokenAddress}`;
    const cached = tokenCreatorCache.get(key);
    if (cached && cached.expiresAt > now) {
      lookups.set(tokenAddress, cached.lookup);
      continue;
    }
    const stored = normalizeTokenCreatorRecord(options.store?.getWalletPnlTokenCreator(options.chain, tokenAddress));
    if (stored) {
      const lookup = { status: "resolved" as const, record: stored };
      lookups.set(tokenAddress, lookup);
      setTokenCreatorCache(options.chain, tokenAddress, lookup);
      continue;
    }
    missing.push(tokenAddress);
  }

  const unresolved = new Set(missing);
  const creatorRecords: WalletPnlTokenCreatorRecord[] = [];
  if (missing.length > 0 && options.blockscoutClient && !creatorLookupDeadlineReached(deadlineAt)) {
    for (let index = 0; index < missing.length; index += BLOCKSCOUT_CONTRACT_CREATION_BATCH_SIZE) {
      if (creatorLookupDeadlineReached(deadlineAt)) {
        logCreatorLookupDeadline(options, deadlineAt, unresolved.size, "blockscout");
        break;
      }
      const batch = missing.slice(index, index + BLOCKSCOUT_CONTRACT_CREATION_BATCH_SIZE);
      let records: Awaited<ReturnType<BlockscoutClient["fetchContractCreations"]>>;
      try {
        records = await options.blockscoutClient.fetchContractCreations(options.chain, batch);
      } catch (error) {
        options.logger?.warn(
          { chain: options.chain, count: unresolved.size, error: (error as Error).message },
          "wallet pnl token creator blockscout lookup failed"
        );
        break;
      }
      for (const record of records) {
        const tokenAddress = normalizeMaybeAddress(record.contractAddress);
        const creator = normalizeMaybeAddress(record.contractCreator);
        if (!tokenAddress || !creator) continue;
        unresolved.delete(tokenAddress);
        const normalizedRecord: WalletPnlTokenCreatorRecord = {
          chain: options.chain,
          tokenAddress,
          creator,
          creationTxHash: record.txHash,
          source: "blockscout-contract-creation",
          confidence: "high",
          updatedAt: new Date().toISOString()
        };
        creatorRecords.push(normalizedRecord);
        const lookup = { status: "resolved" as const, record: normalizedRecord };
        lookups.set(tokenAddress, lookup);
        setTokenCreatorCache(options.chain, tokenAddress, lookup);
      }
      flushCreatorRecords(options.store, creatorRecords);
    }
  }

  if (unresolved.size > 0 && options.rpc && !creatorLookupDeadlineReached(deadlineAt)) {
    for (const tokenAddress of [...unresolved]) {
      if (creatorLookupDeadlineReached(deadlineAt)) {
        logCreatorLookupDeadline(options, deadlineAt, unresolved.size, "rpc");
        break;
      }
      try {
        const result = await lookupContractCreatorWithDeadline(options.chain, options.rpc, tokenAddress, deadlineAt);
        const creator = normalizeMaybeAddress(result.creator);
        if (!creator) continue;
        unresolved.delete(tokenAddress);
        const normalizedRecord: WalletPnlTokenCreatorRecord = {
          chain: options.chain,
          tokenAddress,
          creator,
          creationTxHash: result.creationTxHash,
          creationBlock: result.creationBlock,
          source: result.source,
          confidence: result.confidence,
          createdByContract: result.createdByContract,
          updatedAt: new Date().toISOString()
        };
        creatorRecords.push(normalizedRecord);
        const lookup = { status: "resolved" as const, record: normalizedRecord };
        lookups.set(tokenAddress, lookup);
        setTokenCreatorCache(options.chain, tokenAddress, lookup);
        if (creatorRecords.length >= TOKEN_CREATOR_RECORD_FLUSH_SIZE) flushCreatorRecords(options.store, creatorRecords);
      } catch (error) {
        const lookup = { status: "unresolved" as const };
        lookups.set(tokenAddress, lookup);
        setTokenCreatorCache(options.chain, tokenAddress, lookup);
        options.logger?.debug(
          { chain: options.chain, tokenAddress, error: (error as Error).message },
          "wallet pnl token creator RPC fallback missed"
        );
      }
    }
  }

  flushCreatorRecords(options.store, creatorRecords);

  for (const tokenAddress of tokenAddresses) {
    if (!lookups.has(tokenAddress)) lookups.set(tokenAddress, { status: "pending" });
  }

  return lookups;
}

function creatorLookupDeadlineAt(lookupDeadlineMs: number | undefined): number | undefined {
  if (lookupDeadlineMs === undefined || !Number.isFinite(lookupDeadlineMs) || lookupDeadlineMs <= 0) return undefined;
  return Date.now() + Math.floor(lookupDeadlineMs);
}

function creatorLookupDeadlineReached(deadlineAt: number | undefined): boolean {
  return deadlineAt !== undefined && Date.now() >= deadlineAt;
}

async function lookupContractCreatorWithDeadline(
  chain: WalletPnlAnalyticsSnapshot["chain"],
  rpc: RpcPool,
  tokenAddress: string,
  deadlineAt: number | undefined
) {
  if (deadlineAt === undefined) return lookupContractCreator(chain, rpc, tokenAddress, {});
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw new Error("wallet pnl token creator lookup deadline reached");
  const scoped = rpc.runWithCancelScope(() => lookupContractCreator(chain, rpc, tokenAddress, {}));
  return withCreatorLookupTimeout(scoped.promise, remainingMs, scoped.cancel);
}

function withCreatorLookupTimeout<T>(promise: Promise<T>, timeoutMs: number, cancel: () => number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      const cancelled = cancel();
      reject(new Error(`wallet pnl token creator lookup timed out after ${timeoutMs}ms; cancelled ${cancelled} RPC request${cancelled === 1 ? "" : "s"}`));
    }, Math.max(1, timeoutMs));
    promise.then(resolve, reject);
  }).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function flushCreatorRecords(store: TokenCreatorStore | undefined, records: WalletPnlTokenCreatorRecord[]): void {
  if (records.length === 0) return;
  store?.upsertWalletPnlTokenCreators(records.splice(0, records.length));
}

function logCreatorLookupDeadline(
  options: TokenCreatorResolutionOptions,
  deadlineAt: number | undefined,
  unresolvedCount: number,
  phase: "blockscout" | "rpc"
): void {
  if (deadlineAt === undefined) return;
  options.logger?.warn(
    {
      chain: options.chain,
      phase,
      unresolved: unresolvedCount,
      lookupDeadlineMs: options.lookupDeadlineMs
    },
    "wallet pnl token creator lookup deadline reached"
  );
}

function enrichTokenSummaryWithCreator(
  token: WalletPnlAnalyticsTokenSummary,
  lookup: TokenCreatorLookup | undefined,
  deniedTokenFactoryContracts: ReadonlySet<string>
): WalletPnlAnalyticsTokenSummary {
  const record = normalizeTokenCreatorRecord(lookup?.record);
  const createdThroughDeniedFactory = Boolean(record?.creator && deniedTokenFactoryContracts.has(record.creator.toLowerCase()));
  return {
    ...token,
    creator: record?.creator,
    creatorTxHash: record?.creationTxHash,
    creatorBlock: record?.creationBlock,
    creatorSource: record?.source,
    creatorConfidence: record?.confidence,
    createdByContract: record?.createdByContract,
    creatorDenied: createdThroughDeniedFactory,
    createdThroughDeniedFactory,
    creatorLookupStatus: record ? "resolved" : lookup?.status ?? "pending"
  };
}

function filterGoodSignalWalletsByDeniedCreators(
  rows: WalletPnlAnalyticsSignalWallet[] | undefined,
  tokens: WalletPnlAnalyticsTokenSummary[]
): WalletPnlAnalyticsSignalWallet[] {
  const goodSignalWallets = rows ?? [];
  const deniedTokens = new Set(tokens
    .filter((token) => token.createdThroughDeniedFactory ?? token.creatorDenied)
    .map((token) => token.tokenAddress.toLowerCase()));
  if (deniedTokens.size === 0) return goodSignalWallets;
  return goodSignalWallets.filter((wallet) =>
    walletSignalTokenAddresses(wallet).every((tokenAddress) => !deniedTokens.has(tokenAddress))
  );
}

function walletSignalTokenAddresses(row: WalletPnlAnalyticsSignalWallet): string[] {
  const explicit = row.tokenAddresses ?? [];
  const fallback = row.topTokens.map((token) => token.tokenAddress);
  return [...new Set([...explicit, ...fallback].map((tokenAddress) => tokenAddress.toLowerCase()))];
}

function normalizeMaybeAddress(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return normalizeAddress(value).toLowerCase();
  } catch {
    return undefined;
  }
}

function uniqueNormalizedAddresses(addresses: string[]): string[] {
  const out = new Set<string>();
  for (const address of addresses) {
    const normalized = normalizeMaybeAddress(address);
    if (normalized) out.add(normalized);
  }
  return [...out].sort();
}

function normalizeTokenCreatorRecord(record: WalletPnlTokenCreatorRecord | undefined): WalletPnlTokenCreatorRecord | undefined {
  const creator = normalizeMaybeAddress(record?.creator);
  const tokenAddress = normalizeMaybeAddress(record?.tokenAddress);
  if (!record || !creator || !tokenAddress) return undefined;
  return {
    ...record,
    tokenAddress,
    creator
  };
}

function setTokenCreatorCache(chain: string, tokenAddress: string, lookup: TokenCreatorLookup): void {
  tokenCreatorCache.set(`${chain}:${tokenAddress.toLowerCase()}`, {
    expiresAt: Date.now() + TOKEN_CREATOR_CACHE_TTL_MS,
    lookup
  });
}
