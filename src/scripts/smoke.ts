import { CHAINS, CHAIN_SLUGS, PUBLIC_CHAIN_SLUGS } from "../chains/registry";

const required = new Set(["ethereum", "bsc", "monad", "megaeth", "robinhood", "arbitrum", "optimism", "base", "polygon", "avalanche"]);
const missing = [...required].filter((slug) => !CHAIN_SLUGS.includes(slug as typeof CHAIN_SLUGS[number]));
if (missing.length > 0) throw new Error(`missing chain configs: ${missing.join(", ")}`);

for (const slug of PUBLIC_CHAIN_SLUGS) {
  const chain = CHAINS[slug];
  if (chain.dexes.length === 0) throw new Error(`${slug} has no DEX deployments`);
  if (chain.kind === "evm") {
    if (!chain.chainId) throw new Error(`${slug} missing chainId`);
    const hasRawFactory = chain.dexes.some((dex) =>
      Boolean(
        dex.poolManagerAddress ||
          dex.v3FactoryAddress ||
          dex.v2FactoryAddress ||
          dex.solidlyFactoryAddress ||
          dex.algebraFactoryAddress ||
          dex.lbFactoryAddress ||
          dex.balancerVaultAddress ||
          dex.protocols.includes("curve")
      )
    );
    if (!hasRawFactory) throw new Error(`${slug} has no raw factory/manager address`);
  } else {
    const hasProgramIds = chain.dexes.some((dex) => (dex.programIds?.length ?? 0) > 0);
    if (!hasProgramIds) throw new Error(`${slug} has no program ids`);
  }
}

const coverage = PUBLIC_CHAIN_SLUGS.map((slug) => {
  const chain = CHAINS[slug];
  return {
    slug,
    kind: chain.kind,
    dexes: chain.dexes.map((dex) => `${dex.label}:${dex.protocols.join("/")}`)
  };
});

// eslint-disable-next-line no-console
console.log(JSON.stringify({ ok: true, coverage }, null, 2));
