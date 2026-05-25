import type { Log } from "ethers";
import type { Logger } from "pino";
import { getChain } from "../chains/registry";
import { AERODROME_SWAP_TOPIC } from "../dex/aerodrome";
import { BALANCER_SWAP_TOPIC } from "../dex/balancer";
import { CURVE_TOKEN_EXCHANGE_TOPICS } from "../dex/curve";
import { HYDREX_SWAP_TOPIC } from "../dex/hydrex";
import { LB_SWAP_TOPIC } from "../dex/liquidityBook";
import { poolProtocol } from "../dex/uniswap";
import type { Env } from "../config/env";
import type { ChainSlug, PoolKey } from "../types";
import { FLAUNCH_HOOK_SWAP_TOPIC, PANCAKE_V3_SWAP_TOPIC, V2_SWAP_TOPIC, V3_SWAP_TOPIC, SWAP_TOPIC } from "../uniswap/abis";
import { BASE_FLAUNCH_HOOKS } from "../uniswap/constants";

interface BlockscoutClientOptions {
  apiKey: string;
  apiBaseUrl: string;
  maxLogsPerRequest: number;
  maxRequestsPerTick: number;
  requestDelayMs: number;
  logger?: Logger;
}

export interface BlockscoutLogFilter {
  address: string;
  topic0: string;
  topic1?: string;
  topic2?: string;
  topic3?: string;
}

interface EtherscanLogResult {
  address?: string;
  topics?: string[];
  data?: string;
  blockNumber?: string | number;
  transactionHash?: string;
  transactionIndex?: string | number;
  logIndex?: string | number;
  blockHash?: string;
  removed?: boolean;
}

interface V2LogResult {
  address_hash?: { hash?: string } | string;
  smart_contract?: { hash?: string };
  topics?: string[];
  data?: string;
  block_number?: string | number;
  transaction_hash?: string;
  index?: string | number;
  block_hash?: string;
}

type BlockscoutLogResult = EtherscanLogResult | V2LogResult;

const BLOCKSCOUT_CONTRACT_CREATION_BATCH_SIZE = 5;
const BLOCKSCOUT_TOKEN_TRANSFER_LIMIT = 1_000;

export interface BlockscoutContractCreationRecord {
  contractAddress: string;
  contractCreator: string;
  txHash: string;
}

export interface BlockscoutTokenTransferRecord {
  tokenAddress: string;
  tokenSymbol?: string;
  tokenName?: string;
  decimals?: number;
  from?: string;
  to?: string;
  valueRaw?: string;
  txHash?: string;
  blockNumber?: number;
  timestamp?: string;
}

export class BlockscoutClient {
  private requestCount = 0;
  private requestWindowStartedAt = Date.now();
  private lastRequestAt = 0;

  constructor(private readonly options: BlockscoutClientOptions) {}

  static fromEnv(env: Env, logger?: Logger): BlockscoutClient | undefined {
    if (!env.blockscoutApiKey) return undefined;
    return new BlockscoutClient({
      apiKey: env.blockscoutApiKey,
      apiBaseUrl: env.blockscoutApiBaseUrl,
      maxLogsPerRequest: env.blockscoutMaxLogsPerRequest,
      maxRequestsPerTick: env.blockscoutMaxRequestsPerTick,
      requestDelayMs: env.blockscoutRequestDelayMs,
      logger
    });
  }

  resetBudget(): void {
    this.requestCount = 0;
    this.requestWindowStartedAt = Date.now();
  }

  async fetchContractCreations(chain: ChainSlug, addresses: string[]): Promise<BlockscoutContractCreationRecord[]> {
    const chainId = getChain(chain).chainId;
    if (!chainId) throw new Error(`Blockscout contract creation lookup requires an EVM chain id for ${chain}`);
    const unique = [...new Set(addresses.map((address) => address.toLowerCase()))];
    const out: BlockscoutContractCreationRecord[] = [];
    for (let index = 0; index < unique.length; index += BLOCKSCOUT_CONTRACT_CREATION_BATCH_SIZE) {
      out.push(...await this.queryContractCreations(chainId, unique.slice(index, index + BLOCKSCOUT_CONTRACT_CREATION_BATCH_SIZE)));
    }
    return out;
  }

