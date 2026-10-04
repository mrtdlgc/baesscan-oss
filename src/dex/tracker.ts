import { formatUnits, Log } from "ethers";
import type { RpcPool } from "../services/rpcPool";
import type { Telegraf } from "telegraf";
import type { Logger } from "pino";
import type { Env } from "../config/env";
import type { Address, BuyEvent, ChainSlug, ChatState, PoolKey, TokenMetadata } from "../types";
import type { ChatLastBlockUpdate, Storage } from "../store/storage";
import { TokenService } from "../services/token";
import { PriceService } from "../services/price";
import { normalizeAddress } from "../utils/address";
import { formatTokenAmount } from "../utils/format";
import { getOtherCurrency } from "./uniswap";
import { sendBuyNotification } from "../bot/messages";
import { migrateChatId, migrateTargetFromError } from "../bot/chatMigration";
import { parseBuySwap } from "./swapParsers";
import { fetchSwapLogs, poolIdForSwapLog, uniquePools } from "./swapLogs";
import {
  SolanaRpcClient,
  getSolanaTokenActivity,
  solanaPoolForMint,
  solanaQuoteMetadata
} from "../solana/activity";

const DEFAULT_TRACKER_MAX_BLOCKS_PER_TICK = 2_000;
const MAX_TRACKER_MAX_BLOCKS_PER_TICK = 100_000;

interface EvmTrackerBatch {
  fromBlock: number;
  toBlock: number;
  chats: ChatState[];
}

interface EvmEnrichmentCache {
  txBuyers: Map<string, Promise<Address | undefined>>;
  buyerBalances: Map<string, Promise<number | undefined>>;
}

export class SwapTracker {
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastHeartbeatAt = 0;
  private static readonly HEARTBEAT_INTERVAL_MS = 5 * 60_000;

  constructor(
    private readonly rpcs: Map<ChainSlug, RpcPool>,
    private readonly bot: Telegraf,
    private readonly store: Storage,
    private readonly tokenServices: Map<ChainSlug, TokenService>,
    private readonly priceService: PriceService,
    private readonly env: Env,
    private readonly logger: Logger,
    private readonly solanaClient?: SolanaRpcClient
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.env.pollIntervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const tickStart = Date.now();
    try {
      const activeChats = this.store.getActiveChats();
      this.maybeHeartbeat(activeChats.length, 0, undefined);
      if (activeChats.length === 0) return;

      for (const [chain, chats] of groupChatsByChain(activeChats)) {
        if (chain === "solana") {
          this.logger.warn({ chats: chats.length }, "skipping solana tracker because solana is currently hidden from the supported product surface");
          continue;
        }
        const rpc = this.rpcs.get(chain);
        const tokenService = this.tokenServices.get(chain);
        if (!rpc || !tokenService) {
          this.logger.warn({ chain, chats: chats.length }, "skipping tracker chain with no configured RPC");
          continue;
        }
        await this.tickEvmChain(chain, chats, rpc, tokenService);
      }
      await this.store.save();
    } catch (error) {
      this.logger.error({ error }, "swap tracker tick failed");
    } finally {
      const elapsedMs = Date.now() - tickStart;
      if (elapsedMs > this.env.pollIntervalMs) {
        this.logger.warn(
          { elapsedMs, pollIntervalMs: this.env.pollIntervalMs },
          "tracker tick exceeded poll interval"
        );
      }
      this.running = false;
    }
  }

