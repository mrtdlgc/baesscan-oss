import type { Log } from "ethers";
import { getChain } from "../../chains/registry";
import { discoverBalancerPoolByAddress } from "../../dex/balancer";
import { discoverCurvePoolByAddress } from "../../dex/curve";
import { AERODROME_FACTORY_IFACE, AERODROME_POOL_CREATED_TOPIC, discoverAerodromePoolByAddress } from "../../dex/aerodrome";
import { HYDREX_FACTORY_IFACE, HYDREX_POOL_CREATED_TOPIC, discoverHydrexPoolByAddress } from "../../dex/hydrex";
import { LB_FACTORY_IFACE, LB_PAIR_CREATED_TOPIC, discoverLiquidityBookPoolByAddress } from "../../dex/liquidityBook";
import { discoverPancakePoolByAddress } from "../../dex/pancakeswap";
import { discoverPoolByAddress as discoverUniswapPoolByAddress, getLogsInChunks, parseInitializeLog } from "../../dex/uniswap";
import { INITIALIZE_TOPIC, V2_FACTORY_IFACE, V2_PAIR_CREATED_TOPIC, V3_FACTORY_IFACE, V3_POOL_CREATED_TOPIC } from "../../uniswap/abis";
import type { Address, ChainSlug, PoolDex, PoolKey, PoolProtocol } from "../../types";
import { normalizeAddress } from "../../utils/address";
import type { RpcPool } from "../../services/rpcPool";
import { MARKET_SEEDS_BY_CHAIN } from "./config";
import { uniquePools } from "./poolUtils";
import type { ParseableInterface, RecentFactorySource, RecentPoolSource } from "./types";

const seedPoolCache = new Map<ChainSlug, { maxPools: number; payload: Promise<PoolKey[]> }>();

export async function resolveMarketPools(chain: ChainSlug, rpc: RpcPool, maxPools: number): Promise<PoolKey[]> {
  if (maxPools <= 0) return [];
  const cached = seedPoolCache.get(chain);
  if (cached && cached.maxPools >= maxPools) return (await cached.payload).slice(0, maxPools);
  const seeds = MARKET_SEEDS_BY_CHAIN[chain] ?? [];
  const payload = (async () => {
    const found: PoolKey[] = [];
    const seen = new Set<string>();
    for (const seed of seeds.slice(0, maxPools)) {
      try {
        const pool = await resolveSeedPool(rpc, chain, seed);
        if (!pool) continue;
        const key = pool.id.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        found.push(pool);
      } catch {
        // Seed discovery should not block the whole market board.
      }
    }
    return found;
  })();
  seedPoolCache.set(chain, { maxPools, payload });
  return payload;
}

export async function discoverRecentPools(
  chainSlug: ChainSlug,
  rpc: RpcPool,
  fromBlock: number,
  toBlock: number,
  limit: number,
  chunkSize: number
): Promise<PoolKey[]> {
  if (limit <= 0) return [];
  const sources = trackedPoolSources(chainSlug);
  const candidates: PoolKey[] = [];
  const discoveryChunkSize = Math.max(1, Math.max(chunkSize, 5_000));
  for (const source of sources) {
    if (candidates.length >= limit * 3) break;
    try {
      const logs = await getLogsInChunks(
        rpc,
        { address: source.address, topics: [source.topic] },
        fromBlock,
        toBlock,
        discoveryChunkSize
      );
      for (const log of logs.sort((a, b) => b.blockNumber - a.blockNumber || b.index - a.index).slice(0, limit)) {
        const pool = parseRecentPool(source, log, chainSlug);
        if (pool) candidates.push(pool);
      }
    } catch {
      // Recent-pool discovery is opportunistic; seeded active pools still backstop the board.
    }
  }
  candidates.sort((a, b) => (b.createdBlock ?? 0) - (a.createdBlock ?? 0));
  return uniquePools(candidates).slice(0, limit);
}