  async fetchSwapLogs(env: Env, chain: ChainSlug, pools: PoolKey[], fromBlock: number, toBlock: number, chunkSize = env.blockscoutLogChunkSize): Promise<Log[]> {
    const chainId = getChain(chain).chainId;
    if (!chainId) throw new Error(`Blockscout PRO logs require an EVM chain id for ${chain}`);
    const filters = blockscoutSwapLogFilters(env, chain, pools);
    const logs: Log[] = [];
    for (const filter of filters) {
      logs.push(...await this.fetchLogsForFilter(chainId, filter, fromBlock, toBlock, chunkSize));
    }
    return dedupeLogs(logs).sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
  }

  async fetchLogs(chain: ChainSlug, filters: BlockscoutLogFilter[], fromBlock: number, toBlock: number, chunkSize: number): Promise<Log[]> {
    const chainId = getChain(chain).chainId;
    if (!chainId) throw new Error(`Blockscout logs require an EVM chain id for ${chain}`);
    const logs: Log[] = [];
    for (const filter of filters) {
      logs.push(...await this.fetchLogsForFilter(chainId, filter, fromBlock, toBlock, chunkSize));
    }
    return dedupeLogs(logs).sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
  }

  async fetchAddressTokenTransfers(options: {
    chain: ChainSlug;
    address: string;
    startBlock?: number;
    endBlock?: number;
    limit?: number;
  }): Promise<BlockscoutTokenTransferRecord[]> {
    const chainId = getChain(options.chain).chainId;
    if (!chainId) throw new Error(`Blockscout token transfer lookup requires an EVM chain id for ${options.chain}`);
    const limit = Math.min(BLOCKSCOUT_TOKEN_TRANSFER_LIMIT, Math.max(1, Math.floor(options.limit ?? 100)));
    return this.queryTokenTransfers({
      chainId,
      address: options.address.toLowerCase(),
      startBlock: options.startBlock,
      endBlock: options.endBlock,
      limit
    });
  }

  private async queryContractCreations(chainId: number, addresses: string[]): Promise<BlockscoutContractCreationRecord[]> {
    if (addresses.length === 0) return [];
    this.chargeRequestBudget();
    await this.delayIfNeeded();
    const url = new URL(this.options.apiBaseUrl);
    url.searchParams.set("chain_id", String(chainId));
    url.searchParams.set("module", "contract");
    url.searchParams.set("action", "getcontractcreation");
    url.searchParams.set("contractaddresses", addresses.join(","));
    url.searchParams.set("apikey", this.options.apiKey);

    const response = await fetch(url, { headers: { accept: "application/json" } });
    const text = await response.text();
    const payload = parseBlockscoutPayload(text);
    if (!response.ok) {
      throw new Error(`Blockscout contract creation failed ${response.status}: ${blockscoutMessage(payload)}`);
    }
    const items = Array.isArray(payload.result) ? payload.result : [];
    if (payload.status === "0" && items.length === 0) {
      const message = blockscoutMessage(payload);
      if (/not found|no records|no contract/i.test(message)) return [];
      throw new Error(`Blockscout contract creation returned status=0: ${message}`);
    }
    return items.map(blockscoutContractCreationRecord).filter((record): record is BlockscoutContractCreationRecord => Boolean(record));
  }

  private async queryTokenTransfers(options: {
    chainId: number;
    address: string;
    startBlock?: number;
    endBlock?: number;
    limit: number;
  }): Promise<BlockscoutTokenTransferRecord[]> {
    this.chargeRequestBudget();
    await this.delayIfNeeded();
    const url = new URL(this.options.apiBaseUrl);
    url.searchParams.set("chain_id", String(options.chainId));
    url.searchParams.set("module", "account");
    url.searchParams.set("action", "tokentx");
    url.searchParams.set("address", options.address);
    if (options.startBlock !== undefined) url.searchParams.set("startblock", String(options.startBlock));
    if (options.endBlock !== undefined) url.searchParams.set("endblock", String(options.endBlock));
    url.searchParams.set("page", "1");
    url.searchParams.set("offset", String(options.limit));
    url.searchParams.set("sort", "desc");
    url.searchParams.set("apikey", this.options.apiKey);

    const response = await fetch(url, { headers: { accept: "application/json" } });
    const text = await response.text();
    const payload = parseBlockscoutPayload(text);
    if (!response.ok) {
      throw new Error(`Blockscout token transfers failed ${response.status}: ${blockscoutMessage(payload)}`);
    }
    const items = Array.isArray(payload.result)
      ? payload.result
      : Array.isArray(payload.items)
        ? payload.items
        : [];
    if (items.length === 0 && typeof payload.message === "string" && /no transactions|no records|no token/i.test(payload.message)) return [];
    if (payload.status === "0" && items.length === 0 && payload.message && !/no transactions|no records|no token/i.test(String(payload.message))) {
      throw new Error(`Blockscout token transfers returned status=0: ${blockscoutMessage(payload)}`);
    }
    return items.map(blockscoutTokenTransferRecord).filter((record): record is BlockscoutTokenTransferRecord => Boolean(record));
  }

