export type Address = `0x${string}`;
export type Hex32 = `0x${string}`;
export type ChainSlug =
  | "base"
  | "ethereum"
  | "bsc"
  | "monad"
  | "megaeth"
  | "solana"
  | "arbitrum"
  | "optimism"
  | "polygon"
  | "avalanche";
export type ChainKind = "evm" | "solana";
export type TokenId = Address | string;
export type PoolProtocol = "v2" | "v3" | "v4" | "solidly" | "algebra" | "lb" | "curve" | "balancer" | "solana";
export type HookDiscoveryFilter = "clanker" | "flaunch" | "launchpad";
export type PoolDex =
  | "uniswap"
  | "pancakeswap"
  | "sushiswap"
  | "curve"
  | "balancer"
  | "aerodrome"
  | "velodrome"
  | "camelot"
  | "hydrex"
  | "thena"
  | "biswap"
  | "apeswap"
  | "quickswap"
  | "pharaoh"
  | "blackhole"
  | "traderjoe"
  | "pangolin"
  | "noxa"
  | "kumbaya"
  | "prism"
  | "solana"
  | "pumpfun"
  | "raydium"
  | "orca"
  | "meteora";

export interface TokenMetadata {
  address: TokenId;
  chain?: ChainSlug;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply?: string;
  isNative?: boolean;
  deployBlock?: number;
  metadataFallback?: boolean;
}

export interface PoolKey {
  id: Address | Hex32 | string;
  chain?: ChainSlug;
  dex?: PoolDex;
  protocol?: PoolProtocol;
  currency0: TokenId;
  currency1: TokenId;
  poolTokens?: TokenId[];
  fee: number;
  tickSpacing?: number;
  binStep?: number;
  hooks?: Address;
  stable?: boolean;
  programId?: string;
  poolAddress?: Address;
  vaultAddress?: Address;
  source: "discovered" | "manual";
  createdBlock?: number;
  sqrtPriceX96?: string;
  initialTick?: number;
}

export type MediaKind = "photo" | "animation";

export interface ChatMedia {
  kind: MediaKind;
  /** Either a public URL or a Telegram file_id. */
  ref: string;
}

export interface ChatSettings {
  minUsd: number;
  minQuote: number;
  emoji: string;
  emojiStepUsd: number;
  maxEmojis: number;
  /** @deprecated kept for backward compat with older state files; use `media`. */
  mediaUrl?: string;
  media?: ChatMedia;
  showTxLink: boolean;
  showChartLink: boolean;
  backfillBlocks: number;
  onlyClankerHooks: boolean;
}

export interface ChatState {
  chatId: number;
  title?: string;
  alertThreadId?: number;
  chain?: ChainSlug;
  enabled: boolean;
  tokenAddress?: TokenId;
  token?: TokenMetadata;
  pools: Record<string, PoolKey>;
  settings: ChatSettings;
  lastBlock?: number;
  lastSignature?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BannedChat {
  chatId: number;
  reason?: string;
  bannedAt: string;
}

export interface AppState {
  version: number;
  chats: Record<string, ChatState>;
  bannedChats?: Record<string, BannedChat>;
}

export interface BuyEvent {
  chatId: number;
  chain?: ChainSlug;
  pool: PoolKey;
  token: TokenMetadata;
  quote: TokenMetadata;
  tokenAmountRaw: bigint;
  quoteAmountRaw: bigint;
  tokenAmount: string;
  quoteAmount: string;
  quoteUsd?: number;
  priceUsd?: number;
  fdvUsd?: number;
  buyerEthBalance?: number;
  buyer?: string;
  sender?: string;
  txHash: string;
  blockNumber: number;
  logIndex: number;
}
