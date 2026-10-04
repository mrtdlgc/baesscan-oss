import type { Context } from "telegraf";
import { isAddress } from "ethers";
import type { Logger } from "pino";
import type { Env } from "../config/env";
import type { RpcPool } from "../services/rpcPool";
import type { Address, ChainSlug, ChatState, Hex32, HookDiscoveryFilter, PoolDex, PoolKey, PoolProtocol, TokenId } from "../types";
import { dexLabel, poolDex, poolVersionLabel, selectedDexesLabel } from "../dex/discovery";
import { poolCurrencies, poolProtocol } from "../dex/uniswap";
import { getChain, isChainSlug, publicChainLabels } from "../chains/registry";
import { maybeAddressOrAlias, normalizeAddress } from "../utils/address";
import { parsePositiveNumber } from "../utils/format";

const MAX_POOL_DISCOVERY_BLOCKS = 50_000;
export const SOLANA_DISABLED_MESSAGE =
  "Solana support is currently disabled. Use one of the supported EVM chains: " + publicChainLabels() + ".";

export function assertSupportedUserChain(chain: ChainSlug): void {
  if (chain === "solana") throw new Error(SOLANA_DISABLED_MESSAGE);
}

export function parseOptionalChain(args: string[], env: Env, chat?: ChatState): { chain: ChainSlug; args: string[] } {
  const first = args[0]?.toLowerCase();
  if (isChainSlug(first)) return { chain: first, args: args.slice(1) };
  return { chain: chat?.chain ?? env.primaryChain, args };
}

export function poolDisplayLabel(pool: PoolKey): string {
  return `${dexLabel(poolDex(pool))} ${poolVersionLabel(pool)}`;
}

export function chatTitle(ctx: Context): string | undefined {
  const chat = ctx.chat;
  if (!chat) return undefined;
  if ("title" in chat) return chat.title;
  return ctx.from?.username ?? ctx.from?.first_name;
}

