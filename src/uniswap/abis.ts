import { Interface } from "ethers";

export const POOL_MANAGER_ABI = [
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)"
] as const;

export const FLAUNCH_HOOK_ABI = [
  "event HookSwap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint128 hookLPfeeAmount0, uint128 hookLPfeeAmount1)",
  "event HookFee(bytes32 indexed id, address indexed sender, uint128 feeAmount0, uint128 feeAmount1)"
] as const;

export const V3_FACTORY_ABI = [
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)"
] as const;

export const V3_POOL_ABI = [
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function factory() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)"
] as const;

export const PANCAKE_V3_POOL_ABI = [
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint128 protocolFeesToken0, uint128 protocolFeesToken1)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function factory() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)"
] as const;

export const V2_FACTORY_ABI = [
  "event PairCreated(address indexed token0, address indexed token1, address pair, uint256)"
] as const;

export const V2_PAIR_ABI = [
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function factory() view returns (address)"
] as const;

export const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)"
] as const;

export const POOL_MANAGER_IFACE = new Interface(POOL_MANAGER_ABI);
export const INITIALIZE_TOPIC = POOL_MANAGER_IFACE.getEvent("Initialize")!.topicHash;
export const SWAP_TOPIC = POOL_MANAGER_IFACE.getEvent("Swap")!.topicHash;

export const FLAUNCH_HOOK_IFACE = new Interface(FLAUNCH_HOOK_ABI);
export const FLAUNCH_HOOK_SWAP_TOPIC = FLAUNCH_HOOK_IFACE.getEvent("HookSwap")!.topicHash;

export const V3_FACTORY_IFACE = new Interface(V3_FACTORY_ABI);
export const V3_POOL_IFACE = new Interface(V3_POOL_ABI);
export const PANCAKE_V3_POOL_IFACE = new Interface(PANCAKE_V3_POOL_ABI);
export const V3_POOL_CREATED_TOPIC = V3_FACTORY_IFACE.getEvent("PoolCreated")!.topicHash;
export const V3_SWAP_TOPIC = V3_POOL_IFACE.getEvent("Swap")!.topicHash;
export const PANCAKE_V3_SWAP_TOPIC = PANCAKE_V3_POOL_IFACE.getEvent("Swap")!.topicHash;

export const V2_FACTORY_IFACE = new Interface(V2_FACTORY_ABI);
export const V2_PAIR_IFACE = new Interface(V2_PAIR_ABI);
export const V2_PAIR_CREATED_TOPIC = V2_FACTORY_IFACE.getEvent("PairCreated")!.topicHash;
export const V2_SWAP_TOPIC = V2_PAIR_IFACE.getEvent("Swap")!.topicHash;
