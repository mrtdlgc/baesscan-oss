import { Contract } from "ethers";
import type { JsonRpcProvider } from "ethers";
import type { ChainSlug, PoolDex, PoolProtocol } from "../types";
import { CHAINS, getChain } from "../chains/registry";
import { AbortableJsonRpcProvider, createAbortableJsonRpcProvider } from "../services/abortableRpcProvider";
import { PANCAKE_V3_SWAP_TOPIC, V2_PAIR_IFACE, V2_SWAP_TOPIC, V3_POOL_IFACE, V3_SWAP_TOPIC, SWAP_TOPIC } from "../uniswap/abis";
import { AERODROME_SWAP_TOPIC } from "../dex/aerodrome";
import { BALANCER_POOL_ABI, BALANCER_SWAP_TOPIC, BALANCER_V2_VAULT, BALANCER_VAULT_ABI } from "../dex/balancer";
import { CURVE_POOL_ABI, CURVE_TOKEN_EXCHANGE_TOPICS } from "../dex/curve";
import { HYDREX_SWAP_TOPIC } from "../dex/hydrex";
import { LB_PAIR_ABI, LB_SWAP_TOPIC } from "../dex/liquidityBook";

type EvmCase = {
  kind: "evm";
  chain: Exclude<ChainSlug, "solana">;
  dex: PoolDex;
  protocol: Exclude<PoolProtocol, "solana">;
  label: string;
  pool: string;
  factory?: string;
  manager?: string;
  lookback?: number;
  logChunk?: number;
};

type SolanaCase = {
  kind: "solana";
  chain: "solana";
  dex: PoolDex;
  label: string;
  account: string;
  owner: string;
};

type LiveCase = EvmCase | SolanaCase;

const DEFAULT_LOOKBACK = Number(process.env.LIVE_SMOKE_LOOKBACK_BLOCKS ?? 50_000);
const CASE_TIMEOUT_MS = Number(process.env.LIVE_SMOKE_CASE_TIMEOUT_MS ?? 20_000);
const GLOBAL_TIMEOUT_MS = Number(process.env.LIVE_SMOKE_GLOBAL_TIMEOUT_MS ?? 120_000);
const CONCURRENCY = Number(process.env.LIVE_SMOKE_CONCURRENCY ?? 3);
const LOG_CHUNK = Number(process.env.LIVE_SMOKE_LOG_CHUNK ?? 500);
const MIN_LOG_CHUNK = Number(process.env.LIVE_SMOKE_MIN_LOG_CHUNK ?? 5);
const HEAD_LAG_BLOCKS = Number(process.env.LIVE_SMOKE_HEAD_LAG_BLOCKS ?? 8);
const CASE_FILTER = process.env.LIVE_SMOKE_FILTER?.toLowerCase().trim();
const HIDDEN_DEFAULT_CHAINS = new Set<ChainSlug>(["solana"]);

const RPC_FALLBACKS: Partial<Record<ChainSlug, string[]>> = {
  ethereum: ["https://ethereum.publicnode.com"],
  bsc: ["https://bsc.publicnode.com", "https://bsc-dataseed.binance.org"],
  base: ["https://base.drpc.org", "https://base.gateway.tenderly.co", "https://mainnet.base.org", "https://developer-access-mainnet.base.org"],
  arbitrum: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one.publicnode.com"],
  optimism: ["https://mainnet.optimism.io", "https://optimism.publicnode.com"],
  monad: ["https://rpc1.monad.xyz", "https://rpc3.monad.xyz", "https://rpc.monad.xyz", "https://monad-mainnet.drpc.org"],
  megaeth: ["https://mainnet.megaeth.com/rpc"],
  polygon: ["https://polygon.drpc.org", "https://polygon-bor-rpc.publicnode.com", "https://polygon.api.onfinality.io/public"],
  avalanche: ["https://api.avax.network/ext/bc/C/rpc", "https://avalanche-c-chain-rpc.publicnode.com", "https://1rpc.io/avax/c"],
  solana: ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"]
};

