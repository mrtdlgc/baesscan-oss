import { ZERO_ADDRESS } from "../chains/registry";
import type { Address, ChainSlug } from "../types";
import { normalizeAddress, shortHex } from "../utils/address";
import type { BlockscoutClient, BlockscoutContractCreationRecord } from "./blockscout";
import type { RpcPool } from "./rpcPool";
import { TokenService } from "./token";

export type ContractCreatorSource =
  | "blockscout-contract-creation"
  | "receipt-contract-address"
  | "debug-trace-transaction"
  | "trace-block"
  | "debug-trace-block"
  | "receipt-log-fallback";

export interface ContractCreatorResult {
  chain: ChainSlug;
  address: Address;
  creator: Address;
  contractCreator: Address;
  transactionFrom?: Address;
  txHash: string;
  creationTxHash: string;
  blockNumber?: number;
  creationBlock?: number;
  source: ContractCreatorSource;
  confidence: "high" | "medium";
  createdByContract: boolean;
  generatedAt: string;
  note?: string;
}

export class ContractCreatorLookupError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "ContractCreatorLookupError";
  }
}

interface RawBlock {
  transactions?: unknown[];
}

interface RawReceipt {
  transactionHash?: string;
  contractAddress?: string | null;
  from?: string;
  logs?: Array<{ address?: string }>;
}

interface RawTransaction {
  hash?: string;
  from?: string;
}

interface BlockTransaction {
  hash: string;
  from: Address;
}

interface CandidateTransaction {
  tx: BlockTransaction;
}

interface CreatorMatch {
  creator: Address;
  txHash: string;
  blockNumber?: number;
  transactionFrom?: Address;
  source: ContractCreatorSource;
  confidence: "high" | "medium";
  note?: string;
}

interface ContractCreatorLookupOptions {
  blockscoutClient?: BlockscoutClient;
}

const CREATOR_CACHE_TTL_MS = 7 * 24 * 60 * 60_000;
const tokenServicesByRpc = new WeakMap<RpcPool, Map<ChainSlug, TokenService>>();
const creatorCache = new Map<string, { expiresAt: number; result: ContractCreatorResult }>();
const creatorInFlight = new Map<string, Promise<ContractCreatorResult>>();

export async function lookupContractCreator(
  chain: ChainSlug,
  rpc: RpcPool,
  addressInput: string,
  options: ContractCreatorLookupOptions = {}
): Promise<ContractCreatorResult> {
  const address = normalizeLookupAddress(addressInput);
  const key = `${chain}:${address.toLowerCase()}`;
  const now = Date.now();
  const cached = creatorCache.get(key);
  if (cached && cached.expiresAt > now) return cached.result;
  const inFlight = creatorInFlight.get(key);
  if (inFlight) return inFlight;

  const task = lookupContractCreatorUncached(chain, rpc, address, options)
    .then((result) => {
      creatorCache.set(key, { expiresAt: Date.now() + CREATOR_CACHE_TTL_MS, result });
      return result;
    })
    .finally(() => {
      creatorInFlight.delete(key);
    });
  creatorInFlight.set(key, task);
  return task;
}

function normalizeLookupAddress(addressInput: string): Address {
  try {
    return normalizeAddress(addressInput);
  } catch (error) {
    throw new ContractCreatorLookupError("invalid contract address", 400, "invalid_contract_address", {
      address: addressInput
    });
  }
}

async function lookupContractCreatorUncached(
  chain: ChainSlug,
  rpc: RpcPool,
  address: Address,
  options: ContractCreatorLookupOptions
): Promise<ContractCreatorResult> {
  if (address.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
    throw new ContractCreatorLookupError("native assets do not have a contract creator", 400, "native_asset", { address });
  }

  const blockscoutMatch = await findCreatorWithBlockscout(options.blockscoutClient, chain, rpc, address).catch(() => undefined);
  if (blockscoutMatch) return contractCreatorResult(chain, address, blockscoutMatch);

  const code = await rpc.getCode(address);
  if (!hasRuntimeCode(code)) {
    throw new ContractCreatorLookupError("address has no contract code at the current head", 404, "contract_not_found", {
      address
    });
  }

  const deploymentBlock = await tokenServiceFor(chain, rpc).findDeploymentBlock(address);
  if (deploymentBlock === undefined) {
    throw new ContractCreatorLookupError(
      "RPC could not resolve the contract deployment block; configure an archive-capable RPC for this chain",
      503,
      "deployment_block_unavailable",
      { address }
    );
  }

  const match = await findCreatorInDeploymentBlock(rpc, address, deploymentBlock);
  if (!match) {
    throw new ContractCreatorLookupError("contract creator was not found in the deployment block", 404, "contract_creator_not_found", {
      address,
      deploymentBlock
    });
  }

  return contractCreatorResult(chain, address, match, deploymentBlock);
}

