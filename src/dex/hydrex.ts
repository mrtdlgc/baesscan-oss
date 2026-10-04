import { Interface, Log } from "ethers";
import type { RpcPool } from "../services/rpcPool";
import type { Address, ChainSlug, PoolKey } from "../types";
import type { DexDeployment } from "../chains/registry";
import { isSameAddress, normalizeAddress } from "../utils/address";
import { BASE_HYDREX_FACTORY } from "../uniswap/constants";
import { getDiscoveryLogs, type DiscoverPoolsOptions } from "./uniswap";
import { buildTokenPairFilters, poolContainsSelection } from "./common";

export const HYDREX_FACTORY_ABI = [
  "event Pool(address indexed token0, address indexed token1, address pool)",
  "function poolByPair(address,address) view returns (address)",
  "function defaultConfigurationForPool() view returns (uint16 communityFee, int24 tickSpacing, uint16 fee)"
] as const;

export const HYDREX_POOL_ABI = [
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 price, uint128 liquidity, int24 tick, uint24 overrideFee, uint24 pluginFee)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function factory() view returns (address)",
  "function fee() view returns (uint16)",
  "function tickSpacing() view returns (int24)"
] as const;

export const HYDREX_FACTORY_IFACE = new Interface(HYDREX_FACTORY_ABI);
export const HYDREX_POOL_IFACE = new Interface(HYDREX_POOL_ABI);
export const HYDREX_POOL_CREATED_TOPIC = HYDREX_FACTORY_IFACE.getEvent("Pool")!.topicHash;
export const HYDREX_SWAP_TOPIC = HYDREX_POOL_IFACE.getEvent("Swap")!.topicHash;

export async function discoverHydrexPools(rpc: RpcPool, opts: DiscoverPoolsOptions): Promise<PoolKey[]> {
  if (opts.protocols?.length && !opts.protocols.includes("algebra")) return [];

  const token = normalizeAddress(opts.token);
  const quote = opts.quote ? normalizeAddress(opts.quote) : undefined;
  const deployment = opts.dexDeployment;
  const byId = new Map<string, PoolKey>();
  const excludedPoolIds = new Set(Array.from(opts.excludePoolIds ?? [], (id) => id.toLowerCase()));
  const shouldStop = () => Boolean(opts.stopOnFirst) && byId.size > 0;
  const factory = deployment?.algebraFactoryAddress ?? BASE_HYDREX_FACTORY;
  const filters = buildTokenPairFilters(factory, HYDREX_POOL_CREATED_TOPIC, token, quote);

  const addPool = async (pool: PoolKey) => {
    pool.chain = opts.chain ?? "base";
    pool.dex = deployment?.dex ?? "hydrex";
    if (!poolContainsSelection(pool, token, quote)) return;
    const key = pool.id.toLowerCase();
    if (excludedPoolIds.has(key) || byId.has(key)) return;
    byId.set(key, pool);
    if (opts.onPoolFound) await opts.onPoolFound(pool);
  };

  for (const filter of filters) {
    if (shouldStop()) break;
    await getDiscoveryLogs(
      rpc,
      opts,
      filter,
      async (log: Log) => {
        const pool = parseHydrexPoolLog(log, deployment?.dex ?? "hydrex");
        if (pool) await addPool(await enrichHydrexPool(rpc, pool));
      },
      shouldStop
    );
  }

  return [...byId.values()].sort((a, b) => (a.createdBlock ?? 0) - (b.createdBlock ?? 0));
}

export async function discoverHydrexPoolByAddress(
  rpc: RpcPool,
  poolAddress: Address,
  deployment?: DexDeployment,
  chain: ChainSlug = "base"
): Promise<PoolKey | undefined> {
  const address = normalizeAddress(poolAddress);
  try {
    const factory = normalizeAddress(await rpc.callContract<string>(address, HYDREX_POOL_ABI, "factory"));
    if (!isSameAddress(factory, deployment?.algebraFactoryAddress ?? BASE_HYDREX_FACTORY)) return undefined;
    const currency0 = normalizeAddress(await rpc.callContract<string>(address, HYDREX_POOL_ABI, "token0"));
    const currency1 = normalizeAddress(await rpc.callContract<string>(address, HYDREX_POOL_ABI, "token1"));
    const fee = (await readOptionalNumber(rpc, address, "fee", 0)) ?? 0;
    const tickSpacing = await readOptionalNumber(rpc, address, "tickSpacing", undefined);
    return {
      ...(await enrichHydrexPool(rpc, {
        id: address,
        chain,
        dex: deployment?.dex ?? "hydrex",
        protocol: "algebra",
        currency0,
        currency1,
        fee,
        tickSpacing,
        source: "manual"
      })),
      source: "manual"
    };
  } catch {
    return undefined;
  }
}

async function enrichHydrexPool(rpc: RpcPool, pool: PoolKey): Promise<PoolKey> {
  const fee = (await readOptionalNumber(rpc, pool.id as Address, "fee", pool.fee)) ?? pool.fee;
  const tickSpacing = await readOptionalNumber(rpc, pool.id as Address, "tickSpacing", pool.tickSpacing);
  return { ...pool, fee, tickSpacing };
}

async function readOptionalNumber(
  rpc: RpcPool,
  address: Address,
  fn: "fee" | "tickSpacing",
  fallback: number | undefined
): Promise<number | undefined> {
  try {
    return Number(await rpc.callContract<bigint>(address, HYDREX_POOL_ABI, fn));
  } catch {
    return fallback;
  }
}

function parseHydrexPoolLog(log: Log, dex: PoolKey["dex"]): PoolKey | undefined {
  try {
    const parsed = HYDREX_FACTORY_IFACE.parseLog(log);
    if (!parsed || parsed.name !== "Pool") return undefined;
    const args = parsed.args;
    return {
      id: normalizeAddress(args.pool as string),
      dex,
      protocol: "algebra",
      currency0: normalizeAddress(args.token0 as string),
      currency1: normalizeAddress(args.token1 as string),
      fee: 0,
      source: "discovered",
      createdBlock: log.blockNumber
    };
  } catch {
    return undefined;
  }
}
