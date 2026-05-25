import type { Address, ChainKind, ChainSlug, PoolDex, PoolProtocol } from "../types";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

export interface DexDeployment {
  dex: PoolDex;
  label: string;
  protocols: PoolProtocol[];
  poolManagerAddress?: Address | string;
  v3FactoryAddress?: Address;
  v2FactoryAddress?: Address;
  v2PoolAllowlist?: Address[];
  solidlyFactoryAddress?: Address;
  algebraFactoryAddress?: Address;
  lbFactoryAddress?: Address;
  balancerVaultAddress?: Address;
  programIds?: string[];
}

export interface ChainConfig {
  slug: ChainSlug;
  kind: ChainKind;
  name: string;
  chainId?: number;
  rpcEnv: string;
  nativeSymbol: string;
  wrappedNative?: Address | string;
  explorerBaseUrl?: string;
  geckoNetwork: string;
  dexes: DexDeployment[];
  quoteAliases: Record<string, Address | string>;
  usdLikeQuotes: string[];
  nativeLikeQuotes: string[];
  canonicalPairTokens: string[];
}

const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address;
const BASE_WETH = "0x4200000000000000000000000000000000000006" as Address;
const BASE_FLETH = "0x000000000D564D5be76f7f0d28fE52605afC7Cf8" as Address;
const BASE_VIRTUAL = "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b" as Address;
const BASE_EURC = "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42" as Address;
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" as Address;
const ARB_WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" as Address;
const MON_WMON = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A" as Address;
const MEGA_WETH = "0x4200000000000000000000000000000000000006" as Address;
const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270" as Address;
const WAVAX = "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7" as Address;
const BALANCER_V2_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8" as Address;
const LFJ_LB_FACTORY_V22 = "0xb43120c4745967fa9b93E79C149E66B0f2D6Fe0c" as Address;