const CASES: LiveCase[] = [
  evm("ethereum", "uniswap", "v4", "Uniswap v4 ETH/USDC", "0x00b9edc1583bf6ef09ff3a09f6c23ecb57fd7d0bb75625717ec81eed181e22d7"),
  evm("ethereum", "uniswap", "v3", "Uniswap v3 WETH/USDC", "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640", "0x1F98431c8aD98523631AE4a59f267346ea31F984"),
  evm("ethereum", "uniswap", "v2", "Uniswap v2 WETH/USDC", "0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc", "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f"),
  evm("ethereum", "pancakeswap", "v3", "PancakeSwap v3 WETH/USDT", "0xACDB27B266142223e1e676841C1e809255Fc6D07", "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865"),
  evm("ethereum", "pancakeswap", "v2", "PancakeSwap v2 WETH/USDC", "0x2E8135bE71230c6B1B4045696d41C09Db0414226", "0x1097053Fd2ea711dad45caCcc45EfF7548fCB362"),
  evm("ethereum", "sushiswap", "v2", "SushiSwap v2 WETH/USDC", "0x397FF1542f962076d0BFE58eA045FfA2d347ACa0", "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac"),
  evm("ethereum", "curve", "curve", "Curve sUSDS/USDT", "0x00836fe54625Be242BcFA286207795405ca4fD10"),
  evm("ethereum", "balancer", "balancer", "Balancer DAI/WETH", "0x0b09dea16768f0799065c475be02919503cb2a35"),

  evm("bsc", "pancakeswap", "v3", "PancakeSwap v3 USDT/WBNB", "0x172fcD41E0913e95784454622d1c3724f546f849", "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865"),
  evm("bsc", "pancakeswap", "v2", "PancakeSwap v2 USDT/WBNB", "0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE", "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73"),
  evm("bsc", "uniswap", "v4", "Uniswap v4 USDT/USDC", "0x8321c1f53959b14ece4b5400e60aeac59e7b6b8bac446f2f0a89b9e84e68a08a"),
  evm("bsc", "uniswap", "v3", "Uniswap v3 USDT/WBNB", "0x47a90a2D92A8367A91EfA1906bFc8c1E05BF10c4", "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7"),
  evm("bsc", "uniswap", "v2", "Uniswap v2 SFB/USDT", "0x26146E9d74A07D93Da20dC1df6245f221e93EF3a", "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6"),
  evm("bsc", "thena", "algebra", "THENA V3 THE/WBNB", "0x51Bd5e6d3da9064D59BcaA5A76776560aB42cEb8", "0x306F06C147f064A010530292A1EB6737c3e378e4"),
  evm("bsc", "thena", "v2", "THENA v2 THE/WBNB", "0x63Db6ba9E512186C2FAaDaCEF342FB4A40dc577c", undefined, 50_000, 5_000),
  evm("bsc", "biswap", "v2", "Biswap BSW/WBNB", "0x46492B26639Df0cda9b2769429845cb991591E0A", "0x858E3312ed3A876947EA49d572A7C42DE08af7EE"),
  evm("bsc", "apeswap", "v2", "ApeSwap BANANA/WBNB", "0xF65C1C0478eFDe3c19b49EcBE7ACc57BB6B1D713", "0x0841BD0B734E4F5853f0dD8d7Ea041c241fb0Da6", 250_000, 50_000),

  evm("base", "uniswap", "v4", "Uniswap v4 OTHQ/USDC", "0x0fbcaaf346e1b812a63b2cf196841ed7664ae1d4fa3e9fd93b29266801c15f44"),
  evm("base", "uniswap", "v3", "Uniswap v3 WETH/USDC", "0xb4CB800910B228Ed3d0834cF79D697127BBB00e5", "0x33128a8fC17869897dcE68Ed026d694621f6FDfD"),
  evm("base", "uniswap", "v2", "Uniswap v2 WETH/USDC", "0x88A43bbDF9D098eEC7bCEda4e2494615dfD9bB9C", "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6"),
  evm("base", "pancakeswap", "v3", "PancakeSwap v3 WETH/USDC", "0x72ab388E2E2F6FaceF59E3C3FA2C4E29011c2D38", "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865"),
  evm("base", "pancakeswap", "v2", "PancakeSwap v2 WETH/USDC", "0x79474223AEdD0339780baCcE75aBDa0BE84dcBF9", "0x02a84c1b3BBD7401a5f7fa98a384EBC70bB5749E"),
  evm("base", "sushiswap", "v2", "SushiSwap BRETT/WETH", "0x404E927b203375779a6aBD52A2049cE0ADf6609B", "0x71524B4f93c58fcbF659783284E38825f0622859", 250_000, 50_000),
  evm("base", "aerodrome", "v3", "Aerodrome Slipstream WETH/USDC", "0xb2cc224c1c9Fee385f8ad6a55b4d94e92359DC59", "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A"),
  evm("base", "hydrex", "algebra", "Hydrex Integral WETH/USDC", "0x82Dbe18346A8656dBB5E76f74bf3aE279cc16b29", "0x36077D39cdC65E1e3FB65810430E5b2c4D5fA29E"),
  evm("base", "curve", "curve", "Curve axlUSDC/USDC/crvUSD", "0xF6C5F01C7F3148891ad0e19DF78743d31E390D1f"),
  evm("base", "balancer", "balancer", "Balancer WETH/USDC", "0x47D0868e1e4655C9E95c1520B41D72d4E6c7049F"),

  evm("arbitrum", "uniswap", "v4", "Uniswap v4 ETH/USDC", "0x864abca0a6202dba5b8868772308da953ff125b0f95015adbf89aaf579e903a8"),
  evm("arbitrum", "uniswap", "v3", "Uniswap v3 USDC/WETH", "0xC6962004f452bE9203591991D15f6b388e09E8D0", "0x1F98431c8aD98523631AE4a59f267346ea31F984"),
  evm("arbitrum", "uniswap", "v2", "Uniswap v2 WETH/USDT", "0xD04BC65744306a5C149414dD3Cd5c984D9d3470D", "0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9"),
  evm("arbitrum", "pancakeswap", "v3", "PancakeSwap v3 USDC/WETH", "0x7fCDC35463E3770c2fB992716Cd070B63540b947", "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865"),
  evm("arbitrum", "pancakeswap", "v2", "PancakeSwap v2 WETH/USDC", "0xA59bd260F9707EA44551c510F714cCD482Ec75D8", "0x02a84c1b3BBD7401a5f7fa98a384EBC70bB5749E", 250_000, 100_000),
  evm("arbitrum", "camelot", "algebra", "Camelot V3 USDC/WETH", "0xB1026B8e7276e7ac75410F1Fcbbe21796e8f7526", "0x1a3c9B1d2F0529D97f2afC5136Cc23e58f1FD35B"),
  evm("arbitrum", "camelot", "v2", "Camelot v2 PENDLE/WETH", "0xBfcA4230115De8341F3A3d5e8845fFb3337b2Be3", "0x6EcCab422D763aC031210895C81787E87B43A652"),
  evm("arbitrum", "sushiswap", "v2", "SushiSwap ADoge/WETH", "0x11EECDBD8f2D670016D061E4c064072E6158Ede2", "0xc35DADB65012eC5796536bD9864eD8773aBc74C4", 250_000, 50_000),
  evm("arbitrum", "curve", "curve", "Curve USDC/USDT", "0x7f90122bf0700f9e7e1f688fe926940e8839f353"),
  evm("arbitrum", "balancer", "balancer", "Balancer WETH/USDC", "0xaf0561b26ac83418fc889590b4d7c28d73de6718", undefined, 50_000, 50_000),

  evm("optimism", "uniswap", "v4", "Uniswap v4 ETH/USDC", "0x51bf4cc5b8d9f7f759e41f572fe2a25bc2aeb42432bf12544a350595e5c8bb43"),
  evm("optimism", "uniswap", "v3", "Uniswap v3 USDC/WETH", "0xeb0D8D9E19B749EFb20c67D71EE50b46dfE5755f", "0x1F98431c8aD98523631AE4a59f267346ea31F984"),
  evm("optimism", "uniswap", "v2", "Uniswap v2 WETH/USDC", "0x4C43646304492A925E335f2b6d840C1489f17815", "0x0c3c1c532F1e39EdF36BE9Fe0bE1410313E074Bf"),
  evm("optimism", "velodrome", "v3", "Velodrome Slipstream USDC/WETH", "0x478946bCD4a5a22b316470F5486fAFB928C0bA25", "0xCc0bDDB707055e04e497aB22a59c2aF4391cd12F"),
  evm("optimism", "velodrome", "solidly", "Velodrome v2 VELO/USDC", "0x8134A2FdC127549480865Fb8e5A9E8A8a95a54C5", "0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a"),
  evm("optimism", "curve", "curve", "Curve crvUSD/USDC", "0x03771e24B7C9172d163Bf447490B142a15be3485"),

  evm("monad", "uniswap", "v4", "Uniswap v4 MON/USDC", "0x18a9fc874581f3ba12b7898f80a683c66fd5877fd74b26a85ba9a3a79c549954"),
  evm("monad", "uniswap", "v3", "Uniswap v3 MON/USDC", "0x659bD0BC4167BA25c62E05656F78043E7eD4a9da", "0x204faca1764b154221e35c0d20abb3c525710498"),
  evm("monad", "pancakeswap", "v3", "PancakeSwap v3 USDC/WMON", "0x63e48b725540a3db24aCf6682a29F877808C53F2", "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865"),
  evm("monad", "traderjoe", "lb", "Trader Joe LB MON/USDC", "0x5AFD3EC861f6104af26e8755aBcc1f876de77620", "0xb43120c4745967fa9b93E79C149E66B0f2D6Fe0c"),

  evm("megaeth", "kumbaya", "v3", "Kumbaya USDm/WETH", "0x587F6eeAFC7AD567e96ED1B62775Fa6402164B22", "0x68b34591f662508076927803c567Cc8006988a09"),
  evm("megaeth", "prism", "v3", "Prism USDm/WETH", "0xC2fAc0b5b6C075819e654BcfBbBcda2838609d32", "0x1adb8f973373505bB206e0E5D87af8FB1f5514Ef"),
  evm("megaeth", "noxa", "v3", "Noxa USDm/WETH", "0x4B183a49963F98B3C8fFb4a7e9248DeFC278Cd95", "0x1201EB5081eabc99b23DD952C1BFA5ea090d8779", 250_000, 50_000),

  evm("polygon", "uniswap", "v3", "Uniswap v3 USDC/WPOL", "0xB6e57ed85c4c9dbfEF2a68711e9d6f36c56e0FcB", "0x1F98431c8aD98523631AE4a59f267346ea31F984"),
  evm("polygon", "quickswap", "algebra", "QuickSwap Algebra USDC/WPOL", "0x6669B4706cC152F359e947BCa68E263A87c52634", "0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28", 250_000, 5_000),
  evm("polygon", "sushiswap", "v2", "SushiSwap WETH/WPOL", "0xc4e595acDD7d12feC385E5dA5D43160e8A0bAC0E", "0xc35DADB65012eC5796536bD9864eD8773aBc74C4", 5_000, 1_000),
  evm("polygon", "curve", "curve", "Curve CRV/crvUSDBTCETH", "0xc7c939a474cb10eb837894d1ed1a77c61b268fa7"),
  evm("polygon", "balancer", "balancer", "Balancer USDC/TEL", "0x3bd8A254163F8328eFcc4f8C36da566753462433"),

  evm("avalanche", "pharaoh", "v3", "Pharaoh WAVAX/USDC", "0xf01449C0bA930B6e2CaCA3DEF3CCBd7a3E589534", "0xAE6E5c62328ade73ceefD42228528b70c8157D0d"),
  evm("avalanche", "blackhole", "v3", "Blackhole WAVAX/USDC", "0xA02Ec3Ba8d17887567672b2CDCAF525534636Ea0", "0x512eb749541B7cf294be882D636218c84a5e9E5F"),
  evm("avalanche", "uniswap", "v3", "Uniswap v3 WAVAX/USDC", "0xfAe3f424a0a47706811521E3ee268f00cFb5c45E", "0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD"),
  evm("avalanche", "traderjoe", "lb", "Trader Joe LB WAVAX/USDC", "0x864d4e5Ee7318e97483DB7EB0912E09F161516EA", "0xb43120c4745967fa9b93E79C149E66B0f2D6Fe0c"),
  evm("avalanche", "traderjoe", "v2", "Trader Joe v1 JOE/WAVAX", "0x454E67025631C065d3cFAD6d71E6892f74487a15", "0x9Ad6C38BE94206cA50bb0d90783181662f0Cfa10"),
  evm("avalanche", "pangolin", "v2", "Pangolin PNG/WAVAX", "0xd7538cABBf8605BdE1f4901B47B8D42c61DE0367", "0xefa94DE7a4656D787667C749f7E1223D71E9FD88"),
  evm("avalanche", "sushiswap", "v2", "SushiSwap WAVAX/USDC", "0x6539bF462F73fF9497054bA261C195DA8639ED61", "0xc35DADB65012eC5796536bD9864eD8773aBc74C4", 250_000, 50_000),
  evm("avalanche", "curve", "curve", "Curve USDC.e/USDC", "0x3a43a5851A3e3e0e25A3C1089670269786BE1577"),
  evm("avalanche", "balancer", "balancer", "Balancer USDt/WAVAX", "0x8e600715dB997E1b3bBD884841A840095947cFbc"),

  sol("pumpfun", "Pump.fun AMM migrated pool", "GseMAnNDvntR5uFePZ51yZBXzNSn7GdFPkfHwfr6d77J", "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"),
  sol("raydium", "Raydium SGB/SOL", "GvVMAy6Fw3BEyrNoUa3YYzKhffh7dPu3XeWQKB7vBShg", "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"),
  sol("orca", "Orca SOL/USDC", "83v8iPyZihDEjDdY8RdZddyZNyUtXngz69Lgo9Kt5d6d", "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"),
  sol("meteora", "Meteora active pool", "CccuF4DAxYDffmmgRVzBAPX48SEP5FYjAMoGzAr1jzp4", "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"),
  sol("pancakeswap", "PancakeSwap SOL/USDC", "DJNtGuBGEQiUCWE8F981M2C3ZghZt2XLD8f2sQdZ6rsZ", "HpNfyc2Saw7RKkQd8nEL4khUcuPhQ7WwY1B2qjx8jxFq")
];

