import { getChain } from "../../chains/registry";
import { gmgnTokenUrl, isWalletPnlIgnoredToken } from "../../services/walletPnlFilters";
import type { Env } from "../../config/env";
import type { WalletPnlCursor, WalletPnlSnapshot, WalletPnlTokenRef, WalletPnlWalletSummary } from "../../store/storage";
import type { ChainSlug } from "../../types";
import { shortAddress } from "../../utils/address";
import { displayTokenTicker, tokenTickerTitle } from "../tokenDisplay";
import { escapeAttr, escapeText, page } from "./shared";

interface WalletPnlAdminPageOptions {
  env: Pick<Env, "walletPnlChain" | "walletPnlEnabled" | "walletPnlPostChatId" | "walletPnlSnapshotLimit">;
  snapshot?: WalletPnlSnapshot;
  cursor?: WalletPnlCursor;
  tokenRefsByWallet?: Record<string, WalletPnlTokenRef[]>;
  sort?: WalletPnlSort;
}

interface WalletPnlGatePageOptions {
  chainName: string;
  chainId?: number;
  tokenAddress: string;
  minBalance: string;
  heading?: string;
  copy?: string;
  returnPath?: string;
  error?: string;
}

export type WalletPnlSortKey = "realized" | "roi" | "proceeds" | "cost" | "volume" | "trades" | "lastBlock";
export type WalletPnlSortDir = "asc" | "desc";

export interface WalletPnlSort {
  key: WalletPnlSortKey;
  dir: WalletPnlSortDir;
}

const TOKEN_LIST_VISIBLE_LIMIT = 3;
const DEFAULT_WALLET_PNL_SORT: WalletPnlSort = { key: "realized", dir: "desc" };
const WALLET_PNL_SORT_LABELS: Record<WalletPnlSortKey, string> = {
  realized: "PnL",
  roi: "ROI",
  proceeds: "Proceeds",
  cost: "Cost",
  volume: "Volume",
  trades: "Trades",
  lastBlock: "Last block"
};

export function walletPnlAdminGatePage(options: WalletPnlGatePageOptions): string {
  const heading = options.heading ?? "baes intel";
  const returnPath = options.returnPath ?? "/intel";
  const copy = options.copy ?? `Connect a wallet holding ${formatTokenAmount(options.minBalance)} or more $BAES on ${options.chainName}.`;
  return page("baes intel", `
    <div class="admin-login-shell">
      <section class="admin-login-panel" aria-labelledby="adminGateTitle">
        <a class="brand-mark" href="/"><span>baes</span><strong>scan</strong></a>
        <div>
          <p class="eyebrow">Holder gate</p>
          <h1 id="adminGateTitle">${escapeText(heading)}</h1>
          <p class="admin-login-copy">${escapeText(copy)}</p>
        </div>
        ${options.error ? `<p class="admin-error">${escapeText(options.error)}</p>` : ""}
        <div class="admin-gate-card">
          <dl>
            <div>
              <dt>Chain</dt>
              <dd>${escapeText(options.chainName)}</dd>
            </div>
            <div>
              <dt>Token</dt>
              <dd class="mono">${escapeText(options.tokenAddress)}</dd>
            </div>
          </dl>
          <button id="walletPnlGateButton" class="button-link is-primary" type="button">Connect wallet</button>
          <p id="walletPnlGateStatus" class="admin-gate-status" role="status" aria-live="polite"></p>
        </div>
        <div class="inline-actions">
          <a class="ghost-link" href="/">Back to baes scan</a>
        </div>
      </section>
    </div>
    <script>
      (() => {
        const button = document.getElementById("walletPnlGateButton");
        const status = document.getElementById("walletPnlGateStatus");
        const setStatus = (text, isError = false) => {
          if (!status) return;
          status.textContent = text;
          status.classList.toggle("is-error", isError);
        };
        const requestJson = async (url, options) => {
          const response = await fetch(url, { credentials: "same-origin", ...options });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok || payload.ok === false) {
            throw new Error(payload.error || "Wallet gate request failed.");
          }
          return payload;
        };
        button?.addEventListener("click", async () => {
          if (!window.ethereum?.request) {
            setStatus("No wallet provider found in this browser.", true);
            return;
          }
          button.disabled = true;
          try {
            setStatus("Requesting wallet access...");
            const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
            const address = accounts?.[0];
            if (!address) throw new Error("No wallet account selected.");
            const challenge = await requestJson("/intel/gate/challenge?address=" + encodeURIComponent(address));
            if (challenge.chainId) {
              try {
                await window.ethereum.request({
                  method: "wallet_switchEthereumChain",
                  params: [{ chainId: "0x" + Number(challenge.chainId).toString(16) }]
                });
              } catch {
                // The server-side balance check is authoritative; switching is only a convenience.
              }
            }
            setStatus("Waiting for signature...");
            const signature = await window.ethereum.request({
              method: "personal_sign",
              params: [challenge.message, address]
            });
            setStatus("Checking token balance...");
            await requestJson("/intel/gate/verify", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ address, signature })
            });
            setStatus("Unlocked. Opening intel...");
            window.location.assign(${JSON.stringify(returnPath)});
          } catch (error) {
            setStatus(error?.message || "Wallet gate failed.", true);
            button.disabled = false;
          }
        });
      })();
    </script>
  `, {
    description: `Connect a wallet holding ${formatTokenAmount(options.minBalance)} or more BAES on ${options.chainName} to open baes intel.`,
    canonicalPath: "/intel",
    imagePath: "/og/baes-intel.png",
    robots: "noindex, nofollow"
  });
}