export const CHAINS: Record<ChainSlug, ChainConfig> = {
  ethereum: evmChain({
    slug: "ethereum",
    name: "Ethereum",
    chainId: 1,
    rpcEnv: "ETHEREUM_RPC_URLS",
    nativeSymbol: "ETH",
    wrappedNative: WETH,
    explorerBaseUrl: "https://eth.blockscout.com",
    geckoNetwork: "eth",
    usdLikeQuotes: [
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      "0x6B175474E89094C44Da98b954EedeAC495271d0F"
    ],
    dexes: [
      {
        dex: "uniswap",
        label: "Uniswap",
        protocols: ["v4", "v3", "v2"],
        poolManagerAddress: "0x000000000004444c5dc75cB358380D2e3dE08A90",
        v3FactoryAddress: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
        v2FactoryAddress: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f"
      },
      {
        dex: "pancakeswap",
        label: "PancakeSwap",
        protocols: ["v3", "v2"],
        v3FactoryAddress: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
        v2FactoryAddress: "0x1097053Fd2ea711dad45caCcc45EfF7548fCB362"
      },
      {
        dex: "sushiswap",
        label: "SushiSwap",
        protocols: ["v2"],
        v2FactoryAddress: "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac"
      },
      {
        dex: "curve",
        label: "Curve",
        protocols: ["curve"]
      },
      {
        dex: "balancer",
        label: "Balancer",
        protocols: ["balancer"],
        balancerVaultAddress: BALANCER_V2_VAULT
      }
    ]
  }),
  bsc: evmChain({
    slug: "bsc",
    name: "BNB Smart Chain",
    chainId: 56,
    rpcEnv: "BSC_RPC_URLS",
    nativeSymbol: "BNB",
    wrappedNative: WBNB,
    explorerBaseUrl: "https://bscscan.com",
    geckoNetwork: "bsc",
    usdLikeQuotes: [
      "0x55d398326f99059fF775485246999027B3197955",
      "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
      "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56"
    ],
    dexes: [
      {
        dex: "pancakeswap",
        label: "PancakeSwap",
        protocols: ["v3", "v2"],
        v3FactoryAddress: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
        v2FactoryAddress: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73"
      },
      {
        dex: "uniswap",
        label: "Uniswap",
        protocols: ["v4", "v3", "v2"],
        poolManagerAddress: "0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF",
        v3FactoryAddress: "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7",
        v2FactoryAddress: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6"
      },
      {
        dex: "thena",
        label: "THENA",
        protocols: ["algebra", "v2"],
        algebraFactoryAddress: "0x306F06C147f064A010530292A1EB6737c3e378e4",
        v2PoolAllowlist: ["0x63Db6ba9E512186C2FAaDaCEF342FB4A40dc577c"]
      },
      {
        dex: "biswap",
        label: "Biswap",
        protocols: ["v2"],
        v2FactoryAddress: "0x858E3312ed3A876947EA49d572A7C42DE08af7EE"
      },
      {
        dex: "apeswap",
        label: "ApeSwap",
        protocols: ["v2"],
        v2FactoryAddress: "0x0841BD0B734E4F5853f0dD8d7Ea041c241fb0Da6"
      }
    ]
  }),
  base: evmChain({
    slug: "base",
    name: "Base",
    chainId: 8453,
    rpcEnv: "BASE_RPC_URLS",
    nativeSymbol: "ETH",
    wrappedNative: BASE_WETH,
    explorerBaseUrl: "https://base.blockscout.com",
    geckoNetwork: "base",
    extraNativeLikeQuotes: [BASE_FLETH],
    extraCanonicalPairTokens: [BASE_FLETH, BASE_VIRTUAL, BASE_EURC],
    extraQuoteAliases: {
      fleth: BASE_FLETH,
      virtual: BASE_VIRTUAL,
      eurc: BASE_EURC
    },
    usdLikeQuotes: [
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
      "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA"
    ],
    dexes: [
      {
        dex: "uniswap",
        label: "Uniswap",
        protocols: ["v4", "v3", "v2"],
        poolManagerAddress: "0x498581ff718922c3f8e6a244956af099b2652b2b",
        v3FactoryAddress: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
        v2FactoryAddress: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6"
      },
      {
        dex: "pancakeswap",
        label: "PancakeSwap",
        protocols: ["v3", "v2"],
        v3FactoryAddress: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
        v2FactoryAddress: "0x02a84c1b3BBD7401a5f7fa98a384EBC70bB5749E"
      },
      {
        dex: "sushiswap",
        label: "SushiSwap",
        protocols: ["v2"],
        v2FactoryAddress: "0x71524B4f93c58fcbF659783284E38825f0622859"
      },
      {
        dex: "aerodrome",
        label: "Aerodrome",
        protocols: ["v3", "solidly"],
        v3FactoryAddress: "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A",
        solidlyFactoryAddress: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da"
      },
      {
        dex: "hydrex",
        label: "Hydrex",
        protocols: ["algebra"],
        algebraFactoryAddress: "0x36077D39cdC65E1e3FB65810430E5b2c4D5fA29E"
      },
      {
        dex: "curve",
        label: "Curve",
        protocols: ["curve"]
      },
      {
        dex: "balancer",
        label: "Balancer",
        protocols: ["balancer"],
        balancerVaultAddress: BALANCER_V2_VAULT
      }
    ]
  }),
  arbitrum: evmChain({
    slug: "arbitrum",
    name: "Arbitrum One",
    chainId: 42161,
    rpcEnv: "ARBITRUM_RPC_URLS",
    nativeSymbol: "ETH",
    wrappedNative: ARB_WETH,
    explorerBaseUrl: "https://arbiscan.io",
    geckoNetwork: "arbitrum",
    usdLikeQuotes: [
      "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",
      "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9"
    ],
    dexes: [
      {
        dex: "uniswap",
        label: "Uniswap",
        protocols: ["v4", "v3", "v2"],
        poolManagerAddress: "0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32",
        v3FactoryAddress: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
        v2FactoryAddress: "0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9"
      },
      {
        dex: "pancakeswap",
        label: "PancakeSwap",
        protocols: ["v3", "v2"],
        v3FactoryAddress: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
        v2FactoryAddress: "0x02a84c1b3BBD7401a5f7fa98a384EBC70bB5749E"
      },
      {
        dex: "sushiswap",
        label: "SushiSwap",
        protocols: ["v2"],
        v2FactoryAddress: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4"
      },
      {
        dex: "camelot",
        label: "Camelot",
        protocols: ["algebra", "v2"],
        algebraFactoryAddress: "0x1a3c9B1d2F0529D97f2afC5136Cc23e58f1FD35B",
        v2FactoryAddress: "0x6EcCab422D763aC031210895C81787E87B43A652"
      },
      {
        dex: "curve",
        label: "Curve",
        protocols: ["curve"]
      },
      {
        dex: "balancer",
        label: "Balancer",
        protocols: ["balancer"],
        balancerVaultAddress: BALANCER_V2_VAULT
      }
    ]
  }),
  optimism: evmChain({
    slug: "optimism",
    name: "OP Mainnet",
    chainId: 10,
    rpcEnv: "OPTIMISM_RPC_URLS",
    nativeSymbol: "ETH",
    wrappedNative: BASE_WETH,
    explorerBaseUrl: "https://optimistic.etherscan.io",
    geckoNetwork: "optimistic-ethereum",
    usdLikeQuotes: [
      "0x0b2C639c533813f4Aa9D7837CAF62653d097Ff85",
      "0x7F5c764cBc14f9669B88837ca1490cCa17c31607",
      "0x94b008aDfcC2f2F3D99a06718B69e8A1876dDbAF"
    ],
    dexes: [
      {
        dex: "uniswap",
        label: "Uniswap",
        protocols: ["v4", "v3", "v2"],
        poolManagerAddress: "0x9a13F98Cb987694C9F086b1F5eB990EeA8264Ec3",
        v3FactoryAddress: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
        v2FactoryAddress: "0x0c3c1c532F1e39EdF36BE9Fe0bE1410313E074Bf"
      },
      {
        dex: "velodrome",
        label: "Velodrome",
        protocols: ["v3", "solidly"],
        v3FactoryAddress: "0xCc0bDDB707055e04e497aB22a59c2aF4391cd12F",
        solidlyFactoryAddress: "0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a"
      },
      {
        dex: "curve",
        label: "Curve",
        protocols: ["curve"]
      }
    ]
  }),
  monad: evmChain({
    slug: "monad",
    name: "Monad",
    chainId: 143,
    rpcEnv: "MONAD_RPC_URLS",
    nativeSymbol: "MON",
    wrappedNative: MON_WMON,
    explorerBaseUrl: "https://monadvision.com",
    geckoNetwork: "monad",
    usdLikeQuotes: [],
    dexes: [
      {
        dex: "uniswap",
        label: "Uniswap",
        protocols: ["v4", "v3", "v2"],
        poolManagerAddress: "0x188d586ddcf52439676ca21a244753fa19f9ea8e",
        v3FactoryAddress: "0x204faca1764b154221e35c0d20abb3c525710498",
        v2FactoryAddress: "0x182a927119D56008d921126764bF884221B10f59"
      },
      {
        dex: "pancakeswap",
        label: "PancakeSwap",
        protocols: ["v3"],
        v3FactoryAddress: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865"
      },
      {
        dex: "traderjoe",
        label: "Trader Joe",
        protocols: ["lb", "v2"],
        lbFactoryAddress: LFJ_LB_FACTORY_V22,
        v2FactoryAddress: "0xe32D45C2B1c17a0fE0De76f1ebFA7c44B7810034"
      }
    ]
  }),
  megaeth: evmChain({
    slug: "megaeth",
    name: "MegaETH",
    chainId: 4326,
    rpcEnv: "MEGAETH_RPC_URLS",
    nativeSymbol: "ETH",
    wrappedNative: MEGA_WETH,
    explorerBaseUrl: "https://www.megaexplorer.xyz",
    geckoNetwork: "megaeth",
    usdLikeQuotes: ["0xFAfDdbb3FC7688494971a79cc65DCa3EF82079E7"],
    dexes: [
      {
        dex: "kumbaya",
        label: "Kumbaya",
        protocols: ["v3"],
        v3FactoryAddress: "0x68b34591f662508076927803c567Cc8006988a09"
      },
      {
        dex: "prism",
        label: "Prism",
        protocols: ["v3"],
        v3FactoryAddress: "0x1adb8f973373505bB206e0E5D87af8FB1f5514Ef"
      },
      {
        dex: "noxa",
        label: "Noxa",
        protocols: ["v3"],
        v3FactoryAddress: "0x1201EB5081eabc99b23DD952C1BFA5ea090d8779"
      }
    ]
  }),
  polygon: evmChain({
    slug: "polygon",
    name: "Polygon PoS",
    chainId: 137,
    rpcEnv: "POLYGON_RPC_URLS",
    nativeSymbol: "MATIC",
    wrappedNative: WMATIC,
    explorerBaseUrl: "https://polygonscan.com",
    geckoNetwork: "polygon_pos",
    usdLikeQuotes: [
      "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
      "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
      "0xc2132D05D31c914a87C6611C10748AEb04B58e8F"
    ],
    dexes: [
      {
        dex: "uniswap",
        label: "Uniswap",
        protocols: ["v3"],
        v3FactoryAddress: "0x1F98431c8aD98523631AE4a59f267346ea31F984"
      },
      {
        dex: "quickswap",
        label: "QuickSwap",
        protocols: ["algebra", "v2"],
        algebraFactoryAddress: "0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28",
        v2FactoryAddress: "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32"
      },
      {
        dex: "sushiswap",
        label: "SushiSwap",
        protocols: ["v2"],
        v2FactoryAddress: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4"
      },
      {
        dex: "curve",
        label: "Curve",
        protocols: ["curve"]
      },
      {
        dex: "balancer",
        label: "Balancer",
        protocols: ["balancer"],
        balancerVaultAddress: BALANCER_V2_VAULT
      }
    ]
  }),
  avalanche: evmChain({
    slug: "avalanche",
    name: "Avalanche C-Chain",
    chainId: 43114,
    rpcEnv: "AVALANCHE_RPC_URLS",
    nativeSymbol: "AVAX",
    wrappedNative: WAVAX,
    explorerBaseUrl: "https://snowtrace.io",
    geckoNetwork: "avax",
    usdLikeQuotes: [
      "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
      "0x9702230A8Ea53601f5cD2dc00fDBc13d4F4a8c7",
      "0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664"
    ],
    dexes: [
      {
        dex: "uniswap",
        label: "Uniswap",
        protocols: ["v3"],
        v3FactoryAddress: "0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD"
      },
      {
        dex: "pharaoh",
        label: "Pharaoh",
        protocols: ["v3"],
        v3FactoryAddress: "0xAE6E5c62328ade73ceefD42228528b70c8157D0d"
      },
      {
        dex: "blackhole",
        label: "Blackhole",
        protocols: ["v3"],
        v3FactoryAddress: "0x512eb749541B7cf294be882D636218c84a5e9E5F"
      },
      {
        dex: "traderjoe",
        label: "Trader Joe",
        protocols: ["lb", "v2"],
        lbFactoryAddress: LFJ_LB_FACTORY_V22,
        v2FactoryAddress: "0x9Ad6C38BE94206cA50bb0d90783181662f0Cfa10"
      },
      {
        dex: "pangolin",
        label: "Pangolin",
        protocols: ["v2"],
        v2FactoryAddress: "0xefa94DE7a4656D787667C749f7E1223D71E9FD88"
      },
      {
        dex: "sushiswap",
        label: "SushiSwap",
        protocols: ["v2"],
        v2FactoryAddress: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4"
      },
      {
        dex: "curve",
        label: "Curve",
        protocols: ["curve"]
      },
      {
        dex: "balancer",
        label: "Balancer",
        protocols: ["balancer"],
        balancerVaultAddress: BALANCER_V2_VAULT
      }
    ]
  }),
  solana: {
    slug: "solana",
    kind: "solana",
    name: "Solana",
    rpcEnv: "SOLANA_RPC_URLS",
    nativeSymbol: "SOL",
    wrappedNative: "So11111111111111111111111111111111111111112",
    explorerBaseUrl: "https://solscan.io",
    geckoNetwork: "solana",
    quoteAliases: {
      sol: "So11111111111111111111111111111111111111112",
      native: "So11111111111111111111111111111111111111112",
      wsol: "So11111111111111111111111111111111111111112",
      usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      usdt: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkYpFf2bEX11J4q7"
    },
    usdLikeQuotes: [
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "Es9vMFrzaCERmJfrF4H2FYD4KCoNkYpFf2bEX11J4q7"
    ],
    nativeLikeQuotes: ["So11111111111111111111111111111111111111112"],
    canonicalPairTokens: [
      "So11111111111111111111111111111111111111112",
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "Es9vMFrzaCERmJfrF4H2FYD4KCoNkYpFf2bEX11J4q7"
    ],
    dexes: [
      {
        dex: "pumpfun",
        label: "Pump.fun",
        protocols: ["solana"],
        programIds: [
          "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
          "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
        ]
      },
      {
        dex: "raydium",
        label: "Raydium",
        protocols: ["solana"],
        programIds: [
          "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
          "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
          "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
          "5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h",
          "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj"
        ]
      },
      {
        dex: "orca",
        label: "Orca",
        protocols: ["solana"],
        programIds: ["whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"]
      },
      {
        dex: "meteora",
        label: "Meteora",
        protocols: ["solana"],
        programIds: [
          "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
          "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
          "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"
        ]
      },
      {
        dex: "pancakeswap",
        label: "PancakeSwap",
        protocols: ["solana"],
        programIds: ["HpNfyc2Saw7RKkQd8nEL4khUcuPhQ7WwY1B2qjx8jxFq"]
      }
    ]
  }
};