export async function discoverTrackedPoolsInRange(
  chainSlug: ChainSlug,
  rpc: RpcPool,
  fromBlock: number,
  toBlock: number,
  chunkSize: number,
  limit = 1_000
): Promise<PoolKey[]> {
  const candidates: PoolKey[] = [];
  const discoveryChunkSize = Math.max(1, Math.max(chunkSize, 5_000));
  const sources = trackedPoolSources(chainSlug);
  // Cap each tracked factory independently so one noisy factory cannot permanently starve later factories.
  const perSourceLimit = Math.max(1, limit);
  for (const source of sources) {
    try {
      const logs = await getLogsInChunks(
        rpc,
        { address: source.address, topics: [source.topic] },
        fromBlock,
        toBlock,
        discoveryChunkSize
      );
      let sourceCount = 0;
      for (const log of logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index)) {
        if (sourceCount >= perSourceLimit) break;
        const pool = parseRecentPool(source, log, chainSlug);
        if (pool) {
          candidates.push(pool);
          sourceCount += 1;
        }
      }
    } catch {
      // One factory should not stop the registry from learning pools from the others.
    }
  }
  candidates.sort((a, b) => (a.createdBlock ?? 0) - (b.createdBlock ?? 0));
  return uniquePools(candidates);
}

export function trackedPoolSources(chainSlug: ChainSlug): RecentPoolSource[] {
  const chain = getChain(chainSlug);
  return chain.dexes.flatMap((deployment) => {
    const out: RecentPoolSource[] = [];
    const addFactory = (
      dex: PoolDex,
      protocol: PoolProtocol,
      address: Address | undefined,
      topic: string,
      iface: ParseableInterface
    ) => {
      if (address) out.push({ kind: "factory", dex, protocol, address, topic, iface });
    };
    const dex = deployment.dex;
    if (dex === "uniswap") {
      if (deployment.poolManagerAddress) {
        out.push({ kind: "poolManager", dex: "uniswap", protocol: "v4", address: normalizeAddress(deployment.poolManagerAddress), topic: INITIALIZE_TOPIC });
      }
      addFactory("uniswap", "v3", deployment.v3FactoryAddress, V3_POOL_CREATED_TOPIC, V3_FACTORY_IFACE);
      addFactory("uniswap", "v2", deployment.v2FactoryAddress, V2_PAIR_CREATED_TOPIC, V2_FACTORY_IFACE);
      return out;
    }
    if (deployment.protocols.includes("v3")) addFactory(dex, "v3", deployment.v3FactoryAddress, V3_POOL_CREATED_TOPIC, V3_FACTORY_IFACE);
    if (deployment.protocols.includes("v2")) addFactory(dex, "v2", deployment.v2FactoryAddress, V2_PAIR_CREATED_TOPIC, V2_FACTORY_IFACE);
    if (deployment.protocols.includes("solidly")) {
      addFactory(dex, "solidly", deployment.solidlyFactoryAddress, AERODROME_POOL_CREATED_TOPIC, AERODROME_FACTORY_IFACE);
    }
    if (deployment.protocols.includes("algebra")) {
      addFactory(dex, "algebra", deployment.algebraFactoryAddress, HYDREX_POOL_CREATED_TOPIC, HYDREX_FACTORY_IFACE);
    }
    if (deployment.protocols.includes("lb")) {
      addFactory(dex, "lb", deployment.lbFactoryAddress, LB_PAIR_CREATED_TOPIC, LB_FACTORY_IFACE);
    }
    return out;
  });
}

export function parseTrackedPoolDiscoveryLog(source: RecentPoolSource, log: Log, chain: ChainSlug): PoolKey | undefined {
  return parseRecentPool(source, log, chain);
}

function parseRecentPool(source: RecentPoolSource, log: Log, chain: ChainSlug): PoolKey | undefined {
  if (source.kind === "poolManager") {
    const pool = parseInitializeLog(log);
    if (!pool) return undefined;
    return {
      ...pool,
      chain,
      dex: source.dex,
      protocol: source.protocol,
      source: "discovered",
      createdBlock: log.blockNumber
    };
  }
  return parseFactoryPool(source, log, chain);
}