  private async tickSolanaChain(activeChats: ChatState[]): Promise<void> {
    if (!this.solanaClient?.isConfigured()) {
      this.logger.warn({ chats: activeChats.length }, "skipping solana tracker with no configured RPC");
      return;
    }
    for (const chat of activeChats) {
      if (!chat.tokenAddress || !chat.token) continue;
      const mint = String(chat.tokenAddress);
      const activity = await getSolanaTokenActivity(this.solanaClient, mint, this.env, chat.lastSignature);
      const events = activity.events.slice().reverse();
      for (const event of events) {
        const pool = {
          ...solanaPoolForMint(mint, event.quoteMint, event.dexes[0]),
          programId: event.programIds[0]
        };
        const current = this.currentTrackedChat(chat, { poolId: pool.id, cursor: event.signature });
        if (!current?.token) break;
        try {
          const quote = solanaQuoteMetadata(event.quoteMint, event.quoteDecimals);
          const quoteAmountNumber = Number(event.quoteAmount);
          if (current.settings.minQuote > 0 && quoteAmountNumber < current.settings.minQuote) continue;

          const usdMultiplier = await this.priceService.quoteUsdMultiplier(quote.address, "solana");
          const quoteUsd = usdMultiplier !== undefined ? quoteAmountNumber * usdMultiplier : undefined;
          if (current.settings.minUsd > 0 && quoteUsd !== undefined && quoteUsd < current.settings.minUsd) continue;

          const tokenAmountNumber = Number(event.tokenAmount);
          const token = current.token;
          const swapPriceUsd = quoteUsd !== undefined && tokenAmountNumber > 0 ? quoteUsd / tokenAmountNumber : undefined;
          const valuation = await this.priceService.marketValuation("solana", { tokenAddress: mint });
          const priceUsd = swapPriceUsd ?? valuation?.priceUsd;
          const fdvUsd = fdvFromSupply(token, swapPriceUsd) ?? valuation?.fdvUsd;
          await sendBuyNotification(this.bot.telegram, current, {
            chatId: current.chatId,
            chain: "solana",
            pool,
            token,
            quote,
            tokenAmountRaw: event.tokenAmountRaw,
            quoteAmountRaw: event.quoteAmountRaw,
            tokenAmount: formatTokenAmount(event.tokenAmountRaw, event.tokenDecimals, 4),
            quoteAmount: formatTokenAmount(event.quoteAmountRaw, event.quoteDecimals, 6),
            quoteUsd,
            priceUsd,
            fdvUsd,
            marketCapUsd: valuation?.marketCapUsd,
            buyer: event.buyer,
            sender: event.buyer,
            txHash: event.signature,
            blockNumber: event.slot,
            logIndex: 0
          });
          this.logger.info({ chatId: current.chatId, signature: event.signature, mint }, "sent solana buy notification");
        } catch (error) {
          this.logger.error({ error, chatId: current.chatId, signature: event.signature, mint }, "failed to process solana activity event");
        }
      }
      const current = this.currentTrackedChat(chat);
      if (current) {
        current.lastSignature = activity.newestSignature ?? current.lastSignature;
        this.store.setChat(current);
      }
    }
  }