export function walletPnlAdminPage(options: WalletPnlAdminPageOptions): string {
  const chain = options.snapshot?.chain ?? options.env.walletPnlChain;
  const chainName = getChain(chain).name;
  const snapshot = options.snapshot;
  return page("Wallet PnL intel", `
    <div class="dex-shell admin-shell">
      <aside class="dex-sidebar" aria-label="Wallet PnL navigation">
        <a class="brand-mark" href="/"><span>baes</span><strong>scan</strong></a>
        <nav class="side-nav">
          <a href="/intel"><span class="nav-icon">I</span>Intel</a>
          <a class="is-active" href="/intel/wallet-pnl"><span class="nav-icon">P</span>Wallet PnL</a>
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
        <div class="side-block">
          <p>Status</p>
          <span class="side-link">${options.env.walletPnlEnabled ? "Indexer enabled" : "Indexer disabled"}</span>
          <span class="side-link">${escapeText(chainName)}</span>
        </div>
      </aside>

      <div class="admin-app">
        <header class="admin-top">
          <div>
            <p class="eyebrow">Wallet intel</p>
            <h1>${escapeText(chainName)} wallet PnL</h1>
          </div>
          <div class="inline-actions">
            <a class="ghost-link" href="/intel/wallet-pnl">Refresh</a>
            <a class="ghost-link" href="/intel/wallet-pnl/tokens">Tokens</a>
            <a class="ghost-link" href="/intel/wallet-pnl/tokens/new">New Tokens</a>
            <a class="ghost-link" href="/intel/wallet-pnl/leaderboards/pnl">Leaders</a>
            <a class="ghost-link" href="/intel/wallet-pnl/signals">Signals</a>
            <a class="ghost-link" href="/intel/wallet-pnl/overlap">Overlap</a>
            <a class="ghost-link" href="/intel/wallet-pnl/cohort">Cohort</a>
            <a class="ghost-link" href="/intel/wallet-pnl/risk/tokens">Token Risk</a>
            <a class="ghost-link" href="/intel/wallet-pnl/risk/wallets">Wallet Risk</a>
            <a class="ghost-link" href="/intel/wallet-pnl/pools">Pools</a>
            <a class="ghost-link" href="/intel/wallet-pnl/status">Status</a>
          </div>
        </header>

        ${snapshot ? renderSnapshot(snapshot, options.cursor, options.tokenRefsByWallet, options.sort ?? DEFAULT_WALLET_PNL_SORT) : renderEmptyState(chain, options.cursor)}
      </div>
    </div>
  `, {
    description: `${chainName} wallet PnL, realized exits, retained-window flow, and wallet intel from baes scan.`,
    canonicalPath: "/intel/wallet-pnl",
    imagePath: "/og/baes-intel.png",
    robots: "noindex, nofollow"
  });
}