export function parseWatchArgs(
  rawArgs: string[],
  env: Env
): {
  chain: ChainSlug;
  token: TokenId;
  quote?: TokenId;
  deploymentBlock?: number;
  onlyClankerHooks: boolean;
  hookFilter?: HookDiscoveryFilter;
  scanMode: "first" | "next" | "all";
  protocols?: PoolProtocol[];
  dexes?: PoolDex[];
} {
  const parsedChain = parseOptionalChain(rawArgs, env);
  const args = parsedChain.args;
  const chain = parsedChain.chain;
  if (args.length < 1) throw new Error("Usage: /watch [chain] <token> [quote|any] <tokenDeploymentBlock> [dex] [v2|v3|v4|solidly|algebra|lb|curve|balancer] [clanker] [next|all]");
  if (getChain(chain).kind === "evm" && !isAddress(args[0]!)) throw new Error("token must be an EVM address");

  let quote: TokenId | undefined;
  let quoteSeen = false;
  let deploymentBlock: number | undefined;
  let onlyClankerHooks = false;
  let hookFilter: HookDiscoveryFilter | undefined;
  let scanMode: "first" | "next" | "all" = "first";
  let protocols: PoolProtocol[] | undefined;
  let dexes: PoolDex[] | undefined;
  const addProtocol = (protocol: PoolProtocol) => {
    protocols ??= [];
    if (!protocols.includes(protocol)) protocols.push(protocol);
  };
  const addDex = (dex: PoolDex) => {
    dexes ??= [];
    if (!dexes.includes(dex)) dexes.push(dex);
  };

  for (const raw of args.slice(1)) {
    const part = raw.trim();
    const lower = part.toLowerCase();
    if (["clanker", "--clanker", "onlyclanker"].includes(lower)) {
      onlyClankerHooks = true;
      hookFilter = "clanker";
      continue;
    }
    if (["flaunch", "--flaunch"].includes(lower)) {
      hookFilter = "flaunch";
      continue;
    }
    if (["hooks", "hooked", "launchpad", "launchpads"].includes(lower)) {
      hookFilter = "launchpad";
      continue;
    }
    if (["next", "more", "another"].includes(lower)) {
      scanMode = "next";
      continue;
    }
    if (["all", "every"].includes(lower)) {
      scanMode = "all";
      continue;
    }
    if (["v2", "uni2", "univ2", "uniswap2", "uniswap-v2"].includes(lower)) {
      addProtocol("v2");
      continue;
    }
    if (["v3", "uni3", "univ3", "uniswap3", "uniswap-v3"].includes(lower)) {
      addProtocol("v3");
      continue;
    }
    if (["v4", "uni4", "univ4", "uniswap4", "uniswap-v4"].includes(lower)) {
      addProtocol("v4");
      continue;
    }
    if (lower === "solidly") {
      addProtocol("solidly");
      continue;
    }
    if (["aero", "aerodrome"].includes(lower)) {
      addDex("aerodrome");
      addProtocol("solidly");
      continue;
    }
    if (["velo", "velodrome"].includes(lower)) {
      addDex("velodrome");
      addProtocol("solidly");
      continue;
    }
    if (lower === "algebra") {
      addProtocol("algebra");
      continue;
    }
    if (["lb", "liquiditybook", "liquidity-book"].includes(lower)) {
      addProtocol("lb");
      continue;
    }
    if (["hydrex", "hydrex-integral", "integral"].includes(lower)) {
      addDex("hydrex");
      addProtocol("algebra");
      continue;
    }
    if (["curve", "curvefi", "curve-finance"].includes(lower)) {
      addDex("curve");
      addProtocol("curve");
      continue;
    }
    if (["balancer", "bal", "balancer-v2"].includes(lower)) {
      addDex("balancer");
      addProtocol("balancer");
      continue;
    }
    if (["camelot", "grail"].includes(lower)) {
      addDex("camelot");
      continue;
    }
    if (["sushi", "sushiswap"].includes(lower)) {
      addDex("sushiswap");
      continue;
    }
    if (["thena", "biswap", "apeswap", "quickswap", "pharaoh", "blackhole", "pangolin", "kumbaya", "prism", "noxa"].includes(lower)) {
      addDex(lower as PoolDex);
      continue;
    }
    if (["joe", "traderjoe", "trader-joe", "lfj"].includes(lower)) {
      addDex("traderjoe");
      continue;
    }
    if (["quick", "quick-swap"].includes(lower)) {
      addDex("quickswap");
      continue;
    }
    if (["pancake", "pancakeswap", "pcs"].includes(lower)) {
      addDex("pancakeswap");
      continue;
    }
    if (["uni", "uniswap"].includes(lower)) {
      addDex("uniswap");
      continue;
    }
    if (/^\d+$/.test(part)) {
      deploymentBlock = Number(part);
      continue;
    }
    if (!quoteSeen) {
      if (lower === "any") {
        quoteSeen = true;
        quote = undefined;
        continue;
      }
      const parsedQuote = maybeAddressOrAlias(part, chain);
      if (parsedQuote) {
        quote = parsedQuote;
        quoteSeen = true;
        continue;
      }
    }
    throw new Error(`Unrecognized argument: ${part}`);
  }

  if (hookFilter && protocols && !protocols.includes("v4")) {
    throw new Error("Hook filters only apply to v4 pools.");
  }
  if (hookFilter && dexes && !dexes.includes("uniswap")) {
    throw new Error("Hook filters only apply to Uniswap v4 pools.");
  }
  if (getChain(chain).kind === "evm" && deploymentBlock === undefined) {
    throw new Error(
      "Token deployment block is required for /watch and /scan pool discovery. Example: /watch base 0xToken weth 23456789. Manual /pool entries do not need token discovery."
    );
  }

  return {
    chain,
    token: getChain(chain).kind === "evm" ? normalizeAddress(args[0]!) : args[0]!,
    quote,
    deploymentBlock,
    onlyClankerHooks,
    hookFilter,
    scanMode,
    protocols,
    dexes
  };
}

