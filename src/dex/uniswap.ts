import { AbiCoder, keccak256, Log } from "ethers";
import type { Logger } from "pino";
import type { Address, ChainSlug, Hex32, HookDiscoveryFilter, PoolDex, PoolKey, PoolProtocol, TokenId } from "../types";
import { getChain, type DexDeployment } from "../chains/registry";
import { addressToTopic, isSameAddress, normalizeAddress, sortedCurrencies } from "../utils/address";
import {
  BASE_CLANKER_HOOKS,
  BASE_FLAUNCH_HOOKS,
  BASE_LAUNCHPAD_HOOKS,
  BASE_POOL_MANAGER,
  BASE_V2_FACTORY,
  BASE_V3_FACTORY,
  ZERO_ADDRESS
} from "../uniswap/constants";
import {
  INITIALIZE_TOPIC,
  POOL_MANAGER_IFACE,
  V2_FACTORY_IFACE,
  V2_PAIR_ABI,
  V2_PAIR_CREATED_TOPIC,
  V3_FACTORY_IFACE,
  V3_POOL_ABI,
  V3_POOL_CREATED_TOPIC
} from "../uniswap/abis";
import type { BlockscoutClient, BlockscoutLogFilter, BlockscoutTokenTransferRecord } from "../services/blockscout";
import type { RpcPool } from "../services/rpcPool";

const ABI_CODER = AbiCoder.defaultAbiCoder();
const BLOCKSCOUT_POOL_DISCOVERY_TRANSFER_PAGES = 4;
const BLOCKSCOUT_POOL_DISCOVERY_TX_LOG_LIMIT = 25;
const BLOCKSCOUT_POOL_DISCOVERY_ADDRESS_LIMIT = 50;

export interface DiscoverPoolsOptions {
  chain?: ChainSlug;
  dexDeployment?: DexDeployment;
  poolManagerAddress?: Address;
  v3FactoryAddress?: Address;
  v2FactoryAddress?: Address;
  protocols?: PoolProtocol[];
  token: Address;
  quote?: Address;
  fromBlock: number;
  toBlock: number;
  chunkSize: number;
  onlyClankerHooks?: boolean;
  hookFilter?: HookDiscoveryFilter;
  blockscoutClient?: BlockscoutClient;
  logger?: Logger;
  blockscoutLogScanFallback?: boolean;
  /** When true, abort the scan as soon as the first matching pool is found. */
  stopOnFirst?: boolean;
  excludePoolIds?: Iterable<string>;
  onProgress?: (progress: GetLogsProgress) => void;
  onPoolFound?: (pool: PoolKey) => void | Promise<void>;
}

export interface DiscoverPoolByIdOptions {
  chain?: ChainSlug;
  poolManagerAddress: Address;
  poolId: Hex32;
  fromBlock: number;
  toBlock: number;
  chunkSize: number;
  blockscoutClient?: BlockscoutClient;
  logger?: Logger;
  onProgress?: (progress: GetLogsProgress) => void;
}

export interface DiscoverPoolByAddressOptions {
  chain?: ChainSlug;
  dexDeployment?: DexDeployment;
  poolAddress: Address;
}

export function computePoolId(input: {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}): Hex32 {
  const encoded = ABI_CODER.encode(
    ["address", "address", "uint24", "int24", "address"],
    [input.currency0, input.currency1, input.fee, input.tickSpacing, input.hooks]
  );
  return keccak256(encoded) as Hex32;
}

export function manualPoolKey(args: {
  chain?: ChainSlug;
  currencyA: Address;
  currencyB: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}): PoolKey {
  const [currency0, currency1] = sortedCurrencies(args.currencyA, args.currencyB);
  const id = computePoolId({
    currency0,
    currency1,
    fee: args.fee,
    tickSpacing: args.tickSpacing,
    hooks: normalizeAddress(args.hooks)
  });

  return {
    id,
    chain: args.chain ?? "base",
    dex: "uniswap",
    protocol: "v4",
    currency0,
    currency1,
    fee: args.fee,
    tickSpacing: args.tickSpacing,
    hooks: normalizeAddress(args.hooks),
    source: "manual"
  };
}

export function poolProtocol(pool: PoolKey): PoolProtocol {
  return pool.protocol ?? "v4";
}

