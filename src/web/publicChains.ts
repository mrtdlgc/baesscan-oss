import type { Env } from "../config/env";
import { CHAINS, PUBLIC_CHAIN_SLUGS } from "../chains/registry";
import type { ChainSlug } from "../types";

export function publicChains(deps: {
  env: Pick<Env, "enabledChains" | "rpcUrlsByChain">;
  rpcs: Pick<Map<ChainSlug, unknown>, "get">;
}) {
  return PUBLIC_CHAIN_SLUGS.map((slug) => {
    const chain = CHAINS[slug];
    return {
      slug,
      name: chain.name,
      kind: chain.kind,
      enabled: deps.env.enabledChains.includes(slug),
      rpcConfigured: Boolean(deps.rpcs.get(slug)),
      dexes: chain.dexes.map((dex) => ({ dex: dex.dex, label: dex.label, protocols: dex.protocols, programIds: dex.programIds }))
    };
  });
}