export function effectiveProtocols(protocols: PoolProtocol[] | undefined, onlyClankerHooks: boolean): PoolProtocol[] | undefined {
  if (protocols?.length) return protocols;
  return onlyClankerHooks ? ["v4"] : undefined;
}

export function effectiveDexes(dexes: PoolDex[] | undefined, onlyClankerHooks: boolean): PoolDex[] | undefined {
  if (dexes?.length) return dexes;
  return onlyClankerHooks ? ["uniswap"] : undefined;
}

export function resolveHookDiscoveryFilter(
  parsed: { hookFilter?: HookDiscoveryFilter; onlyClankerHooks: boolean },
  existingChat?: ChatState
): HookDiscoveryFilter | undefined {
  if (parsed.hookFilter) return parsed.hookFilter;
  return parsed.onlyClankerHooks || existingChat?.settings.onlyClankerHooks ? "clanker" : undefined;
}

export function selectionLabel(protocols: PoolProtocol[] | undefined, dexes: PoolDex[] | undefined, chain: ChainSlug): string {
  const version = protocols?.length ? protocols.map(protocolLabel).join("/") : "all";
  return `${selectedDexesLabel(dexes, chain)} ${version}`;
}

export function protocolLabel(protocol: PoolProtocol): string {
  if (protocol === "algebra") return "Algebra";
  if (protocol === "curve") return "Curve";
  if (protocol === "balancer") return "Balancer";
  if (protocol === "solana") return "Solana";
  return protocol === "solidly" ? "Solidly" : protocol.toUpperCase();
}

type PoolIdentifier = { kind: "v4"; poolId: Hex32 } | { kind: "address"; poolAddress: Address };

export function parsePoolIdentifierArg(raw: string): PoolIdentifier | undefined {
  const poolIdMatch = raw.match(/0x[a-fA-F0-9]{64}/);
  if (poolIdMatch) return { kind: "v4", poolId: poolIdMatch[0].toLowerCase() as Hex32 };
  const addressMatch = raw.match(/0x[a-fA-F0-9]{40}/);
  return addressMatch ? { kind: "address", poolAddress: normalizeAddress(addressMatch[0]) } : undefined;
}

export function parsePoolIdArgs(args: string[]): { targetToken?: Address; fromBlock?: number } {
  let targetToken: Address | undefined;
  let fromBlock: number | undefined;
  for (const raw of args) {
    const part = raw.trim();
    if (!part) continue;
    if (/^\d+$/.test(part)) {
      fromBlock = Number(part);
      continue;
    }
    if (isAddress(part)) {
      targetToken = normalizeAddress(part);
      continue;
    }
    throw new Error(`Unrecognized pool argument: ${part}`);
  }
  return { targetToken, fromBlock };
}

export function normalizeOptionalAddress(value?: string): Address | undefined {
  if (!value || !isAddress(value)) return undefined;
  return normalizeAddress(value);
}

export function inferTargetTokenFromPool(pool: PoolKey, chain: ChainSlug): Address | undefined {
  return inferTargetTokenFromAddresses(chain, ...poolCurrencies(pool));
}

export function inferTargetTokenFromAddresses(chain: ChainSlug, ...addresses: Array<TokenId | undefined>): Address | undefined {
  const canonical = new Set(getChain(chain).canonicalPairTokens.map((address) => address.toLowerCase()));
  const candidates = addresses.filter(Boolean).filter((value): value is Address => typeof value === "string" && isAddress(value));
  const nonCanonical = candidates.filter((address) => !canonical.has(address.toLowerCase()));
  return nonCanonical.length === 1 ? nonCanonical[0] : undefined;
}