  private async tickEvmChain(
    chain: ChainSlug,
    activeChats: ChatState[],
    rpc: RpcPool,
    tokenService: TokenService
  ): Promise<void> {
    const latest = await rpc.getBlockNumber();
    const headBlock = Math.max(0, latest - this.env.confirmations);
    const pools = uniquePools(activeChats);
    this.maybeHeartbeat(activeChats.length, pools.length, latest);
    if (pools.length === 0) return;

    const maxBlocks = trackerMaxBlocksPerTick();
    const batches = evmTrackerBatches(activeChats, headBlock, maxBlocks);
    if (batches.length === 0) return;

    const enrichmentCache: EvmEnrichmentCache = {
      txBuyers: new Map(),
      buyerBalances: new Map()
    };

    for (const batch of batches) {
      const batchPools = uniquePools(batch.chats);
      if (batchPools.length === 0) continue;
      const chatsByPool = chatsByPoolId(batch.chats);
      this.logger.debug(
        {
          chain,
          chats: batch.chats.length,
          pools: batchPools.length,
          fromBlock: batch.fromBlock,
          toBlock: batch.toBlock,
          headBlock,
          range: batch.toBlock - batch.fromBlock + 1,
          catchupRemaining: headBlock - batch.toBlock,
          cursorBatches: batches.length
        },
        "tracker tick: fetching swap logs"
      );

      const logs = await fetchSwapLogs(rpc, this.env, chain, batchPools, batch.fromBlock, batch.toBlock);
      if (logs.length > 0) {
        this.logger.info(
          {
            chain,
            chats: batch.chats.length,
            pools: batchPools.length,
            swaps: logs.length,
            fromBlock: batch.fromBlock,
            toBlock: batch.toBlock
          },
          "tracker tick: swap logs found"
        );
      }
      logs.sort((a, b) => {
        if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
        if (a.transactionIndex !== b.transactionIndex) return a.transactionIndex - b.transactionIndex;
        return a.index - b.index;
      });

      for (const log of logs) {
        const poolId = poolIdForSwapLog(log, this.env, chain);
        if (!poolId) continue;
        const watchingChats = chatsByPool.get(poolId) ?? [];
        for (const chat of watchingChats) {
          const current = this.currentTrackedChat(chat, { poolId, blockNumber: log.blockNumber });
          if (!current?.tokenAddress || !current.token) continue;
          const pool = current.pools[poolId] ?? current.pools[poolId.toLowerCase()];
          if (!pool) continue;
          try {
            await this.handleSwapLog(chain, rpc, tokenService, current, pool, log, enrichmentCache);
          } catch (error) {
            this.logger.error(
              { error, chain, chatId: current.chatId, txHash: log.transactionHash, poolId },
              "failed to process swap log"
            );
          }
        }
      }

      const cursorUpdates: ChatLastBlockUpdate[] = [];
      for (const chat of batch.chats) {
        const current = this.currentTrackedChat(chat);
        if (!current) continue;
        if ((current.lastBlock ?? 0) >= batch.toBlock) continue;
        cursorUpdates.push({ chatId: current.chatId, lastBlock: batch.toBlock });
      }
      this.store.advanceChatLastBlocks(cursorUpdates);
    }
  }

  private currentTrackedChat(
    snapshot: ChatState,
    opts: { poolId?: string; blockNumber?: number; cursor?: string } = {}
  ): ChatState | undefined {
    const current = this.store.getChat(snapshot.chatId);
    if (!current?.enabled) return undefined;
    if ((current.chain ?? "base") !== (snapshot.chain ?? "base")) return undefined;
    if (!current.tokenAddress || !snapshot.tokenAddress) return undefined;
    if (tokenKey(current.tokenAddress) !== tokenKey(snapshot.tokenAddress)) return undefined;
    if (opts.poolId && !current.pools[opts.poolId.toLowerCase()]) return undefined;
    if (opts.blockNumber !== undefined && opts.blockNumber <= (current.lastBlock ?? 0)) return undefined;
    if (opts.cursor && current.lastSignature !== snapshot.lastSignature) return undefined;
    if (opts.cursor && opts.cursor === current.lastSignature) return undefined;
    return current;
  }

  private maybeHeartbeat(chats: number, pools: number, latestBlock: number | undefined): void {
    const now = Date.now();
    if (now - this.lastHeartbeatAt < SwapTracker.HEARTBEAT_INTERVAL_MS) return;
    this.lastHeartbeatAt = now;
    this.logger.info(
      { chats, pools, latestBlock, pollIntervalMs: this.env.pollIntervalMs },
      "tracker heartbeat"
    );
  }

