import { Log } from "ethers";
import type { Env } from "../config/env";
import type { RpcPool } from "../services/rpcPool";
import type { ChainSlug, PoolKey } from "../types";
import { getChain } from "../chains/registry";
import { isSameAddress, normalizeAddress } from "../utils/address";
import { FLAUNCH_HOOK_SWAP_TOPIC, PANCAKE_V3_SWAP_TOPIC, V2_SWAP_TOPIC, V3_SWAP_TOPIC, SWAP_TOPIC } from "../uniswap/abis";
import { BASE_FLAUNCH_HOOKS } from "../uniswap/constants";
import { getLogsInChunks, poolProtocol } from "./uniswap";
import { AERODROME_SWAP_TOPIC } from "./aerodrome";
import { BALANCER_SWAP_TOPIC } from "./balancer";
import { CURVE_TOKEN_EXCHANGE_TOPICS } from "./curve";
import { HYDREX_SWAP_TOPIC } from "./hydrex";
import { LB_SWAP_TOPIC } from "./liquidityBook";

export async function fetchSwapLogs(
  rpc: RpcPool,
  env: Env,
  chain: ChainSlug,
  pools: PoolKey[],
  fromBlock: number,
  toBlock: number
): Promise<Log[]> {
  const logs: Log[] = [];
  const poolManagerAddress = env.poolManagerAddresses[chain];
  const v4Ids = uniqueIds(
    pools.filter((pool) => (pool.dex ?? "uniswap") === "uniswap" && poolProtocol(pool) === "v4").map((pool) => pool.id.toLowerCase())
  );
  const flaunchHookPoolIds = flaunchHookPoolsByAddress(pools);
  const flaunchPoolIds = new Set([...flaunchHookPoolIds.values()].flat());
  const poolManagerV4Ids = v4Ids.filter((id) => !flaunchPoolIds.has(id));
  const pancakeV3Addresses = uniqueIds(
    pools
      .filter((pool) => poolProtocol(pool) === "v3" && pool.dex === "pancakeswap")
      .map((pool) => pool.id.toLowerCase())
  );
  const v3Addresses = uniqueIds(
    pools
      .filter((pool) => (poolProtocol(pool) === "v3" || (poolProtocol(pool) === "algebra" && pool.dex !== "hydrex")) && pool.dex !== "pancakeswap")
      .map((pool) => pool.id.toLowerCase())
  );
  const v2Addresses = uniqueIds(
    pools
      .filter((pool) => poolProtocol(pool) === "v2" && pool.dex !== "aerodrome")
      .map((pool) => pool.id.toLowerCase())
  );
  const aerodromeAddresses = uniqueIds(
    pools
      .filter((pool) => poolProtocol(pool) === "solidly")
      .map((pool) => pool.id.toLowerCase())
  );
  const hydrexAddresses = uniqueIds(
    pools
      .filter((pool) => pool.dex === "hydrex")
      .map((pool) => pool.id.toLowerCase())
  );
  const lbAddresses = uniqueIds(
    pools
      .filter((pool) => poolProtocol(pool) === "lb")
      .map((pool) => pool.id.toLowerCase())
  );
  const curveAddresses = uniqueIds(
    pools
      .filter((pool) => poolProtocol(pool) === "curve")
      .map((pool) => (pool.poolAddress ?? pool.id).toLowerCase())
  );
  const balancerIds = uniqueIds(
    pools
      .filter((pool) => poolProtocol(pool) === "balancer")
      .map((pool) => pool.id.toLowerCase())
  );
  const balancerVault = getChain(chain).dexes.find((deployment) => deployment.dex === "balancer")?.balancerVaultAddress;

  for (const ids of chunks(poolManagerAddress ? poolManagerV4Ids : [], 100)) {
    const chunkLogs = await getLogsInChunks(
      rpc,
      { address: poolManagerAddress!, topics: [SWAP_TOPIC, ids] },
      fromBlock,
      toBlock,
      env.logChunkSize
    );
    logs.push(...chunkLogs);
  }
  for (const addresses of chunks(v3Addresses, 100)) {
    const chunkLogs = await getLogsInChunks(
      rpc,
      { address: addresses, topics: [V3_SWAP_TOPIC] },
      fromBlock,
      toBlock,
      env.logChunkSize
    );
    logs.push(...chunkLogs);
  }
  for (const addresses of chunks(pancakeV3Addresses, 100)) {
    const chunkLogs = await getLogsInChunks(
      rpc,
      { address: addresses, topics: [PANCAKE_V3_SWAP_TOPIC] },
      fromBlock,
      toBlock,
      env.logChunkSize
    );
    logs.push(...chunkLogs);
  }
  for (const addresses of chunks(v2Addresses, 100)) {
    const chunkLogs = await getLogsInChunks(
      rpc,
      { address: addresses, topics: [V2_SWAP_TOPIC] },
      fromBlock,
      toBlock,
      env.logChunkSize
    );
    logs.push(...chunkLogs);
  }
  for (const addresses of chunks(aerodromeAddresses, 100)) {
    const chunkLogs = await getLogsInChunks(
      rpc,
      { address: addresses, topics: [AERODROME_SWAP_TOPIC] },
      fromBlock,
      toBlock,
      env.logChunkSize
    );
    logs.push(...chunkLogs);
  }
  for (const addresses of chunks(hydrexAddresses, 100)) {
    const chunkLogs = await getLogsInChunks(
      rpc,
      { address: addresses, topics: [HYDREX_SWAP_TOPIC] },
      fromBlock,
      toBlock,
      env.logChunkSize
    );
    logs.push(...chunkLogs);
  }
  for (const [hookAddress, ids] of flaunchHookPoolIds.entries()) {
    for (const idChunk of chunks(ids, 100)) {
      const chunkLogs = await getLogsInChunks(
        rpc,
        { address: hookAddress, topics: [FLAUNCH_HOOK_SWAP_TOPIC, idChunk] },
        fromBlock,
        toBlock,
        env.logChunkSize
      );
      logs.push(...chunkLogs);
    }
  }
  for (const addresses of chunks(lbAddresses, 100)) {
    const chunkLogs = await getLogsInChunks(
      rpc,
      { address: addresses, topics: [LB_SWAP_TOPIC] },
      fromBlock,
      toBlock,
      env.logChunkSize
    );
    logs.push(...chunkLogs);
  }
  for (const addresses of chunks(curveAddresses, 100)) {
    const chunkLogs = await getLogsInChunks(
      rpc,
      { address: addresses, topics: [CURVE_TOKEN_EXCHANGE_TOPICS] },
      fromBlock,
      toBlock,
      env.logChunkSize
    );
    logs.push(...chunkLogs);
  }
  for (const ids of chunks(balancerVault ? balancerIds : [], 100)) {
    const chunkLogs = await getLogsInChunks(
      rpc,
      { address: balancerVault!, topics: [BALANCER_SWAP_TOPIC, ids] },
      fromBlock,
      toBlock,
      env.logChunkSize
    );
    logs.push(...chunkLogs);
  }
  return logs;
}

