import type { ChainSlug } from "../../types";
import { chainLabel, getChain, isChainSlug } from "../../chains/registry";
import { isMarketBoardChain } from "../marketChains";
import { standaloneChartScript } from "./chartScript";
import { escapeAttr, escapeText, page } from "./shared";

export function chartPage(url: URL, publicMarketApiBase?: string): string {
  const [, , chain = "base", ...poolParts] = url.pathname.split("/");
  const poolId = decodeURIComponent(poolParts.join("/"));
  const chainSlug = isChainSlug(chain) ? chain : "base";
  if (isMarketBoardChain(chainSlug)) {
    const chainName = chainLabel(chainSlug);
    const endpoint = `${publicMarketApiBase ?? ""}/api/market/${chainSlug}/${encodeURIComponent(poolId)}`;
    return page(`${chainName} Pool · baes scan`, `
      <div class="chart-shell">
        <aside class="dex-sidebar is-compact" aria-label="Navigation">
          <a class="brand-mark" href="/"><span>baes</span><strong>scan</strong></a>
          <nav class="side-nav">
            <a href="/"><span class="nav-icon">←</span>Markets</a>
            <a href="${escapeAttr(endpoint)}"><span class="nav-icon">⌬</span>JSON</a>
            <a href="#trades"><span class="nav-icon">≡</span>Trades</a>
          </nav>
        </aside>
        <div class="chart-app">
          <header class="dex-top is-compact">
            <div class="pair-head" id="pairHead">
              <span class="token-avatar token-avatar-large" id="tokenAvatar">?</span>
              <div class="pair-text">
                <p class="eyebrow" id="pairChain">${escapeText(chainName)}</p>
                <h1 id="pairTitle">${escapeText(shortAddressForServer(poolId))}</h1>
                <p class="pair-meta">
                  <span class="dex-chip" id="pairDex">—</span>
                  <span class="mono muted" id="pairPool">pool ${escapeText(shortAddressForServer(poolId))}</span>
                  <span class="mono muted" id="pairToken">token —</span>
                </p>
              </div>
            </div>
            <div class="pair-price" id="pairPrice" aria-live="polite">
              <strong id="bigPrice">–</strong>
              <span id="bigChange" class="muted">–</span>
            </div>
          </header>

          <section class="kpi-strip" aria-label="Key stats">
            <div><dt>Price</dt><dd id="kpiPrice">–</dd></div>
            <div><dt>24h Change</dt><dd id="kpiChange24h">–</dd></div>
            <div><dt>24h Volume</dt><dd id="kpiVol24h">–</dd></div>
            <div><dt>24h Txns</dt><dd id="kpiTxns24h">–</dd></div>
            <div><dt>Liquidity</dt><dd id="kpiLiquidity">–</dd></div>
            <div><dt>Market cap</dt><dd id="kpiMcap">–</dd></div>
            <div><dt>FDV</dt><dd id="kpiFdv">–</dd></div>
          </section>

          <section class="chart-layout">
            <div class="chart-card">
              <div class="chart-card-head">
                <div class="window-pills" role="tablist" aria-label="Window change">
                  <span class="window-pill" data-window="m15"><b>15m</b> <em id="winM15">–</em></span>
                  <span class="window-pill" data-window="h1"><b>1h</b> <em id="winH1">–</em></span>
                  <span class="window-pill" data-window="h6"><b>6h</b> <em id="winH6">–</em></span>
                  <span class="window-pill" data-window="h24"><b>24h</b> <em id="winH24">–</em></span>
                </div>
                <div class="inline-actions">
                  <a class="ghost-link is-disabled" id="explorerLink" target="_blank" rel="noreferrer" role="link" aria-disabled="true">Explorer</a>
                  <a class="ghost-link is-disabled" id="geckoLink" target="_blank" rel="noreferrer" role="link" aria-disabled="true">GeckoTerminal</a>
                </div>
              </div>
              <div class="iframe-wrap" id="chartFrameWrap">
                <div class="empty-chart" id="chartLoading">Loading chart…</div>
              </div>
              <p class="chart-source muted" id="status">GeckoTerminal chart - archive loading</p>
            </div>

            <aside class="info-card" aria-label="Token information">
              <div class="info-card-head">
                <p class="eyebrow">Pair info</p>
                <span class="muted mono" id="refreshState">–</span>
              </div>
              <dl class="info-list">
                <div><dt>Name</dt><dd id="infoName">–</dd></div>
                <div><dt>Symbol</dt><dd id="infoSymbol">–</dd></div>
                <div><dt>Chain</dt><dd id="infoChain">${escapeText(chainName)}</dd></div>
                <div><dt>DEX</dt><dd id="infoDex">–</dd></div>
                <div><dt>Pool</dt><dd id="infoPool" class="mono">–</dd></div>
                <div><dt>Quote</dt><dd id="infoQuote">–</dd></div>
                <div><dt>Token</dt><dd id="infoToken" class="mono">–</dd></div>
                <div><dt>Window</dt><dd id="infoWindow" class="mono">–</dd></div>
              </dl>
            </aside>
          </section>

          <section class="trades-card" id="trades" aria-label="Recent trades">
            <header class="trades-head">
              <div><p class="eyebrow">Archived tape</p><h2>Recent swaps</h2></div>
              <span class="muted mono" id="tradesMeta">–</span>
            </header>
            <div class="table-scroll">
              <table class="dex-table is-trades">
                <thead><tr>
                  <th>Side</th>
                  <th class="num">Total</th>
                  <th class="num">Amount</th>
                  <th class="num">Price</th>
                  <th class="num">Age</th>
                  <th>Tx</th>
                </tr></thead>
                <tbody id="tradeRows"><tr><td colspan="6" class="empty-cell">Waiting for swaps…</td></tr></tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
      <script>${standaloneChartScript(endpoint, chainSlug, publicMarketApiBase, getChain(chainSlug).geckoNetwork)}</script>
    `);
  }
  const endpoint = `/api/raw/${encodeURIComponent(chain)}/${encodeURIComponent(poolId)}`;
  return page("Pool Data · baes scan", `
    <nav class="page-nav" aria-label="Site navigation">
      <button class="button-link" onclick="history.length > 1 ? history.back() : location.assign('/')" type="button">← Back</button>
      <a class="button-link" href="/">Markets</a>
    </nav>
    <section>
      <p class="eyebrow">${escapeText(chainLabel((isChainSlug(chain) ? chain : "base") as ChainSlug))}</p>
      <h1>Pool ${escapeText(poolId)}</h1>
      <p>${escapeText(chainLabel((isChainSlug(chain) ? chain : "base") as ChainSlug))} pools fall back to the raw-data preview when a GeckoTerminal embed is not available.</p>
      <pre id="raw">Loading…</pre>
    </section>
    <script>
      const rawEndpoint = ${JSON.stringify(endpoint)};
      fetch(rawEndpoint)
        .then((r) => r.json())
        .then((json) => { document.getElementById('raw').textContent = JSON.stringify(json, null, 2); })
        .catch((error) => { document.getElementById('raw').textContent = String(error); });
    </script>
  `);
}

function shortAddressForServer(value: string): string {
  if (!value || value.length <= 14) return value || "";
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
