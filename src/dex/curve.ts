import { Contract, Interface, Log } from "ethers";
import type { RpcPool } from "../services/rpcPool";
import type { Address, ChainSlug, PoolKey } from "../types";
import type { DexDeployment } from "../chains/registry";
import { isSameAddress, normalizeAddress } from "../utils/address";

export const CURVE_POOL_ABI = [
  "function coins(uint256) view returns (address)",
  "function coins(int128) view returns (address)",
  "function fee() view returns (uint256)"
] as const;

const CURVE_TOKEN_EXCHANGE_INT_ABI = [
  "event TokenExchange(address indexed buyer, int128 sold_id, uint256 tokens_sold, int128 bought_id, uint256 tokens_bought)"
] as const;

const CURVE_TOKEN_EXCHANGE_UINT_ABI = [
  "event TokenExchange(address indexed buyer, uint256 sold_id, uint256 tokens_sold, uint256 bought_id, uint256 tokens_bought)"
] as const;

export const CURVE_TOKEN_EXCHANGE_INT_IFACE = new Interface(CURVE_TOKEN_EXCHANGE_INT_ABI);
export const CURVE_TOKEN_EXCHANGE_UINT_IFACE = new Interface(CURVE_TOKEN_EXCHANGE_UINT_ABI);
export const CURVE_TOKEN_EXCHANGE_INT_TOPIC = CURVE_TOKEN_EXCHANGE_INT_IFACE.getEvent("TokenExchange")!.topicHash;
export const CURVE_TOKEN_EXCHANGE_UINT_TOPIC = CURVE_TOKEN_EXCHANGE_UINT_IFACE.getEvent("TokenExchange")!.topicHash;
export const CURVE_TOKEN_EXCHANGE_TOPICS = [CURVE_TOKEN_EXCHANGE_INT_TOPIC, CURVE_TOKEN_EXCHANGE_UINT_TOPIC];

export async function discoverCurvePoolByAddress(
  rpc: RpcPool,
  poolAddress: Address,
  deployment?: DexDeployment,
  chain: ChainSlug = "base"
): Promise<PoolKey | undefined> {
  const address = normalizeAddress(poolAddress);
  const coins = await readCurveCoins(rpc, address);
  if (coins.length < 2) return undefined;
  return {
    id: address,
    chain,
    dex: deployment?.dex ?? "curve",
    protocol: "curve",
    currency0: coins[0]!,
    currency1: coins[1]!,
    poolTokens: coins,
    fee: await readCurveFee(rpc, address),
    poolAddress: address,
    source: "manual"
  };
}

export async function readCurveCoins(rpc: RpcPool, poolAddress: Address, maxCoins = 8): Promise<Address[]> {
  const out: Address[] = [];
  for (let i = 0; i < maxCoins; i++) {
    const coin = await readCurveCoin(rpc, poolAddress, i);
    if (!coin) break;
    if (!out.some((existing) => isSameAddress(existing, coin))) out.push(coin);
  }
  return out;
}

async function readCurveCoin(rpc: RpcPool, poolAddress: Address, index: number): Promise<Address | undefined> {
  for (const signature of ["coins(uint256)", "coins(int128)"]) {
    try {
      const value = await rpc.withFallback(`curve:${signature}`, async (provider) => {
        const contract = new Contract(poolAddress, CURVE_POOL_ABI, provider);
        return contract.getFunction(signature)(index) as Promise<string>;
      });
      return normalizeAddress(value);
    } catch {
      // Try the alternate legacy/current Curve coins signature.
    }
  }
  return undefined;
}

async function readCurveFee(rpc: RpcPool, poolAddress: Address): Promise<number> {
  try {
    const fee = await rpc.withFallback("curve:fee", async (provider) => {
      const contract = new Contract(poolAddress, CURVE_POOL_ABI, provider);
      return contract.getFunction("fee")() as Promise<bigint>;
    });
    return Number(fee);
  } catch {
    return 0;
  }
}

export interface ParsedCurveSwap {
  tokenAmountRaw: bigint;
  quoteAmountRaw: bigint;
  quoteAddress?: Address;
  sender?: Address;
}

export function parseCurveBuySwap(pool: PoolKey, log: Log, tokenAddress: Address): ParsedCurveSwap | undefined {
  const parsed = parseCurveTokenExchange(log);
  if (!parsed) return undefined;
  const tokens = poolTokenAddresses(pool);
  const targetIndex = tokens.findIndex((token) => isSameAddress(token, tokenAddress));
  if (targetIndex < 0 || parsed.boughtId !== targetIndex) return undefined;
  const soldToken = tokens[parsed.soldId];
  if (!soldToken) return undefined;
  return {
    tokenAmountRaw: parsed.tokensBought,
    quoteAmountRaw: parsed.tokensSold,
    quoteAddress: soldToken,
    sender: parsed.buyer
  };
}

function poolTokenAddresses(pool: PoolKey): Address[] {
  const out: Address[] = [];
  for (const token of [pool.currency0, pool.currency1, ...(pool.poolTokens ?? [])]) {
    if (typeof token !== "string" || !token.startsWith("0x")) continue;
    const normalized = normalizeAddress(token);
    if (!out.some((existing) => isSameAddress(existing, normalized))) out.push(normalized);
  }
  return out;
}

function parseCurveTokenExchange(log: Log):
  | { buyer: Address; soldId: number; tokensSold: bigint; boughtId: number; tokensBought: bigint }
  | undefined {
  for (const iface of [CURVE_TOKEN_EXCHANGE_INT_IFACE, CURVE_TOKEN_EXCHANGE_UINT_IFACE]) {
    try {
      const parsed = iface.parseLog(log);
      if (!parsed || parsed.name !== "TokenExchange") continue;
      return {
        buyer: normalizeAddress(parsed.args.buyer as string),
        soldId: Number(parsed.args.sold_id),
        tokensSold: BigInt(parsed.args.tokens_sold),
        boughtId: Number(parsed.args.bought_id),
        tokensBought: BigInt(parsed.args.tokens_bought)
      };
    } catch {
      // Try the other Curve TokenExchange variant.
    }
  }
  return undefined;
}