export function poolIdForSwapLog(log: Log, env: Env, chain: ChainSlug): string | undefined {
  const poolManagerAddress = env.poolManagerAddresses[chain];
  if (poolManagerAddress && isSameAddress(log.address, poolManagerAddress)) return (log.topics[1] ?? "").toLowerCase();
  if (log.topics[0]?.toLowerCase() === FLAUNCH_HOOK_SWAP_TOPIC.toLowerCase() && BASE_FLAUNCH_HOOKS.has(log.address.toLowerCase())) {
    return (log.topics[1] ?? "").toLowerCase();
  }
  const balancerVault = getChain(chain).dexes.find((deployment) => deployment.dex === "balancer")?.balancerVaultAddress;
  if (balancerVault && isSameAddress(log.address, balancerVault) && log.topics[0] === BALANCER_SWAP_TOPIC) {
    return (log.topics[1] ?? "").toLowerCase();
  }
  return normalizeAddress(log.address).toLowerCase();
}

export function uniquePools(chats: Array<{ pools: Record<string, PoolKey> }>): PoolKey[] {
  const byId = new Map<string, PoolKey>();
  for (const chat of chats) {
    for (const pool of Object.values(chat.pools)) {
      const id = pool.id.toLowerCase();
      if (!byId.has(id)) byId.set(id, pool);
    }
  }
  return [...byId.values()];
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.toLowerCase()))];
}

function flaunchHookPoolsByAddress(pools: PoolKey[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const pool of pools) {
    if ((pool.dex ?? "uniswap") !== "uniswap" || poolProtocol(pool) !== "v4") continue;
    const hookAddress = pool.hooks?.toLowerCase();
    if (!hookAddress || !BASE_FLAUNCH_HOOKS.has(hookAddress)) continue;
    const ids = out.get(hookAddress) ?? [];
    ids.push(pool.id.toLowerCase());
    out.set(hookAddress, ids);
  }
  for (const [hookAddress, ids] of out.entries()) out.set(hookAddress, uniqueIds(ids));
  return out;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