export function poolDex(pool: PoolKey): PoolDex {
  return pool.dex ?? "uniswap";
}

export async function discoverPools(rpc: RpcPool, opts: DiscoverPoolsOptions): Promise<PoolKey[]> {
  const token = normalizeAddress(opts.token);
  const quote = opts.quote ? normalizeAddress(opts.quote) : undefined;
  const quoteMatches = quoteCandidates(opts.chain ?? "base", quote);
  const protocols = opts.protocols?.length ? opts.protocols : (["v4", "v3", "v2"] as PoolProtocol[]);
  const byId = new Map<string, PoolKey>();
  const excludedPoolIds = new Set(Array.from(opts.excludePoolIds ?? [], (id) => id.toLowerCase()));

  const shouldStop = () => Boolean(opts.stopOnFirst) && byId.size > 0;
  const addPool = async (pool: PoolKey) => {
    pool.chain = opts.chain ?? "base";
    const key = pool.id.toLowerCase();
    if (excludedPoolIds.has(key) || byId.has(key)) return;
    byId.set(key, pool);
    if (opts.onPoolFound) await opts.onPoolFound(pool);
  };

  await discoverPoolsFromBlockscoutTransfers(rpc, opts, token, quoteMatches, protocols, addPool, shouldStop);

  for (const protocol of protocols) {
    if (shouldStop()) break;
    if (protocol === "v4") {
      await discoverV4Pools(rpc, opts, token, quoteMatches, addPool, shouldStop);
    } else if (protocol === "v3") {
      await discoverV3Pools(rpc, opts, token, quoteMatches, addPool, shouldStop);
    } else if (protocol === "v2") {
      await discoverV2Pools(rpc, opts, token, quoteMatches, addPool, shouldStop);
    }
  }

  return [...byId.values()].sort((a, b) => (a.createdBlock ?? 0) - (b.createdBlock ?? 0));
}

async function discoverV4Pools(
  rpc: RpcPool,
  opts: DiscoverPoolsOptions,
  token: Address,
  quotes: Address[] | undefined,
  addPool: (pool: PoolKey) => Promise<void>,
  shouldStop: () => boolean
) {
  const manager = opts.poolManagerAddress ?? (opts.dexDeployment?.poolManagerAddress as Address | undefined) ?? BASE_POOL_MANAGER;
  const filters = buildInitializeFilters(manager, token, quotes);
  const hookFilter = opts.hookFilter ?? (opts.onlyClankerHooks ? "clanker" : undefined);

  for (const filter of filters) {
    if (shouldStop()) break;
    await getDiscoveryLogs(
      rpc,
      opts,
      filter,
      async (log: Log) => {
        const pool = parseInitializeLog(log);
        if (!pool) return;
        if (!isSameAddress(pool.currency0, token) && !isSameAddress(pool.currency1, token)) return;
        if (!poolHasAnyQuote(pool, quotes)) return;
        if (hookFilter && !poolHookMatchesFilter(pool.hooks, hookFilter)) return;
        await addPool(pool);
      },
      shouldStop
    );
  }
}