  private async handleSwapLog(
    chain: ChainSlug,
    rpc: RpcPool,
    tokenService: TokenService,
    chat: ChatState,
    pool: PoolKey,
    log: Log,
    enrichmentCache: EvmEnrichmentCache
  ): Promise<void> {
    const tokenAddress = normalizeAddress(chat.tokenAddress!);
    const parsedSwap = parseBuySwap(pool, log, tokenAddress);
    if (!parsedSwap) return;

    const quoteAddress = parsedSwap.quoteAddress ?? getOtherCurrency(pool, tokenAddress);
    const quote = await tokenService.getToken(quoteAddress);
    const token = await this.tokenForAlert(chat, tokenAddress, tokenService);
    const quoteAmountRaw = parsedSwap.quoteAmountRaw;
    const quoteAmountNumber = Number(formatUnits(quoteAmountRaw, quote.decimals));

    if (chat.settings.minQuote > 0 && quoteAmountNumber < chat.settings.minQuote) return;

    const usdMultiplier = await this.priceService.quoteUsdMultiplier(quote.address, chain);
    const quoteUsd = usdMultiplier !== undefined ? quoteAmountNumber * usdMultiplier : undefined;
    if (chat.settings.minUsd > 0 && quoteUsd !== undefined && quoteUsd < chat.settings.minUsd) return;

    const tokenAmountRaw = parsedSwap.tokenAmountRaw;
    const tokenAmountNumber = Number(formatUnits(tokenAmountRaw, token.decimals));
    const swapPriceUsd = quoteUsd !== undefined && tokenAmountNumber > 0 ? quoteUsd / tokenAmountNumber : undefined;
    const valuation = await this.priceService.marketValuation(chain, {
      tokenAddress: token.address,
      pairId: pool.poolAddress ?? pool.id
    });
    const priceUsd = swapPriceUsd ?? valuation?.priceUsd;
    const fdvUsd = fdvFromSupply(token, swapPriceUsd) ?? valuation?.fdvUsd;
    const marketCapUsd = valuation?.marketCapUsd;
    if (fdvUsd === undefined && marketCapUsd === undefined) {
      this.logger.warn(
        {
          chain,
          chatId: chat.chatId,
          txHash: log.transactionHash,
          poolId: pool.id,
          token: token.address,
          tokenSymbol: token.symbol,
          quote: quote.address,
          quoteSymbol: quote.symbol,
          hasQuoteUsd: quoteUsd !== undefined,
          hasPriceUsd: priceUsd !== undefined,
          hasTotalSupply: Boolean(token.totalSupply),
          hasMarketData: valuation !== undefined
        },
        "buy alert market cap unavailable"
      );
    }

    const buyer = await this.getBuyerForTransaction(rpc, log.transactionHash, enrichmentCache);
    const buyerEthBalance = buyer ? await this.getBuyerEthBalanceCached(rpc, buyer, enrichmentCache) : undefined;
    const event: BuyEvent = {
      chatId: chat.chatId,
      chain,
      pool,
      token,
      quote,
      tokenAmountRaw,
      quoteAmountRaw,
      tokenAmount: formatTokenAmount(tokenAmountRaw, token.decimals, 4),
      quoteAmount: formatTokenAmount(quoteAmountRaw, quote.decimals, 6),
      quoteUsd,
      priceUsd,
      fdvUsd,
      marketCapUsd,
      buyer,
      buyerEthBalance,
      sender: parsedSwap.sender,
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
      logIndex: log.index
    };

    try {
      await sendBuyNotification(this.bot.telegram, chat, event);
      this.logger.info({ chatId: chat.chatId, txHash: event.txHash, poolId: pool.id }, "sent buy notification");
    } catch (error) {
      // A basic group that was upgraded to a supergroup answers with the new chat id.
      // Move the record across instead of failing on every buy from here on.
      const migrateTo = migrateTargetFromError(error);
      if (migrateTo !== undefined) {
        await migrateChatId(this.store, this.logger, chat.chatId, migrateTo);
        return;
      }
      this.logger.error({ error, chatId: chat.chatId, txHash: event.txHash }, "failed to send Telegram notification");
    }
  }

  private async tokenForAlert(chat: ChatState, tokenAddress: Address, tokenService: TokenService): Promise<TokenMetadata> {
    const token = chat.token as TokenMetadata;
    if (token.totalSupply) return token;
    const totalSupply = await tokenService.getTotalSupply(tokenAddress);
    if (!totalSupply) return token;
    const refreshed = { ...token, totalSupply };
    chat.token = refreshed;
    this.store.setChat(chat);
    return refreshed;
  }

  private async getBuyerEthBalance(rpc: RpcPool, buyer: Address): Promise<number | undefined> {
    try {
      return Number(formatUnits(await rpc.getBalance(buyer), 18));
    } catch (error) {
      this.logger.warn({ error, buyer }, "failed to fetch buyer native balance");
      return undefined;
    }
  }