const ACTIVE_CASES = CASE_FILTER
  ? CASES.filter(caseMatchesFilter)
  : CASES.filter((item) => !HIDDEN_DEFAULT_CHAINS.has(item.chain));

function evm(
  chain: Exclude<ChainSlug, "solana">,
  dex: PoolDex,
  protocol: Exclude<PoolProtocol, "solana">,
  label: string,
  pool: string,
  factory?: string,
  lookback?: number,
  logChunk?: number
): EvmCase {
  const deployment = getChain(chain).dexes.find((item) => item.dex === dex);
  return {
    kind: "evm",
    chain,
    dex,
    protocol,
    label,
    pool: pool.toLowerCase(),
    factory: factory?.toLowerCase(),
    manager: typeof deployment?.poolManagerAddress === "string" ? deployment.poolManagerAddress.toLowerCase() : undefined,
    lookback,
    logChunk
  };
}

function sol(dex: PoolDex, label: string, account: string, owner: string): SolanaCase {
  return { kind: "solana", chain: "solana", dex, label, account, owner };
}

interface CaseResult {
  ok: boolean;
  id: string;
  chain: ChainSlug;
  dex: PoolDex;
  protocol: string;
  label: string;
  elapsedMs: number;
  details?: Record<string, unknown>;
  error?: string;
}