export async function scanRange(
  rpc: RpcPool,
  env: Env,
  startBlock: number
): Promise<{ fromBlock: number; toBlock: number }> {
  const latest = await rpc.getBlockNumber();
  const headBlock = Math.max(0, latest - env.confirmations);
  const fromBlock = Math.max(0, Math.floor(startBlock));
  const maxBlocks = Math.min(MAX_POOL_DISCOVERY_BLOCKS, Math.max(1, Math.floor(env.poolScanLookbackBlocks)));
  const toBlock = Math.min(headBlock, fromBlock + maxBlocks - 1);
  if (fromBlock > toBlock) throw new Error(`fromBlock ${fromBlock} is greater than toBlock ${toBlock}`);
  return { fromBlock, toBlock };
}

export function rangeLimitNote(fromBlock: number, toBlock: number): string {
  const count = Math.max(0, toBlock - fromBlock + 1);
  return count >= MAX_POOL_DISCOVERY_BLOCKS ? ` (capped at ${MAX_POOL_DISCOVERY_BLOCKS.toLocaleString()} blocks)` : "";
}

export function isPoolCurrency(pool: PoolKey, token: TokenId): boolean {
  return poolCurrencies(pool).some((currency) => currency.toLowerCase() === token.toLowerCase());
}

export function poolMatchesSelection(
  pool: PoolKey,
  token: TokenId,
  quote?: TokenId,
  protocols?: PoolProtocol[],
  dexes?: PoolDex[]
): boolean {
  if (protocols?.length && !protocols.includes(poolProtocol(pool))) return false;
  if (dexes?.length && !dexes.includes(pool.dex ?? "uniswap")) return false;
  if (!isPoolCurrency(pool, token)) return false;
  return quote ? quoteMatchesPool(pool, quote) : true;
}

function quoteMatchesPool(pool: PoolKey, quote: TokenId): boolean {
  if (isPoolCurrency(pool, quote)) return true;
  const chain = getChain(pool.chain ?? "base");
  const quoteIsNativeLike = chain.nativeLikeQuotes.some((nativeQuote) => nativeQuote.toLowerCase() === quote.toLowerCase());
  if (!quoteIsNativeLike) return false;
  return poolCurrencies(pool).some((currency) =>
    chain.nativeLikeQuotes.some((nativeQuote) => nativeQuote.toLowerCase() === currency.toLowerCase())
  );
}

export function assertCanTrackToken(existingChat: ChatState | undefined, token: TokenId): void {
  if (!existingChat?.tokenAddress) return;
  if (existingChat.tokenAddress.toLowerCase() === token.toLowerCase()) return;
  const existing = existingChat.token?.symbol
    ? `${existingChat.token.symbol} (${existingChat.tokenAddress})`
    : existingChat.tokenAddress;
  throw new Error(
    `This chat is already tracking ${existing}. Use /unwatch first if you want to switch to a different token.`
  );
}

export function applySetting(chat: ChatState, rawKey: string, rawValue: string): void {
  const key = rawKey.toLowerCase();
  switch (key) {
    case "minusd":
    case "min_usd":
      chat.settings.minUsd = parsePositiveNumber(rawValue, "minUsd");
      return;
    case "minquote":
    case "min_quote":
      chat.settings.minQuote = parsePositiveNumber(rawValue, "minQuote");
      return;
    case "emoji":
      if (!rawValue.trim()) throw new Error("emoji cannot be empty");
      chat.settings.emoji = rawValue.trim();
      return;
    case "emojistep":
    case "emoji_step":
      chat.settings.emojiStepUsd = parsePositiveNumber(rawValue, "emojiStepUsd");
      return;
    case "maxemojis":
    case "max_emoji":
      chat.settings.maxEmojis = Math.max(1, Math.floor(parsePositiveNumber(rawValue, "maxEmojis")));
      return;
    case "media":
      if (["off", "none", "false", "0"].includes(rawValue.toLowerCase())) {
        delete chat.settings.mediaUrl;
        delete chat.settings.media;
        return;
      }
      // For backward compat, /set media <url> still accepts a URL and treats it as a photo.
      delete chat.settings.mediaUrl;
      chat.settings.media = { kind: "photo", ref: rawValue.trim() };
      return;
    case "tx":
    case "txlink":
      chat.settings.showTxLink = parseBool(rawValue);
      return;
    case "chart":
    case "chartlink":
      chat.settings.showChartLink = parseBool(rawValue);
      return;
    case "backfill":
      chat.settings.backfillBlocks = Math.floor(parsePositiveNumber(rawValue, "backfill"));
      return;
    case "clanker":
      chat.settings.onlyClankerHooks = parseBool(rawValue);
      return;
    default:
      throw new Error(`Unknown setting: ${rawKey}`);
  }
}