async function discoverPoolsFromBlockscoutTransfers(
  rpc: RpcPool,
  opts: DiscoverPoolsOptions,
  token: Address,
  quotes: Address[] | undefined,
  protocols: PoolProtocol[],
  addPool: (pool: PoolKey) => Promise<void>,
  shouldStop: () => boolean
): Promise<void> {
  const blockscout = opts.blockscoutClient;
  if (!blockscout) return;

  let transfers: Awaited<ReturnType<BlockscoutClient["fetchTokenTransfers"]>>;
  try {
    transfers = await blockscout.fetchTokenTransfers({
      chain: opts.chain ?? "base",
      tokenAddress: token,
      pageLimit: BLOCKSCOUT_POOL_DISCOVERY_TRANSFER_PAGES
    });
  } catch (error) {
    opts.logger?.warn(
      { chain: opts.chain ?? "base", token, error: (error as Error).message },
      "Blockscout token transfer pool discovery failed; falling back to RPC logs"
    );
    return;
  }

  if (transfers.length === 0) return;
  const inRange = transfers.filter((transfer) => transfer.blockNumber === undefined || (transfer.blockNumber >= opts.fromBlock && transfer.blockNumber <= opts.toBlock));
  const txHashes = blockscoutCandidateTxHashes(inRange, opts, protocols);
  for (const txHash of txHashes) {
    if (shouldStop()) break;
    let logs: Log[];
    try {
      logs = await blockscout.fetchTransactionLogs(opts.chain ?? "base", txHash);
    } catch (error) {
      opts.logger?.warn(
        { chain: opts.chain ?? "base", token, txHash, error: (error as Error).message },
        "Blockscout transaction log pool discovery failed"
      );
      continue;
    }
    for (const log of logs) {
      if (shouldStop()) break;
      const pool = parseBlockscoutTransferPoolLog(log, opts, protocols);
      if (pool) await addBlockscoutTransferPool(pool, token, quotes, opts, addPool);
    }
  }

  if (shouldStop()) return;
  const poolAddresses = blockscoutCandidatePoolAddresses(inRange, token, opts, protocols);
  for (const poolAddress of poolAddresses) {
    if (shouldStop()) break;
    const pool = await discoverPoolByAddress(rpc, { chain: opts.chain, dexDeployment: opts.dexDeployment, poolAddress }).catch(() => undefined);
    if (pool) await addBlockscoutTransferPool({ ...pool, source: "discovered" }, token, quotes, opts, addPool);
  }
}

async function discoverV3Pools(
  rpc: RpcPool,
  opts: DiscoverPoolsOptions,
  token: Address,
  quotes: Address[] | undefined,
  addPool: (pool: PoolKey) => Promise<void>,
  shouldStop: () => boolean
) {
  const factory = opts.v3FactoryAddress ?? opts.dexDeployment?.v3FactoryAddress ?? BASE_V3_FACTORY;
  const filters = buildFactoryFilters(factory, V3_POOL_CREATED_TOPIC, token, quotes);

  for (const filter of filters) {
    if (shouldStop()) break;
    await getDiscoveryLogs(
      rpc,
      opts,
      filter,
      async (log: Log) => {
        const pool = parseV3PoolCreatedLog(log);
        if (!pool) return;
        if (!isSameAddress(pool.currency0, token) && !isSameAddress(pool.currency1, token)) return;
        if (!poolHasAnyQuote(pool, quotes)) return;
        await addPool(pool);
      },
      shouldStop
    );
  }
}

async function discoverV2Pools(
  rpc: RpcPool,
  opts: DiscoverPoolsOptions,
  token: Address,
  quotes: Address[] | undefined,
  addPool: (pool: PoolKey) => Promise<void>,
  shouldStop: () => boolean
) {
  const factory = opts.v2FactoryAddress ?? opts.dexDeployment?.v2FactoryAddress ?? BASE_V2_FACTORY;
  const filters = buildFactoryFilters(factory, V2_PAIR_CREATED_TOPIC, token, quotes);

  for (const filter of filters) {
    if (shouldStop()) break;
    await getDiscoveryLogs(
      rpc,
      opts,
      filter,
      async (log: Log) => {
        const pool = parseV2PairCreatedLog(log);
        if (!pool) return;
        if (!isSameAddress(pool.currency0, token) && !isSameAddress(pool.currency1, token)) return;
        if (!poolHasAnyQuote(pool, quotes)) return;
        await addPool(pool);
      },
      shouldStop
    );
  }
}

export async function discoverPoolById(rpc: RpcPool, opts: DiscoverPoolByIdOptions): Promise<PoolKey | undefined> {
  let found: PoolKey | undefined;
  await getDiscoveryLogs(
    rpc,
    opts,
    { address: opts.poolManagerAddress, topics: [INITIALIZE_TOPIC, opts.poolId.toLowerCase()] },
    async (log: Log) => {
      const pool = parseInitializeLog(log);
      if (pool && pool.id.toLowerCase() === opts.poolId.toLowerCase()) found = { ...pool, chain: opts.chain ?? "base" };
    },
    () => Boolean(found)
  );
  return found;
}

