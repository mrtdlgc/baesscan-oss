import { Interface, Log } from "ethers";
import type { RpcPool } from "../services/rpcPool";
import type { Address, ChainSlug, PoolKey } from "../types";
import type { DexDeployment } from "../chains/registry";
import { addressToTopic, isSameAddress, normalizeAddress } from "../utils/address";
import { getLogsInChunks, type DiscoverPoolsOptions } from "./uniswap";
import { poolContainsSelection } from "./common";

export const LB_FACTORY_ABI = [
  "event LBPairCreated(address indexed tokenX, address indexed tokenY, uint256 indexed binStep, address LBPair, uint256 pid)"
] as const;

export const LB_PAIR_ABI = [
  "event Swap(address indexed sender, address indexed to, uint24 id, bytes32 amountsIn, bytes32 amountsOut, uint24 volatilityAccumulator, bytes32 totalFees, bytes32 protocolFees)",
  "function getFactory() view returns (address)",
  "function getTokenX() view returns (address)",
  "function getTokenY() view returns (address)",
  "function getBinStep() view returns (uint16)"
] as const;

export const LB_FACTORY_IFACE = new Interface(LB_FACTORY_ABI);
export const LB_PAIR_IFACE = new Interface(LB_PAIR_ABI);
export const LB_PAIR_CREATED_TOPIC = LB_FACTORY_IFACE.getEvent("LBPairCreated")!.topicHash;
export const LB_SWAP_TOPIC = LB_PAIR_IFACE.getEvent("Swap")!.topicHash;

export async function discoverLiquidityBookPools(rpc: RpcPool, opts: DiscoverPoolsOptions): Promise<PoolKey[]> {
  if (opts.protocols?.length && !opts.protocols.includes("lb")) return [];
  const factory = opts.dexDeployment?.lbFactoryAddress;
  if (!factory) return [];

  const token = normalizeAddress(opts.token);
  const quote = opts.quote ? normalizeAddress(opts.quote) : undefined;
  const byId = new Map<string, PoolKey>();
  const excludedPoolIds = new Set(Array.from(opts.excludePoolIds ?? [], (id) => id.toLowerCase()));
  const shouldStop = () => Boolean(opts.stopOnFirst) && byId.size > 0;

  const addPool = async (pool: PoolKey) => {
    pool.chain = opts.chain ?? "base";
    pool.dex = opts.dexDeployment?.dex ?? "traderjoe";
    if (!poolContainsSelection(pool, token, quote)) return;
    const key = pool.id.toLowerCase();
    if (excludedPoolIds.has(key) || byId.has(key)) return;
    byId.set(key, pool);
    if (opts.onPoolFound) await opts.onPoolFound(pool);
  };

  for (const filter of buildLbPairFilters(factory, token, quote)) {
    if (shouldStop()) break;
    await getLogsInChunks(
      rpc,
      filter,
      opts.fromBlock,
      opts.toBlock,
      opts.chunkSize,
      opts.onProgress,
      async (log: Log) => {
        const pool = parseLbPairCreatedLog(log, opts.dexDeployment?.dex ?? "traderjoe");
        if (pool) await addPool(pool);
      },
      shouldStop
    );
  }

  return [...byId.values()].sort((a, b) => (a.createdBlock ?? 0) - (b.createdBlock ?? 0));
}

export async function discoverLiquidityBookPoolByAddress(
  rpc: RpcPool,
  poolAddress: Address,
  deployment?: DexDeployment,
  chain: ChainSlug = "base"
): Promise<PoolKey | undefined> {
  const address = normalizeAddress(poolAddress);
  try {
    const factory = normalizeAddress(await rpc.callContract<string>(address, LB_PAIR_ABI, "getFactory"));
    if (deployment?.lbFactoryAddress && !isSameAddress(factory, deployment.lbFactoryAddress)) return undefined;
    const currency0 = normalizeAddress(await rpc.callContract<string>(address, LB_PAIR_ABI, "getTokenX"));
    const currency1 = normalizeAddress(await rpc.callContract<string>(address, LB_PAIR_ABI, "getTokenY"));
    const binStep = Number(await rpc.callContract<bigint>(address, LB_PAIR_ABI, "getBinStep"));
    return {
      id: address,
      chain,
      dex: deployment?.dex ?? "traderjoe",
      protocol: "lb",
      currency0,
      currency1,
      fee: binStep,
      binStep,
      poolAddress: address,
      source: "manual"
    };
  } catch {
    return undefined;
  }
}

