import { getChain, PUBLIC_CHAIN_SLUGS } from "../../chains/registry";
import { gmgnTokenUrl } from "../../services/walletPnlFilters";
import type { CopyShadowConfig, CopyShadowPosition, CopyShadowSignal, CopyShadowSnapshot } from "../../store/storage";
import type { ChainSlug } from "../../types";
import { shortAddress } from "../../utils/address";
import { displayTokenTicker, tokenTickerTitle } from "../tokenDisplay";
import { escapeAttr, escapeText, page } from "./shared";

interface CopyShadowAdminPageOptions {
  config: CopyShadowConfig;
  snapshot?: CopyShadowSnapshot;
  error?: string;
  saved?: boolean;
}

interface CopyShadowLoginOptions {
  configured: boolean;
  error?: string;
}

export function copyShadowAdminLoginPage(options: CopyShadowLoginOptions): string {
  const disabled = !options.configured;
  return page("Copy shadow admin", `
    <div class="admin-login-shell">
      <section class="admin-login-panel" aria-labelledby="adminLoginTitle">
        <a class="brand-mark" href="/"><span>baes</span><strong>scan</strong></a>
        <div>
          <p class="eyebrow">Admin</p>
          <h1 id="adminLoginTitle">Copy shadow</h1>
          <p class="admin-login-copy">${disabled
            ? "Set WEB_ADMIN_PASSWORD before this page can be opened."
            : "Enter the admin password to view the paper copy-trading simulation."}</p>
        </div>
        ${options.error ? `<p class="admin-error">${escapeText(options.error)}</p>` : ""}
        <form class="admin-login-form" method="post" action="/admin/copy-shadow">
          <label for="adminPassword">Password</label>
          <input id="adminPassword" name="password" type="password" autocomplete="current-password" ${disabled ? "disabled" : "autofocus"} />
          <button class="button-link is-primary" type="submit" ${disabled ? "disabled" : ""}>Unlock</button>
        </form>
      </section>
    </div>
  `);
}

export function copyShadowAdminPage(options: CopyShadowAdminPageOptions): string {
  const chain = options.config.chain;
  const chainName = getChain(chain).name;
  const snapshot = options.snapshot;
  return page("Copy shadow admin", `
    <div class="dex-shell admin-shell">
      <aside class="dex-sidebar" aria-label="Admin navigation">
        <a class="brand-mark" href="/"><span>baes</span><strong>scan</strong></a>
        <nav class="side-nav">
          <a href="/intel/wallet-pnl"><span class="nav-icon">P</span>Wallet PnL</a>
          <a class="is-active" href="/admin/copy-shadow"><span class="nav-icon">S</span>Copy shadow</a>
          <a href="/"><span class="nav-icon">B</span>Buybot</a>
          <a href="/health"><span class="nav-icon">H</span>Health</a>
          <a href="/admin/copy-shadow?logout=1"><span class="nav-icon">L</span>Logout</a>
        </nav>
        <div class="side-block">
          <p>Status</p>
          <span class="side-link">${options.config.enabled ? "Simulator enabled" : "Simulator disabled"}</span>
          <span class="side-link">${escapeText(chainName)}</span>
        </div>
      </aside>

      <div class="admin-app">
        <header class="admin-top">
          <div>
            <p class="eyebrow">Paper copy trader</p>
            <h1>${escapeText(chainName)} copy shadow</h1>
          </div>
          <div class="inline-actions">
            <a class="ghost-link" href="/admin/copy-shadow">Refresh</a>
            <a class="ghost-link" href="/admin/copy-shadow?logout=1">Logout</a>
          </div>
        </header>

        ${options.error ? `<p class="admin-error admin-page-alert">${escapeText(options.error)}</p>` : ""}
        ${options.saved ? `<p class="admin-success admin-page-alert">Settings saved and simulation rebuilt.</p>` : ""}
        ${renderSettingsForm(options.config)}
        ${snapshot ? renderSnapshot(snapshot) : renderEmptyState(options.config)}
      </div>
    </div>
  `);
}