export async function discoverPoolByAddress(rpc: RpcPool, opts: DiscoverPoolByAddressOptions): Promise<PoolKey | undefined> {
  const poolAddress = normalizeAddress(opts.poolAddress);
  const deployment = opts.dexDeployment;
  const currency0 = normalizeAddress(await rpc.callContract<string>(poolAddress, V3_POOL_ABI, "token0"));
  const currency1 = normalizeAddress(await rpc.callContract<string>(poolAddress, V3_POOL_ABI, "token1"));

  try {
    const factory = normalizeAddress(await rpc.callContract<string>(poolAddress, V3_POOL_ABI, "factory"));
    if (!isSameAddress(factory, deployment?.v3FactoryAddress ?? BASE_V3_FACTORY)) return undefined;
    const fee = Number(await rpc.callContract<bigint>(poolAddress, V3_POOL_ABI, "fee"));
    const tickSpacing = Number(await rpc.callContract<bigint>(poolAddress, V3_POOL_ABI, "tickSpacing"));
    return {
      id: poolAddress,
      chain: opts.chain ?? "base",
      dex: "uniswap",
      protocol: "v3",
      currency0,
      currency1,
      fee,
      tickSpacing,
      source: "manual"
    };
  } catch {
    try {
      const factory = normalizeAddress(await rpc.callContract<string>(poolAddress, V2_PAIR_ABI, "factory"));
      if (!isSameAddress(factory, deployment?.v2FactoryAddress ?? BASE_V2_FACTORY)) return undefined;
    } catch {
      return undefined;
    }
    return {
      id: poolAddress,
      chain: opts.chain ?? "base",
      dex: "uniswap",
      protocol: "v2",
      currency0,
      currency1,
      fee: 3000,
      source: "manual"
    };
  }
}

function parseBlockscoutTransferPoolLog(
  log: Log,
  opts: DiscoverPoolsOptions,
  protocols: PoolProtocol[]
): PoolKey | undefined {
  const address = log.address.toLowerCase();
  const manager = opts.poolManagerAddress ?? (opts.dexDeployment?.poolManagerAddress as Address | undefined) ?? BASE_POOL_MANAGER;
  if (protocols.includes("v4") && isSameAddress(address, manager)) return parseInitializeLog(log);

  const v3Factory = opts.v3FactoryAddress ?? opts.dexDeployment?.v3FactoryAddress ?? BASE_V3_FACTORY;
  if (protocols.includes("v3") && isSameAddress(address, v3Factory)) return parseV3PoolCreatedLog(log);

  const v2Factory = opts.v2FactoryAddress ?? opts.dexDeployment?.v2FactoryAddress ?? BASE_V2_FACTORY;
  if (protocols.includes("v2") && isSameAddress(address, v2Factory)) return parseV2PairCreatedLog(log);

  return undefined;
}

async function addBlockscoutTransferPool(
  pool: PoolKey,
  token: Address,
  quotes: Address[] | undefined,
  opts: DiscoverPoolsOptions,
  addPool: (pool: PoolKey) => Promise<void>
): Promise<void> {
  if (!isSameAddress(pool.currency0, token) && !isSameAddress(pool.currency1, token)) return;
  if (!poolHasAnyQuote(pool, quotes)) return;
  const hookFilter = opts.hookFilter ?? (opts.onlyClankerHooks ? "clanker" : undefined);
  if (pool.protocol === "v4" && hookFilter && !poolHookMatchesFilter(pool.hooks, hookFilter)) return;
  await addPool(pool);
}

function blockscoutCandidateTxHashes(
  transfers: BlockscoutTokenTransferRecord[],
  opts: DiscoverPoolsOptions,
  protocols: PoolProtocol[]
): string[] {
  const token = normalizeAddress(opts.token);
  const manager = opts.poolManagerAddress ?? (opts.dexDeployment?.poolManagerAddress as Address | undefined) ?? BASE_POOL_MANAGER;
  const candidates = new Map<string, { txHash: string; rank: number; blockNumber: number; logIndex: number }>();

  for (const transfer of transfers) {
    if (!transfer.txHash) continue;
    const touchesManager = protocols.includes("v4") && transferTouchesAddress(transfer, manager);
    const hasPoolLikeCounterparty = (protocols.includes("v2") || protocols.includes("v3")) && transferCounterparties(transfer, token, manager).length > 0;
    if (!touchesManager && !hasPoolLikeCounterparty) continue;
    const rank = touchesManager ? 0 : 1;
    const current = candidates.get(transfer.txHash);
    const next = {
      txHash: transfer.txHash,
      rank,
      blockNumber: transfer.blockNumber ?? Number.MAX_SAFE_INTEGER,
      logIndex: transfer.logIndex ?? Number.MAX_SAFE_INTEGER
    };
    if (!current || compareBlockscoutCandidate(next, current) < 0) candidates.set(transfer.txHash, next);
  }

  return [...candidates.values()]
    .sort(compareBlockscoutCandidate)
    .slice(0, BLOCKSCOUT_POOL_DISCOVERY_TX_LOG_LIMIT)
    .map((candidate) => candidate.txHash);
}