let completed = 0;
const startedAt = Date.now();
if (CASE_FILTER && ACTIVE_CASES.length === 0) {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ ok: false, error: `no live smoke cases match filter: ${CASE_FILTER}` }, null, 2));
  process.exit(1);
}
const watchdog = setTimeout(() => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ ok: false, error: "live smoke global timeout", completed, total: ACTIVE_CASES.length }, null, 2));
  process.exit(1);
}, GLOBAL_TIMEOUT_MS);

const heartbeat = setInterval(() => {
  // eslint-disable-next-line no-console
  console.error(`[live-smoke] checked ${completed}/${ACTIVE_CASES.length} after ${Math.round((Date.now() - startedAt) / 1000)}s`);
}, Math.min(120_000, GLOBAL_TIMEOUT_MS));

runPool(ACTIVE_CASES, CONCURRENCY)
  .then((results) => {
    clearTimeout(watchdog);
    clearInterval(heartbeat);
    const failures = results.filter((result) => !result.ok);
    const byChain = results.reduce<Record<string, { ok: number; fail: number }>>((acc, result) => {
      acc[result.chain] ??= { ok: 0, fail: 0 };
      if (result.ok) acc[result.chain]!.ok++;
      else acc[result.chain]!.fail++;
      return acc;
    }, {});
    const payload = {
      ok: failures.length === 0,
      elapsedMs: Date.now() - startedAt,
      total: results.length,
      passed: results.length - failures.length,
      failed: failures.length,
      byChain,
      results
    };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(payload, null, 2));
    if (failures.length > 0) process.exit(1);
  })
  .catch((error) => {
    clearTimeout(watchdog);
    clearInterval(heartbeat);
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });

