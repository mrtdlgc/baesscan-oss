import type { Logger } from "pino";
import { getChain } from "../chains/registry";
import type { BackfillRpcProviderConfig, Env } from "../config/env";
import type { ChainSlug } from "../types";
import { createAbortableJsonRpcProvider } from "./abortableRpcProvider";
import { RpcPool } from "./rpcPool";

export function createBackfillRpcPool(env: Env, chain: ChainSlug, logger: Logger): RpcPool | undefined {
  const chainConfig = getChain(chain);
  if (chainConfig.kind !== "evm" || !chainConfig.chainId) return undefined;
  const configs = env.backfillRpcProvidersByChain[chain] ?? [];
  if (configs.length === 0) return undefined;
  return createPoolFromBackfillConfigs(chain, chainConfig.chainId, configs, logger);
}

export function createBackfillRpcPools(env: Env, logger: Logger): Map<ChainSlug, RpcPool> {
  const out = new Map<ChainSlug, RpcPool>();
  for (const chain of env.marketArchiveChains) {
    const pool = createBackfillRpcPool(env, chain, logger);
    if (pool) out.set(chain, pool);
  }
  return out;
}

function createPoolFromBackfillConfigs(
  chain: ChainSlug,
  chainId: number,
  configs: BackfillRpcProviderConfig[],
  logger: Logger
): RpcPool {
  const providers = configs.map((config) =>
    createAbortableJsonRpcProvider(config.url, { name: chain, chainId }, { staticNetwork: true, batchMaxCount: 3 })
  );
  return new RpcPool(providers, logger, {
    strategy: "balanced",
    providers: configs.map((config) => ({
      label: config.label,
      maxRps: config.maxRps,
      logBlockLimit: config.logBlockLimit,
      weight: config.weight
    }))
  });
}
