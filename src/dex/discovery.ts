import type { RpcPool } from "../services/rpcPool";
import type { ChainSlug, PoolDex, PoolKey, PoolProtocol } from "../types";
import { allDexLabels, getChain } from "../chains/registry";
import type { DexDeployment } from "../chains/registry";
import {
  discoverPoolByAddress as discoverUniswapPoolByAddress,
  discoverPools as discoverUniswapPools,
  type DiscoverPoolByAddressOptions,
  type DiscoverPoolsOptions
} from "./uniswap";
import { discoverAerodromePoolByAddress, discoverAerodromePools } from "./aerodrome";
import { discoverBalancerPoolByAddress } from "./balancer";
import { discoverCurvePoolByAddress } from "./curve";
import { discoverHydrexPoolByAddress, discoverHydrexPools } from "./hydrex";
import { discoverLiquidityBookPoolByAddress, discoverLiquidityBookPools } from "./liquidityBook";
import { discoverPancakePoolByAddress, discoverPancakePools } from "./pancakeswap";

export interface DexDiscoverPoolsOptions extends DiscoverPoolsOptions {
  dexes?: PoolDex[];
  chain?: ChainSlug;
}

const UNISWAP_PROTOCOLS = new Set<PoolProtocol>(["v4", "v3", "v2"]);
const PANCAKE_PROTOCOLS = new Set<PoolProtocol>(["v3", "v2"]);
const SOLIDLY_PROTOCOLS = new Set<PoolProtocol>(["solidly"]);
const ALGEBRA_PROTOCOLS = new Set<PoolProtocol>(["algebra"]);
const LB_PROTOCOLS = new Set<PoolProtocol>(["lb"]);

export async function discoverPools(rpc: RpcPool, opts: DexDiscoverPoolsOptions): Promise<PoolKey[]> {
  const chain = getChain(opts.chain ?? "base");
  if (chain.kind !== "evm") return [];
  const deployments = selectedDeployments(chain.dexes, opts.dexes);
  const byId = new Map<string, PoolKey>();
  const excludedPoolIds = new Set(Array.from(opts.excludePoolIds ?? [], (id) => id.toLowerCase()));

  const shouldStop = () => Boolean(opts.stopOnFirst) && byId.size > 0;
  const addPool = async (pool: PoolKey) => {
    const key = pool.id.toLowerCase();
    if (excludedPoolIds.has(key) || byId.has(key)) return;
    byId.set(key, pool);
    if (opts.onPoolFound) await opts.onPoolFound(pool);
  };

  for (const deployment of deployments) {
    if (shouldStop()) break;
    if (deployment.dex === "curve" || deployment.dex === "balancer") {
      continue;
    }
    if (deployment.dex === "uniswap") {
      await runAdapter(rpc, opts, deployment, selectProtocols(opts.protocols, deployment, UNISWAP_PROTOCOLS), discoverUniswapPools, addPool);
      continue;
    }
    if (deployment.protocols.includes("solidly")) {
      await runAdapter(rpc, opts, deployment, selectProtocols(opts.protocols, deployment, SOLIDLY_PROTOCOLS), discoverAerodromePools, addPool);
    }
    if (!shouldStop() && deployment.protocols.includes("algebra")) {
      await runAdapter(rpc, opts, deployment, selectProtocols(opts.protocols, deployment, ALGEBRA_PROTOCOLS), discoverHydrexPools, addPool);
    }
    if (!shouldStop() && deployment.protocols.includes("lb")) {
      await runAdapter(rpc, opts, deployment, selectProtocols(opts.protocols, deployment, LB_PROTOCOLS), discoverLiquidityBookPools, addPool);
    }
    if (!shouldStop() && (deployment.protocols.includes("v2") || deployment.protocols.includes("v3"))) {
      await runAdapter(rpc, opts, deployment, selectProtocols(opts.protocols, deployment, PANCAKE_PROTOCOLS), discoverPancakePools, addPool);
    }
  }

  return [...byId.values()].sort((a, b) => (a.createdBlock ?? 0) - (b.createdBlock ?? 0));
}

