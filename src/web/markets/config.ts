import { getChain } from "../../chains/registry";
import type { Address, ChainSlug, PoolDex } from "../../types";

export const MARKET_SEEDS_BY_CHAIN: Partial<Record<ChainSlug, Array<{ address: Address; dex: PoolDex }>>> = {
  base: [
    { address: "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59", dex: "aerodrome" },
    { address: "0xb4cb800910b228ed3d0834cf79d697127bbb00e5", dex: "uniswap" },
    { address: "0x72ab388e2e2f6facef59e3c3fa2c4e29011c2d38", dex: "pancakeswap" },
    { address: "0x88a43bbdf9d098eec7bceda4e2494615dfd9bb9c", dex: "uniswap" },
    { address: "0x82dbe18346a8656dbb5e76f74bf3ae279cc16b29", dex: "hydrex" },
    { address: "0x79474223aedd0339780bacce75abda0be84dcbf9", dex: "pancakeswap" },
    { address: "0xa4fdd479eda160671636e2ecf8f993cbf86258a8", dex: "aerodrome" },
    { address: "0x3f0296bf652e19bca772ec3df08b32732f93014a", dex: "aerodrome" },
    { address: "0x4e962bb3889bf030368f56810a9c96b83cb3e778", dex: "aerodrome" },
    { address: "0x47ca96ea59c13f72745928887f84c9f52c3d7348", dex: "aerodrome" },
    { address: "0xf1cacd7e005b9337c58aae77bc88d93c635cdf4d", dex: "pancakeswap" },
    { address: "0x66660fbcd3829932586a5af62093ee75faa91f9f", dex: "pancakeswap" },
    { address: "0x7cb770d0513c30e0cb45e4899e4a2cbeed6f9830", dex: "pancakeswap" },
    { address: "0x0ba69825c4c033e72309f6ac0bde0023b15cc97c", dex: "hydrex" },
    { address: "0xb20f018dde5a6fe7f93c31da05a5da9efbc52772", dex: "hydrex" },
    { address: "0x3f9b863ef4b295d6ba370215bcca3785fcc44f44", dex: "hydrex" },
    { address: "0xcecf4d16114e601276ba7e8c39a309fbfc605f0e", dex: "hydrex" },
    { address: "0xc142affc7191aa77ef644a790da10a9aa8b01f7e", dex: "hydrex" },
    { address: "0x404e927b203375779a6abd52a2049ce0adf6609b", dex: "sushiswap" },
    { address: "0xde37e221442fa15c35dc19fbae11ed106ba52fb2", dex: "curve" },
    { address: "0xf2ecc3a2defb4ecc1ac510cbbc405a539a990be4", dex: "curve" },
    { address: "0x47d0868e1e4655c9e95c1520b41d72d4e6c7049f", dex: "balancer" }
  ],
  ethereum: [
    { address: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640", dex: "uniswap" },
    { address: "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8", dex: "uniswap" },
    { address: "0xcbcdf9626bc03e24f779434178a73a0b4bad62ed", dex: "uniswap" },
    { address: "0x4e68ccd3e89f51c3074ca5072bbac773960dfa36", dex: "uniswap" },
    { address: "0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc", dex: "uniswap" },
    { address: "0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7", dex: "curve" },
    { address: "0x5c6ee304399dbdb9c8ef030ab642b10820db8f56", dex: "balancer" }
  ],
  bsc: [
    { address: "0x172fcd41e0913e95784454622d1c3724f546f849", dex: "pancakeswap" },
    { address: "0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae", dex: "pancakeswap" },
    { address: "0x47a90a2d92a8367a91efa1906bfc8c1e05bf10c4", dex: "uniswap" },
    { address: "0x51bd5e6d3da9064d59bcaa5a76776560ab42ceb8", dex: "thena" },
    { address: "0x63db6ba9e512186c2faadacef342fb4a40dc577c", dex: "thena" },
    { address: "0x46492b26639df0cda9b2769429845cb991591e0a", dex: "biswap" },
    { address: "0xf65c1c0478efde3c19b49ecbe7acc57bb6b1d713", dex: "apeswap" }
  ],
  arbitrum: [
    { address: "0xc6962004f452be9203591991d15f6b388e09e8d0", dex: "uniswap" },
    { address: "0x7fcdc35463e3770c2fb992716cd070b63540b947", dex: "pancakeswap" },
    { address: "0xb1026b8e7276e7ac75410f1fcbbe21796e8f7526", dex: "camelot" },
    { address: "0xbfca4230115de8341f3a3d5e8845ffb3337b2be3", dex: "camelot" },
    { address: "0x11eecdbd8f2d670016d061e4c064072e6158ede2", dex: "sushiswap" },
    { address: "0x7f90122bf0700f9e7e1f688fe926940e8839f353", dex: "curve" },
    { address: "0xaf0561b26ac83418fc889590b4d7c28d73de6718", dex: "balancer" }
  ],
  optimism: [
    { address: "0xeb0d8d9e19b749efb20c67d71ee50b46dfe5755f", dex: "uniswap" },
    { address: "0x478946bcd4a5a22b316470f5486fafb928c0ba25", dex: "velodrome" },
    { address: "0x8134a2fdc127549480865fb8e5a9e8a8a95a54c5", dex: "velodrome" },
    { address: "0x03771e24b7c9172d163bf447490b142a15be3485", dex: "curve" }
  ],
  polygon: [
    { address: "0xb6e57ed85c4c9dbfef2a68711e9d6f36c56e0fcb", dex: "uniswap" },
    { address: "0x6669b4706cc152f359e947bca68e263a87c52634", dex: "quickswap" },
    { address: "0x14ef96a0f7d738db906bdd5260e46aa47b1e6e45", dex: "quickswap" },
    { address: "0xc4e595acdd7d12fec385e5da5d43160e8a0bac0e", dex: "sushiswap" },
    { address: "0xc7c939a474cb10eb837894d1ed1a77c61b268fa7", dex: "curve" },
    { address: "0x3bd8a254163f8328efcc4f8c36da566753462433", dex: "balancer" }
  ],
  avalanche: [
    { address: "0xf01449c0ba930b6e2caca3def3ccbd7a3e589534", dex: "pharaoh" },
    { address: "0xa02ec3ba8d17887567672b2cdcaf525534636ea0", dex: "blackhole" },
    { address: "0xfae3f424a0a47706811521e3ee268f00cfb5c45e", dex: "uniswap" },
    { address: "0x864d4e5ee7318e97483db7eb0912e09f161516ea", dex: "traderjoe" },
    { address: "0x454e67025631c065d3cfad6d71e6892f74487a15", dex: "traderjoe" },
    { address: "0xd7538cabbf8605bde1f4901b47b8d42c61de0367", dex: "pangolin" },
    { address: "0x6539bf462f73ff9497054ba261c195da8639ed61", dex: "sushiswap" },
    { address: "0x3a43a5851a3e3e0e25a3c1089670269786be1577", dex: "curve" },
    { address: "0x8e600715db997e1b3bbd884841a840095947cfbc", dex: "balancer" }
  ],
  monad: [
    { address: "0x659bd0bc4167ba25c62e05656f78043e7ed4a9da", dex: "uniswap" },
    { address: "0x63e48b725540a3db24acf6682a29f877808c53f2", dex: "pancakeswap" },
    { address: "0x5afd3ec861f6104af26e8755abcc1f876de77620", dex: "traderjoe" }
  ],
  megaeth: [
    { address: "0x587f6eeafc7ad567e96ed1b62775fa6402164b22", dex: "kumbaya" },
    { address: "0xc2fac0b5b6c075819e654bcfbbbcda2838609d32", dex: "prism" },
    { address: "0x4b183a49963f98b3c8ffb4a7e9248defc278cd95", dex: "noxa" }
  ]
};

export const BLOCK_SECONDS_BY_CHAIN: Partial<Record<ChainSlug, number>> = {
  base: 2,
  ethereum: 12,
  arbitrum: 1,
  optimism: 2,
  bsc: 3,
  polygon: 2,
  avalanche: 2
};

export const DEFAULT_TRENDING_CACHE_MS = 45_000;
export const DEFAULT_TRENDING_MAX_POOLS = 8;
export const DEFAULT_RAILWAY_TRENDING_LOOKBACK_SECONDS = 90 * 60;
export const DEFAULT_MARKET_DETAIL_CACHE_MS = 8_000;
export const DEFAULT_MARKET_DETAIL_LOOKBACK_BLOCKS = 3_600;
export const DEFAULT_NEW_PAIRS_CACHE_MS = 30_000;
export const DEFAULT_NEW_PAIRS_LOOKBACK_BLOCKS = 7_200;
export const DEFAULT_NEW_PAIRS_MAX_POOLS = 24;
export const MAX_TRENDING_LOOKBACK_BLOCKS = 50_000;
export const MAX_TRENDING_POOLS = 32;
export const MAX_MARKET_DETAIL_LOOKBACK_BLOCKS = 20_000;
export const MAX_NEW_PAIRS_LOOKBACK_BLOCKS = 50_000;
export const MAX_NEW_PAIRS_POOLS = 50;
export const DEFAULT_MARKET_BUILD_TIMEOUT_MS = 25_000;

export function ensureEvmMarketChain(chain: ChainSlug): void {
  if (getChain(chain).kind !== "evm") {
    throw new Error(`The market board uses EVM swap logs; ${chain} uses a separate raw preview path.`);
  }
}

export function blockSecondsFor(chain: ChainSlug): number {
  return BLOCK_SECONDS_BY_CHAIN[chain] ?? 2;
}

export function defaultTrendingLookbackBlocks(chain: ChainSlug): number {
  const profile = (process.env.MARKET_LIVE_PROFILE ?? "railway-free").toLowerCase();
  const lookbackSeconds = profile === "full" || profile === "full-24h" ? 24 * 60 * 60 : DEFAULT_RAILWAY_TRENDING_LOOKBACK_SECONDS;
  return Math.ceil(lookbackSeconds / blockSecondsFor(chain));
}

export function boundedNumberForChain(chain: ChainSlug, name: string, fallback: number, min: number, max: number): number {
  const chainName = `${chain.toUpperCase().replace("-", "_")}_${name}`;
  const raw = process.env[chainName] ?? process.env[name];
  if (!raw || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

export function boundedNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}
