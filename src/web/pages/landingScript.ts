import type { ChainSlug } from "../../types";

export function marketScript(publicMarketApiBase?: string, chainNames: Record<string, string> = {}, initialChain: ChainSlug = "base"): string {
  return `
const state = { chain: ${JSON.stringify(initialChain)}, view: 'trending', markets: [], pairs: [], filter: '', lastPayload: null };
const fmtUsd = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 6 });
const fmtShortUsd = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 });
const fmtNumber = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 2 });
const chainNames = ${JSON.stringify(chainNames)};
const head = document.getElementById('marketHead');
const rows = document.getElementById('marketRows');
const statusEl = document.getElementById('status');
const windowEl = document.getElementById('window');
const boardTitle = document.getElementById('boardTitle');
const boardSub = document.getElementById('boardSub');
const apiLink = document.getElementById('apiLink');
const searchInput = document.getElementById('marketSearch');
const clearSearchButton = document.getElementById('clearSearch');
const dataSourceEl = document.getElementById('dataSource');
const metricVolume = document.getElementById('metricVolume');
const metricTxns = document.getElementById('metricTxns');
const metricBlock = document.getElementById('metricBlock');
const metricPairs = document.getElementById('metricPairs');
const apiBase = ${JSON.stringify(publicMarketApiBase ?? "")};

// View tab switches (top + sidebar)
document.querySelectorAll('[data-view], [data-tab]').forEach(function (button) {
  button.addEventListener('click', function (event) {
    const view = button.getAttribute('data-view') || button.getAttribute('data-tab') || 'trending';
    if (button.tagName === 'A') event.preventDefault();
    loadView(view, false);
  });
});

document.querySelectorAll('[data-chain]').forEach(function (button) {
  button.addEventListener('click', function () {
    if (button.disabled || button.getAttribute('aria-disabled') === 'true') return;
    const chain = button.getAttribute('data-chain') || 'base';
    if (chain === state.chain) return;
    state.chain = chain;
    document.querySelectorAll('[data-chain]').forEach(function (item) {
      const isActive = item.getAttribute('data-chain') === chain;
      item.classList.toggle('is-active', isActive);
      item.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    loadView(state.view, false);
  });
});

if (searchInput) {
  searchInput.addEventListener('input', function () {
    state.filter = searchInput.value || '';
    syncSearchUi();
    renderRows();
  });
  searchInput.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
      const firstRow = rows && rows.querySelector('.market-row');
      const href = firstRow && firstRow.getAttribute('data-href');
      if (href) window.location.href = href;
    }
  });
  window.addEventListener('keydown', function (event) {
    const target = event.target;
    const tagName = target && target.tagName ? target.tagName.toLowerCase() : '';
    const isTyping = tagName === 'input' || tagName === 'textarea' || tagName === 'select' || (target && target.isContentEditable);
    if (!isTyping && event.key === '/') {
      event.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
  });
}
if (clearSearchButton && searchInput) {
  clearSearchButton.addEventListener('click', function () {
    searchInput.value = '';
    state.filter = '';
    syncSearchUi();
    renderRows();
    searchInput.focus();
  });
}

let pollTimer = null;
let consecutiveErrors = 0;
function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer);
  if (document.hidden) return;
  const base = 30000;
  const backoff = Math.min(8, consecutiveErrors);
  const delay = base * Math.pow(1.6, backoff);
  pollTimer = setTimeout(function () { loadView(state.view, true); }, delay);
}
document.addEventListener('visibilitychange', function () {
  if (!document.hidden) loadView(state.view, true);
  else if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
});

const VIEW_LABELS = {
  trending: { headline: 'trending pools', sub: 'Active pools ranked by volume, swaps, price movement, and recency.' },
  new: { headline: 'new pairs', sub: 'Recently created pools, with the first parsed buy when the scan catches one.' },
  gainers: { headline: 'top gainers', sub: 'Pools with positive 24h movement, ranked from strongest move down.' },
  losers: { headline: 'top losers', sub: 'Pools with negative 24h movement, ranked from steepest move down.' }
};

loadView('trending', false);

function loadView(view, quiet) {
  state.view = view;
  const chainName = activeChainName();
  syncViewIndicators();
  const label = VIEW_LABELS[view] || VIEW_LABELS.trending;
  if (boardTitle) boardTitle.textContent = chainName + ' ' + label.headline;
  if (boardSub) boardSub.textContent = label.sub;
  if (apiLink) apiLink.href = endpointFor(view);

  if (!quiet) {
    updateStatus(view === 'new'
      ? 'Loading archived new ' + chainName + ' pools'
      : 'Loading archived ' + chainName + ' markets');
    windowEl.textContent = '';
    rows.innerHTML = loadingRows(view);
  }

  fetchJson(endpointFor(view))
    .then(function (payload) {
      if (view === 'new') {
        state.pairs = payload.pairs || [];
      } else {
        state.markets = payload.markets || [];
      }
      windowEl.textContent = windowText(payload);
      updateDataSource(payload);
      state.lastPayload = payload;
      renderRows();
      consecutiveErrors = 0;
      schedulePoll();
    })
    .catch(function (error) {
      updateStatus(view === 'new' ? 'New-pairs scan failed' : 'Market scan failed');
      rows.innerHTML = '<tr><td colspan="' + (view === 'new' ? '8' : '14') + '" class="empty-cell error">' + escapeHtml(errorHint(error)) + '</td></tr>';
      consecutiveErrors += 1;
      schedulePoll();
    });
}

function updateStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function loadingRows(view) {
  const cols = view === 'new' ? 8 : 14;
  const rows = [];
  for (let i = 0; i < 6; i += 1) {
    rows.push('<tr class="skeleton-row"><td colspan="' + cols + '"><span></span></td></tr>');
  }
  return rows.join('');
}

function fetchJson(url) {
  return fetch(url, { cache: 'no-store' })
    .then(function (response) {
      return response.text().then(function (text) {
        const payload = parseJson(text);
        payload.__dataSource = dataSourceFrom(response, payload);
        payload.__snapshotKey = response.headers.get('x-snapshot-key') || '';
        if (!response.ok) {
          const message = payload.error || ('Market API returned ' + response.status);
          const error = new Error(message);
          error.status = response.status;
          error.payload = payload;
          throw error;
        }
        return payload;
      });
    });
}

function parseJson(text) {
  if (!text) return {};
  try { return JSON.parse(text); }
  catch {
    throw new Error('Market API returned invalid JSON');
  }
}

function dataSourceFrom(response, payload) {
  const header = (response.headers.get('x-data-source') || '').toLowerCase();
  if (header.indexOf('r2') !== -1 || payload.source === 'r2-snapshot' || payload.source === 'r2-archive') return 'r2';
  return 'raw-rpc';
}

function sourceLabel(payload) {
  return payload && payload.__dataSource === 'r2' ? 'Archive snapshot' : 'Live producer';
}

function updateDataSource(payload) {
  if (!dataSourceEl) return;
  dataSourceEl.textContent = sourceLabel(payload);
  dataSourceEl.classList.toggle('is-r2', payload && payload.__dataSource === 'r2');
  dataSourceEl.title = payload && payload.__snapshotKey ? payload.__snapshotKey : '';
}

function windowText(payload) {
  const pieces = [];
  if (payload.fromBlock !== undefined && payload.toBlock !== undefined) pieces.push('blocks ' + payload.fromBlock + '–' + payload.toBlock);
  if (payload.generatedAt) pieces.push('updated ' + relativeTime(payload.generatedAt));
  if (payload.cacheMs) pieces.push('refresh ' + Math.round(payload.cacheMs / 1000) + 's');
  return pieces.join(' · ');
}

function relativeTime(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return 'recently';
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return seconds + 's ago';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + 'm ago';
  const hours = Math.round(minutes / 60);
  if (hours < 48) return hours + 'h ago';
  return new Date(time).toLocaleDateString();
}

function errorHint(error) {
  const payload = error && error.payload ? error.payload : {};
  if (payload.error === 'snapshot missing') {
    return 'No saved market snapshot is available for this view yet.';
  }
  if (payload.error === 'chain not supported by this worker') {
    return 'This chain is not served by the current R2 worker.';
  }
  return 'The market board could not load this view. Try again in a moment.';
}

function syncViewIndicators() {
  document.querySelectorAll('[data-view]').forEach(function (button) {
    const isActive = button.getAttribute('data-view') === state.view;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
  document.querySelectorAll('[data-tab]').forEach(function (link) {
    link.classList.toggle('is-active', link.getAttribute('data-tab') === state.view);
  });
}

function endpointFor(view) {
  // gainers/losers reuse the trending payload; we re-sort it client-side.
  const path = (view === 'new') ? 'new-pairs' : 'trending';
  return apiBase + '/api/' + path + '/' + encodeURIComponent(state.chain);
}

function activeChainName() {
  return chainNames[state.chain] || state.chain;
}

function chartPathFor(item) {
  return '/chart/' + encodeURIComponent(state.chain) + '/' + encodeURIComponent(item.poolId);
}

function rankedMarkets() {
  const list = state.markets.slice();
  if (state.view === 'gainers') {
    return list
      .filter(function (market) { return Number.isFinite(Number(windowChange(market, 'h24'))) && Number(windowChange(market, 'h24')) > 0; })
      .sort(function (a, b) {
        return Number(windowChange(b, 'h24')) - Number(windowChange(a, 'h24'));
      });
  }
  if (state.view === 'losers') {
    return list
      .filter(function (market) { return Number.isFinite(Number(windowChange(market, 'h24'))) && Number(windowChange(market, 'h24')) < 0; })
      .sort(function (a, b) {
        return Number(windowChange(a, 'h24')) - Number(windowChange(b, 'h24'));
      });
  }
  return list;
}

function renderRows() {
  if (state.view === 'new') return renderNewPairRows();
  head.innerHTML = '<tr>' +
    '<th class="num">#</th>' +
    '<th>Pair</th>' +
    '<th class="num">Price</th>' +
    '<th class="num">Age</th>' +
    '<th class="num">Txns</th>' +
    '<th class="num">Volume</th>' +
    '<th class="num change">15m</th>' +
    '<th class="num change">1h</th>' +
    '<th class="num change">6h</th>' +
    '<th class="num change">24h</th>' +
    '<th class="num">Liquidity</th>' +
    '<th class="num">MCap</th>' +
    '<th>DEX</th>' +
    '<th aria-label="Open"></th>' +
    '</tr>';

  const source = rankedMarkets();
  const list = filterItems(source);
  updateOverview(state.lastPayload || {}, list);
  syncBoardStatus(source.length, list.length);
  if (!list.length) {
    rows.innerHTML = '<tr><td colspan="14" class="empty-cell">' + emptyMessageForView(source.length) + '</td></tr>';
    return;
  }
  rows.innerHTML = list.map(function (market, index) {
    const price = market.priceUsd ? fmtUsd.format(market.priceUsd) : numberWithQuote(market.price, market.quoteToken.symbol);
    const volume = market.volumeUsd ? fmtShortUsd.format(market.volumeUsd) : numberWithQuote(market.quoteVolume, market.quoteToken.symbol);
    const liquidity = market.liquidityUsd ? fmtShortUsd.format(market.liquidityUsd) : '–';
    const mcap = market.marketCapUsd ? fmtShortUsd.format(market.marketCapUsd) : '–';
    const href = chartPathFor(market);
    return '<tr class="market-row" data-href="' + escapeAttr(href) + '">' +
      '<td class="num muted" data-label="#">' + (index + 1) + '</td>' +
      '<td data-label="Pair">' + tokenCell(market) + '</td>' +
      '<td class="num mono" data-label="Price">' + escapeHtml(price) + '</td>' +
      '<td class="num mono muted" data-label="Age">' + formatElapsedMinutes(market.ageMinutes) + '</td>' +
      '<td class="num mono" data-label="Txns">' + fmtNumber.format(market.swapCount || 0) + '</td>' +
      '<td class="num mono" data-label="Volume">' + escapeHtml(volume) + '</td>' +
      '<td class="num" data-label="15m">' + changeHtml(windowChange(market, 'm15')) + '</td>' +
      '<td class="num" data-label="1h">' + changeHtml(windowChange(market, 'h1')) + '</td>' +
      '<td class="num" data-label="6h">' + changeHtml(windowChange(market, 'h6')) + '</td>' +
      '<td class="num" data-label="24h">' + changeHtml(windowChange(market, 'h24')) + '</td>' +
      '<td class="num mono muted" data-label="Liquidity">' + escapeHtml(liquidity) + '</td>' +
      '<td class="num mono" data-label="MCap">' + escapeHtml(mcap) + '</td>' +
      '<td data-label="DEX"><span class="dex-chip">' + escapeHtml(market.dex) + ' ' + escapeHtml(market.protocol) + '</span></td>' +
      '<td class="num row-open" data-label=""><a class="row-cta" href="' + escapeAttr(href) + '" aria-label="Open chart">→</a></td>' +
      '</tr>';
  }).join('');
  attachRowHandlers();
}

function renderNewPairRows() {
  head.innerHTML = '<tr>' +
    '<th class="num">#</th>' +
    '<th>Pair</th>' +
    '<th class="num">Age</th>' +
    '<th>First buy</th>' +
    '<th class="num">Txns</th>' +
    '<th>DEX</th>' +
    '<th>Pool</th>' +
    '<th aria-label="Open"></th>' +
    '</tr>';
  const source = state.pairs.slice();
  const list = filterItems(source);
  updateOverview(state.lastPayload || {}, list);
  syncBoardStatus(source.length, list.length);
  if (!list.length) {
    rows.innerHTML = '<tr><td colspan="8" class="empty-cell">' + emptyMessageForView(source.length) + '</td></tr>';
    return;
  }
  rows.innerHTML = list.map(function (pair, index) {
    const firstBuy = pair.firstBuy;
    const firstBuyTotal = firstBuy ? (firstBuy.volumeUsd ? fmtShortUsd.format(firstBuy.volumeUsd) : numberWithQuote(firstBuy.quoteAmount, pair.quoteToken.symbol)) : 'Waiting';
    const firstBuySmall = firstBuy ? formatAge(firstBuy.ageSeconds) + ' ago' : 'no buy parsed';
    const href = chartPathFor(pair);
    return '<tr class="market-row" data-href="' + escapeAttr(href) + '">' +
      '<td class="num muted" data-label="#">' + (index + 1) + '</td>' +
      '<td data-label="Pair">' + tokenCell(pair) + '</td>' +
      '<td class="num mono muted" data-label="Age">' + formatElapsedMinutes(pair.ageMinutes) + '</td>' +
      '<td data-label="First buy"><span class="side-pill ' + (firstBuy ? 'buy' : 'waiting') + '">' + (firstBuy ? 'BUY' : 'WAIT') + '</span><small>' + escapeHtml(firstBuyTotal + ' · ' + firstBuySmall) + '</small></td>' +
      '<td class="num mono" data-label="Txns">' + fmtNumber.format(pair.swapCount || 0) + '</td>' +
      '<td data-label="DEX"><span class="dex-chip">' + escapeHtml(pair.dex) + ' ' + escapeHtml(pair.protocol) + '</span></td>' +
      '<td class="mono muted" data-label="Pool">' + escapeHtml(shortAddress(pair.poolAddress || pair.poolId)) + '</td>' +
      '<td class="num row-open" data-label=""><a class="row-cta" href="' + escapeAttr(href) + '" aria-label="Open chart">→</a></td>' +
      '</tr>';
  }).join('');
  attachRowHandlers();
}

function attachRowHandlers() {
  document.querySelectorAll('.market-row').forEach(function (row) {
    row.addEventListener('click', function (event) {
      if (event.target && event.target.closest && event.target.closest('a,button')) return;
      const href = row.getAttribute('data-href');
      if (href) window.location.href = href;
    });
  });
}

function updateOverview(payload, items) {
  items = items || [];
  const volume = items.reduce(function (sum, item) {
    const eventVolume = item.firstBuy && item.firstBuy.volumeUsd ? item.firstBuy.volumeUsd : 0;
    return sum + (item.volumeUsd || eventVolume || 0);
  }, 0);
  const txns = items.reduce(function (sum, item) { return sum + (item.swapCount || 0); }, 0);
  if (metricVolume) metricVolume.textContent = volume > 0 ? fmtShortUsd.format(volume) : '–';
  if (metricTxns) metricTxns.textContent = fmtNumber.format(txns);
  if (metricBlock) metricBlock.textContent = payload.toBlock ? fmtNumber.format(payload.toBlock) : '–';
  if (metricPairs) metricPairs.textContent = fmtNumber.format(items.length);
}

function normalizedSearch() {
  return String(state.filter || '').trim().toLowerCase();
}

function filterItems(items) {
  const query = normalizedSearch();
  if (!query) return items;
  return items.filter(function (item) {
    return searchBlob(item).indexOf(query) !== -1;
  });
}

function syncSearchUi() {
  if (!clearSearchButton) return;
  clearSearchButton.classList.toggle('is-visible', normalizedSearch().length > 0);
}

function searchBlob(item) {
  const parts = [
    item.pairLabel,
    item.poolId,
    item.poolAddress,
    item.dex,
    item.protocol,
    item.baseToken && item.baseToken.name,
    item.baseToken && item.baseToken.symbol,
    item.baseToken && item.baseToken.address,
    item.quoteToken && item.quoteToken.name,
    item.quoteToken && item.quoteToken.symbol,
    item.quoteToken && item.quoteToken.address
  ];
  return parts.filter(Boolean).join(' ').toLowerCase();
}

function viewNoun() {
  if (state.view === 'new') return 'new pools';
  if (state.view === 'gainers') return 'gainers';
  if (state.view === 'losers') return 'losers';
  return 'active pools';
}

function syncBoardStatus(sourceCount, visibleCount) {
  const query = normalizedSearch();
  const chainName = activeChainName();
  const noun = viewNoun();
  if (query) {
    updateStatus(visibleCount + ' of ' + sourceCount + ' ' + chainName + ' ' + noun + ' match search');
    return;
  }
  updateStatus(sourceCount + ' ' + chainName + ' ' + noun);
}

function emptyMessageForView(sourceCount) {
  const query = normalizedSearch();
  if (query && sourceCount > 0) return 'No matches for "' + escapeHtml(query) + '".';
  if (state.view === 'new') return 'No fresh pairs surfaced in this window yet.';
  if (state.view === 'gainers') return 'No positive movers in this window yet.';
  if (state.view === 'losers') return 'No negative movers in this window yet.';
  return 'No active pools surfaced in this window yet.';
}

function tokenCell(item) {
  const symbol = item.baseToken && item.baseToken.symbol ? item.baseToken.symbol : item.pairLabel.split('/')[0];
  const href = gmgnTokenUrl(state.chain, item.baseToken && item.baseToken.address);
  const tag = href ? 'a' : 'div';
  const attrs = href ? ' href="' + escapeAttr(href) + '" target="_blank" rel="noreferrer"' : '';
  return '<' + tag + ' class="token-cell' + (href ? ' token-cell-link' : '') + '"' + attrs + '>' +
    '<span class="token-avatar">' + escapeHtml(tokenInitials(symbol)) + '</span>' +
    '<span class="token-meta">' +
      '<strong>' + escapeHtml(item.pairLabel) + '</strong>' +
      '<small class="mono">' + escapeHtml(shortAddress(item.baseToken.address)) + '</small>' +
    '</span>' +
  '</' + tag + '>';
}

function gmgnTokenUrl(chain, address) {
  const value = String(address || '');
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return '';
  const gmgnChain = gmgnChainSlug(chain);
  if (!gmgnChain) return '';
  return 'https://gmgn.ai/' + encodeURIComponent(gmgnChain) + '/token/' + encodeURIComponent(value);
}

function gmgnChainSlug(chain) {
  if (chain === 'base') return 'base';
  if (chain === 'ethereum') return 'eth';
  if (chain === 'bsc') return 'bsc';
  if (chain === 'arbitrum') return 'arb';
  return '';
}

function tokenInitials(symbol) {
  return String(symbol || '?').replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '?';
}

function windowChange(market, key) {
  return market.windowStats && market.windowStats[key] ? market.windowStats[key].priceChangePct : undefined;
}

function changeHtml(value) {
  if (value === undefined || value === null || !Number.isFinite(Number(value))) return '<span class="muted">–</span>';
  const n = Number(value);
  return '<span class="' + (n >= 0 ? 'good' : 'bad') + '">' + signed(n) + '%</span>';
}

function numberWithQuote(value, quote) {
  if (value === undefined || value === null || !Number.isFinite(Number(value))) return '–';
  return fmtNumber.format(Number(value)) + ' ' + quote;
}

function signed(value) {
  const n = Number(value);
  return (n > 0 ? '+' : '') + n.toFixed(Math.abs(n) >= 10 ? 1 : 2);
}

function formatAge(seconds) {
  const value = Number(seconds) || 0;
  if (value < 60) return Math.round(value) + 's';
  if (value < 3600) return Math.round(value / 60) + 'm';
  return Math.round(value / 3600) + 'h';
}

function formatElapsedMinutes(minutes) {
  const value = Number(minutes) || 0;
  if (value < 1) return 'just now';
  if (value < 60) return Math.round(value) + 'm';
  if (value < 1440) return Math.round(value / 60) + 'h';
  return Math.round(value / 1440) + 'd';
}

function shortAddress(value) {
  const text = String(value || '');
  if (text.length <= 12) return text;
  return text.slice(0, 6) + '…' + text.slice(-4);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, function (char) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char];
  });
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, '&#39;');
}
`;
}
