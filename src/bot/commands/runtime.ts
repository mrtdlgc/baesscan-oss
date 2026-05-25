import type { Context } from "telegraf";
import type { RpcPool, RpcPoolHealth, RpcProviderHealth } from "../../services/rpcPool";
import type { SolanaRpcClient } from "../../solana/activity";
import type { TokenService } from "../../services/token";
import type { ChainSlug } from "../../types";
import { getChain } from "../../chains/registry";
import type { CommandDeps } from "./types";

export function configuredRpcChains(deps: CommandDeps): ChainSlug[] {
  return [...deps.rpcs.keys()].filter((chain) => chain !== "solana");
}

export async function evmRpcScanSection(deps: CommandDeps, chain: ChainSlug, probe: boolean): Promise<string> {
  const rpc = deps.rpcs.get(chain);
  if (!rpc) return `${getChain(chain).name}\nnot configured`;
  let latest = "not probed";
  if (probe) {
    try {
      latest = String(await rpc.getBlockNumber());
    } catch (error) {
      latest = `probe failed: ${(error as Error).message}`;
    }
  }
  return formatRpcPoolHealth(getChain(chain).name, latest, rpc.healthSnapshot());
}

export async function solanaRpcScanSection(deps: CommandDeps, probe: boolean): Promise<string> {
  const client = deps.solanaClient;
  if (!client?.isConfigured()) return "Solana\nnot configured";
  let latest = "not probed";
  if (probe) {
    try {
      latest = String(await client.getSlot());
    } catch (error) {
      latest = `probe failed: ${(error as Error).message}`;
    }
  }
  const health = client.healthSnapshot();
  const lines = [`Solana`, `latest slot: ${latest}`, `providers: ${health.providerCount}`];
  for (const endpoint of health.endpoints) {
    const fail = `${endpoint.failures}/${endpoint.attempts} (${endpoint.failurePct.toFixed(1)}%)`;
    lines.push(
      `#${endpoint.index} ${endpoint.label}\n` +
        `  fail ${fail}; ok ${endpoint.successes}; last ok ${endpoint.lastSuccessSlot ?? "-"} ${relativeTime(endpoint.lastSuccessAt)}; last fail ${endpoint.lastFailureSlot ?? "-"} ${relativeTime(endpoint.lastFailureAt)}${endpoint.lastError ? `; ${endpoint.lastError}` : ""}`
    );
  }
  return lines.join("\n");
}

function formatRpcPoolHealth(chainName: string, latest: string, health: RpcPoolHealth): string {
  const lines = [
    chainName,
    `latest block: ${latest}`,
    `providers: ${health.providerCount}; active: #${health.activeIndex}${health.stickyUntil ? ` until ${health.stickyUntil}` : ""}`
  ];
  if (health.recommendations.length > 0) {
    lines.push("routing:");
    for (const recommendation of health.recommendations) lines.push(`- ${recommendation}`);
  }
  for (const provider of health.providers) lines.push(formatRpcProviderHealth(provider));
  return lines.join("\n");
}

function formatRpcProviderHealth(provider: RpcProviderHealth): string {
  const fail = `${provider.failures}/${provider.attempts} (${provider.failurePct.toFixed(1)}%)`;
  const marker = provider.active ? " active" : "";
  return (
    `#${provider.index}${marker} ${provider.label}\n` +
    `  fail ${fail}; ok ${provider.successes}; last ok ${provider.lastSuccessBlock ?? "-"} ${relativeTime(provider.lastSuccessAt)}; last fail ${provider.lastFailureBlock ?? "-"} ${relativeTime(provider.lastFailureAt)}${provider.lastError ? `; ${provider.lastError}` : ""}` +
    (provider.policyNotes.length > 0 ? `\n  policy ${provider.policyNotes.join("; ")}` : "")
  );
}

function relativeTime(iso?: string): string {
  if (!iso) return "";
  const elapsed = Date.now() - Date.parse(iso);
  if (!Number.isFinite(elapsed) || elapsed < 0) return "";
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function argsOf(ctx: Context): string[] {
  const message = ctx.message;
  if (!message || !("text" in message)) return [];
  return message.text.trim().split(/\s+/).slice(1);
}

export function solanaRuntime(deps: CommandDeps): SolanaRpcClient {
  if (!deps.solanaClient?.isConfigured()) {
    throw new Error("Solana RPC is not configured. Add SOLANA_RPC_URLS and include solana in ENABLED_CHAINS.");
  }
  return deps.solanaClient;
}

export function evmRuntime(deps: CommandDeps, chain: ChainSlug): { rpc: RpcPool; tokenService: TokenService } {
  const chainConfig = getChain(chain);
  if (chainConfig.kind !== "evm") {
    throw new Error(`${chainConfig.name} is not currently supported by the public bot surface.`);
  }
  const rpc = deps.rpcs.get(chain);
  const tokenService = deps.tokenServices.get(chain);
  if (!rpc || !tokenService) {
    throw new Error(`${chainConfig.name} RPC is not configured. Add ${chainConfig.rpcEnv} and include ${chain} in ENABLED_CHAINS.`);
  }
  return { rpc, tokenService };
}