function contractCreatorResult(
  chain: ChainSlug,
  address: Address,
  match: CreatorMatch,
  deploymentBlock?: number
): ContractCreatorResult {
  const transactionFrom = match.transactionFrom;
  const creationBlock = match.blockNumber ?? deploymentBlock;
  return {
    chain,
    address,
    creator: match.creator,
    contractCreator: match.creator,
    transactionFrom,
    txHash: match.txHash,
    creationTxHash: match.txHash,
    blockNumber: creationBlock,
    creationBlock,
    source: match.source,
    confidence: match.confidence,
    createdByContract: Boolean(transactionFrom && transactionFrom.toLowerCase() !== match.creator.toLowerCase()),
    generatedAt: new Date().toISOString(),
    note: match.note
  };
}

async function findCreatorWithBlockscout(
  blockscoutClient: BlockscoutClient | undefined,
  chain: ChainSlug,
  rpc: RpcPool,
  address: Address
): Promise<CreatorMatch | undefined> {
  if (!blockscoutClient) return undefined;
  const records = await blockscoutClient.fetchContractCreations(chain, [address]);
  const record = records.find((candidate) => sameAddress(candidate.contractAddress, address));
  if (!record) return undefined;
  return blockscoutRecordToCreatorMatch(rpc, record);
}

async function blockscoutRecordToCreatorMatch(rpc: RpcPool, record: BlockscoutContractCreationRecord): Promise<CreatorMatch | undefined> {
  const creator = normalizeMaybe(record.contractCreator);
  if (!creator || !isHexHash(record.txHash)) return undefined;
  const transaction = await rpc.getTransaction(record.txHash).catch(() => null);
  const transactionFrom = normalizeMaybe(transaction?.from);
  return {
    creator,
    blockNumber: transaction?.blockNumber ?? undefined,
    transactionFrom,
    txHash: record.txHash,
    source: "blockscout-contract-creation",
    confidence: "high",
    note: transaction?.blockNumber === undefined
      ? "Blockscout returned the contract creator and creation transaction; the configured RPC did not return a block number for that transaction."
      : undefined
  };
}

function tokenServiceFor(chain: ChainSlug, rpc: RpcPool): TokenService {
  let byChain = tokenServicesByRpc.get(rpc);
  if (!byChain) {
    byChain = new Map();
    tokenServicesByRpc.set(rpc, byChain);
  }
  let service = byChain.get(chain);
  if (!service) {
    service = new TokenService(rpc, chain, { fastMetadata: true });
    byChain.set(chain, service);
  }
  return service;
}

async function findCreatorInDeploymentBlock(
  rpc: RpcPool,
  address: Address,
  blockNumber: number
): Promise<CreatorMatch | undefined> {
  const block = await rpc.send<RawBlock | null>("eth_getBlockByNumber", [blockTag(blockNumber), true], {
    blockNumber,
    note: "contract creator block"
  });
  if (!block) {
    throw new ContractCreatorLookupError("deployment block was not returned by the RPC", 503, "deployment_block_unavailable", {
      blockNumber
    });
  }

  const transactions = await loadBlockTransactions(rpc, block, blockNumber);
  if (transactions.length === 0) {
    throw new ContractCreatorLookupError("deployment block did not include full transaction objects", 503, "full_block_unavailable", {
      blockNumber
    });
  }

  const txByHash = new Map(transactions.map((tx) => [tx.hash.toLowerCase(), tx]));
  const txByPosition = new Map(transactions.map((tx, index) => [index, tx]));
  const receiptsByHash = await getBlockReceipts(rpc, blockNumber);
  const candidates: CandidateTransaction[] = [];

  for (const tx of transactions) {
    const receipt = receiptsByHash?.get(tx.hash.toLowerCase()) ?? await getTransactionReceipt(rpc, tx.hash, blockNumber);
    if (!receipt) continue;
    if (sameAddress(receipt.contractAddress, address)) {
      return {
        creator: tx.from,
        transactionFrom: tx.from,
        txHash: tx.hash,
        source: "receipt-contract-address",
        confidence: "high"
      };
    }
    if (receipt.logs?.some((log) => sameAddress(log.address, address))) {
      candidates.push({ tx });
    }
  }

  for (const candidate of candidates) {
    const match = await findCreatorWithTransactionTrace(rpc, address, candidate.tx).catch(() => undefined);
    if (match) return match;
  }

  const traceBlockMatch = await findCreatorWithTraceBlock(rpc, address, blockNumber, txByHash, txByPosition).catch(() => undefined);
  if (traceBlockMatch) return traceBlockMatch;

  const debugBlockMatch = await findCreatorWithDebugTraceBlock(rpc, address, blockNumber, txByHash, transactions).catch(() => undefined);
  if (debugBlockMatch) return debugBlockMatch;

  const fallback = candidates[0];
  if (fallback) {
    return {
      creator: fallback.tx.from,
      transactionFrom: fallback.tx.from,
      txHash: fallback.tx.hash,
      source: "receipt-log-fallback",
      confidence: "medium",
      note: "Matched the deployment transaction from token logs, but this RPC did not expose create traces; creator falls back to the transaction sender."
    };
  }

  return undefined;
}