async function runPool(cases: LiveCase[], concurrency: number): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (cursor < cases.length) {
      const index = cursor++;
      const item = cases[index]!;
      const result = await runCaseWithTimeout(item);
      completed++;
      results[index] = result;
      // eslint-disable-next-line no-console
      console.error(`${result.ok ? "PASS" : "FAIL"} ${result.id} ${result.elapsedMs}ms${result.error ? ` - ${result.error}` : ""}`);
    }
  });
  await Promise.all(workers);
  return results;
}

async function runCaseWithTimeout(item: LiveCase): Promise<CaseResult> {
  const started = Date.now();
  const id = `${item.chain}:${item.dex}:${item.kind === "evm" ? item.protocol : "solana"}:${item.label}`;
  const controller = new AbortController();
  const providers = new Set<AbortableJsonRpcProvider>();
  try {
    const task = item.kind === "evm" ? runEvmCase(item, (provider) => providers.add(provider)) : runSolanaCase(item, controller.signal);
    const details = await withTimeout(task, CASE_TIMEOUT_MS, id, () => {
      controller.abort();
      let cancelled = 0;
      for (const provider of providers) cancelled += provider.cancelInflight();
      return cancelled;
    });
    return { ok: true, id, chain: item.chain, dex: item.dex, protocol: item.kind === "evm" ? item.protocol : "solana", label: item.label, elapsedMs: Date.now() - started, details };
  } catch (error) {
    return { ok: false, id, chain: item.chain, dex: item.dex, protocol: item.kind === "evm" ? item.protocol : "solana", label: item.label, elapsedMs: Date.now() - started, error: (error as Error).message };
  }
}