  private async fetchLogsForFilter(chainId: number, filter: BlockscoutLogFilter, fromBlock: number, toBlock: number, chunkSize: number): Promise<Log[]> {
    const logs: Log[] = [];
    let start = Math.max(0, fromBlock);
    const end = Math.max(start, toBlock);
    while (start <= end) {
      const chunkEnd = Math.min(end, start + Math.max(1, chunkSize) - 1);
      logs.push(...await this.fetchLogsRange(chainId, filter, start, chunkEnd));
      start = chunkEnd + 1;
    }
    return logs;
  }

  private async fetchLogsRange(chainId: number, filter: BlockscoutLogFilter, fromBlock: number, toBlock: number): Promise<Log[]> {
    const results = await this.queryLogs(chainId, filter, fromBlock, toBlock);
    if (results.length >= this.options.maxLogsPerRequest && fromBlock < toBlock) {
      const mid = Math.floor((fromBlock + toBlock) / 2);
      return [
        ...await this.fetchLogsRange(chainId, filter, fromBlock, mid),
        ...await this.fetchLogsRange(chainId, filter, mid + 1, toBlock)
      ];
    }
    return results.map((result) => blockscoutLogToEthersLog(result, filter.address)).filter((log): log is Log => Boolean(log));
  }

  private async queryLogs(chainId: number, filter: BlockscoutLogFilter, fromBlock: number, toBlock: number): Promise<BlockscoutLogResult[]> {
    this.chargeRequestBudget();
    await this.delayIfNeeded();
    const url = new URL(this.options.apiBaseUrl);
    url.searchParams.set("chain_id", String(chainId));
    url.searchParams.set("module", "logs");
    url.searchParams.set("action", "getLogs");
    url.searchParams.set("fromBlock", String(fromBlock));
    url.searchParams.set("toBlock", String(toBlock));
    url.searchParams.set("address", filter.address);
    url.searchParams.set("topic0", filter.topic0);
    const topicFields = [1, 2, 3] as const;
    for (const index of topicFields) {
      const topic = filter[`topic${index}`];
      if (!topic) continue;
      url.searchParams.set(`topic${index}`, topic);
      url.searchParams.set(`topic0_${index}_opr`, "and");
    }
    url.searchParams.set("apikey", this.options.apiKey);

    const response = await fetch(url, { headers: { accept: "application/json" } });
    const text = await response.text();
    const payload = parseBlockscoutPayload(text);
    if (!response.ok) {
      throw new Error(`Blockscout logs failed ${response.status}: ${blockscoutMessage(payload)}`);
    }
    const items = Array.isArray(payload.result)
      ? payload.result
      : Array.isArray(payload.items)
        ? payload.items
        : [];
    if (items.length === 0 && typeof payload.message === "string" && /no logs|no records/i.test(payload.message)) return [];
    if (payload.status === "0" && items.length === 0 && payload.message && !/no logs|no records/i.test(String(payload.message))) {
      throw new Error(`Blockscout logs returned status=0: ${blockscoutMessage(payload)}`);
    }
    return items as BlockscoutLogResult[];
  }

  private async delayIfNeeded(): Promise<void> {
    const delayMs = this.options.requestDelayMs;
    if (delayMs <= 0) return;
    const now = Date.now();
    const waitMs = this.lastRequestAt > 0 ? Math.max(0, delayMs - (now - this.lastRequestAt)) : 0;
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    this.lastRequestAt = Date.now();
  }

  private chargeRequestBudget(): void {
    const now = Date.now();
    if (now - this.requestWindowStartedAt > 60_000) {
      this.requestCount = 0;
      this.requestWindowStartedAt = now;
    }
    this.requestCount += 1;
    if (this.requestCount > this.options.maxRequestsPerTick) {
      throw new Error(`Blockscout request budget exceeded (${this.options.maxRequestsPerTick})`);
    }
  }
}