function blockscoutCandidatePoolAddresses(
  transfers: BlockscoutTokenTransferRecord[],
  token: Address,
  opts: DiscoverPoolsOptions,
  protocols: PoolProtocol[]
): Address[] {
  if (!protocols.includes("v2") && !protocols.includes("v3")) return [];
  const manager = opts.poolManagerAddress ?? (opts.dexDeployment?.poolManagerAddress as Address | undefined) ?? BASE_POOL_MANAGER;
  const candidates = new Map<string, { address: Address; blockNumber: number; logIndex: number }>();
  for (const transfer of transfers) {
    for (const address of transferCounterparties(transfer, token, manager)) {
      const current = candidates.get(address.toLowerCase());
      const next = {
        address,
        blockNumber: transfer.blockNumber ?? Number.MAX_SAFE_INTEGER,
        logIndex: transfer.logIndex ?? Number.MAX_SAFE_INTEGER
      };
      if (!current || next.blockNumber < current.blockNumber || (next.blockNumber === current.blockNumber && next.logIndex < current.logIndex)) {
        candidates.set(address.toLowerCase(), next);
      }
    }
  }
  return [...candidates.values()]
    .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
    .slice(0, BLOCKSCOUT_POOL_DISCOVERY_ADDRESS_LIMIT)
    .map((candidate) => candidate.address);
}

function transferCounterparties(transfer: BlockscoutTokenTransferRecord, token: Address, poolManagerAddress: Address): Address[] {
  const out: Address[] = [];
  const add = (address: string | undefined, isContract: boolean | undefined) => {
    if (!address || isContract === false) return;
    if (isSameAddress(address, token) || isSameAddress(address, ZERO_ADDRESS) || isSameAddress(address, poolManagerAddress)) return;
    if (!out.some((existing) => isSameAddress(existing, address))) out.push(normalizeAddress(address));
  };
  add(transfer.from, transfer.fromIsContract);
  add(transfer.to, transfer.toIsContract);
  return out;
}

function transferTouchesAddress(transfer: BlockscoutTokenTransferRecord, address: Address): boolean {
  return Boolean((transfer.from && isSameAddress(transfer.from, address)) || (transfer.to && isSameAddress(transfer.to, address)));
}

function compareBlockscoutCandidate(
  a: { rank: number; blockNumber: number; logIndex: number },
  b: { rank: number; blockNumber: number; logIndex: number }
): number {
  return a.rank - b.rank || a.blockNumber - b.blockNumber || a.logIndex - b.logIndex;
}

function buildInitializeFilters(poolManagerAddress: Address, token: Address, quotes?: Address[]) {
  if (quotes?.length) {
    const currencyTopics = uniqueTopics([addressToTopic(token), ...quotes.map((quote) => addressToTopic(quote))]);
    return [
      {
        address: poolManagerAddress,
        topics: [INITIALIZE_TOPIC, null, currencyTopics, currencyTopics]
      }
    ];
  }

  return [
    {
      address: poolManagerAddress,
      topics: [INITIALIZE_TOPIC, null, addressToTopic(token)]
    },
    {
      address: poolManagerAddress,
      topics: [INITIALIZE_TOPIC, null, null, addressToTopic(token)]
    }
  ];
}

function buildFactoryFilters(factoryAddress: Address, eventTopic: string, token: Address, quotes?: Address[]) {
  if (quotes?.length) {
    const currencyTopics = uniqueTopics([addressToTopic(token), ...quotes.map((quote) => addressToTopic(quote))]);
    return [
      {
        address: factoryAddress,
        topics: [eventTopic, currencyTopics, currencyTopics]
      }
    ];
  }

  return [
    {
      address: factoryAddress,
      topics: [eventTopic, addressToTopic(token)]
    },
    {
      address: factoryAddress,
      topics: [eventTopic, null, addressToTopic(token)]
    }
  ];
}