function renderSettingsForm(config: CopyShadowConfig): string {
  const chainOptions = PUBLIC_CHAIN_SLUGS
    .filter((chain) => getChain(chain).kind === "evm")
    .map((chain) => {
      const selected = chain === config.chain ? " selected" : "";
      return `<option value="${escapeAttr(chain)}"${selected}>${escapeText(getChain(chain).name)}</option>`;
    })
    .join("");
  return `
    <section class="board-card admin-settings-card" aria-labelledby="copyShadowSettingsTitle">
      <div class="admin-settings-head">
        <div>
          <p class="eyebrow">Simulation settings</p>
          <h2 id="copyShadowSettingsTitle">Admin controls</h2>
        </div>
        <span class="source-pill">${config.enabled ? "Enabled" : "Disabled"}</span>
      </div>
      <form class="admin-settings-form" method="post" action="/admin/copy-shadow">
        <label class="admin-toggle-row">
          <input name="enabled" type="checkbox" ${config.enabled ? "checked" : ""} />
          <span>Run paper simulation</span>
        </label>
        <div class="admin-form-grid">
          <label class="admin-form-field">
            <span>Chain</span>
            <select name="chain">${chainOptions}</select>
          </label>
          ${numberInput("intervalSeconds", "Rebuild seconds", Math.floor((config.intervalMs ?? 60_000) / 1000), "30", "900", "1")}
          ${numberInput("tradeSizeUsd", "Trade size", config.settings.tradeSizeUsd, "1", "10000", "1")}
          ${numberInput("maxPositionUsd", "Max position", config.settings.maxPositionUsd, "1", "100000", "1")}
          ${numberInput("executionDelayBlocks", "Delay blocks", config.settings.executionDelayBlocks, "0", "10000", "1")}
          ${numberInput("maxPriceLookaheadBlocks", "Lookahead blocks", config.settings.maxPriceLookaheadBlocks, "1", "50000", "1")}
          ${numberInput("slippageBps", "Slippage bps", config.settings.slippageBps, "0", "9000", "1")}
          ${numberInput("gasUsd", "Gas USD", config.settings.gasUsd, "0", "100", "0.001")}
          ${numberInput("minSourceVolumeUsd", "Min source volume", config.settings.minSourceVolumeUsd, "0", "100000000", "1")}
          ${numberInput("recentSignalsLimit", "Signal limit", config.recentSignalsLimit, "10", "1000", "1")}
          ${numberInput("positionLimit", "Position limit", config.positionLimit, "10", "1000", "1")}
        </div>
        <label class="admin-form-field admin-form-field-wide">
          <span>Watched wallets</span>
          <textarea name="wallets" rows="4" spellcheck="false">${escapeText(config.wallets.join("\n"))}</textarea>
        </label>
        <div class="admin-form-actions">
          <button class="button-link is-primary" type="submit" name="action" value="save">Save simulation</button>
          <button class="button-link is-danger" type="submit" name="action" value="stop" ${config.enabled ? "" : "disabled"}>Stop simulation</button>
          <span class="muted">Last updated ${escapeText(formatDateTime(config.updatedAt))}</span>
        </div>
      </form>
    </section>
  `;
}

function numberInput(name: string, label: string, value: number, min: string, max: string, step: string): string {
  return `
    <label class="admin-form-field">
      <span>${escapeText(label)}</span>
      <input name="${escapeAttr(name)}" type="number" min="${escapeAttr(min)}" max="${escapeAttr(max)}" step="${escapeAttr(step)}" value="${escapeAttr(String(value))}" />
    </label>
  `;
}