async function getBlockReceipts(rpc: RpcPool, blockNumber: number): Promise<Map<string, RawReceipt> | undefined> {
  const receipts = await rpc.send<unknown>("eth_getBlockReceipts", [blockTag(blockNumber)], {
    blockNumber,
    note: "contract creator block receipts"
  }).catch(() => undefined);
  if (!Array.isArray(receipts)) return undefined;
  const out = new Map<string, RawReceipt>();
  for (const receipt of receipts) {
    if (!isRecord(receipt)) continue;
    const hash = typeof receipt.transactionHash === "string" ? receipt.transactionHash.toLowerCase() : undefined;
    if (hash) out.set(hash, receipt as RawReceipt);
  }
  return out.size > 0 ? out : undefined;
}

function getTransactionReceipt(rpc: RpcPool, txHash: string, blockNumber: number): Promise<RawReceipt | null> {
  return rpc.send<RawReceipt | null>("eth_getTransactionReceipt", [txHash], {
    blockNumber,
    note: shortHex(txHash)
  });
}

async function findCreatorWithTransactionTrace(
  rpc: RpcPool,
  address: Address,
  tx: BlockTransaction
): Promise<CreatorMatch | undefined> {
  const trace = await rpc.send<unknown>("debug_traceTransaction", [tx.hash, { tracer: "callTracer", timeout: "10s" }], {
    note: shortHex(tx.hash)
  });
  const frame = traceFrameFromUnknown(trace);
  const create = findCreateFrame(frame, address);
  if (!create) return undefined;
  return {
    creator: create.creator,
    transactionFrom: tx.from,
    txHash: tx.hash,
    source: "debug-trace-transaction",
    confidence: "high"
  };
}

async function findCreatorWithTraceBlock(
  rpc: RpcPool,
  address: Address,
  blockNumber: number,
  txByHash: Map<string, BlockTransaction>,
  txByPosition: Map<number, BlockTransaction>
): Promise<CreatorMatch | undefined> {
  const traces = await rpc.send<unknown>("trace_block", [blockTag(blockNumber)], {
    blockNumber,
    note: "contract creator trace_block"
  });
  if (!Array.isArray(traces)) return undefined;
  for (const trace of traces) {
    if (!isRecord(trace)) continue;
    if (String(trace.type ?? "").toLowerCase() !== "create") continue;
    const result = isRecord(trace.result) ? trace.result : undefined;
    if (!sameAddress(typeof result?.address === "string" ? result.address : undefined, address)) continue;
    const action = isRecord(trace.action) ? trace.action : undefined;
    const creator = normalizeMaybe(typeof action?.from === "string" ? action.from : undefined);
    if (!creator) continue;
    const txHash = typeof trace.transactionHash === "string" ? trace.transactionHash : undefined;
    const tx = txHash
      ? txByHash.get(txHash.toLowerCase())
      : txByPosition.get(numericTracePosition(trace.transactionPosition) ?? -1);
    const resolvedTxHash = txHash ?? tx?.hash;
    if (!resolvedTxHash) continue;
    return {
      creator,
      transactionFrom: tx?.from,
      txHash: resolvedTxHash,
      source: "trace-block",
      confidence: "high"
    };
  }
  return undefined;
}

async function findCreatorWithDebugTraceBlock(
  rpc: RpcPool,
  address: Address,
  blockNumber: number,
  txByHash: Map<string, BlockTransaction>,
  transactions: BlockTransaction[]
): Promise<CreatorMatch | undefined> {
  const traces = await rpc.send<unknown>("debug_traceBlockByNumber", [blockTag(blockNumber), { tracer: "callTracer", timeout: "10s" }], {
    blockNumber,
    note: "contract creator debug_traceBlockByNumber"
  });
  if (!Array.isArray(traces)) return undefined;
  for (let index = 0; index < traces.length; index++) {
    const entry = traces[index];
    const record = isRecord(entry) ? entry : undefined;
    const frame = traceFrameFromUnknown(record?.result ?? entry);
    const create = findCreateFrame(frame, address);
    if (!create) continue;
    const txHash = typeof record?.txHash === "string"
      ? record.txHash
      : typeof record?.transactionHash === "string"
        ? record.transactionHash
        : undefined;
    const tx = txHash ? txByHash.get(txHash.toLowerCase()) : transactions[index];
    const resolvedTxHash = txHash ?? tx?.hash;
    if (!resolvedTxHash) continue;
    return {
      creator: create.creator,
      transactionFrom: tx?.from,
      txHash: resolvedTxHash,
      source: "debug-trace-block",
      confidence: "high"
    };
  }
  return undefined;
}