export async function discoverPoolByAddress(rpc: RpcPool, opts: DiscoverPoolByAddressOptions): Promise<PoolKey | undefined> {
  const chainSlug = opts.chain ?? "base";
  const chain = getChain(chainSlug);
  if (chain.kind !== "evm") return undefined;
  for (const deployment of chain.dexes) {
    const found =
      (deployment.protocols.includes("curve")
        ? await discoverCurvePoolByAddress(rpc, opts.poolAddress, deployment, chainSlug)
        : undefined) ??
      (deployment.protocols.includes("balancer")
        ? await discoverBalancerPoolByAddress(rpc, opts.poolAddress, deployment, chainSlug)
        : undefined) ??
      (deployment.protocols.includes("solidly")
        ? await discoverAerodromePoolByAddress(rpc, opts.poolAddress, deployment, chainSlug)
        : undefined) ??
      (deployment.protocols.includes("algebra")
        ? await discoverHydrexPoolByAddress(rpc, opts.poolAddress, deployment, chainSlug)
        : undefined) ??
      (deployment.protocols.includes("lb")
        ? await discoverLiquidityBookPoolByAddress(rpc, opts.poolAddress, deployment, chainSlug)
        : undefined) ??
      (deployment.dex !== "uniswap" && (deployment.protocols.includes("v2") || deployment.protocols.includes("v3"))
        ? await discoverPancakePoolByAddress(rpc, opts.poolAddress, deployment, chainSlug)
        : undefined) ??
      (deployment.dex === "uniswap"
        ? await discoverUniswapPoolByAddress(rpc, { ...opts, chain: chainSlug, dexDeployment: deployment })
        : undefined);
    if (found) return found;
  }
  return undefined;
}

async function runAdapter(
  rpc: RpcPool,
  opts: DexDiscoverPoolsOptions,
  deployment: DexDeployment,
  protocols: PoolProtocol[] | undefined,
  adapter: (rpc: RpcPool, opts: DiscoverPoolsOptions) => Promise<PoolKey[]>,
  addPool: (pool: PoolKey) => Promise<void>
): Promise<void> {
  if (protocols?.length === 0) return;
  const pools = await adapter(rpc, {
    ...opts,
    dexDeployment: deployment,
    protocols,
    onPoolFound: addPool
  });
  for (const pool of pools) await addPool(pool);
}

function selectedDeployments(deployments: DexDeployment[], dexes: PoolDex[] | undefined): DexDeployment[] {
  if (!dexes?.length) return deployments;
  return deployments.filter((deployment) => dexes.includes(deployment.dex));
}

function selectProtocols(
  requested: PoolProtocol[] | undefined,
  deployment: DexDeployment,
  allowed: Set<PoolProtocol>
): PoolProtocol[] {
  const deployable = deployment.protocols.filter((protocol) => allowed.has(protocol));
  if (!requested?.length) return deployable;
  return requested.filter((protocol) => deployable.includes(protocol));
}

export function selectedDexesLabel(dexes: PoolDex[] | undefined, chain: ChainSlug = "base"): string {
  return dexes?.length ? dexes.map(dexLabel).join("/") : allDexLabels(getChain(chain));
}

export function dexLabel(dex: PoolDex): string {
  switch (dex) {
    case "pancakeswap":
      return "PancakeSwap";
    case "aerodrome":
      return "Aerodrome";
    case "velodrome":
      return "Velodrome";
    case "sushiswap":
      return "SushiSwap";
    case "curve":
      return "Curve";
    case "balancer":
      return "Balancer";
    case "camelot":
      return "Camelot";
    case "hydrex":
      return "Hydrex";
    case "thena":
      return "THENA";
    case "biswap":
      return "Biswap";
    case "apeswap":
      return "ApeSwap";
    case "quickswap":
      return "QuickSwap";
    case "pharaoh":
      return "Pharaoh";
    case "blackhole":
      return "Blackhole";
    case "traderjoe":
      return "Trader Joe";
    case "pangolin":
      return "Pangolin";
    case "noxa":
      return "Noxa";
    case "kumbaya":
      return "Kumbaya";
    case "prism":
      return "Prism";
    case "solana":
      return "Solana";
    case "pumpfun":
      return "Pump.fun";
    case "raydium":
      return "Raydium";
    case "orca":
      return "Orca";
    case "meteora":
      return "Meteora";
    default:
      return "Uniswap";
  }
}

export function poolDex(pool: PoolKey): PoolDex {
  return pool.dex ?? "uniswap";
}

export function poolVersionLabel(pool: PoolKey): string {
  const protocol = pool.protocol ?? "v4";
  if (pool.dex === "camelot" && protocol === "algebra") return "V3";
  if (protocol === "algebra") return "Integral";
  if (protocol === "lb") return pool.binStep ? `LB ${pool.binStep}bps` : "LB";
  if (protocol === "curve") return "Curve";
  if (protocol === "balancer") return "Vault";
  if (protocol === "solidly") return pool.stable ? "stable" : "volatile";
  if (protocol === "solana") return "program";
  return protocol.toUpperCase();
}