function renderSnapshot(
  snapshot: WalletPnlSnapshot,
  cursor?: WalletPnlCursor,
  tokenRefsByWallet?: Record<string, WalletPnlTokenRef[]>,
  sort: WalletPnlSort = DEFAULT_WALLET_PNL_SORT
): string {
  const sortedWallets = sortWalletSummaries(snapshot.top, sort);
  const rows = sortedWallets.map((wallet, index) => renderWalletRow(wallet, index, snapshot.chain, tokenRefsByWallet)).join("");
  return `
    <section class="admin-summary" aria-labelledby="walletPnlSummaryTitle">
      <div class="admin-summary-copy">
        <div class="admin-title-row">
          <h2 id="walletPnlSummaryTitle">Latest snapshot</h2>
          <span class="source-pill${snapshot.partial ? " is-warning" : ""}">${snapshot.partial ? "Catching up" : "Ready"}</span>
        </div>
        <p>Generated ${escapeText(formatDateTime(snapshot.generatedAt))}. Window is ${snapshot.windowHours}h; normalized trades are retained for ${snapshot.retentionDays}d.</p>
      </div>
      <dl class="admin-metrics">
        <div><dt>Profitable wallets</dt><dd>${snapshot.top.length.toLocaleString()}</dd></div>
        <div><dt>Wallets seen</dt><dd>${snapshot.walletCount.toLocaleString()}</dd></div>
        <div><dt>Window trades</dt><dd>${snapshot.tradeCount.toLocaleString()}</dd></div>
        <div><dt>Scanned block</dt><dd>${snapshot.toBlock.toLocaleString()}</dd></div>
        <div><dt>Cursor</dt><dd>${cursor?.lastBlock !== undefined ? cursor.lastBlock.toLocaleString() : "-"}</dd></div>
        <div><dt>Last post</dt><dd>${cursor?.lastPostedAt ? escapeText(formatDateTime(cursor.lastPostedAt)) : "-"}</dd></div>
      </dl>
    </section>

    <section class="board-card admin-wallet-card" aria-label="Wallet PnL table">
      <div class="admin-table-toolbar">
        <span>Sort</span>
        ${renderSortToolbar(sort)}
      </div>
      <div class="table-scroll">
        <table class="dex-table admin-wallet-table">
          <thead>
            <tr>
              <th>Rank</th>
              <th>Wallet</th>
              <th class="num">${renderSortHeader("realized", "Realized PnL", sort)}</th>
              <th class="num">${renderSortHeader("roi", "ROI", sort)}</th>
              <th class="num">${renderSortHeader("proceeds", "Proceeds", sort)}</th>
              <th class="num">${renderSortHeader("cost", "Cost", sort)}</th>
              <th class="num">${renderSortHeader("volume", "Volume", sort)}</th>
              <th>${renderSortHeader("trades", "Trades", sort)}</th>
              <th>Tokens</th>
              <th class="num">${renderSortHeader("lastBlock", "Last block", sort)}</th>
              <th>Links</th>
            </tr>
          </thead>
          <tbody>
            ${rows || `<tr><td colspan="11" class="empty-cell">No profitable realized exits in the current window.</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderSortToolbar(sort: WalletPnlSort): string {
  return (Object.keys(WALLET_PNL_SORT_LABELS) as WalletPnlSortKey[])
    .map((key) => renderSortControl(key, WALLET_PNL_SORT_LABELS[key], sort))
    .join("");
}

function renderSortHeader(key: WalletPnlSortKey, label: string, sort: WalletPnlSort): string {
  return renderSortControl(key, label, sort, "admin-sort-link");
}

function renderSortControl(key: WalletPnlSortKey, label: string, sort: WalletPnlSort, className = "admin-sort-chip"): string {
  const active = sort.key === key;
  const nextDir: WalletPnlSortDir = active && sort.dir === "desc" ? "asc" : "desc";
  const dirLabel = active ? ` ${sort.dir === "desc" ? "v" : "^"}` : "";
  return `<a class="${escapeAttr(`${className}${active ? " is-active" : ""}`)}" href="${escapeAttr(sortHref(key, nextDir))}">${escapeText(label)}${dirLabel ? `<span>${escapeText(dirLabel.trim())}</span>` : ""}</a>`;
}

function sortHref(key: WalletPnlSortKey, dir: WalletPnlSortDir): string {
  return `/intel/wallet-pnl?sort=${encodeURIComponent(key)}&dir=${encodeURIComponent(dir)}`;
}

function sortWalletSummaries(wallets: WalletPnlWalletSummary[], sort: WalletPnlSort): WalletPnlWalletSummary[] {
  const direction = sort.dir === "asc" ? 1 : -1;
  return [...wallets].sort((a, b) => {
    const diff = walletSortValue(a, sort.key) - walletSortValue(b, sort.key);
    if (diff !== 0) return diff * direction;
    return b.realizedPnlUsd - a.realizedPnlUsd || b.volumeUsd - a.volumeUsd || a.wallet.localeCompare(b.wallet);
  });
}

function walletSortValue(wallet: WalletPnlWalletSummary, key: WalletPnlSortKey): number {
  if (key === "realized") return wallet.realizedPnlUsd;
  if (key === "roi") return wallet.roiPct ?? Number.NEGATIVE_INFINITY;
  if (key === "proceeds") return wallet.realizedProceedsUsd;
  if (key === "cost") return wallet.realizedCostUsd;
  if (key === "volume") return wallet.volumeUsd;
  if (key === "trades") return wallet.buyCount + wallet.sellCount;
  return wallet.lastBlock;
}

function renderEmptyState(chain: ChainSlug, cursor?: WalletPnlCursor): string {
  return `
    <section class="admin-summary" aria-labelledby="walletPnlEmptyTitle">
      <div class="admin-summary-copy">
        <div class="admin-title-row">
          <h2 id="walletPnlEmptyTitle">No snapshot yet</h2>
          <span class="source-pill is-warning">Waiting</span>
        </div>
        <p>The page is ready, but the ${escapeText(getChain(chain).name)} wallet-PnL indexer has not saved a snapshot yet.</p>
      </div>
      <dl class="admin-metrics">
        <div><dt>Cursor</dt><dd>${cursor?.lastBlock !== undefined ? cursor.lastBlock.toLocaleString() : "-"}</dd></div>
        <div><dt>Updated</dt><dd>${cursor?.updatedAt ? escapeText(formatDateTime(cursor.updatedAt)) : "-"}</dd></div>
      </dl>
    </section>
  `;
}

function renderWalletRow(
  wallet: WalletPnlWalletSummary,
  index: number,
  chain: ChainSlug,
  tokenRefsByWallet?: Record<string, WalletPnlTokenRef[]>
): string {
  const explorer = adminExplorerBaseUrl(chain);
  const walletUrl = explorer ? `${explorer}/address/${wallet.wallet}` : undefined;
  const txUrl = explorer ? `${explorer}/tx/${wallet.lastTxHash}` : undefined;
  const roi = wallet.roiPct !== undefined ? `${formatPct(wallet.roiPct)}` : "-";
  const tokenRefs = tokenRefsByWallet?.[wallet.wallet.toLowerCase()] ?? wallet.tradedTokenRefs ?? [];
  const tokens = renderTokenList(chain, tokenRefs, wallet.tradedTokens, `wallet-pnl-tokens-${index}`);
  const exits = `${wallet.profitableExitCount}/${wallet.losingExitCount}`;
  return `
    <tr>
      <td data-label="Rank">${index + 1}</td>
      <td data-label="Wallet" class="wallet-cell">
        ${walletUrl
          ? `<a class="mono wallet-address" href="${escapeAttr(walletUrl)}" target="_blank" rel="noreferrer" title="${escapeAttr(wallet.wallet)}">${escapeText(shortAddress(wallet.wallet))}</a>`
          : `<span class="mono wallet-address" title="${escapeAttr(wallet.wallet)}">${escapeText(shortAddress(wallet.wallet))}</span>`}
      </td>
      <td data-label="Realized PnL" class="num good">${escapeText(formatSignedUsd(wallet.realizedPnlUsd))}</td>
      <td data-label="ROI" class="num">${escapeText(roi)}</td>
      <td data-label="Proceeds" class="num">${escapeText(formatUsd(wallet.realizedProceedsUsd))}</td>
      <td data-label="Cost" class="num">${escapeText(formatUsd(wallet.realizedCostUsd))}</td>
      <td data-label="Volume" class="num">${escapeText(formatUsd(wallet.volumeUsd))}</td>
      <td data-label="Trades">${wallet.buyCount.toLocaleString()} buy / ${wallet.sellCount.toLocaleString()} sell <span class="muted">(${escapeText(exits)} exits)</span></td>
      <td data-label="Tokens" class="token-list">${tokens}</td>
      <td data-label="Last block" class="num">${wallet.lastBlock.toLocaleString()}</td>
      <td data-label="Links">
        <div class="admin-link-row">
          ${walletUrl ? `<a href="${escapeAttr(walletUrl)}" target="_blank" rel="noreferrer">Wallet</a>` : ""}
          ${txUrl ? `<a href="${escapeAttr(txUrl)}" target="_blank" rel="noreferrer">Tx</a>` : ""}
        </div>
      </td>
    </tr>
  `;
}

function renderTokenList(chain: ChainSlug, refs: WalletPnlTokenRef[], symbols: string[], popoverId: string): string {
  const visibleRefs = refs.filter((ref) => !isWalletPnlIgnoredToken(chain, ref.address, ref.symbol));
  if (visibleRefs.length > 0) {
    const items = visibleRefs.map((ref) => ({
      href: gmgnTokenUrl(chain, ref.address),
      label: displayTokenTicker(ref.symbol, ref.address),
      title: tokenTickerTitle(ref.symbol, ref.address)
    }));
    return renderTokenItems(items, popoverId);
  }
  const visibleSymbols = symbols.filter((symbol) => !isWalletPnlIgnoredToken(chain, undefined, symbol));
  if (visibleSymbols.length > 0) {
    return renderTokenItems(visibleSymbols.map((symbol) => ({
      label: displayTokenTicker(symbol),
      title: tokenTickerTitle(symbol)
    })), popoverId);
  }
  return `<span class="muted">-</span>`;
}

function renderTokenItems(items: Array<{ href?: string; label: string; title: string }>, popoverId: string): string {
  const visible = items.slice(0, TOKEN_LIST_VISIBLE_LIMIT);
  const hidden = items.slice(TOKEN_LIST_VISIBLE_LIMIT);
  const fullTitle = items.map((item) => item.title).join(", ");
  return `<span class="admin-token-summary" title="${escapeAttr(fullTitle)}">${visible.map((item, index) => {
    const separator = index < visible.length - 1 || hidden.length > 0 ? `<span class="admin-token-separator">, </span>` : "";
    const token = item.href
      ? `<a class="admin-token-link" href="${escapeAttr(item.href)}" target="_blank" rel="noreferrer" title="${escapeAttr(item.title)}" aria-label="${escapeAttr(`Open ${item.label} on GMGN`)}">${escapeText(item.label)}</a>`
      : `<span class="admin-token-link" title="${escapeAttr(item.title)}">${escapeText(item.label)}</span>`;
    return `${token}${separator}`;
  }).join("")}${hidden.length > 0 ? renderTokenPopover(items, hidden.length, popoverId) : ""}</span>`;
}

function adminExplorerBaseUrl(chain: ChainSlug): string | undefined {
  return getChain(chain).explorerBaseUrl?.replace(/\/+$/g, "");
}

function renderTokenPopover(items: Array<{ href?: string; label: string; title: string }>, hiddenCount: number, popoverId: string): string {
  return `<button class="admin-token-more" type="button" popovertarget="${escapeAttr(popoverId)}" title="Show all tokens">+${hiddenCount}</button><div id="${escapeAttr(popoverId)}" class="admin-token-popover" popover>
    <div class="admin-token-popover-head">All tokens</div>
    <div class="admin-token-popover-list">
      ${items.map((item) => item.href
        ? `<a class="admin-token-popover-link" href="${escapeAttr(item.href)}" target="_blank" rel="noreferrer" title="${escapeAttr(item.title)}">${escapeText(item.label)}</a>`
        : `<span class="admin-token-popover-link" title="${escapeAttr(item.title)}">${escapeText(item.label)}</span>`
      ).join("")}
    </div>
  </div>`;
}

function formatTokenAmount(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return parsed.toLocaleString(undefined, { maximumFractionDigits: 6 });
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

function formatPct(value: number): string {
  if (!Number.isFinite(value)) return "-";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}
