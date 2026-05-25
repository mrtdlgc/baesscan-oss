const DEFAULT_PREFIX = "dex-data";
const DEFAULT_CACHE_SECONDS = 20;
const SUPPORTED_CHAINS = new Set(["base", "ethereum"]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    if (request.method !== "GET" && request.method !== "HEAD") {
      return cors(json({ error: "method not allowed" }, 405));
    }
    if (url.pathname === "/health") return cors(json({ ok: true, source: "cloudflare-r2", chains: [...SUPPORTED_CHAINS] }));

    const route = routeForPath(url.pathname, env.SNAPSHOT_PREFIX || DEFAULT_PREFIX);
    if (!route) return cors(json({ error: "not found", path: url.pathname }, 404));
    if (route.unsupportedChain) return cors(json({ error: "chain not supported by this worker", chain: route.unsupportedChain }, 404));

    const cacheSeconds = boundedNumber(env.EDGE_CACHE_SECONDS, DEFAULT_CACHE_SECONDS, 5, 300);
    const object = await env.MARKET_DATA.get(route.key);
    if (!object) return cors(json({ error: "snapshot missing", key: route.key, fallbackKey: route.compressedKey }, 404));

    let body = request.method === "HEAD" ? null : object.body;
    const headers = new Headers({
      "access-control-allow-origin": "*",
      "cache-control": `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}`,
      "content-type": "application/json; charset=utf-8",
      "vary": "accept-encoding",
      "x-data-source": "cloudflare-r2-snapshot",
      "x-snapshot-key": route.key
    });

    return new Response(body, { headers });
  }
};

function routeForPath(pathname, prefix) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "api") return undefined;

  // /api/trending/:chain or /api/markets/:chain
  if ((parts[1] === "trending" || parts[1] === "markets") && parts[2]) {
    if (!SUPPORTED_CHAINS.has(parts[2])) return { unsupportedChain: parts[2] };
    return publicSnapshotRoute(`${prefix}/${parts[2]}/trending/latest.json`);
  }
  if ((parts[1] === "new-pairs" || parts[1] === "pairs") && parts[2]) {
    if (!SUPPORTED_CHAINS.has(parts[2])) return { unsupportedChain: parts[2] };
    return publicSnapshotRoute(`${prefix}/${parts[2]}/new-pairs/latest.json`);
  }
  if (parts[1] === "archive" && parts[2] && parts[3] === "manifest") {
    if (!SUPPORTED_CHAINS.has(parts[2])) return { unsupportedChain: parts[2] };
    return publicSnapshotRoute(`${prefix}/${parts[2]}/archive/latest-manifest.json`);
  }
  if (parts[1] === "archive" && parts[2] && parts[3] === "swaps" && parts[4] === "manifest") {
    if (!SUPPORTED_CHAINS.has(parts[2])) return { unsupportedChain: parts[2] };
    return publicSnapshotRoute(`${prefix}/${parts[2]}/swaps/latest-manifest.json`);
  }
  if (parts[1] === "market" && parts[2] && parts.length >= 4) {
    if (!SUPPORTED_CHAINS.has(parts[2])) return { unsupportedChain: parts[2] };
    const poolId = decodeURIComponent(parts.slice(3).join("/"));
    if (!poolId) return undefined;
    return publicSnapshotRoute(`${prefix}/${parts[2]}/pools/${encodeKeyPart(poolId)}/market/latest.json`);
  }
  return undefined;
}

function publicSnapshotRoute(key) {
  return { key, compressedKey: `${key}.br` };
}

function encodeKeyPart(value) {
  return encodeURIComponent(String(value).toLowerCase()).replace(/%/g, "~");
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function cors(response) {
  response.headers.set("access-control-allow-origin", "*");
  response.headers.set("access-control-allow-methods", "GET, HEAD, OPTIONS");
  response.headers.set("access-control-allow-headers", "content-type");
  response.headers.set("access-control-expose-headers", "x-data-source, x-snapshot-key");
  return response;
}
