import type { ChainSlug } from "../../types";

export function standaloneChartScript(endpoint: string, chain: ChainSlug, publicMarketApiBase?: string, geckoNetwork?: string): string {
  return `
let currentMarket = null;
const chartChain = ${JSON.stringify(chain)};
const chartGeckoNetwork = ${JSON.stringify(geckoNetwork ?? chain)};
const apiBase = ${JSON.stringify(publicMarketApiBase ?? "")};
const chartEndpoint = ${JSON.stringify(endpoint)};
const fmtUsd = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 6 });
const fmtShortUsd = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 });
const fmtNumber = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 2 });

function geckoNetworkFor(chain) {
  if (chain === 'ethereum' || chain === 'eth') return 'eth';
  if (chain === chartChain) return chartGeckoNetwork || chain || 'base';
  return chain || 'base';
}

function geckoPoolIdentifier(market) {
  const candidate = String(market.poolAddress || market.poolId || '').toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(candidate) || /^0x[0-9a-f]{64}$/.test(candidate)) return candidate;
  return null;
}

function geckoPoolUrl(market) {
  const net = geckoNetworkFor(market.chain || chartChain);
  const id = geckoPoolIdentifier(market);
  if (!id) return null;
  return 'https://www.geckoterminal.com/' + net + '/pools/' + id;
}

function geckoEmbedUrl(market) {
  const url = geckoPoolUrl(market);
  return url ? url + '?embed=1&info=0&swaps=0&grayscale=0&light_chart=1' : null;
}

function geckoExternalUrl(market) {
  return geckoPoolUrl(market);
}

function mountGeckoFrame(market) {
  const wrap = document.getElementById('chartFrameWrap');
  if (!wrap) return;
  const embed = geckoEmbedUrl(market);
  if (!embed) {
    wrap.innerHTML = '<div class="empty-chart">No GeckoTerminal embed is available for this pool. Raw market data is shown below.</div>';
    return;
  }
  const existing = wrap.querySelector('iframe');
  if (existing && existing.dataset.src === embed) return;
  wrap.innerHTML = '<iframe class="gecko-frame" data-src="' + embed + '" src="' + embed + '" title="GeckoTerminal chart" loading="lazy" allow="clipboard-write"></iframe>';
}

let chartPollTimer = null;
let chartConsecutiveErrors = 0;
function scheduleChartPoll() {
  if (chartPollTimer) clearTimeout(chartPollTimer);
  if (document.hidden) return;
  const base = 12000;
  const backoff = Math.min(8, chartConsecutiveErrors);
  const delay = base * Math.pow(1.6, backoff);
  chartPollTimer = setTimeout(loadMarket, delay);
}
document.addEventListener('visibilitychange', function () {
  if (!document.hidden) loadMarket();
  else if (chartPollTimer) { clearTimeout(chartPollTimer); chartPollTimer = null; }
});

loadMarket();

function loadMarket() {
  fetchChartJson(chartEndpoint)
    .then(function (payload) {
      const market = payload.market;
      currentMarket = market;
      applyMarket(market, payload);
      chartConsecutiveErrors = 0;
      scheduleChartPoll();
    })
    .catch(function (error) {
      const status = document.getElementById('status');
      if (status) status.textContent = 'Chart load failed: ' + chartErrorHint(error);
      chartConsecutiveErrors += 1;
      scheduleChartPoll();
    });
}

function fetchChartJson(url) {
  return fetch(url, { cache: 'no-store' })
    .then(function (response) {
      return response.text().then(function (text) {
        const payload = parseChartJson(text);
        payload.__dataSource = chartDataSourceFrom(response, payload);
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

function parseChartJson(text) {
  if (!text) return {};
  try { return JSON.parse(text); }
  catch {
    throw new Error('Market API returned invalid JSON');
  }
}

function chartDataSourceFrom(response, payload) {
  const header = (response.headers.get('x-data-source') || '').toLowerCase();
  if (header.indexOf('r2') !== -1 || payload.source === 'r2-snapshot' || payload.source === 'r2-archive') return 'r2';
  return 'raw-rpc';
}

function chartSourceLabel(payload) {
  return payload && payload.__dataSource === 'r2' ? 'archive snapshot' : 'live producer';
}

function chartErrorHint(error) {
  const payload = error && error.payload ? error.payload : {};
  if (payload.error === 'snapshot missing') return 'No saved market snapshot is available for this pool yet.';
  if (payload.error === 'chain not supported by this worker') return 'This chain is not served by the current R2 worker.';
  return error.message || 'Market API failed';
}

function applyMarket(market, payload) {
  if (!market) return;
  document.title = market.pairLabel + ' · baes scan';

  // Header pair
  setText('tokenAvatar', tokenInitials(market.baseToken.symbol));
  setText('pairChain', chainNameFor(market.chain || chartChain));
  setText('pairTitle', market.pairLabel);
  setText('pairDex', (market.dex || '') + ' ' + (market.protocol || ''));
  setText('pairPool', 'pool ' + shortAddress(market.poolAddress || market.poolId));
  const tokenUrl = gmgnTokenUrl(market.chain || chartChain, market.baseToken.address);
  setLinkedText('pairToken', 'token ' + shortAddress(market.baseToken.address), tokenUrl);

  const priceText = market.priceUsd ? fmtUsd.format(market.priceUsd) : numberWithQuote(market.price, market.quoteToken.symbol);
  setText('bigPrice', priceText);
  const change24h = windowChange(market, 'h24');
  const changeEl = document.getElementById('bigChange');
  if (changeEl) {
    if (change24h === undefined || change24h === null || !Number.isFinite(Number(change24h))) {
      changeEl.textContent = '–';
      changeEl.className = 'muted';
    } else {
      const n = Number(change24h);
      changeEl.textContent = signed(n) + '% (24h)';
      changeEl.className = n >= 0 ? 'good' : 'bad';
    }
  }

  // KPI strip
  setText('kpiPrice', priceText);
  setText('kpiChange24h', changeText(change24h));
  setText('kpiVol24h', windowVolume(market, 'h24'));
  setText('kpiTxns24h', windowTxns(market, 'h24'));
  setText('kpiLiquidity', market.liquidityUsd ? fmtShortUsd.format(market.liquidityUsd) : '–');
  setText('kpiMcap', market.marketCapUsd ? fmtShortUsd.format(market.marketCapUsd) : '–');
  setText('kpiFdv', market.fdvUsd ? fmtShortUsd.format(market.fdvUsd) : (market.marketCapUsd ? fmtShortUsd.format(market.marketCapUsd) : '–'));

  // Window pills
  setWindowPill('winM15', windowChange(market, 'm15'));
  setWindowPill('winH1', windowChange(market, 'h1'));
  setWindowPill('winH6', windowChange(market, 'h6'));
  setWindowPill('winH24', windowChange(market, 'h24'));

  // Info card
  setText('infoName', market.baseToken.name || market.baseToken.symbol);
  setText('infoSymbol', market.baseToken.symbol);
  setText('infoChain', chainNameFor(market.chain || chartChain));
  setText('infoDex', (market.dex || '') + ' ' + (market.protocol || ''));
  setText('infoPool', shortAddress(market.poolAddress || market.poolId));
  setText('infoQuote', market.quoteToken.symbol);
  setLinkedText('infoToken', shortAddress(market.baseToken.address), tokenDexUrl);
  setText('infoWindow', 'blocks ' + market.firstBlock + '–' + market.lastBlock);

  // External links
  const explorerLink = document.getElementById('explorerLink');
  setExternalLink(explorerLink, market.explorerUrl, 'Explorer');
  const geckoLink = document.getElementById('geckoLink');
  const externalGecko = geckoExternalUrl(market);
  setExternalLink(geckoLink, externalGecko, 'GeckoTerminal');
  if (geckoLink && !externalGecko) geckoLink.style.display = 'none';

  // Status / refresh markers
  setText('status', 'GeckoTerminal chart · ' + chartSourceLabel(payload) + ' · blocks ' + market.firstBlock + '-' + market.lastBlock);
  setText('refreshState', 'updated ' + new Date().toLocaleTimeString());
  setText('tradesMeta', (market.events ? market.events.length : 0) + ' swaps in window');

  mountGeckoFrame(market);
  renderTape(market);
}

function setExternalLink(link, href, label) {
  if (!link) return;
  link.textContent = href ? label + ' ↗' : label;
  link.style.display = '';
  if (href) {
    link.href = href;
    link.classList.remove('is-disabled');
    link.removeAttribute('aria-disabled');
    return;
  }
  link.removeAttribute('href');
  link.classList.add('is-disabled');
  link.setAttribute('aria-disabled', 'true');
}

function setWindowPill(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  if (value === undefined || value === null || !Number.isFinite(Number(value))) {
    el.textContent = '–';
    el.parentElement && el.parentElement.classList.remove('good', 'bad');
    return;
  }
  const n = Number(value);
  el.textContent = signed(n) + '%';
  if (el.parentElement) {
    el.parentElement.classList.toggle('good', n >= 0);
    el.parentElement.classList.toggle('bad', n < 0);
  }
}

function renderTape(market) {
  const rows = document.getElementById('tradeRows');
  if (!rows) return;
  const events = market.events || [];
  if (!events.length) {
    rows.innerHTML = '<tr><td colspan="6" class="empty-cell">No swaps in this window.</td></tr>';
    return;
  }
  rows.innerHTML = events.slice(0, 100).map(function (event) {
    const sideClass = event.side === 'buy' ? 'buy' : 'sell';
    const total = event.volumeUsd ? fmtShortUsd.format(event.volumeUsd) : numberWithQuote(event.quoteAmount, market.quoteToken.symbol);
    const price = event.priceUsd ? fmtUsd.format(event.priceUsd) : numberWithQuote(event.price, market.quoteToken.symbol);
    const tx = event.explorerUrl
      ? '<a href="' + escapeAttr(event.explorerUrl) + '" target="_blank" rel="noreferrer">' + shortHash(event.txHash) + '</a>'
      : shortHash(event.txHash);
    return '<tr>' +
      '<td><span class="side-pill ' + sideClass + '">' + event.side.toUpperCase() + '</span></td>' +
      '<td class="num mono">' + escapeHtml(total) + '</td>' +
      '<td class="num mono">' + fmtNumber.format(event.baseAmount) + ' ' + escapeHtml(market.baseToken.symbol) + '</td>' +
      '<td class="num mono">' + escapeHtml(price) + '</td>' +
      '<td class="num mono muted">' + formatAge(event.ageSeconds) + '</td>' +
      '<td class="mono">' + tx + '</td>' +
      '</tr>';
  }).join('');
}

function windowStat(market, key) {
  return market.windowStats && market.windowStats[key] ? market.windowStats[key] : undefined;
}

function windowChange(market, key) {
  const stat = windowStat(market, key);
  return stat ? stat.priceChangePct : undefined;
}

function windowVolume(market, key) {
  const stat = windowStat(market, key);
  if (!stat) return '–';
  return stat.volumeUsd ? fmtShortUsd.format(stat.volumeUsd) : numberWithQuote(stat.quoteVolume, market.quoteToken.symbol);
}

function windowTxns(market, key) {
  const stat = windowStat(market, key);
  if (!stat) return '–';
  return fmtNumber.format(stat.swapCount || 0);
}

function changeText(value) {
  if (value === undefined || value === null || !Number.isFinite(Number(value))) return '–';
  return signed(Number(value)) + '%';
}

function chainNameFor(chain) {
  if (chain === 'ethereum' || chain === 'eth') return 'Ethereum';
  if (chain === 'base') return 'Base';
  return chain || 'chain';
}

function tokenInitials(symbol) {
  return String(symbol || '?').replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '?';
}

function shortAddress(value) {
  const text = String(value || '');
  if (text.length <= 14) return text;
  return text.slice(0, 6) + '…' + text.slice(-4);
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value === undefined || value === null ? '–' : String(value);
}

function setLinkedText(id, label, href) {
  const element = document.getElementById(id);
  if (!element) return;
  if (!href) {
    element.textContent = label === undefined || label === null ? 'â€“' : String(label);
    return;
  }
  element.innerHTML = '<a href="' + escapeAttr(href) + '" target="_blank" rel="noreferrer">' + escapeHtml(label) + '</a>';
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

function shortHash(value) {
  return value.slice(0, 6) + '…' + value.slice(-4);
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