function renderSnapshot(snapshot: CopyShadowSnapshot): string {
  const walletRows = snapshot.wallets.map((wallet) => `
    <tr>
      <td data-label="Wallet">${renderWallet(snapshot.chain, wallet.wallet)}</td>
      <td data-label="Realized" class="num ${wallet.realizedPnlUsd >= 0 ? "good" : "bad"}">${escapeText(formatSignedUsd(wallet.realizedPnlUsd))}</td>
      <td data-label="Unrealized" class="num ${wallet.unrealizedPnlUsd >= 0 ? "good" : "bad"}">${escapeText(formatSignedUsd(wallet.unrealizedPnlUsd))}</td>
      <td data-label="Copied">${wallet.copiedBuyCount.toLocaleString()} buy / ${wallet.copiedSellCount.toLocaleString()} sell</td>
      <td data-label="Skipped" class="num">${wallet.skippedSignalCount.toLocaleString()}</td>
      <td data-label="Open" class="num">${wallet.openPositionCount.toLocaleString()}</td>
      <td data-label="Last block" class="num">${wallet.lastBlock ? wallet.lastBlock.toLocaleString() : "-"}</td>
    </tr>
  `).join("");
  const positionRows = snapshot.positions.map((position) => renderPositionRow(snapshot.chain, position)).join("");
  const signalRows = snapshot.recentSignals.map((signal) => renderSignalRow(snapshot.chain, signal)).join("");

  return `
    <section class="admin-summary" aria-labelledby="copyShadowSummaryTitle">
      <div class="admin-summary-copy">
        <div class="admin-title-row">
          <h2 id="copyShadowSummaryTitle">Latest simulation</h2>
          <span class="source-pill">Paper only</span>
        </div>
        <p>Generated ${escapeText(formatDateTime(snapshot.generatedAt))}. Execution waits ${snapshot.settings.executionDelayBlocks.toLocaleString()} block(s), then uses the next observed token price within ${snapshot.settings.maxPriceLookaheadBlocks.toLocaleString()} block(s).</p>
      </div>
      <dl class="admin-metrics">
        <div><dt>Realized PnL</dt><dd class="${snapshot.realizedPnlUsd >= 0 ? "good" : "bad"}">${escapeText(formatSignedUsd(snapshot.realizedPnlUsd))}</dd></div>
        <div><dt>Unrealized</dt><dd class="${snapshot.unrealizedPnlUsd >= 0 ? "good" : "bad"}">${escapeText(formatSignedUsd(snapshot.unrealizedPnlUsd))}</dd></div>
        <div><dt>Copied buys</dt><dd>${snapshot.copiedBuyCount.toLocaleString()}</dd></div>
        <div><dt>Copied sells</dt><dd>${snapshot.copiedSellCount.toLocaleString()}</dd></div>
        <div><dt>Skipped</dt><dd>${snapshot.skippedSignalCount.toLocaleString()}</dd></div>
        <div><dt>Open positions</dt><dd>${snapshot.openPositionCount.toLocaleString()}</dd></div>
        <div><dt>Source trades</dt><dd>${snapshot.sourceTradeCount.toLocaleString()}</dd></div>
        <div><dt>Scanned block</dt><dd>${snapshot.toBlock !== undefined ? snapshot.toBlock.toLocaleString() : "-"}</dd></div>
        <div><dt>Trade size</dt><dd>${escapeText(formatUsd(snapshot.settings.tradeSizeUsd))}</dd></div>
        <div><dt>Slippage model</dt><dd>${escapeText(formatBps(snapshot.settings.slippageBps))}</dd></div>
      </dl>
    </section>

    <section class="board-card admin-wallet-card" aria-label="Copy shadow wallet summary">
      <div class="table-scroll">
        <table class="dex-table admin-wallet-table">
          <thead><tr><th>Wallet</th><th class="num">Realized</th><th class="num">Unrealized</th><th>Copied</th><th class="num">Skipped</th><th class="num">Open</th><th class="num">Last block</th></tr></thead>
          <tbody>${walletRows || `<tr><td colspan="7" class="empty-cell">No watched-wallet trades found in retained wallet-PnL data.</td></tr>`}</tbody>
        </table>
      </div>
    </section>

    <section class="board-card admin-wallet-card" aria-label="Open simulated positions">
      <div class="table-scroll">
        <table class="dex-table admin-wallet-table">
          <thead><tr><th>Token</th><th>Wallet</th><th class="num">Quantity</th><th class="num">Cost</th><th class="num">Value</th><th class="num">Unrealized</th><th class="num">Last block</th></tr></thead>
          <tbody>${positionRows || `<tr><td colspan="7" class="empty-cell">No open simulated positions.</td></tr>`}</tbody>
        </table>
      </div>
    </section>

    <section class="board-card admin-wallet-card" aria-label="Recent copy shadow signals">
      <div class="table-scroll">
        <table class="dex-table admin-wallet-table">
          <thead><tr><th>Signal</th><th>Token</th><th>Status</th><th class="num">Source price</th><th class="num">Exec price</th><th class="num">Sim PnL</th><th class="num">Block</th><th>Links</th></tr></thead>
          <tbody>${signalRows || `<tr><td colspan="8" class="empty-cell">No copy signals yet.</td></tr>`}</tbody>
        </table>
      </div>
    </section>
  `;
}

function renderEmptyState(config: CopyShadowConfig): string {
  return `
    <section class="admin-summary" aria-labelledby="copyShadowEmptyTitle">
      <div class="admin-summary-copy">
        <div class="admin-title-row">
          <h2 id="copyShadowEmptyTitle">No simulation yet</h2>
          <span class="source-pill is-warning">Waiting</span>
        </div>
        <p>The copy-shadow page is ready, but no paper simulation snapshot has been saved for ${escapeText(getChain(config.chain).name)} yet.</p>
      </div>
      <dl class="admin-metrics">
        <div><dt>Watched wallets</dt><dd>${config.wallets.length.toLocaleString()}</dd></div>
        <div><dt>Status</dt><dd>${config.enabled ? "Enabled" : "Disabled"}</dd></div>
      </dl>
    </section>
  `;
}