function blockscoutSwapLogFilters(env: Env, chain: ChainSlug, pools: PoolKey[]): BlockscoutLogFilter[] {
  const filters: BlockscoutLogFilter[] = [];
  const poolManagerAddress = env.poolManagerAddresses[chain];
  const flaunchHookPoolIds = flaunchHookPoolsByAddress(pools);
  const flaunchPoolIds = new Set([...flaunchHookPoolIds.values()].flat());
  for (const id of uniqueIds(pools.filter((pool) => (pool.dex ?? "uniswap") === "uniswap" && poolProtocol(pool) === "v4").map((pool) => pool.id)).filter((id) => !flaunchPoolIds.has(id))) {
    if (poolManagerAddress) filters.push({ address: poolManagerAddress.toLowerCase(), topic0: SWAP_TOPIC, topic1: id });
  }
  for (const [hookAddress, ids] of flaunchHookPoolIds.entries()) {
    for (const id of ids) filters.push({ address: hookAddress, topic0: FLAUNCH_HOOK_SWAP_TOPIC, topic1: id });
  }
  for (const address of uniqueIds(pools.filter((pool) => poolProtocol(pool) === "v3" && pool.dex === "pancakeswap").map((pool) => pool.id))) {
    filters.push({ address, topic0: PANCAKE_V3_SWAP_TOPIC });
  }
  for (const address of uniqueIds(pools.filter((pool) => (poolProtocol(pool) === "v3" || (poolProtocol(pool) === "algebra" && pool.dex !== "hydrex")) && pool.dex !== "pancakeswap").map((pool) => pool.id))) {
    filters.push({ address, topic0: V3_SWAP_TOPIC });
  }
  for (const address of uniqueIds(pools.filter((pool) => poolProtocol(pool) === "v2" && pool.dex !== "aerodrome").map((pool) => pool.id))) {
    filters.push({ address, topic0: V2_SWAP_TOPIC });
  }
  for (const address of uniqueIds(pools.filter((pool) => poolProtocol(pool) === "solidly").map((pool) => pool.id))) {
    filters.push({ address, topic0: AERODROME_SWAP_TOPIC });
  }
  for (const address of uniqueIds(pools.filter((pool) => pool.dex === "hydrex").map((pool) => pool.id))) {
    filters.push({ address, topic0: HYDREX_SWAP_TOPIC });
  }
  for (const address of uniqueIds(pools.filter((pool) => poolProtocol(pool) === "lb").map((pool) => pool.id))) {
    filters.push({ address, topic0: LB_SWAP_TOPIC });
  }
  for (const address of uniqueIds(pools.filter((pool) => poolProtocol(pool) === "curve").map((pool) => pool.poolAddress ?? pool.id))) {
    for (const topic0 of CURVE_TOKEN_EXCHANGE_TOPICS) filters.push({ address, topic0 });
  }
  const balancerVault = getChain(chain).dexes.find((deployment) => deployment.dex === "balancer")?.balancerVaultAddress;
  if (balancerVault) {
    for (const id of uniqueIds(pools.filter((pool) => poolProtocol(pool) === "balancer").map((pool) => pool.id))) {
      filters.push({ address: balancerVault.toLowerCase(), topic0: BALANCER_SWAP_TOPIC, topic1: id });
    }
  }
  return filters;
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

function blockscoutLogToEthersLog(result: BlockscoutLogResult, fallbackAddress: string): Log | undefined {
  const raw = result as Record<string, unknown>;
  const topics = Array.isArray(result.topics) ? result.topics.filter((topic): topic is string => typeof topic === "string") : [];
  const data = typeof result.data === "string" ? result.data : "0x";
  const blockNumber = parseBlockscoutNumber(raw.blockNumber ?? raw.block_number);
  const logIndex = parseBlockscoutNumber(raw.logIndex ?? raw.index);
  const txHash = raw.transactionHash ?? raw.transaction_hash;
  const address = logAddress(result) ?? fallbackAddress;
  if (!topics.length || blockNumber === undefined || logIndex === undefined || typeof txHash !== "string") return undefined;
  return {
    address: address.toLowerCase(),
    topics: topics.map((topic) => topic.toLowerCase()),
    data,
    blockNumber,
    transactionHash: txHash.toLowerCase(),
    index: logIndex,
    blockHash: typeof (raw.blockHash ?? raw.block_hash) === "string" ? String(raw.blockHash ?? raw.block_hash) : "",
    transactionIndex: parseBlockscoutNumber(raw.transactionIndex) ?? 0,
    removed: Boolean(raw.removed)
  } as unknown as Log;
}

function blockscoutContractCreationRecord(value: unknown): BlockscoutContractCreationRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const contractAddress = typeof raw.contractAddress === "string"
    ? raw.contractAddress
    : typeof raw.contract_address === "string"
      ? raw.contract_address
      : undefined;
  const contractCreator = typeof raw.contractCreator === "string"
    ? raw.contractCreator
    : typeof raw.contract_creator === "string"
      ? raw.contract_creator
      : undefined;
  const txHash = typeof raw.txHash === "string"
    ? raw.txHash
    : typeof raw.transactionHash === "string"
      ? raw.transactionHash
      : typeof raw.transaction_hash === "string"
        ? raw.transaction_hash
        : undefined;
  if (!contractAddress || !contractCreator || !txHash) return undefined;
  return { contractAddress, contractCreator, txHash };
}