export interface ParsedLiquidityBookSwap {
  tokenAmountRaw: bigint;
  quoteAmountRaw: bigint;
  quoteAddress?: Address;
  sender?: Address;
}

export function parseLiquidityBookBuySwap(pool: PoolKey, log: Log, tokenAddress: Address): ParsedLiquidityBookSwap | undefined {
  const parsed = LB_PAIR_IFACE.parseLog(log);
  if (!parsed || parsed.name !== "Swap") return undefined;
  const tokenIsX = isSameAddress(pool.currency0, tokenAddress);
  const tokenIsY = isSameAddress(pool.currency1, tokenAddress);
  if (!tokenIsX && !tokenIsY) return undefined;

  const amountsIn = decodeLbAmounts(parsed.args.amountsIn as string);
  const amountsOut = decodeLbAmounts(parsed.args.amountsOut as string);
  if (tokenIsX && amountsOut.x > 0n && amountsIn.y > 0n) {
    return {
      tokenAmountRaw: amountsOut.x,
      quoteAmountRaw: amountsIn.y,
      quoteAddress: normalizeAddress(pool.currency1 as string),
      sender: parsed.args.sender ? normalizeAddress(parsed.args.sender as string) : undefined
    };
  }
  if (tokenIsY && amountsOut.y > 0n && amountsIn.x > 0n) {
    return {
      tokenAmountRaw: amountsOut.y,
      quoteAmountRaw: amountsIn.x,
      quoteAddress: normalizeAddress(pool.currency0 as string),
      sender: parsed.args.sender ? normalizeAddress(parsed.args.sender as string) : undefined
    };
  }
  return undefined;
}

export function decodeLbAmounts(packed: string): { x: bigint; y: bigint } {
  const value = BigInt(packed);
  const mask = (1n << 128n) - 1n;
  return {
    x: value & mask,
    y: value >> 128n
  };
}

function buildLbPairFilters(factoryAddress: Address, token: Address, quote?: Address) {
  if (quote) {
    const tokenTopic = addressToTopic(token);
    const quoteTopic = addressToTopic(quote);
    return [
      {
        address: factoryAddress,
        topics: [LB_PAIR_CREATED_TOPIC, [tokenTopic, quoteTopic], [tokenTopic, quoteTopic]]
      }
    ];
  }

  return [
    {
      address: factoryAddress,
      topics: [LB_PAIR_CREATED_TOPIC, addressToTopic(token)]
    },
    {
      address: factoryAddress,
      topics: [LB_PAIR_CREATED_TOPIC, null, addressToTopic(token)]
    }
  ];
}

function parseLbPairCreatedLog(log: Log, dex: PoolKey["dex"]): PoolKey | undefined {
  try {
    const parsed = LB_FACTORY_IFACE.parseLog(log);
    if (!parsed || parsed.name !== "LBPairCreated") return undefined;
    const tokenX = parsed.args.tokenX ?? parsed.args[0];
    const tokenY = parsed.args.tokenY ?? parsed.args[1];
    const binStep = Number(parsed.args.binStep ?? parsed.args[2]);
    const pair = parsed.args.LBPair ?? parsed.args.lbPair ?? parsed.args[3];
    const poolAddress = normalizeAddress(pair as string);
    return {
      id: poolAddress,
      dex,
      protocol: "lb",
      currency0: normalizeAddress(tokenX as string),
      currency1: normalizeAddress(tokenY as string),
      fee: binStep,
      binStep,
      poolAddress,
      source: "discovered",
      createdBlock: log.blockNumber
    };
  } catch {
    return undefined;
  }
}
