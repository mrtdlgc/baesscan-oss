import { AbiCoder, keccak256, Log } from "ethers";
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
import type { RpcPool } from "../services/rpcPool";

const ABI_CODER = AbiCoder.defaultAbiCoder();

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
    await getLogsInChunks(
      rpc,
      filter,
      opts.fromBlock,
      opts.toBlock,
      opts.chunkSize,
      opts.onProgress,
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
    await getLogsInChunks(
      rpc,
      filter,
      opts.fromBlock,
      opts.toBlock,
      opts.chunkSize,
      opts.onProgress,
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
    await getLogsInChunks(
      rpc,
      filter,
      opts.fromBlock,
      opts.toBlock,
      opts.chunkSize,
      opts.onProgress,
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
  await getLogsInChunks(
    rpc,
    { address: opts.poolManagerAddress, topics: [INITIALIZE_TOPIC, opts.poolId.toLowerCase()] },
    opts.fromBlock,
    opts.toBlock,
    opts.chunkSize,
    opts.onProgress,
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

export async function getLogsInChunks(
  rpc: RpcPool,
  baseFilter: { address: string | string[]; topics: Array<string | string[] | null> },
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