function blockscoutTokenTransferRecord(value: unknown): BlockscoutTokenTransferRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const token = raw.token && typeof raw.token === "object" ? raw.token as Record<string, unknown> : undefined;
  const total = raw.total && typeof raw.total === "object" ? raw.total as Record<string, unknown> : undefined;
  const tokenAddress = stringValue(raw.contractAddress)
    ?? stringValue(raw.contract_address)
    ?? stringValue(raw.tokenAddress)
    ?? stringValue(raw.token_address)
    ?? objectHash(token?.address)
    ?? objectHash(token?.address_hash);
  if (!tokenAddress) return undefined;
  const txHash = stringValue(raw.hash)
    ?? stringValue(raw.transactionHash)
    ?? stringValue(raw.transaction_hash)
    ?? objectHash(raw.transaction);
  const timestamp = parseBlockscoutTimestamp(raw.timeStamp ?? raw.timestamp);
  return {
    tokenAddress: tokenAddress.toLowerCase(),
    tokenSymbol: stringValue(raw.tokenSymbol) ?? stringValue(raw.token_symbol) ?? stringValue(token?.symbol),
    tokenName: stringValue(raw.tokenName) ?? stringValue(raw.token_name) ?? stringValue(token?.name),
    decimals: parseBlockscoutNumber(raw.tokenDecimal ?? raw.token_decimal ?? token?.decimals ?? total?.decimals),
    from: objectHash(raw.from)?.toLowerCase(),
    to: objectHash(raw.to)?.toLowerCase(),
    valueRaw: stringValue(raw.value) ?? stringValue(total?.value),
    txHash: txHash?.toLowerCase(),
    blockNumber: parseBlockscoutNumber(raw.blockNumber ?? raw.block_number),
    timestamp
  };
}

function logAddress(result: BlockscoutLogResult): string | undefined {
  if ("address" in result && typeof result.address === "string") return result.address;
  if ("address_hash" in result && typeof result.address_hash === "string") return result.address_hash;
  if ("address_hash" in result && result.address_hash && typeof result.address_hash === "object" && typeof result.address_hash.hash === "string") return result.address_hash.hash;
  if ("smart_contract" in result && result.smart_contract?.hash) return result.smart_contract.hash;
  return undefined;
}

function objectHash(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  return stringValue(raw.hash) ?? stringValue(raw.address) ?? stringValue(raw.address_hash);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function parseBlockscoutNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = value.startsWith("0x") ? Number.parseInt(value, 16) : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBlockscoutTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value * 1000).toISOString();
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const trimmed = value.trim();
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) return new Date(numeric * 1000).toISOString();
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function parseBlockscoutPayload(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Blockscout logs returned non-JSON response: ${text.slice(0, 120) || "empty response body"}`);
  }
}

function blockscoutMessage(payload: Record<string, unknown>): string {
  const message = typeof payload.message === "string" ? payload.message : undefined;
  const result = typeof payload.result === "string" ? payload.result : undefined;
  return message ?? result ?? "unknown error";
}

function dedupeLogs(logs: Log[]): Log[] {
  const byKey = new Map<string, Log>();
  for (const log of logs) {
    byKey.set(`${log.transactionHash.toLowerCase()}:${log.index}`, log);
  }
  return [...byKey.values()];
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.toLowerCase()))];
}