async function runEvmCase(item: EvmCase, onProvider?: (provider: AbortableJsonRpcProvider) => void): Promise<Record<string, unknown>> {
  let lastError: unknown;
  const providers = providersFor(item.chain, onProvider);
  try {
    for (const provider of providers) {
      try {
        return await runEvmCaseWithProvider(item, provider);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`no working RPC for ${item.chain}`);
  } finally {
    for (const provider of providers) provider.destroy();
  }
}

async function runEvmCaseWithProvider(item: EvmCase, provider: JsonRpcProvider): Promise<Record<string, unknown>> {
  const chain = getChain(item.chain);
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== chain.chainId) {
    throw new Error(`RPC chain id mismatch: expected ${chain.chainId}, got ${network.chainId}`);
  }
  if (item.protocol === "curve") {
    return runCurveCase(provider, item);
  }
  if (item.protocol === "balancer") {
    return runBalancerCase(provider, item);
  }
  if (item.protocol === "v4") {
    const manager = item.manager;
    if (!manager) throw new Error("missing v4 PoolManager");
    const code = await provider.getCode(manager);
    if (code === "0x") throw new Error(`PoolManager has no code at ${manager}`);
    const logs = await recentLogs(provider, { address: manager, topics: [SWAP_TOPIC, item.pool.toLowerCase()] }, item.lookback, item.logChunk);
    if (logs.length === 0) throw new Error("no recent v4 swap logs found");
    return { block: await provider.getBlockNumber(), manager, recentSwaps: logs.length, lastSwap: logs.at(-1)?.transactionHash };
  }
  if (item.protocol === "lb") {
    return runLiquidityBookCase(provider, item);
  }

  const code = await provider.getCode(item.pool);
  if (code === "0x") throw new Error(`pool has no code at ${item.pool}`);
  const isV2Like = item.protocol === "v2" || item.protocol === "solidly";
  const iface = isV2Like ? V2_PAIR_IFACE : V3_POOL_IFACE;
  const contract = new Contract(item.pool, iface, provider);
  const [token0, token1] = await Promise.all([
    contract.getFunction("token0")(),
    contract.getFunction("token1")()
  ]);
  let factory: string | undefined;
  if (item.factory) {
    factory = String(await contract.getFunction("factory")());
    if (factory.toLowerCase() !== item.factory.toLowerCase()) {
      throw new Error(`factory mismatch: expected ${item.factory}, got ${factory}`);
    }
  } else {
    try {
      factory = String(await contract.getFunction("factory")());
    } catch {
      // Some Solidly forks expose pool state but omit factory(); token/log validation is enough here.
    }
  }
  const topic = swapTopicFor(item, isV2Like);
  const logs = await recentLogs(provider, { address: item.pool, topics: [topic] }, item.lookback, item.logChunk);
  if (logs.length === 0) throw new Error("no recent swap logs found");
  return { block: await provider.getBlockNumber(), token0, token1, factory, recentSwaps: logs.length, lastSwap: logs.at(-1)?.transactionHash };
}

