# Cloudflare Market Snapshots

This repo keeps pool discovery and swap parsing raw-RPC first. Cloudflare is used only for cheap public reads after the Railway/VPS process has produced snapshots.

## Data Flow

```text
Railway/VPS app
  -> raw RPC market scans
  -> compressed JSON snapshots
  -> Cloudflare R2

Cloudflare Worker
  -> /api/trending/{base|ethereum}
  -> /api/new-pairs/{base|ethereum}
  -> /api/market/{base|ethereum}/:poolId
  -> /api/archive/{base|ethereum}/manifest
  -> /api/archive/{base|ethereum}/swaps/manifest
  -> R2 snapshot reads + edge cache
```

## Railway Env

```env
MARKET_SNAPSHOTS_ENABLED=true
MARKET_ARCHIVE_ENABLED=true
MARKET_SNAPSHOT_PREFIX=dex-data
MARKET_SNAPSHOT_CACHE_SECONDS=20
MARKET_HISTORY_RETENTION_DAYS=30
MARKET_ARCHIVE_MAX_FACTORY_DISCOVERIES=1000
MARKET_ARCHIVE_FAST_TOKEN_METADATA=false
BASE_BACKFILL_RPC_PROVIDERS=drpc|https://...|rps=2|blocks=2000|weight=3,chainstack|https://...|rps=1|blocks=100
ETHEREUM_BACKFILL_RPC_PROVIDERS=drpc|https://...|rps=2|blocks=2000|weight=3,infura|https://...|rps=1|blocks=1000
MARKET_ARCHIVE_CHUNK_TRADE_LIMIT=5000
BLOCKSCOUT_LOG_SOURCE=fallback
BLOCKSCOUT_API_KEY=...
BLOCKSCOUT_MAX_LOGS_PER_REQUEST=1000
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=raw-dex-market-data
PUBLIC_MARKET_API_BASE=https://raw-dex-market-api.your-subdomain.workers.dev
```

`MARKET_ARCHIVE_MAX_FACTORY_DISCOVERIES` is a per-factory guard, not a total per-tick cap.

`BASE_BACKFILL_RPC_PROVIDERS` and `ETHEREUM_BACKFILL_RPC_PROVIDERS` define a separate balanced scheduler for archive/backfill RPC calls. Entries use `label|url|rps=N|blocks=N|weight=N`; `blocks` should match that provider's safe `eth_getLogs` range, and `weight` gives stronger providers a larger share of queued work.

`MARKET_ARCHIVE_FAST_TOKEN_METADATA=true` speeds one-time catch-up backfills by fetching only token symbol/decimals and skipping token name/totalSupply calls. Keep it disabled for the steady archive producer if FDV-style market cap matters.

With only `MARKET_SNAPSHOTS_ENABLED=true`, snapshot writes are best-effort: if R2 is unavailable, the local API response still returns and the app logs a warning. With `MARKET_ARCHIVE_ENABLED=true`, public market APIs are archive-first and fail fast when the required R2 snapshot is missing.

## R2 Object Layout

```text
dex-data/{base|ethereum}/trending/latest.json.br
dex-data/{base|ethereum}/trending/latest.json
dex-data/{base|ethereum}/new-pairs/latest.json.br
dex-data/{base|ethereum}/new-pairs/latest.json
dex-data/{base|ethereum}/pools/{encodedPoolId}/market/latest.json.br
dex-data/{base|ethereum}/pools/{encodedPoolId}/market/latest.json
dex-data/{base|ethereum}/pools/{encodedPoolId}/history/YYYY/MM/DD/HH-mm-ss.json.br
dex-data/{base|ethereum}/pools/latest-registry.json.br
dex-data/{base|ethereum}/archive/latest-manifest.json.br
dex-data/{base|ethereum}/archive/latest-manifest.json
dex-data/{base|ethereum}/swaps/blocks/{fromBlock}-{toBlock}.json.br
dex-data/{base|ethereum}/swaps/latest-manifest.json.br
dex-data/{base|ethereum}/swaps/latest-manifest.json
```

Pool IDs are lowercased, `encodeURIComponent` encoded, and `%` is replaced with `~` so v4 IDs and addresses stay path-safe.

History chunks are immutable Brotli JSON. Each chunk stores the raw-RPC market summary, candles, recent swap tape, window stats, market cap/FDV, and a retention marker. R2 lifecycle rules should expire `dex-data/*/pools/*/history/*` after `MARKET_HISTORY_RETENTION_DAYS` days.

