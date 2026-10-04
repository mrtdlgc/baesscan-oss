import { Log } from "ethers";
import type { RpcPool } from "../services/rpcPool";
import type { Address, ChainSlug, PoolDex, PoolKey, PoolProtocol } from "../types";
import type { DexDeployment } from "../chains/registry";
import { isSameAddress, normalizeAddress } from "../utils/address";
import {
  BASE_PANCAKESWAP_V2_FACTORY,
  BASE_PANCAKESWAP_V3_FACTORY
} from "../uniswap/constants";
import {
  V2_FACTORY_IFACE,
  V2_PAIR_ABI,
  V2_PAIR_CREATED_TOPIC,
  V3_FACTORY_IFACE,
  V3_POOL_ABI,
  V3_POOL_CREATED_TOPIC
} from "../uniswap/abis";
import { getDiscoveryLogs, type DiscoverPoolsOptions } from "./uniswap";
import { buildTokenPairFilters, poolContainsSelection } from "./common";

export async function discoverPancakePools(rpc: RpcPool, opts: DiscoverPoolsOptions): Promise<PoolKey[]> {
  const token = normalizeAddress(opts.token);
  const quote = opts.quote ? normalizeAddress(opts.quote) : undefined;
  const protocols = opts.protocols?.length ? opts.protocols : (["v3", "v2"] as PoolProtocol[]);
  const dex = opts.dexDeployment?.dex ?? "pancakeswap";
  const byId = new Map<string, PoolKey>();
  const excludedPoolIds = new Set(Array.from(opts.excludePoolIds ?? [], (id) => id.toLowerCase()));
  const shouldStop = () => Boolean(opts.stopOnFirst) && byId.size > 0;

  const addPool = async (pool: PoolKey) => {
    pool.chain = opts.chain ?? "base";
    pool.dex = dex;
    if (!poolContainsSelection(pool, token, quote)) return;
    const key = pool.id.toLowerCase();
    if (excludedPoolIds.has(key) || byId.has(key)) return;
    byId.set(key, pool);
    if (opts.onPoolFound) await opts.onPoolFound(pool);
  };

  if (protocols.includes("v3")) {
    await discoverPancakeV3Pools(rpc, opts, token, quote, addPool, shouldStop, dex);
  }
  if (!shouldStop() && protocols.includes("v2")) {
    await discoverPancakeV2Pools(rpc, opts, token, quote, addPool, shouldStop, dex);
  }

  return [...byId.values()].sort((a, b) => (a.createdBlock ?? 0) - (b.createdBlock ?? 0));
}

export async function discoverPancakePoolByAddress(
  rpc: RpcPool,
  poolAddress: Address,
  deployment?: DexDeployment,
  chain: ChainSlug = "base"
): Promise<PoolKey | undefined> {
  const address = normalizeAddress(poolAddress);
  const v3 = await maybePancakeV3Pool(rpc, address, deployment, chain);
  if (v3) return v3;
  return maybePancakeV2Pool(rpc, address, deployment, chain);
}

async function discoverPancakeV3Pools(
  rpc: RpcPool,
  opts: DiscoverPoolsOptions,
  token: Address,
  quote: Address | undefined,
  addPool: (pool: PoolKey) => Promise<void>,
  shouldStop: () => boolean,
  dex: PoolDex
) {
  const factory = opts.dexDeployment?.v3FactoryAddress ?? (opts.dexDeployment ? undefined : BASE_PANCAKESWAP_V3_FACTORY);
  if (!factory) return;
  const filters = buildTokenPairFilters(factory, V3_POOL_CREATED_TOPIC, token, quote);
  for (const filter of filters) {
    if (shouldStop()) break;
    await getDiscoveryLogs(
      rpc,
      opts,
      filter,
      async (log: Log) => {
        const pool = parsePancakeV3PoolCreatedLog(log, dex);
        if (pool) await addPool(pool);
      },
      shouldStop
    );
  }
}