async function runLiquidityBookCase(provider: JsonRpcProvider, item: EvmCase): Promise<Record<string, unknown>> {
  const code = await provider.getCode(item.pool);
  if (code === "0x") throw new Error(`LB pair has no code at ${item.pool}`);
  const contract = new Contract(item.pool, LB_PAIR_ABI, provider);
  const [tokenX, tokenY, factory, binStep] = await Promise.all([
    contract.getFunction("getTokenX")(),
    contract.getFunction("getTokenY")(),
    contract.getFunction("getFactory")(),
    contract.getFunction("getBinStep")()
  ]);
  if (item.factory && String(factory).toLowerCase() !== item.factory.toLowerCase()) {
    throw new Error(`factory mismatch: expected ${item.factory}, got ${factory}`);
  }
  const logs = await recentLogs(provider, { address: item.pool, topics: [LB_SWAP_TOPIC] }, item.lookback, item.logChunk);
  if (logs.length === 0) throw new Error("no recent LB swap logs found");
  return {
    block: await provider.getBlockNumber(),
    tokenX,
    tokenY,
    factory,
    binStep: Number(binStep),
    recentSwaps: logs.length,
    lastSwap: logs.at(-1)?.transactionHash
  };
}

async function runCurveCase(provider: JsonRpcProvider, item: EvmCase): Promise<Record<string, unknown>> {
  const code = await provider.getCode(item.pool);
  if (code === "0x") throw new Error(`curve pool has no code at ${item.pool}`);
  const contract = new Contract(item.pool, CURVE_POOL_ABI, provider);
  const coins: string[] = [];
  for (let i = 0; i < 8; i++) {
    let coin: string | undefined;
    for (const signature of ["coins(uint256)", "coins(int128)"]) {
      try {
        coin = await contract.getFunction(signature)(i) as string;
        break;
      } catch {
        // Try the alternate Curve coins signature.
      }
    }
    if (!coin) break;
    coins.push(coin);
  }
  if (coins.length < 2) throw new Error("curve pool exposes fewer than two coins");
  const logs = await recentLogs(provider, { address: item.pool, topics: [CURVE_TOKEN_EXCHANGE_TOPICS] }, item.lookback, item.logChunk);
  if (logs.length === 0) throw new Error("no recent Curve TokenExchange logs found");
  return { block: await provider.getBlockNumber(), coins, recentSwaps: logs.length, lastSwap: logs.at(-1)?.transactionHash };
}

async function runBalancerCase(provider: JsonRpcProvider, item: EvmCase): Promise<Record<string, unknown>> {
  const code = await provider.getCode(item.pool);
  if (code === "0x") throw new Error(`balancer pool has no code at ${item.pool}`);
  const pool = new Contract(item.pool, BALANCER_POOL_ABI, provider);
  const poolId = String(await pool.getFunction("getPoolId")()).toLowerCase();
  const vaultAddress = String(await pool.getFunction("getVault")());
  if (vaultAddress.toLowerCase() !== BALANCER_V2_VAULT.toLowerCase()) {
    throw new Error(`unexpected Balancer vault ${vaultAddress}`);
  }
  const vault = new Contract(vaultAddress, BALANCER_VAULT_ABI, provider);
  const [tokens] = await vault.getFunction("getPoolTokens")(poolId) as [string[], bigint[], bigint];
  const visibleTokens = tokens.filter((token) => token.toLowerCase() !== item.pool.toLowerCase());
  if (visibleTokens.length < 2) throw new Error("balancer pool exposes fewer than two non-BPT tokens");
  const logs = await recentLogs(provider, { address: vaultAddress, topics: [BALANCER_SWAP_TOPIC, poolId] }, item.lookback, item.logChunk);
  if (logs.length === 0) throw new Error("no recent Balancer Vault Swap logs found");
  return { block: await provider.getBlockNumber(), poolId, vault: vaultAddress, tokens: visibleTokens, recentSwaps: logs.length, lastSwap: logs.at(-1)?.transactionHash };
}

function swapTopicFor(item: EvmCase, isV2Like: boolean): string {
  if (item.protocol === "solidly") return AERODROME_SWAP_TOPIC;
  if (isV2Like) return V2_SWAP_TOPIC;
  if (item.dex === "hydrex") return HYDREX_SWAP_TOPIC;
  if (item.dex === "pancakeswap" && item.protocol === "v3") return PANCAKE_V3_SWAP_TOPIC;
  return V3_SWAP_TOPIC;
}

function caseMatchesFilter(item: LiveCase): boolean {
  if (!CASE_FILTER) return true;
  const values = item.kind === "evm"
    ? [item.kind, item.chain, item.dex, item.protocol, item.label, item.pool, item.factory]
    : [item.kind, item.chain, item.dex, "solana", item.label, item.account, item.owner];
  return values.filter(Boolean).join(" ").toLowerCase().includes(CASE_FILTER);
}