  private getBuyerForTransaction(
    rpc: RpcPool,
    txHash: string,
    enrichmentCache: EvmEnrichmentCache
  ): Promise<Address | undefined> {
    const cacheKey = txHash.toLowerCase();
    const cached = enrichmentCache.txBuyers.get(cacheKey);
    if (cached) return cached;
    const lookup = rpc.getTransaction(txHash)
      .then((tx) => tx?.from ? normalizeAddress(tx.from) : undefined)
      .catch((error) => {
        this.logger.warn({ error, txHash }, "failed to fetch swap transaction sender");
        return undefined;
      });
    enrichmentCache.txBuyers.set(cacheKey, lookup);
    return lookup;
  }

  private getBuyerEthBalanceCached(
    rpc: RpcPool,
    buyer: Address,
    enrichmentCache: EvmEnrichmentCache
  ): Promise<number | undefined> {
    const cacheKey = buyer.toLowerCase();
    const cached = enrichmentCache.buyerBalances.get(cacheKey);
    if (cached) return cached;
    const lookup = this.getBuyerEthBalance(rpc, buyer);
    enrichmentCache.buyerBalances.set(cacheKey, lookup);
    return lookup;
  }
}

function trackerMaxBlocksPerTick(): number {
  const raw = process.env.TRACKER_MAX_BLOCKS_PER_TICK;
  if (!raw || raw.trim() === "") return DEFAULT_TRACKER_MAX_BLOCKS_PER_TICK;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_TRACKER_MAX_BLOCKS_PER_TICK;
  return Math.max(1, Math.min(MAX_TRACKER_MAX_BLOCKS_PER_TICK, Math.floor(parsed)));
}

function groupChatsByChain(chats: ChatState[]): Map<ChainSlug, ChatState[]> {
  const out = new Map<ChainSlug, ChatState[]>();
  for (const chat of chats) {
    const chain = chat.chain ?? "base";
    const list = out.get(chain) ?? [];
    list.push(chat);
    out.set(chain, list);
  }
  return out;
}

function tokenKey(value: unknown): string {
  return String(value).toLowerCase();
}

function evmTrackerBatches(
  activeChats: ChatState[],
  headBlock: number,
  maxBlocks: number
): EvmTrackerBatch[] {
  const pending = activeChats
    .map((chat) => ({ chat, nextBlock: (chat.lastBlock ?? headBlock) + 1 }))
    .filter((item) => item.nextBlock <= headBlock)
    .sort((a, b) => a.nextBlock - b.nextBlock || a.chat.chatId - b.chat.chatId);
  const batches: EvmTrackerBatch[] = [];
  let index = 0;
  while (index < pending.length) {
    const first = pending[index];
    if (!first) break;
    const fromBlock = first.nextBlock;
    const toBlock = Math.min(headBlock, fromBlock + maxBlocks - 1);
    const chats: ChatState[] = [];
    while (index < pending.length && pending[index]!.nextBlock <= toBlock) {
      chats.push(pending[index]!.chat);
      index++;
    }
    if (chats.length > 0) batches.push({ fromBlock, toBlock, chats });
  }
  return batches;
}

function chatsByPoolId(chats: ChatState[]): Map<string, ChatState[]> {
  const out = new Map<string, ChatState[]>();
  for (const chat of chats) {
    for (const poolId of Object.keys(chat.pools)) {
      const key = poolId.toLowerCase();
      const poolChats = out.get(key) ?? [];
      poolChats.push(chat);
      out.set(key, poolChats);
    }
  }
  return out;
}

/** Fully diluted valuation from on-chain total supply and the executed swap price. */
function fdvFromSupply(token: TokenMetadata, priceUsd: number | undefined): number | undefined {
  if (priceUsd === undefined || !token.totalSupply) return undefined;
  try {
    const supply = Number(formatUnits(BigInt(token.totalSupply), token.decimals));
    if (!Number.isFinite(supply) || supply <= 0) return undefined;
    return supply * priceUsd;
  } catch {
    return undefined;
  }
}
