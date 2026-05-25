import type { Env } from "../../config/env";
import type { ChainSlug } from "../../types";
import { chainLabel } from "../../chains/registry";
import { isMarketBoardChain } from "../marketChains";
import { publicChains } from "../publicChains";
import { marketScript } from "./landingScript";
import { blockscoutPoweredLink, escapeAttr, escapeText, page } from "./shared";

interface LandingPageDeps {
  env: Pick<
    Env,
    | "enabledChains"
    | "rpcUrlsByChain"
    | "publicMarketApiBase"
    | "marketsEnabled"
    | "walletPnlEnabled"
    | "walletPnlNewTokensIntervalMs"
  >;
  rpcs: Pick<Map<ChainSlug, unknown>, "get">;
}

export function landingPage(deps: LandingPageDeps): string {
  const chains = publicChains(deps);
  const chainNames = Object.fromEntries(chains.map((chain) => [chain.slug, chain.name]));
  const marketChains = chains.filter((chain) => isMarketBoardChain(chain.slug));
  const hasPublicMarketApi = deps.env.marketsEnabled && Boolean(deps.env.publicMarketApiBase);
  const initialChain = (marketChains.find((chain) => chain.enabled && chain.rpcConfigured)?.slug ??
    (hasPublicMarketApi ? marketChains.find((chain) => chain.slug === "base")?.slug : undefined) ??
    marketChains.find((chain) => chain.enabled)?.slug ??
    marketChains[0]?.slug ??
    "base") as ChainSlug;
  const chainPills = chains
    .filter((chain) => isMarketBoardChain(chain.slug))
    .map((chain) => {
      const active = chain.slug === initialChain;
      const ready = hasPublicMarketApi || (chain.enabled && chain.rpcConfigured);
      const title = ready ? "" : ` title="RPC is not configured for the public market board on ${escapeText(chain.name)} yet."`;
      return `<button class="chain-pill${active ? " is-active" : ""}${ready ? "" : " is-disabled"}" data-chain="${escapeText(chain.slug)}" type="button" role="tab" aria-selected="${active ? "true" : "false"}"${ready ? "" : " disabled aria-disabled=\"true\""}${title}><span class="chain-dot" data-chain-dot="${escapeText(chain.slug)}"></span>${escapeText(chain.name)}</button>`;
    })
    .join("");
  const sideChains = chains
    .map((chain) => `<span class="side-chain">${escapeText(chain.name)}</span>`)
    .join("");
  const initialChainName = chainNames[initialChain] ?? chainLabel(initialChain);
  const intelCadence = formatCadence(deps.env.walletPnlNewTokensIntervalMs);

  return page("baes scan Telegram buybot", `
    <div class="dex-shell">
      <aside class="dex-sidebar" aria-label="Site navigation">
        <a class="brand-mark" href="/"><span>baes</span><strong>scan</strong></a>
        <nav class="side-nav">
          <a class="is-active" href="#top"><span class="nav-icon">B</span>Buybot</a>
          <a href="/intel"><span class="nav-icon">I</span>Intel</a>
          <a href="#coverage"><span class="nav-icon">C</span>Coverage</a>
          <a href="#setup"><span class="nav-icon">S</span>Setup</a>
          ${deps.env.marketsEnabled ? `<a href="#market-board"><span class="nav-icon">M</span>Markets</a>` : ""}
        </nav>
        <div class="side-block">
          <p>Networks</p>
          ${sideChains}
        </div>
        <div class="side-block">
          <p>Resources</p>
          <a class="side-link" href="/intel">Holder Intel</a>
          ${deps.env.marketsEnabled ? `<a class="side-link" id="apiLink" href="${escapeAttr(`${deps.env.publicMarketApiBase ?? ""}/api/trending/${initialChain}`)}">API JSON</a>` : ""}
          <a class="side-link" href="/health">Health</a>
        </div>
      </aside>

      <div class="market-app" id="top">
        <section class="landing-hero" aria-labelledby="landingTitle">
          <div class="landing-hero-copy">
            <p class="eyebrow">Telegram buy alerts for real DEX pools</p>
            <h1 id="landingTitle">Add <span>@BAESBuyBot</span> and post the buys your group actually cares about.</h1>
            <p class="landing-lede">baes scan is a Telegram-first buybot for token teams that need route-specific alerts across Uniswap v4, Aerodrome, PancakeSwap, SushiSwap, Camelot, Trader Joe, Curve, Balancer, and more.</p>
            ${blockscoutPoweredLink("blockscout-hero-badge")}
            <div class="landing-actions">
              <a class="button-link is-primary" href="https://t.me/BAESBuyBot" target="_blank" rel="noreferrer">Open @BAESBuyBot</a>
              <a class="ghost-link" href="/intel">Open Intel</a>
              ${deps.env.marketsEnabled ? `<a class="ghost-link" href="#market-board">View markets</a>` : ""}
            </div>
            <div class="landing-proof" aria-label="Product highlights">
              <span>Read-only alerts</span>
              <span>Pool IDs and exact pools</span>
              <span>Telegram topics</span>
              <span>Free to try</span>
            </div>
          </div>
          <div class="alert-preview" aria-label="Telegram alert preview">
            <div class="alert-window">
              <div class="alert-top">
                <span class="alert-dot"></span>
                <strong>@BAESBuyBot</strong>
                <em>Telegram preview</em>
              </div>
              <div class="alert-message">
                <p class="alert-kicker">Fresh buy on Base / Uniswap v4</p>
                <h2>3.42 ETH bought BAES</h2>
                <dl>
                  <div><dt>Pool</dt><dd>v4 PoolManager route</dd></div>
                  <div><dt>Buyer</dt><dd>0x7a9...21c4</dd></div>
                  <div><dt>Group</dt><dd>Launch alerts topic</dd></div>
                </dl>
                <code>/watch base 0xToken any &lt;firstMintBlock&gt; uniswap v4 all</code>
              </div>
              <div class="alert-stack">
                <span>settings</span>
                <span>media</span>
                <span>min buy</span>
                <span>topic</span>
              </div>
            </div>
          </div>
        </section>

        <section class="coverage-band" id="intel-preview" aria-labelledby="intelPreviewTitle">
          <div class="section-heading">
            <p class="eyebrow">Holder intel</p>
            <h2 id="intelPreviewTitle">Wallet clusters and new-token analysis.</h2>
            <p>Open <code>/intel</code> for wallet PnL, risk clusters, cohort overlap, and a New Tokens view that refreshes from a cached ${escapeText(intelCadence)} analysis without blocking the site.</p>
          </div>
          <div class="coverage-layout">
            <div class="protocol-panel">
              <h3>Self-hosted intel</h3>
              <p>The intel surface is open in the self-hosted edition. Enable the wallet-PnL indexer with <code>WALLET_PNL_ENABLED=true</code> after reading <code>docs/rpc-costs.md</code>.</p>
              <a href="/intel">Open intel</a>
            </div>
            <div class="coverage-map">
              <span>New Tokens</span>
              <span>Wallet PnL</span>
              <span>Token Risk</span>
              <span>Wallet Risk</span>
              <span>Overlap</span>
              <span>Cohort</span>
              <span>${escapeText(deps.env.walletPnlEnabled ? "Indexer live" : "Indexer paused")}</span>
            </div>
          </div>
        </section>

        <section class="function-grid" aria-labelledby="functionTitle">
          <div class="section-heading">
            <p class="eyebrow">What it does</p>
            <h2 id="functionTitle">The buybot surface your Telegram group needs before launch pressure hits.</h2>
          </div>
          <div class="feature-grid">
            <article class="feature-card">
              <span>01</span>
              <h3>Route-specific buy alerts</h3>
              <p>Track the DEX route the community actually uses instead of treating every token as one generic pair.</p>
            </article>
            <article class="feature-card">
              <span>02</span>
              <h3>Uniswap v4 and hook-aware setup</h3>
              <p>Use pool IDs, full pool keys, and Clanker-style filters when a normal pair address is not enough.</p>
            </article>
            <article class="feature-card">
              <span>03</span>
              <h3>Direct pool entry</h3>
              <p>Save known pairs, Curve pools, Balancer pools, Liquidity Book pools, or v4 pool IDs with <code>/pool</code>.</p>
            </article>
            <article class="feature-card">
              <span>04</span>
              <h3>Telegram topics and styling</h3>
              <p>Route alerts with <code>/topic here</code>, then tune minimum buys, media, text, emoji, and posting behavior.</p>
            </article>
            <article class="feature-card">
              <span>05</span>
              <h3>Multi-chain coverage</h3>
              <p>Use one setup language across Base, Ethereum, BSC, Arbitrum, Optimism, Polygon, Avalanche, Monad, and MegaETH.</p>
            </article>
            <article class="feature-card">
              <span>06</span>
              <h3>Shareable chart links</h3>
              <p>Keep alerts practical with direct transaction and chart links instead of asking the web app to run a public market terminal.</p>
            </article>
          </div>
        </section>

        <section class="coverage-band" id="coverage" aria-labelledby="coverageTitle">
          <div class="section-heading">
            <p class="eyebrow">Coverage</p>
            <h2 id="coverageTitle">Built for modern pool shapes, not only old pair contracts.</h2>
          </div>
          <div class="coverage-layout">
            <div class="coverage-map">
              <span>Base</span>
              <span>Ethereum</span>
              <span>BNB Smart Chain</span>
              <span>Arbitrum</span>
              <span>Optimism</span>
              <span>Polygon</span>
              <span>Avalanche</span>
              <span>Monad</span>
              <span>MegaETH</span>
            </div>
            <div class="protocol-panel">
              <h3>Supported route families</h3>
              <p>Uniswap v2/v3/v4, PancakeSwap v2/v3, SushiSwap v2, Aerodrome and Velodrome, Hydrex, Camelot, THENA, QuickSwap, Trader Joe, Pharaoh, Blackhole, Pangolin, Curve, and Balancer.</p>
            </div>
          </div>
        </section>

        <section class="setup-flow" id="setup" aria-labelledby="setupTitle">
          <div class="section-heading">
            <p class="eyebrow">Setup</p>
            <h2 id="setupTitle">Three commands from silent group to live buy feed.</h2>
          </div>
          <div class="flow-steps">
            <article>
              <span>1</span>
              <h3>Add the bot</h3>
              <p>Invite <code>@BAESBuyBot</code> to your Telegram group or channel and give it permission to post.</p>
            </article>
            <article>
              <span>2</span>
              <h3>Watch the token</h3>
              <p>Use the token's exact first-mint block, or a block very close to it, so route discovery starts in the right place.</p>
              <pre>/watch base 0xToken any &lt;firstMintBlock&gt; uniswap v4 all</pre>
            </article>
            <article>
              <span>3</span>
              <h3>Confirm and route</h3>
              <p>Check saved pools, tune the alert style, and send posts to the right Telegram topic.</p>
              <pre>/pools
/settings
/topic here</pre>
            </article>
          </div>
        </section>

        ${deps.env.marketsEnabled ? `<section class="market-section" id="market-board" aria-labelledby="boardTitle">
          <div class="section-heading market-heading">
            <p class="eyebrow">Market board</p>
            <h2>See the web surface behind the Telegram bot.</h2>
            <p>The board is secondary to the buybot, but it gives teams a public place to inspect active pools, open charts, and share market context.</p>
          </div>
        </section>

        <header class="dex-top">
          <label class="search-box" for="marketSearch">
            <span class="search-glyph" aria-hidden="true">/</span>
            <input id="marketSearch" type="search" autocomplete="off" spellcheck="false" placeholder="Search token, pool or address" />
            <button class="search-clear" id="clearSearch" type="button" aria-label="Clear search">x</button>
            <kbd>/</kbd>
          </label>
          <div class="dex-top-actions">
            <div class="chain-pills" role="tablist" aria-label="Chain">${chainPills}</div>
          </div>
        </header>

        <section class="hero-strip">
          <div class="hero-headline">
            <p class="eyebrow">On-chain market board</p>
            <h1 id="boardTitle">${escapeText(initialChainName)} trending pools</h1>
            <p class="hero-sub" id="boardSub">Fresh pool activity from baes scan, with chart views opened through GeckoTerminal.</p>
          </div>
          <dl class="hero-stats">
            <div><dt>Volume (window)</dt><dd id="metricVolume">-</dd></div>
            <div><dt>Transactions</dt><dd id="metricTxns">-</dd></div>
            <div><dt>Pools</dt><dd id="metricPairs">-</dd></div>
            <div><dt>Latest block</dt><dd id="metricBlock">-</dd></div>
          </dl>
        </section>

        <div class="board-controls">
          <div class="view-tabs" role="tablist" aria-label="View">
            <button class="view-tab is-active" data-view="trending" type="button" role="tab" aria-selected="true">Trending</button>
            <button class="view-tab" data-view="new" type="button" role="tab" aria-selected="false">New pairs</button>
            <button class="view-tab" data-view="gainers" type="button" role="tab" aria-selected="false">Gainers</button>
            <button class="view-tab" data-view="losers" type="button" role="tab" aria-selected="false">Losers</button>
          </div>
          <div class="board-meta">
            <span id="dataSource" class="source-pill">Live scan</span>
            <span id="status">Loading ${escapeText(initialChainName)} swaps</span>
            <span id="window" class="board-window"></span>
          </div>
        </div>

        <section class="board-card" aria-label="Pool list">
          <div class="table-scroll">
            <table class="dex-table" id="marketTable">
              <thead id="marketHead"></thead>
              <tbody id="marketRows">
                <tr><td colspan="14" class="empty-cell is-loading">Preparing the market board...</td></tr>
              </tbody>
            </table>
          </div>
        </section>
        ` : ""}
      </div>
    </div>
    ${deps.env.marketsEnabled ? `<script>${marketScript(deps.env.publicMarketApiBase, chainNames, initialChain)}</script>` : ""}
  `, {
    description: "baes scan is a Telegram-first buybot for pool-aware DEX buy alerts, route-specific setup, and token-gated holder intel.",
    canonicalPath: "/",
    imagePath: "/og/baes-scan.png"
  });
}

function formatCadence(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1_000)}-second`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}-minute`;
  const hours = Math.round(minutes / 60);
  return `${hours}-hour`;
}
