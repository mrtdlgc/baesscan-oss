import { Interface, Log } from "ethers";
import type { RpcPool } from "../services/rpcPool";
import type { Address, ChainSlug, PoolKey } from "../types";
import type { DexDeployment } from "../chains/registry";
import { isSameAddress, normalizeAddress } from "../utils/address";

export const BALANCER_V2_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8" as Address;

export const BALANCER_POOL_ABI = [
  "function getPoolId() view returns (bytes32)",
  "function getVault() view returns (address)"
] as const;

export const BALANCER_VAULT_ABI = [
  "event Swap(bytes32 indexed poolId, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut)",
  "function getPoolTokens(bytes32 poolId) view returns (address[] tokens, uint256[] balances, uint256 lastChangeBlock)"
] as const;

export const BALANCER_VAULT_IFACE = new Interface(BALANCER_VAULT_ABI);
export const BALANCER_SWAP_TOPIC = BALANCER_VAULT_IFACE.getEvent("Swap")!.topicHash;

export async function discoverBalancerPoolByAddress(
  rpc: RpcPool,
  poolAddress: Address,
  deployment?: DexDeployment,
  chain: ChainSlug = "base"
): Promise<PoolKey | undefined> {
  const address = normalizeAddress(poolAddress);
  try {
    const poolId = (await rpc.callContract<string>(address, BALANCER_POOL_ABI, "getPoolId")).toLowerCase();
    const poolVault = normalizeAddress(await rpc.callContract<string>(address, BALANCER_POOL_ABI, "getVault"));
    const expectedVault = normalizeAddress(deployment?.balancerVaultAddress ?? BALANCER_V2_VAULT);
    if (!isSameAddress(poolVault, expectedVault)) return undefined;

    const result = await rpc.callContract<readonly [string[], bigint[], bigint]>(poolVault, BALANCER_VAULT_ABI, "getPoolTokens", [poolId]);
    const tokens = result[0]
      .map((token) => normalizeAddress(token))
      .filter((token) => !isSameAddress(token, address));
    if (tokens.length < 2) return undefined;

    return {
      id: poolId,
      chain,
      dex: deployment?.dex ?? "balancer",
      protocol: "balancer",
      currency0: tokens[0]!,
      currency1: tokens[1]!,
      poolTokens: tokens,
      fee: 0,
      poolAddress: address,
      vaultAddress: poolVault,
      source: "manual"
    };
  } catch {
    return undefined;
  }
}

export interface ParsedBalancerSwap {
  tokenAmountRaw: bigint;
  quoteAmountRaw: bigint;
  quoteAddress?: Address;
  sender?: Address;
}

export function parseBalancerBuySwap(pool: PoolKey, log: Log, tokenAddress: Address): ParsedBalancerSwap | undefined {
  const parsed = BALANCER_VAULT_IFACE.parseLog(log);
  if (!parsed || parsed.name !== "Swap") return undefined;
  if (String(parsed.args.poolId).toLowerCase() !== pool.id.toLowerCase()) return undefined;

  const tokenIn = normalizeAddress(parsed.args.tokenIn as string);
  const tokenOut = normalizeAddress(parsed.args.tokenOut as string);
  if (!isSameAddress(tokenOut, tokenAddress)) return undefined;
  const tokens = [pool.currency0, pool.currency1, ...(pool.poolTokens ?? [])];
  if (!tokens.some((token) => isSameAddress(token, tokenIn))) return undefined;

  return {
    tokenAmountRaw: BigInt(parsed.args.amountOut),
    quoteAmountRaw: BigInt(parsed.args.amountIn),
    quoteAddress: tokenIn
  };
}
