import type { Logger } from "pino";
import type { Env } from "../../config/env";
import type { BlockscoutClient } from "../../services/blockscout";
import type { PriceService } from "../../services/price";
import type { RpcPool } from "../../services/rpcPool";
import type { TokenService } from "../../services/token";
import type { SolanaRpcClient } from "../../solana/activity";
import type { Storage } from "../../store/storage";
import type { ChainSlug } from "../../types";

export interface CommandDeps {
  rpc?: RpcPool;
  rpcs: Map<ChainSlug, RpcPool>;
  store: Storage;
  tokenServices: Map<ChainSlug, TokenService>;
  blockscoutClient?: BlockscoutClient;
  solanaClient?: SolanaRpcClient;
  priceService: PriceService;
  env: Env;
  logger: Logger;
}