export function parseBool(raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (["on", "true", "yes", "1"].includes(normalized)) return true;
  if (["off", "false", "no", "0"].includes(normalized)) return false;
  throw new Error(`Expected on/off, got ${raw}`);
}

export function tenPow(decimals: number): bigint {
  return 10n ** BigInt(Math.max(0, decimals));
}

export async function replyLong(ctx: Context, text: string): Promise<void> {
  const max = 3900;
  for (let i = 0; i < text.length; i += max) {
    await ctx.reply(text.slice(i, i + max));
  }
}

interface ProgressContext {
  chatId: number;
  token: string;
  action: "scan" | "watch" | "pool";
}

export function createProgressReporter(ctx: Context, logger: Logger, info: ProgressContext) {
  const start = Date.now();
  let lastTelegramUpdate = 0;
  let lastLogUpdate = 0;
  let lastPercent = -1;
  let progressMsgId: number | undefined;
  let foundPools: number | undefined;

  const setFound = (matches: number) => {
    foundPools = Math.max(foundPools ?? 0, matches);
  };

  const onProgress = (p: { scanned: number; total: number; matches: number; currentChunk: number }) => {
    const percent = Math.min(100, Math.floor((p.scanned / p.total) * 100));
    const now = Date.now();
    const matches = foundPools ?? p.matches;

    // Log every 5s - visible on Railway.
    if (now - lastLogUpdate > 5_000) {
      lastLogUpdate = now;
      logger.info(
        {
          ...info,
          percent,
          scanned: p.scanned,
          total: p.total,
          matches,
          chunk: p.currentChunk,
          elapsedMs: now - start
        },
        "pool scan progress"
      );
    }

    // Update Telegram every 15s or 10%, whichever comes first.
    const dueByTime = now - lastTelegramUpdate > 15_000;
    const dueByPercent = percent - lastPercent >= 10;
    if (!dueByTime && !dueByPercent) return;
    lastTelegramUpdate = now;
    lastPercent = percent;

    const text =
      `Scanning ${percent}% (${p.scanned.toLocaleString()}/${p.total.toLocaleString()} blocks)\n` +
      `Pools found: ${matches} | chunk ${p.currentChunk}`;
    void (async () => {
      try {
        if (progressMsgId === undefined) {
          const sent = await ctx.telegram.sendMessage(info.chatId, text);
          progressMsgId = sent.message_id;
        } else {
          await ctx.telegram.editMessageText(info.chatId, progressMsgId, undefined, text);
        }
      } catch {
        // Telegram rate-limits or message-not-modified; safe to ignore.
      }
    })();
  };

  const finish = async (matches: number) => {
    const elapsedMs = Date.now() - start;
    logger.info({ ...info, matches, elapsedMs }, "pool scan complete");
    if (progressMsgId !== undefined) {
      const text = `Scan complete: ${matches} pool(s) found in ${(elapsedMs / 1000).toFixed(1)}s.`;
      try {
        await ctx.telegram.editMessageText(info.chatId, progressMsgId, undefined, text);
      } catch {
        // ignore
      }
    }
  };

  return { onProgress, finish, setFound };
}
