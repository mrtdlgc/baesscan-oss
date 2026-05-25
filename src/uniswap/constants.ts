import type { Address } from "../types";

export const BASE_CHAIN_ID = 8453;
export const BASE_EXPLORER = "https://base.blockscout.com";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

// Official Uniswap v4 PoolManager deployment on Base mainnet.
export const BASE_POOL_MANAGER = "0x498581ff718922c3f8e6a244956af099b2652b2b" as Address;
// Official Uniswap v3 and v2 factory deployments on Base mainnet.
export const BASE_V3_FACTORY = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD" as Address;
export const BASE_V2_FACTORY = "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6" as Address;

// PancakeSwap deployments on Base mainnet.
export const BASE_PANCAKESWAP_V3_FACTORY = "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865" as Address;
export const BASE_PANCAKESWAP_V2_FACTORY = "0x02a84c1b3BBD7401a5f7fa98a384EBC70bB5749E" as Address;

// Aerodrome deployments on Base mainnet.
export const BASE_AERODROME_POOL_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da" as Address;

// Hydrex Integral deployment on Base mainnet.
export const BASE_HYDREX_FACTORY = "0x36077D39cdC65E1e3FB65810430E5b2c4D5fA29E" as Address;

// Common Base quote tokens.
export const BASE_WETH = "0x4200000000000000000000000000000000000006" as Address;
export const BASE_FLETH = "0x000000000D564D5be76f7f0d28fE52605afC7Cf8" as Address;
export const BASE_VIRTUAL = "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b" as Address;
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
export const BASE_USDBC = "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA" as Address;
export const BASE_USDT = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2" as Address;

// Current Clanker v4/v4.1 hook addresses on Base from Clanker docs.
export const BASE_CLANKER_HOOKS = new Set<string>([
  "0xd60D6B218116cFd801E28F78d011a203D2b068Cc".toLowerCase(), // ClankerHookDynamicFeeV2
  "0xb429d62f8f3bFFb98CdB9569533eA23bF0Ba28CC".toLowerCase(), // ClankerHookStaticFeeV2
  "0x34a45c6B61876d739400Bd71228CbcbD4F53E8cC".toLowerCase(), // ClankerHookDynamicFee
  "0xDd5EeaFf7BD481AD55Db083062b13a3cdf0A68CC".toLowerCase()  // ClankerHookStaticFee
]);

// Flaunch v4 PositionManager hook family on Base.
export const BASE_FLAUNCH_HOOKS = new Set<string>([
  "0x51bba15255406cfe7099a42183302640ba7dafdc".toLowerCase(), // Position Manager V1
  "0xf785bb58059fab6fb19bdda2cb9078d9e546efdc".toLowerCase(), // Position Manager V2
  "0xb903b0ab7bcee8f5e4d8c9b10a71aac7135d6fdc".toLowerCase(), // Position Manager V3
  "0x23321f11a6d44fd1ab790044fdfde5758c902fdc".toLowerCase(), // Position Manager V4
  "0x8dc3b85e1dc1c846ebf3971179a751896842e5dc".toLowerCase(), // Any Position Manager V1
  "0x9e433f32bb5481a9ca7dff5b3af74a7ed041a888".toLowerCase(), // flETHHooks
  "0xdbac778f974681e013cf8716f6b77e2f9d73e0cc".toLowerCase()  // flayHooks
]);

// Bankr token-launching API reports Doppler v4 launches; recent Base launch
// PoolManager Initialize logs resolve to this verified DopplerHookInitializer.
export const BASE_BANKR_HOOKS = new Set<string>([
  "0xBDF938149ac6a781F94FAa0ed45E6A0e984c6544".toLowerCase() // DopplerHookInitializer
]);

export const BASE_TOKENS_FUN_HOOKS = new Set<string>([
  "0x1f6C7744a0B0393db8E96D3aaA023146828028cC".toLowerCase(), // HookStaticFeeV2
  "0x73E74c090446ad7c9745EBa3c26F3E1a9680E8CC".toLowerCase(), // HookStaticFee
  "0x7deBE6943ACEFE85c4EE81Aadd736466e07528cC".toLowerCase(), // HookDynamicFeeV2
  "0xab29E4cb49980a6aC152515bb69470e0dEDC68cC".toLowerCase()  // HookDynamicFee
]);

export const BASE_JANPU_HOOKS = new Set<string>([
  "0x49659b737c672324a221623f8d3f29e5687f28cc".toLowerCase(), // JanpuHookDynamicFeeV2
  "0xb67f057bfbcb27ff9908dbf2d3d9dbd89d29e8cc".toLowerCase()  // JanpuHookStaticFeeV2
]);

export const BASE_LAYERMEME_HOOKS = new Set<string>([
  "0x440f4148e323de5d8196582628971bfff802e8cc".toLowerCase(), // Dynamic Fee Hook v2
  "0x5fef75737d2c547c9ea11e750b207239954368cc".toLowerCase()  // Static Fee Hook v2
]);

export const BASE_CLAWNCH_HOOKS = new Set<string>([
  "0x2F9354Bbb0eDEf5c2a5C4b78D0C59D73412A28CC".toLowerCase() // ClawnchHookStaticFeeV2
]);

export const BASE_SEEDIFY_HOOKS = new Set<string>([
  "0x2Fd54Aaf84023EDA60Bd65eDb5914c1a306850cc".toLowerCase() // Seedify Fee Hook
]);

export const BASE_LAUNCHPAD_HOOKS = new Set<string>([
  ...BASE_CLANKER_HOOKS,
  ...BASE_FLAUNCH_HOOKS,
  ...BASE_BANKR_HOOKS,
  ...BASE_TOKENS_FUN_HOOKS,
  ...BASE_JANPU_HOOKS,
  ...BASE_LAYERMEME_HOOKS,
  ...BASE_CLAWNCH_HOOKS,
  ...BASE_SEEDIFY_HOOKS
]);

export const QUOTE_ALIASES: Record<string, Address> = {
  eth: ZERO_ADDRESS,
  native: ZERO_ADDRESS,
  weth: BASE_WETH,
  fleth: BASE_FLETH,
  virtual: BASE_VIRTUAL,
  usdc: BASE_USDC,
  usdt: BASE_USDT,
  usdbc: BASE_USDBC
};

export const USD_LIKE_QUOTES = new Set<string>([
  BASE_USDC.toLowerCase(),
  BASE_USDT.toLowerCase(),
  BASE_USDBC.toLowerCase()
]);

export const ETH_LIKE_QUOTES = new Set<string>([
  ZERO_ADDRESS.toLowerCase(),
  BASE_WETH.toLowerCase(),
  BASE_FLETH.toLowerCase()
]);

export const CANONICAL_PAIR_TOKENS = new Set<string>([
  ZERO_ADDRESS.toLowerCase(),
  BASE_WETH.toLowerCase(),
  BASE_FLETH.toLowerCase(),
  BASE_VIRTUAL.toLowerCase(),
  BASE_USDC.toLowerCase(),
  BASE_USDT.toLowerCase(),
  BASE_USDBC.toLowerCase()
]);