interface EvmChainInput {
  slug: ChainSlug;
  name: string;
  chainId: number;
  rpcEnv: string;
  nativeSymbol: string;
  wrappedNative: Address;
  explorerBaseUrl: string;
  geckoNetwork: string;
  usdLikeQuotes: Address[];
  extraNativeLikeQuotes?: Address[];
  extraCanonicalPairTokens?: Address[];
  extraQuoteAliases?: Record<string, Address>;
  dexes: DexDeployment[];
}

function evmChain(input: EvmChainInput): ChainConfig {
  const quoteAliases: Record<string, Address> = {
    native: ZERO_ADDRESS,
    [input.nativeSymbol.toLowerCase()]: ZERO_ADDRESS,
    weth: input.wrappedNative,
    wbnb: input.wrappedNative,
    wmon: input.wrappedNative
  };
  for (const [alias, address] of Object.entries(input.extraQuoteAliases ?? {})) {
    quoteAliases[alias.toLowerCase()] = address;
  }
  const usdAliases = ["usdc", "usdt", "usdbc", "dai", "busd", "fdusd"];
  for (let i = 0; i < input.usdLikeQuotes.length && i < usdAliases.length; i++) {
    quoteAliases[usdAliases[i]!] = input.usdLikeQuotes[i]!;
  }
  const nativeLikeQuotes = uniqueQuoteList([ZERO_ADDRESS, input.wrappedNative, ...(input.extraNativeLikeQuotes ?? [])]);
  const canonicalPairTokens = uniqueQuoteList([
    ...nativeLikeQuotes,
    ...input.usdLikeQuotes,
    ...(input.extraCanonicalPairTokens ?? [])
  ]);
  return {
    kind: "evm",
    quoteAliases,
    nativeLikeQuotes,
    canonicalPairTokens,
    ...input
  };
}