function quoteCandidates(chainSlug: ChainSlug, quote: Address | undefined): Address[] | undefined {
  if (!quote) return undefined;
  const normalized = normalizeAddress(quote);
  const nativeLikeQuotes = getChain(chainSlug).nativeLikeQuotes
    .filter((value) => value.startsWith("0x"))
    .map((value) => normalizeAddress(value));
  if (!nativeLikeQuotes.some((candidate) => isSameAddress(candidate, normalized))) return [normalized];
  return uniqueAddresses([normalized, ...nativeLikeQuotes]);
}

function poolHasAnyQuote(pool: PoolKey, quotes: Address[] | undefined): boolean {
  if (!quotes?.length) return true;
  return quotes.some((quote) => isSameAddress(pool.currency0, quote) || isSameAddress(pool.currency1, quote));
}

function poolHookMatchesFilter(hooks: Address | undefined, filter: HookDiscoveryFilter): boolean {
  const key = hooks?.toLowerCase();
  if (!key) return false;
  if (filter === "clanker") return BASE_CLANKER_HOOKS.has(key);
  if (filter === "flaunch") return BASE_FLAUNCH_HOOKS.has(key);
  return BASE_LAUNCHPAD_HOOKS.has(key);
}

function uniqueAddresses(addresses: Address[]): Address[] {
  const out: Address[] = [];
  const seen = new Set<string>();
  for (const address of addresses) {
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(address);
  }
  return out;
}

function uniqueTopics(topics: string[]): string[] {
  return [...new Set(topics.map((topic) => topic.toLowerCase()))];
}

export interface GetLogsProgress {
  scanned: number;
  total: number;
  matches: number;
  currentChunk: number;
}

export interface DiscoveryLogFilter {
  address: string | string[];
  topics: Array<string | string[] | null>;
}

interface DiscoveryLogOptions {
  chain?: ChainSlug;
  fromBlock: number;
  toBlock: number;
  chunkSize: number;
  blockscoutClient?: BlockscoutClient;
  blockscoutLogScanFallback?: boolean;
  logger?: Logger;
  onProgress?: (progress: GetLogsProgress) => void;
}

export async function getDiscoveryLogs(
  rpc: RpcPool,
  opts: DiscoveryLogOptions,
  baseFilter: DiscoveryLogFilter,
  onLog?: (log: Log) => void | Promise<void>,
  shouldStop?: () => boolean
): Promise<Log[]> {
  const blockscoutLogs = opts.blockscoutLogScanFallback ? await fetchBlockscoutDiscoveryLogs(opts, baseFilter) : undefined;
  if (blockscoutLogs && blockscoutLogs.length > 0) {
    const consumed = await consumeDiscoveryLogs(blockscoutLogs, onLog, shouldStop);
    opts.onProgress?.(completedDiscoveryProgress(opts, blockscoutLogs.length));
    return consumed;
  }

  return getLogsInChunks(
    rpc,
    baseFilter,
    opts.fromBlock,
    opts.toBlock,
    opts.chunkSize,
    opts.onProgress,
    onLog,
    shouldStop
  );
}

export async function getLogsInChunks(
  rpc: RpcPool,
  baseFilter: DiscoveryLogFilter,
  fromBlock: number,
  toBlock: number,
  chunkSize: number,
  onProgress?: (progress: GetLogsProgress) => void,
  onLog?: (log: Log) => void | Promise<void>,
  shouldStop?: () => boolean
): Promise<Log[]> {
  const logs: Log[] = [];
  let start = Math.max(0, fromBlock);
  const end = Math.max(start, toBlock);
  const total = Math.max(1, end - start + 1);
  let currentChunk = Math.max(1, chunkSize);

  while (start <= end) {
    if (shouldStop?.()) break;
    const chunkEnd = Math.min(end, start + currentChunk - 1);
    try {
      const chunkLogs = await rpc.getLogs({ ...baseFilter, fromBlock: start, toBlock: chunkEnd });
      logs.push(...chunkLogs);
      if (onLog) {
        for (const l of chunkLogs) {
          await onLog(l);
          if (shouldStop?.()) break;
        }
      }
      start = chunkEnd + 1;
      onProgress?.({
        scanned: Math.min(total, start - Math.max(0, fromBlock)),
        total,
        matches: logs.length,
        currentChunk
      });
    } catch (error) {
      const detected = detectBlockRangeLimit(error);
      if (detected && detected < currentChunk) {
        currentChunk = detected;
        continue;
      }
      if (currentChunk > 1) {
        currentChunk = Math.max(1, Math.floor(currentChunk / 2));
        continue;
      }
      throw error;
    }
  }
  return logs;
}