async function discoverPancakeV2Pools(
  rpc: RpcPool,
  opts: DiscoverPoolsOptions,
  token: Address,
  quote: Address | undefined,
  addPool: (pool: PoolKey) => Promise<void>,
  shouldStop: () => boolean,
  dex: PoolDex
) {
  const factory = opts.dexDeployment?.v2FactoryAddress ?? (opts.dexDeployment ? undefined : BASE_PANCAKESWAP_V2_FACTORY);
  if (!factory) return;
  const filters = buildTokenPairFilters(factory, V2_PAIR_CREATED_TOPIC, token, quote);
  for (const filter of filters) {
    if (shouldStop()) break;
    await getDiscoveryLogs(
      rpc,
      opts,
      filter,
      async (log: Log) => {
        const pool = parsePancakeV2PairCreatedLog(log, dex);
        if (pool) await addPool(pool);
      },
      shouldStop
    );
  }
}

function parsePancakeV3PoolCreatedLog(log: Log, dex: PoolDex): PoolKey | undefined {
  try {
    const parsed = V3_FACTORY_IFACE.parseLog(log);
    if (!parsed || parsed.name !== "PoolCreated") return undefined;
    const args = parsed.args;
    return {
      id: normalizeAddress(args.pool as string),
      dex,
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

function parsePancakeV2PairCreatedLog(log: Log, dex: PoolDex): PoolKey | undefined {
  try {
    const parsed = V2_FACTORY_IFACE.parseLog(log);
    if (!parsed || parsed.name !== "PairCreated") return undefined;
    const args = parsed.args;
    return {
      id: normalizeAddress(args.pair as string),
      dex,
      protocol: "v2",
      currency0: normalizeAddress(args.token0 as string),
      currency1: normalizeAddress(args.token1 as string),
      fee: 2500,
      source: "discovered",
      createdBlock: log.blockNumber
    };
  } catch {
    return undefined;
  }
}

async function maybePancakeV3Pool(
  rpc: RpcPool,
  poolAddress: Address,
  deployment?: DexDeployment,
  chain: ChainSlug = "base"
): Promise<PoolKey | undefined> {
  try {
    const factory = normalizeAddress(await rpc.callContract<string>(poolAddress, V3_POOL_ABI, "factory"));
    if (!isSameAddress(factory, deployment?.v3FactoryAddress ?? BASE_PANCAKESWAP_V3_FACTORY)) return undefined;
    const currency0 = normalizeAddress(await rpc.callContract<string>(poolAddress, V3_POOL_ABI, "token0"));
    const currency1 = normalizeAddress(await rpc.callContract<string>(poolAddress, V3_POOL_ABI, "token1"));
    const fee = Number(await rpc.callContract<bigint>(poolAddress, V3_POOL_ABI, "fee"));
    const tickSpacing = Number(await rpc.callContract<bigint>(poolAddress, V3_POOL_ABI, "tickSpacing"));
    return {
      id: poolAddress,
      chain,
      dex: deployment?.dex ?? "pancakeswap",
      protocol: "v3",
      currency0,
      currency1,
      fee,
      tickSpacing,
      source: "manual"
    };
  } catch {
    return undefined;
  }
}

async function maybePancakeV2Pool(
  rpc: RpcPool,
  poolAddress: Address,
  deployment?: DexDeployment,
  chain: ChainSlug = "base"
): Promise<PoolKey | undefined> {
  try {
    const expectedFactory = deployment?.v2FactoryAddress ?? (deployment ? undefined : BASE_PANCAKESWAP_V2_FACTORY);
    if (expectedFactory) {
      const factory = normalizeAddress(await rpc.callContract<string>(poolAddress, V2_PAIR_ABI, "factory"));
      if (!isSameAddress(factory, expectedFactory)) return undefined;
    } else if (deployment && !deployment.v2PoolAllowlist?.some((allowed) => isSameAddress(allowed, poolAddress))) {
      return undefined;
    }
    const currency0 = normalizeAddress(await rpc.callContract<string>(poolAddress, V2_PAIR_ABI, "token0"));
    const currency1 = normalizeAddress(await rpc.callContract<string>(poolAddress, V2_PAIR_ABI, "token1"));
    return {
      id: poolAddress,
      chain,
      dex: deployment?.dex ?? "pancakeswap",
      protocol: "v2",
      currency0,
      currency1,
      fee: 2500,
      source: "manual"
    };
  } catch {
    return undefined;
  }
}
