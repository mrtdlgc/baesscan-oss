import { Interface, Log } from "ethers";
import type { RpcPool } from "../services/rpcPool";
import type { Address, ChainSlug, PoolKey } from "../types";
import type { DexDeployment } from "../chains/registry";
import { isSameAddress, normalizeAddress } from "../utils/address";
import { BASE_AERODROME_POOL_FACTORY } from "../uniswap/constants";
import { getLogsInChunks, type DiscoverPoolsOptions } from "./uniswap";
import { buildTokenPairFilters, poolContainsSelection } from "./common";

export const AERODROME_FACTORY_ABI = [
  "event PoolCreated(address indexed token0, address indexed token1, bool indexed stable, address pool, uint256)",
  "function getFee(address pool, bool stable) view returns (uint256)"
] as const;

export const AERODROME_POOL_ABI = [
  "event Swap(address indexed sender, address indexed to, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function stable() view returns (bool)",
  "function factory() view returns (address)"
] as const;

export const AERODROME_FACTORY_IFACE = new Interface(AERODROME_FACTORY_ABI);
export const AERODROME_POOL_IFACE = new Interface(AERODROME_POOL_ABI);
export const AERODROME_POOL_CREATED_TOPIC = AERODROME_FACTORY_IFACE.getEvent("PoolCreated")!.topicHash;
export const AERODROME_SWAP_TOPIC = AERODROME_POOL_IFACE.getEvent("Swap")!.topicHash;

export async function discoverAerodromePools(rpc: RpcPool, opts: DiscoverPoolsOptions): Promise<PoolKey[]> {
  if (opts.protocols?.length && !opts.protocols.includes("solidly")) return [];

  const token = normalizeAddress(opts.token);
  const quote = opts.quote ? normalizeAddress(opts.quote) : undefined;
  const deployment = opts.dexDeployment;
  const byId = new Map<string, PoolKey>();
  const excludedPoolIds = new Set(Array.from(opts.excludePoolIds ?? [], (id) => id.toLowerCase()));
  const shouldStop = () => Boolean(opts.stopOnFirst) && byId.size > 0;
  const factory = deployment?.solidlyFactoryAddress ?? (opts.chain === "base" || !deployment ? BASE_AERODROME_POOL_FACTORY : undefined);
  if (!factory) return [];
  const filters = buildTokenPairFilters(factory, AERODROME_POOL_CREATED_TOPIC, token, quote);

  const addPool = async (pool: PoolKey) => {
    pool.chain = opts.chain ?? "base";
    pool.dex = deployment?.dex ?? "aerodrome";
    if (!poolContainsSelection(pool, token, quote)) return;
    const key = pool.id.toLowerCase();
    if (excludedPoolIds.has(key) || byId.has(key)) return;
    byId.set(key, pool);
    if (opts.onPoolFound) await opts.onPoolFound(pool);
  };

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
        const pool = parseAerodromePoolCreatedLog(log, deployment?.dex ?? "aerodrome");
        if (pool) await addPool(pool);
      },
      shouldStop
    );
  }

  return [...byId.values()].sort((a, b) => (a.createdBlock ?? 0) - (b.createdBlock ?? 0));
}

export async function discoverAerodromePoolByAddress(
  rpc: RpcPool,
  poolAddress: Address,
  deployment?: DexDeployment,
  chain: ChainSlug = "base"
): Promise<PoolKey | undefined> {
  const address = normalizeAddress(poolAddress);
  try {
    const expectedFactory = deployment?.solidlyFactoryAddress ?? (!deployment || chain === "base" ? BASE_AERODROME_POOL_FACTORY : undefined);
    let factory: Address | undefined;
    try {
      factory = normalizeAddress(await rpc.callContract<string>(address, AERODROME_POOL_ABI, "factory"));
      if (expectedFactory && !isSameAddress(factory, expectedFactory)) return undefined;
    } catch {
      if (!deployment) return undefined;
    }
    const currency0 = normalizeAddress(await rpc.callContract<string>(address, AERODROME_POOL_ABI, "token0"));
    const currency1 = normalizeAddress(await rpc.callContract<string>(address, AERODROME_POOL_ABI, "token1"));
    const stable = Boolean(await rpc.callContract<boolean>(address, AERODROME_POOL_ABI, "stable"));
    const fee = await aerodromeFee(rpc, address, stable, deployment?.solidlyFactoryAddress);
    return {
      id: address,
      chain,
      dex: deployment?.dex ?? "aerodrome",
      protocol: "solidly",
      currency0,
      currency1,
      fee,
      stable,
      source: "manual"
    };
  } catch {
    return undefined;
  }
}

function parseAerodromePoolCreatedLog(log: Log, dex: PoolKey["dex"]): PoolKey | undefined {
  try {
    const parsed = AERODROME_FACTORY_IFACE.parseLog(log);
    if (!parsed || parsed.name !== "PoolCreated") return undefined;
    const args = parsed.args;
    const stable = Boolean(args.stable);
    return {
      id: normalizeAddress(args.pool as string),
      dex,
      protocol: "solidly",
      currency0: normalizeAddress(args.token0 as string),
      currency1: normalizeAddress(args.token1 as string),
      fee: defaultAerodromeFee(stable),
      stable,
      source: "discovered",
      createdBlock: log.blockNumber
    };
  } catch {
    return undefined;
  }
}

async function aerodromeFee(rpc: RpcPool, pool: Address, stable: boolean, factory = BASE_AERODROME_POOL_FACTORY): Promise<number> {
  try {
    const raw = Number(await rpc.callContract<bigint>(factory, AERODROME_FACTORY_ABI, "getFee", [pool, stable]));
    return raw * 100;
  } catch {
    return defaultAerodromeFee(stable);
  }
}

function defaultAerodromeFee(stable: boolean): number {
  // Aerodrome stores fees as basis points / 10000. PoolKey.fee uses
  // hundredths of a bip so it formats consistently with Uniswap/Pancake fees.
  return stable ? 500 : 3000;
}