When `MARKET_ARCHIVE_ENABLED=true`, the app also maintains a persistent pool registry from the configured tracked DEX factory/PoolManager events and writes compact swap-event chunks for registered pools. These chunks store only the data needed to rebuild baes scan trades later: compact raw logs, normalized buy/sell trade rows, pool metadata, token metadata, and the quote USD multiplier used at ingest time. They intentionally do not store full transactions.

The local archive backfill also writes `pools/latest-registry.json.br`. A fresh Railway producer can read that registry on startup, hydrate its local store, and continue scanning known pools after the historical R2 fill.

The archive producer calculates public payloads after it writes swap chunks. It rebuilds trending markets, new-pairs, market-detail stats, trend scores, candles, and recent tape from normalized archive trades, then writes the latest public snapshots back to R2.

Public market APIs do not trigger live RPC scans when archive mode is enabled. `/api/trending/{chain}`, `/api/new-pairs/{chain}`, and `/api/market/{chain}/:poolId` read already-published R2 snapshots and fail fast if those snapshots are missing. Live raw-RPC work belongs to the background producer/indexer, not user page loads.

`BLOCKSCOUT_LOG_SOURCE` controls the optional Blockscout PRO swap-log source for the producer. Use `fallback` to try Blockscout only after RPC log fetch failures, or `preferred` to fetch archive swap logs from Blockscout first and fall back to RPC on Blockscout errors. Blockscout logs are normalized through the same parser as RPC logs before anything is written to R2.

`BLOCKSCOUT_MAX_LOGS_PER_REQUEST` should match the provider's per-request result cap. The client recursively splits a range when a response reaches this count, which avoids silently trusting a capped response as complete.

Retention is enforced by the archive producer and the local backfill command. On every processed range, expired swap-chunk records are deleted from R2, removed from the local store, and the swap manifest is republished without those objects. Keep an R2 lifecycle rule for `dex-data/*/swaps/blocks/*` as a backup guard, but the app does not rely on lifecycle alone.

## Local Archive Backfill

Run the initial swap-event archive locally before deploying Railway:

```bash
npm run build
npm run archive:backfill -- --chain base --days 30
npm run archive:backfill -- --chain ethereum --days 30
```

Use `--chain all` to process Base and Ethereum sequentially. The command uploads swap chunks and manifests directly to R2, then publishes derived trending, new-pairs, and market-detail snapshots. It logs each range as it works and resumes from the local archive cursor by default.

Factory-discovered pools are not persisted until the archive observes at least one buy trade for that pool. Pending no-buy candidates stay in a bounded in-memory window controlled by `MARKET_ARCHIVE_PENDING_POOL_TTL_BLOCKS`, which keeps local and Railway state from growing with launcher spam. When `STORAGE_BACKEND=json` is used, the JSON store writes archive-heavy records into fixed-size sidecar chunks under `DATA_FILE.chunks/` instead of storing all pool/chunk metadata in one JSON file.

Useful controls:

```bash
npm run archive:backfill -- --chain base --from-block 29000000 --to-block 30300000
npm run archive:backfill -- --chain base --days 30 --swap-step-blocks 1000
npm run archive:backfill -- --chain base --days 30 --no-resume
npm run archive:backfill -- --chain base --days 30 --skip-derived
```

The older `backfill:r2` command is still useful for small snapshot-size checks, but the archive backfill command is the production path for historical swap-event chunks.

## Cloudflare Worker

Copy `cloudflare/market-worker/wrangler.toml.example` to `wrangler.toml`, set the bucket name, then deploy:

```bash
cd cloudflare/market-worker
wrangler deploy
```

The Worker routes:

```text
/health
/api/trending/{base|ethereum}
/api/markets/{base|ethereum}
/api/new-pairs/{base|ethereum}
/api/pairs/{base|ethereum}
/api/market/{base|ethereum}/:poolId
/api/archive/{base|ethereum}/manifest
/api/archive/{base|ethereum}/swaps/manifest
```

The producer writes Brotli objects for server-side archive reads and plain `.json` aliases for public Worker routes. The Worker serves only the plain aliases so browser `fetch()` calls always receive JSON text; `.json.br` objects stay available for Node-side archive reads.

Set `PUBLIC_MARKET_API_BASE` on the Railway web service after the Worker is deployed. The HTML can still be served by Railway, but browser-facing market JSON reads will go to Cloudflare.

## Why This Exists

Public chart/feed reads should not come from Supabase or Railway once traffic grows. R2 has no egress fees, and the Worker can absorb frequent refreshes with short cache windows. The indexer still needs RPC budget, but users reading charts do not multiply RPC calls or database egress.