async function runSolanaCase(item: SolanaCase, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const info = await solanaRpc("getAccountInfo", [item.account, { encoding: "jsonParsed" }], signal);
  const owner = info?.value?.owner;
  if (!owner) throw new Error("pool account not found");
  if (owner !== item.owner) throw new Error(`owner mismatch: expected ${item.owner}, got ${owner}`);
  const signatures = await solanaRpc("getSignaturesForAddress", [item.account, { limit: 5 }], signal);
  if (!Array.isArray(signatures) || signatures.length === 0) throw new Error("no recent signatures found");
  return { owner, recentSignatures: signatures.length, lastSignature: signatures[0]?.signature };
}

function providersFor(chain: ChainSlug, onProvider?: (provider: AbortableJsonRpcProvider) => void): AbortableJsonRpcProvider[] {
  const urls = [...readRpcUrls(chain), ...(RPC_FALLBACKS[chain] ?? [])].filter((url, index, all) => all.indexOf(url) === index);
  if (urls.length === 0) throw new Error(`no RPC URL configured for ${chain}`);
  const cfg = CHAINS[chain];
  const providers = urls.map((url) => createAbortableJsonRpcProvider(url, cfg.chainId ? { name: chain, chainId: cfg.chainId } : undefined, { staticNetwork: Boolean(cfg.chainId) }));
  for (const provider of providers) onProvider?.(provider);
  return providers;
}

function readRpcUrls(chain: ChainSlug): string[] {
  const cfg = CHAINS[chain];
  const multi = process.env[cfg.rpcEnv]?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  const single = process.env[cfg.rpcEnv.replace(/S$/, "")]?.trim();
  return multi.length ? multi : single ? [single] : [];
}

async function recentLogs(
  provider: JsonRpcProvider,
  filter: { address: string; topics: Array<string | string[] | null> },
  lookback = DEFAULT_LOOKBACK,
  logChunk = LOG_CHUNK
) {
  const latest = Math.max(0, (await provider.getBlockNumber()) - HEAD_LAG_BLOCKS);
  const from = Math.max(0, latest - lookback);
  const logs = [];
  let end = latest;
  let chunkSize = Math.max(MIN_LOG_CHUNK, logChunk);
  while (end >= from) {
    const start = Math.max(from, end - chunkSize + 1);
    try {
      const chunk = await provider.getLogs({ ...filter, fromBlock: start, toBlock: end });
      if (chunk.length > 0) {
        logs.push(...chunk);
        return logs;
      }
      end = start - 1;
      chunkSize = Math.max(MIN_LOG_CHUNK, logChunk);
    } catch (error) {
      if (isHeadLagError(error) && end > from) {
        end = Math.max(from, end - Math.max(1, HEAD_LAG_BLOCKS));
        continue;
      }
      if (isRangeLimitError(error) && chunkSize > MIN_LOG_CHUNK) {
        chunkSize = Math.max(MIN_LOG_CHUNK, Math.floor(chunkSize / 2));
        continue;
      }
      throw error;
    }
  }
  return logs;
}

async function solanaRpc(method: string, params: unknown[], signal?: AbortSignal) {
  const urls = [...readRpcUrls("solana"), ...(RPC_FALLBACKS.solana ?? [])].filter((url, index, all) => all.indexOf(url) === index);
  let lastError: unknown;
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal,
        body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params })
      });
      if (!response.ok) throw new Error(`Solana RPC HTTP ${response.status}`);
      const json = await response.json() as { result?: unknown; error?: { message?: string } };
      if (json.error) throw new Error(json.error.message ?? "Solana RPC error");
      return json.result as any;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Solana RPC error");
}

function isRangeLimitError(error: unknown): boolean {
  const message = String((error as { message?: unknown }).message ?? error).toLowerCase();
  return message.includes("range") || message.includes("limit") || message.includes("too many") || message.includes("more than");
}

function isHeadLagError(error: unknown): boolean {
  const message = String((error as { message?: unknown }).message ?? error).toLowerCase();
  return message.includes("beyond current head") || message.includes("after last accepted block");
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => number
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          const cancelled = onTimeout?.() ?? 0;
          const suffix = cancelled > 0 ? `; cancelled ${cancelled} inflight request${cancelled === 1 ? "" : "s"}` : "";
          reject(new Error(`case timeout after ${timeoutMs}ms: ${label}${suffix}`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
