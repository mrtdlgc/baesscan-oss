import { blockscoutPoweredLink, escapeAttr, escapeText, page } from "./shared";

interface IntelHomePageOptions {
  walletPnlEnabled: boolean;
}

const INTEL_CARDS: Array<{ href: string; label: string; kicker: string; body: string }> = [
  {
    href: "/intel/wallet-pnl",
    label: "Wallet PnL",
    kicker: "Overview",
    body: "Cached wallet performance, token winners, realized PnL, and retained-window flow."
  },
  {
    href: "/intel/wallet-pnl/tokens/new",
    label: "New Tokens",
    kicker: "Fresh markets",
    body: "Recently active tokens, first-seen blocks, early volume, and risk signals."
  },
  {
    href: "/intel/wallet-pnl/signals",
    label: "Wallet Signals",
    kicker: "Track",
    body: "High-signal wallets ranked by trusted-hook flow, realized PnL, win rate, and cluster context."
  },
  {
    href: "/intel/wallet-pnl/risk/tokens",
    label: "Token Risk",
    kicker: "Token clusters",
    body: "Tokens with concentrated churn, symmetric trading, and abnormal wallet behavior."
  },
  {
    href: "/intel/wallet-pnl/risk/wallets",
    label: "Wallet Risk",
    kicker: "Wallet clusters",
    body: "High-frequency wallets, tight symmetry, concentrated token activity, and suspicious volume."
  },
  {
    href: "/intel/wallet-pnl/overlap",
    label: "Overlap",
    kicker: "Shared wallets",
    body: "Find what else a token cohort traded and where the same wallets cluster."
  },
  {
    href: "/intel/wallet-pnl/cohort",
    label: "Cohort",
    kicker: "Wallet sets",
    body: "Paste wallets and inspect shared tokens, pools, behavior, and historical buys."
  },
  {
    href: "/intel/wallet-pnl/pools",
    label: "Pools",
    kicker: "Market venues",
    body: "Rank pools by volume, churn, wallet concentration, and retained-window activity."
  },
  {
    href: "/intel/wallet-pnl/status",
    label: "Status",
    kicker: "Indexer health",
    body: "Snapshot block, retained range, cursor state, and materialization status."
  }
];

export function intelHomePage(options: IntelHomePageOptions): string {
  return page("baes intel", `
    <div class="intel-home-shell">
      <aside class="dex-sidebar" aria-label="Intel navigation">
        <a class="brand-mark" href="/"><span>baes</span><strong>scan</strong></a>
        <nav class="side-nav">
          <a class="is-active" href="/intel"><span class="nav-icon">I</span>Intel</a>
          <a href="/intel/wallet-pnl"><span class="nav-icon">P</span>Wallet PnL</a>
          <a href="/intel/wallet-pnl/tokens"><span class="nav-icon">T</span>Tokens</a>
          <a href="/intel/wallet-pnl/tokens/new"><span class="nav-icon">N</span>New Tokens</a>
          <a href="/intel/wallet-pnl/leaderboards/pnl"><span class="nav-icon">L</span>Leaders</a>
          <a href="/intel/wallet-pnl/signals"><span class="nav-icon">G</span>Signals</a>
          <a href="/intel/wallet-pnl/overlap"><span class="nav-icon">O</span>Overlap</a>
          <a href="/intel/wallet-pnl/cohort"><span class="nav-icon">C</span>Cohort</a>
          <a href="/intel/wallet-pnl/risk/tokens"><span class="nav-icon">R</span>Token Risk</a>
          <a href="/intel/wallet-pnl/risk/wallets"><span class="nav-icon">W</span>Wallet Risk</a>
          <a href="/intel/wallet-pnl/pools"><span class="nav-icon">U</span>Pools</a>
          <a href="/intel/wallet-pnl/status"><span class="nav-icon">S</span>Status</a>
          <a href="/"><span class="nav-icon">B</span>Buybot</a>
        </nav>
      </aside>

      <div class="intel-home-main">
        <section class="intel-hero" aria-labelledby="intelHomeTitle">
          <p class="eyebrow">Self-hosted intel</p>
          <h1 id="intelHomeTitle">baes intel</h1>
          <p>Wallet PnL, token risk, and cohort tools. The self-hosted edition exposes these pages directly; enable <code>WALLET_PNL_ENABLED=true</code> to start the indexer.</p>
          ${blockscoutPoweredLink("blockscout-hero-badge is-intel")}
          <dl class="intel-gate-strip">
            <div>
              <dt>Indexer</dt>
              <dd>${options.walletPnlEnabled ? "Enabled" : "Disabled"}</dd>
            </div>
          </dl>
        </section>

        <section class="intel-card-grid" aria-label="Intel navigation cards">
          ${INTEL_CARDS.map(renderIntelCard).join("")}
        </section>
      </div>
    </div>
  `, {
    description: "Self-hosted baes intel for wallet PnL, New Tokens, risk clusters, overlap cohorts, and retained-window flow.",
    canonicalPath: "/intel",
    imagePath: "/og/baes-intel.png"
  });
}

function renderIntelCard(card: { href: string; label: string; kicker: string; body: string }): string {
  return `
    <a class="intel-nav-card" href="${escapeAttr(card.href)}">
      <span>${escapeText(card.kicker)}</span>
      <strong>${escapeText(card.label)}</strong>
      <p>${escapeText(card.body)}</p>
    </a>
  `;
}