function uniqueQuoteList(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

export const CHAIN_SLUGS = Object.keys(CHAINS) as ChainSlug[];
export const PUBLIC_CHAIN_SLUGS: ChainSlug[] = CHAIN_SLUGS.filter((slug) => slug !== "solana");

export function isChainSlug(value: string | undefined): value is ChainSlug {
  return Boolean(value && value.toLowerCase() in CHAINS);
}

export function isPublicChainSlug(value: string | undefined): value is ChainSlug {
  return Boolean(value && PUBLIC_CHAIN_SLUGS.includes(value.toLowerCase() as ChainSlug));
}

export function getChain(slug: ChainSlug): ChainConfig {
  return CHAINS[slug];
}

export function publicChainLabels(): string {
  return PUBLIC_CHAIN_SLUGS.map(chainLabel).join(", ");
}

export function chainLabel(slug: ChainSlug): string {
  return CHAINS[slug].name;
}

export function poolManagerFor(chain: ChainConfig): Address | undefined {
  const value = chain.dexes.find((dex) => dex.poolManagerAddress && dex.protocols.includes("v4"))?.poolManagerAddress;
  return typeof value === "string" && value.startsWith("0x") ? (value as Address) : undefined;
}

export function allDexLabels(chain: ChainConfig): string {
  return chain.dexes.map((dex) => dex.label).join("/");
}

export function normalizeTokenKey(token: string): string {
  return token.toLowerCase();
}