function renderPositionRow(chain: ChainSlug, position: CopyShadowPosition): string {
  const tokenUrl = gmgnTokenUrl(chain, position.tokenAddress);
  return `
    <tr>
      <td data-label="Token">${renderToken(tokenUrl, position.tokenSymbol, position.tokenAddress)}</td>
      <td data-label="Wallet">${renderWallet(chain, position.wallet)}</td>
      <td data-label="Quantity" class="num">${escapeText(formatAmount(position.quantity))}</td>
      <td data-label="Cost" class="num">${escapeText(formatUsd(position.costUsd))}</td>
      <td data-label="Value" class="num">${position.marketValueUsd !== undefined ? escapeText(formatUsd(position.marketValueUsd)) : "-"}</td>
      <td data-label="Unrealized" class="num ${position.unrealizedPnlUsd !== undefined && position.unrealizedPnlUsd >= 0 ? "good" : "bad"}">${position.unrealizedPnlUsd !== undefined ? escapeText(formatSignedUsd(position.unrealizedPnlUsd)) : "-"}</td>
      <td data-label="Last block" class="num">${position.lastBlock.toLocaleString()}</td>
    </tr>
  `;
}

function renderSignalRow(chain: ChainSlug, signal: CopyShadowSignal): string {
  const tokenUrl = gmgnTokenUrl(chain, signal.tokenAddress);
  const explorer = adminExplorerBaseUrl(chain);
  const txUrl = explorer ? `${explorer}/tx/${signal.sourceTxHash}` : undefined;
  const statusClass = signal.status === "copied" ? "source-pill" : "source-pill is-warning";
  return `
    <tr>
      <td data-label="Signal">${escapeText(signal.side.toUpperCase())}</td>
      <td data-label="Token">${renderToken(tokenUrl, signal.tokenSymbol, signal.tokenAddress)}</td>
      <td data-label="Status"><span class="${statusClass}">${escapeText(signal.status)}</span>${signal.reason ? `<span class="muted"> ${escapeText(signal.reason)}</span>` : ""}</td>
      <td data-label="Source price" class="num">${signal.sourcePriceUsd !== undefined ? escapeText(formatPrice(signal.sourcePriceUsd)) : "-"}</td>
      <td data-label="Exec price" class="num">${signal.executionPriceUsd !== undefined ? escapeText(formatPrice(signal.executionPriceUsd)) : "-"}</td>
      <td data-label="Sim PnL" class="num ${signal.simulatedPnlUsd !== undefined && signal.simulatedPnlUsd >= 0 ? "good" : "bad"}">${signal.simulatedPnlUsd !== undefined ? escapeText(formatSignedUsd(signal.simulatedPnlUsd)) : "-"}</td>
      <td data-label="Block" class="num">${signal.sourceBlock.toLocaleString()}</td>
      <td data-label="Links">${txUrl ? `<a href="${escapeAttr(txUrl)}" target="_blank" rel="noreferrer">Tx</a>` : ""}</td>
    </tr>
  `;
}

function renderWallet(chain: ChainSlug, wallet: string): string {
  const explorer = adminExplorerBaseUrl(chain);
  const href = explorer ? `${explorer}/address/${wallet}` : undefined;
  return href
    ? `<a class="mono wallet-address" href="${escapeAttr(href)}" target="_blank" rel="noreferrer">${escapeText(shortAddress(wallet))}</a>`
    : `<span class="mono wallet-address">${escapeText(shortAddress(wallet))}</span>`;
}

function renderToken(href: string | undefined, symbol: string, address: string): string {
  const label = displayTokenTicker(symbol, address);
  const title = tokenTickerTitle(symbol, address);
  return href
    ? `<a class="admin-token-pill" href="${escapeAttr(href)}" target="_blank" rel="noreferrer" title="${escapeAttr(title)}" aria-label="${escapeAttr(`Open ${label} on GMGN`)}"><span class="admin-token-pill-text">${escapeText(label)}</span></a>`
    : `<span class="admin-token-pill" title="${escapeAttr(title)}"><span class="admin-token-pill-text">${escapeText(label)}</span></span>`;
}

function adminExplorerBaseUrl(chain: ChainSlug): string | undefined {
  return getChain(chain).explorerBaseUrl?.replace(/\/+$/g, "");
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short"
  });
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "-";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
  return `$${value.toFixed(2)}`;
}

function formatSignedUsd(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatUsd(value)}`;
}

function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return "-";
  if (value >= 1) return `$${value.toFixed(4)}`;
  return `$${value.toPrecision(6)}`;
}

function formatAmount(value: number): string {
  if (!Number.isFinite(value)) return "-";
  if (Math.abs(value) >= 1_000_000) return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (Math.abs(value) >= 1) return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return value.toPrecision(6);
}

function formatBps(value: number): string {
  return `${(value / 100).toFixed(2)}%`;
}