async function fetchBlockscoutDiscoveryLogs(opts: DiscoveryLogOptions, baseFilter: DiscoveryLogFilter): Promise<Log[] | undefined> {
  if (!opts.blockscoutClient) return undefined;
  const filters = blockscoutFiltersFromRpcFilter(baseFilter);
  if (filters.length === 0) return undefined;
  try {
    return await opts.blockscoutClient.fetchLogs(opts.chain ?? "base", filters, opts.fromBlock, opts.toBlock, opts.chunkSize);
  } catch (error) {
    opts.logger?.warn(
      {
        chain: opts.chain ?? "base",
        address: baseFilter.address,
        topic0: filterTopicLabel(baseFilter.topics[0]),
        error: (error as Error).message
      },
      "Blockscout pool discovery failed; falling back to RPC logs"
    );
    return undefined;
  }
}

async function consumeDiscoveryLogs(
  logs: Log[],
  onLog?: (log: Log) => void | Promise<void>,
  shouldStop?: () => boolean
): Promise<Log[]> {
  const consumed: Log[] = [];
  for (const log of logs) {
    if (shouldStop?.()) break;
    consumed.push(log);
    if (onLog) await onLog(log);
    if (shouldStop?.()) break;
  }
  return consumed;
}

function completedDiscoveryProgress(opts: DiscoveryLogOptions, matches: number): GetLogsProgress {
  const start = Math.max(0, opts.fromBlock);
  const end = Math.max(start, opts.toBlock);
  const total = Math.max(1, end - start + 1);
  return {
    scanned: total,
    total,
    matches,
    currentChunk: Math.max(1, opts.chunkSize)
  };
}

function blockscoutFiltersFromRpcFilter(baseFilter: DiscoveryLogFilter): BlockscoutLogFilter[] {
  const addresses = Array.isArray(baseFilter.address)
    ? uniqueTopics(baseFilter.address)
    : [baseFilter.address.toLowerCase()];
  const topic0Choices = blockscoutTopicChoices(baseFilter.topics[0], true);
  const topic1Choices = blockscoutTopicChoices(baseFilter.topics[1], false);
  const topic2Choices = blockscoutTopicChoices(baseFilter.topics[2], false);
  const topic3Choices = blockscoutTopicChoices(baseFilter.topics[3], false);
  const out: BlockscoutLogFilter[] = [];
  const seen = new Set<string>();

  for (const address of addresses) {
    for (const topic0 of topic0Choices) {
      if (!topic0) continue;
      for (const topic1 of topic1Choices) {
        for (const topic2 of topic2Choices) {
          for (const topic3 of topic3Choices) {
            const filter: BlockscoutLogFilter = { address, topic0 };
            if (topic1) filter.topic1 = topic1;
            if (topic2) filter.topic2 = topic2;
            if (topic3) filter.topic3 = topic3;
            const key = [filter.address, filter.topic0, filter.topic1 ?? "", filter.topic2 ?? "", filter.topic3 ?? ""].join(":");
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(filter);
          }
        }
      }
    }
  }

  return out;
}

function blockscoutTopicChoices(topic: string | string[] | null | undefined, required: boolean): Array<string | undefined> {
  if (typeof topic === "string") return [topic.toLowerCase()];
  if (Array.isArray(topic)) return uniqueTopics(topic);
  return required ? [] : [undefined];
}

function filterTopicLabel(topic: string | string[] | null | undefined): string | string[] | undefined {
  if (typeof topic === "string") return topic;
  if (Array.isArray(topic)) return topic;
  return undefined;
}

