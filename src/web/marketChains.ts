import type { ChainSlug } from "../types";

export const MARKET_BOARD_CHAINS: ChainSlug[] = ["base", "ethereum"];

export function isMarketBoardChain(value: string | undefined): value is ChainSlug {
  return MARKET_BOARD_CHAINS.includes(value as ChainSlug);
}