function parseFactoryPool(source: RecentFactorySource, log: Log, chain: ChainSlug): PoolKey | undefined {
  try {
    const parsed = source.iface.parseLog(log);
    if (!parsed) return undefined;
    if (source.protocol === "v3") {
      const poolAddress = normalizeAddress(parsed.args.pool as string);
      return {
        id: poolAddress,
        chain,
        dex: source.dex,
        protocol: "v3",
        currency0: normalizeAddress(parsed.args.token0 as string),
        currency1: normalizeAddress(parsed.args.token1 as string),
        fee: Number(parsed.args.fee),
        tickSpacing: Number(parsed.args.tickSpacing),
        poolAddress,
        source: "discovered",
        createdBlock: log.blockNumber
      };
    }
    if (source.protocol === "v2") {
      const poolAddress = normalizeAddress(parsed.args.pair as string);
      return {
        id: poolAddress,
        chain,
        dex: source.dex,
        protocol: "v2",
        currency0: normalizeAddress(parsed.args.token0 as string),
        currency1: normalizeAddress(parsed.args.token1 as string),
        fee: source.dex === "pancakeswap" ? 2500 : 3000,
        poolAddress,
        source: "discovered",
        createdBlock: log.blockNumber
      };
    }
    if (source.protocol === "solidly") {
      const poolAddress = normalizeAddress(parsed.args.pool as string);
      return {
        id: poolAddress,
        chain,
        dex: source.dex,
        protocol: "solidly",
        currency0: normalizeAddress(parsed.args.token0 as string),
        currency1: normalizeAddress(parsed.args.token1 as string),
        fee: 0,
        stable: Boolean(parsed.args.stable),
        poolAddress,
        source: "discovered",
        createdBlock: log.blockNumber
      };
    }
    if (source.protocol === "algebra") {
      const poolAddress = normalizeAddress(parsed.args.pool as string);
      return {
        id: poolAddress,
        chain,
        dex: source.dex,
        protocol: "algebra",
        currency0: normalizeAddress(parsed.args.token0 as string),
        currency1: normalizeAddress(parsed.args.token1 as string),
        fee: 0,
        poolAddress,
        source: "discovered",
        createdBlock: log.blockNumber
      };
    }
    if (source.protocol === "lb") {
      const tokenX = parsed.args.tokenX ?? parsed.args[0];
      const tokenY = parsed.args.tokenY ?? parsed.args[1];
      const binStep = Number(parsed.args.binStep ?? parsed.args[2]);
      const pair = parsed.args.LBPair ?? parsed.args.lbPair ?? parsed.args[3];
      const poolAddress = normalizeAddress(pair as string);
      return {
        id: poolAddress,
        chain,
        dex: source.dex,
        protocol: "lb",
        currency0: normalizeAddress(tokenX as string),
        currency1: normalizeAddress(tokenY as string),
        fee: binStep,
        binStep,
        poolAddress,
        source: "discovered",
        createdBlock: log.blockNumber
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function resolveSeedPool(rpc: RpcPool, chainSlug: ChainSlug, seed: { address: Address; dex: PoolDex }): Promise<PoolKey | undefined> {
  const chain = getChain(chainSlug);
  const deployment = chain.dexes.find((candidate) => candidate.dex === seed.dex);
  const address = normalizeAddress(seed.address);
  if (seed.dex === "uniswap") return discoverUniswapPoolByAddress(rpc, { chain: chainSlug, poolAddress: address, dexDeployment: deployment });
  if (deployment?.protocols.includes("curve")) return discoverCurvePoolByAddress(rpc, address, deployment, chainSlug);
  if (deployment?.protocols.includes("balancer")) return discoverBalancerPoolByAddress(rpc, address, deployment, chainSlug);
  if (deployment?.protocols.includes("solidly")) return discoverAerodromePoolByAddress(rpc, address, deployment, chainSlug);
  if (deployment?.protocols.includes("lb")) {
    const lb = await discoverLiquidityBookPoolByAddress(rpc, address, deployment, chainSlug);
    if (lb) return lb;
  }
  if (deployment?.protocols.includes("algebra")) {
    const algebra = await discoverHydrexPoolByAddress(rpc, address, deployment, chainSlug);
    if (algebra) return algebra;
  }
  if (deployment?.protocols.includes("v2") || deployment?.protocols.includes("v3")) {
    return discoverPancakePoolByAddress(rpc, address, deployment, chainSlug);
  }
  return undefined;
}