interface TraceFrame {
  type?: unknown;
  from?: unknown;
  to?: unknown;
  address?: unknown;
  contractAddress?: unknown;
  createdContract?: unknown;
  result?: unknown;
  calls?: unknown;
}

function findCreateFrame(frame: TraceFrame | undefined, address: Address): { creator: Address } | undefined {
  if (!frame) return undefined;
  const type = String(frame.type ?? "").toUpperCase();
  if ((type === "CREATE" || type === "CREATE2") && frameCreatedAddressMatches(frame, address)) {
    const creator = normalizeMaybe(typeof frame.from === "string" ? frame.from : undefined);
    if (creator) return { creator };
  }
  if (Array.isArray(frame.calls)) {
    for (const child of frame.calls) {
      const match = findCreateFrame(traceFrameFromUnknown(child), address);
      if (match) return match;
    }
  }
  return undefined;
}

function frameCreatedAddressMatches(frame: TraceFrame, address: Address): boolean {
  if (sameAddress(typeof frame.to === "string" ? frame.to : undefined, address)) return true;
  if (sameAddress(typeof frame.address === "string" ? frame.address : undefined, address)) return true;
  if (sameAddress(typeof frame.contractAddress === "string" ? frame.contractAddress : undefined, address)) return true;
  if (sameAddress(typeof frame.createdContract === "string" ? frame.createdContract : undefined, address)) return true;
  if (isRecord(frame.result) && sameAddress(typeof frame.result.address === "string" ? frame.result.address : undefined, address)) return true;
  return false;
}

function traceFrameFromUnknown(value: unknown): TraceFrame | undefined {
  return isRecord(value) ? value as TraceFrame : undefined;
}

function normalizeBlockTransactions(block: RawBlock): BlockTransaction[] {
  const out: BlockTransaction[] = [];
  for (const raw of block.transactions ?? []) {
    if (!isRecord(raw)) continue;
    const tx = raw as RawTransaction;
    if (typeof tx.hash !== "string" || typeof tx.from !== "string") continue;
    const from = normalizeMaybe(tx.from);
    if (!from) continue;
    out.push({ hash: tx.hash, from });
  }
  return out;
}

async function loadBlockTransactions(rpc: RpcPool, block: RawBlock, blockNumber: number): Promise<BlockTransaction[]> {
  const transactions = normalizeBlockTransactions(block);
  if (transactions.length > 0) return transactions;

  const hashes = (block.transactions ?? []).filter((value): value is string => isHexHash(String(value)));
  const out: BlockTransaction[] = [];
  for (const hash of hashes) {
    const tx = await rpc.getTransaction(hash).catch(() => null);
    const txFrom = normalizeMaybe(tx?.from);
    if (tx?.hash && txFrom) {
      out.push({ hash: tx.hash, from: txFrom });
      continue;
    }
    const receipt = await getTransactionReceipt(rpc, hash, blockNumber).catch(() => null);
    const receiptFrom = normalizeMaybe(receipt?.from);
    if (receiptFrom) out.push({ hash, from: receiptFrom });
  }
  return out;
}

function sameAddress(value: string | null | undefined, target: Address): boolean {
  const normalized = normalizeMaybe(value ?? undefined);
  return Boolean(normalized && normalized.toLowerCase() === target.toLowerCase());
}

function normalizeMaybe(value: string | undefined): Address | undefined {
  if (!value) return undefined;
  try {
    return normalizeAddress(value);
  } catch {
    return undefined;
  }
}

function hasRuntimeCode(code: string | undefined): boolean {
  return Boolean(code && code !== "0x" && code !== "0x0");
}

function isHexHash(value: string): boolean {
  return /^0x[a-fA-F0-9]{64}$/.test(value);
}

function blockTag(blockNumber: number): string {
  return `0x${Math.max(0, Math.floor(blockNumber)).toString(16)}`;
}

function numericTracePosition(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function contractCreatorPublicError(error: unknown, fallbackAddress?: string): Record<string, unknown> {
  if (error instanceof ContractCreatorLookupError) {
    return {
      error: error.message,
      code: error.code,
      statusCode: error.statusCode,
      ...(fallbackAddress ? { address: fallbackAddress } : {}),
      ...error.details
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    error: message,
    code: "contract_creator_lookup_failed",
    statusCode: 500,
    ...(fallbackAddress ? { address: fallbackAddress } : {})
  };
}