function detectBlockRangeLimit(error: unknown): number | undefined {
  const message = errorMessages(error).join(" ").toLowerCase();
  if (!message) return undefined;
  // Common patterns:
  //   "please limit the query to at most 1000 blocks"
  //   "block range is too wide ... limit is 10000"
  //   "exceeds the maximum block range of 5000"
  const isRangeError =
    /limit.*\d+.*blocks?/.test(message) ||
    /block range/.test(message) ||
    /maximum.*range/.test(message) ||
    /range.*too\s*(wide|large|big)/.test(message);
  if (!isRangeError) return undefined;
  const match = message.match(/(\d{2,7})\s*blocks?/);
  if (match && match[1]) {
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 500;
}

function errorMessages(error: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    if (typeof value === "string") {
      out.push(value);
      return;
    }
    if (typeof value !== "object") return;
    const v = value as Record<string, unknown>;
    if (typeof v.message === "string") out.push(v.message);
    if (typeof v.shortMessage === "string") out.push(v.shortMessage);
    if (typeof v.reason === "string") out.push(v.reason);
    if (typeof v.body === "string") out.push(v.body);
    visit(v.error);
    visit(v.info);
    visit(v.cause);
    if (Array.isArray(v.errors)) for (const e of v.errors) visit(e);
  };
  visit(error);
  return out;
}

export function parseInitializeLog(log: Log): PoolKey | undefined {
  try {
    const parsed = POOL_MANAGER_IFACE.parseLog(log);
    if (!parsed || parsed.name !== "Initialize") return undefined;
    const args = parsed.args;
    return {
      id: args.id as Hex32,
      chain: undefined,
      dex: "uniswap",
      protocol: "v4",
      currency0: normalizeAddress(args.currency0 as string),
      currency1: normalizeAddress(args.currency1 as string),
      fee: Number(args.fee),
      tickSpacing: Number(args.tickSpacing),
      hooks: normalizeAddress((args.hooks as string) || ZERO_ADDRESS),
      source: "discovered",
      createdBlock: log.blockNumber,
      sqrtPriceX96: args.sqrtPriceX96?.toString(),
      initialTick: Number(args.tick)
    };
  } catch {
    return undefined;
  }
}

export function parseV3PoolCreatedLog(log: Log): PoolKey | undefined {
  try {
    const parsed = V3_FACTORY_IFACE.parseLog(log);
    if (!parsed || parsed.name !== "PoolCreated") return undefined;
    const args = parsed.args;
    return {
      id: normalizeAddress(args.pool as string),
      chain: undefined,
      dex: "uniswap",
      protocol: "v3",
      currency0: normalizeAddress(args.token0 as string),
      currency1: normalizeAddress(args.token1 as string),
      fee: Number(args.fee),
      tickSpacing: Number(args.tickSpacing),
      source: "discovered",
      createdBlock: log.blockNumber
    };
  } catch {
    return undefined;
  }
}

export function parseV2PairCreatedLog(log: Log): PoolKey | undefined {
  try {
    const parsed = V2_FACTORY_IFACE.parseLog(log);
    if (!parsed || parsed.name !== "PairCreated") return undefined;
    const args = parsed.args;
    return {
      id: normalizeAddress(args.pair as string),
      chain: undefined,
      dex: "uniswap",
      protocol: "v2",
      currency0: normalizeAddress(args.token0 as string),
      currency1: normalizeAddress(args.token1 as string),
      fee: 3000,
      source: "discovered",
      createdBlock: log.blockNumber
    };
  } catch {
    return undefined;
  }
}

export function getOtherCurrency(pool: PoolKey, token: TokenId): TokenId {
  const currencies = poolCurrencies(pool);
  if (!currencies.some((currency) => isSameAddress(currency, token))) {
    throw new Error(`Token ${token} is not part of pool ${pool.id}`);
  }
  const other = currencies.find((currency) => !isSameAddress(currency, token));
  if (other) return other;
  throw new Error(`Token ${token} is not part of pool ${pool.id}`);
}

export function poolCurrencies(pool: PoolKey): TokenId[] {
  const out: TokenId[] = [];
  for (const currency of [pool.currency0, pool.currency1, ...(pool.poolTokens ?? [])]) {
    if (out.some((existing) => existing.toLowerCase() === currency.toLowerCase())) continue;
    out.push(currency);
  }
  return out;
}
