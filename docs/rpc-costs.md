# RPC and Indexing Costs

baes scan is a read-only scanner. It does not pay validators or stake collateral. The actual operating cost is RPC requests, optional Blockscout requests, and optional Cloudflare R2 storage/egress. This document is the honest version.

If you are scanning a single quiet Base group, costs are negligible. If you turn on wallet-PnL, market archive, historical backfills, and active pool discovery across multiple chains, costs grow quickly. The hosted [baesscan.com](https://baesscan.com) intel pages exist because maintaining that index full-time is non-trivial.

## What is cheap

- The Telegram bot itself: a few RPC reads per group per polling tick.
- `/pool` manual entry: zero discovery cost.
- `/api/chains`: static registry, no RPC.
- Contract-creator lookups: one or two RPC calls per address, or one Blockscout call when configured.
- A no-secret `WEB_ENABLED=true` boot: the landing page does not call RPCs.

## What can get expensive

The features below either issue many requests per scan tick or replay large block ranges. Treat them as "off unless you have reasoned about quota."

### Wallet-PnL ledger

`WALLET_PNL_ENABLED=true` runs a background scanner. On Base, each tick fetches blocks of swap logs, resolves transaction senders, and updates the local ledger. The expensive knobs:

- `WALLET_PNL_MAX_BLOCKS_PER_TICK` (default 1000)
- `WALLET_PNL_BLOCK_LOOKUP_CONCURRENCY` (default 8)
- `WALLET_PNL_TX_LOOKUP_CONCURRENCY` (default 16)

Per-tx sender lookups dominate when block-level lookups miss. Public RPCs frequently throttle this pattern.

### Active pool discovery

`WALLET_PNL_ACTIVE_POOL_DISCOVERY_ENABLED=true` calls Blockscout on every tick to find new active v4 pool ids. Without a Blockscout PRO key, you will hit anonymous rate limits quickly.

### Token bootstrap

`WALLET_PNL_TOKEN_BOOTSTRAP_ENABLED=true` is triggered when a user opens a token page that has no rows yet. It replays up to `WALLET_PNL_TOKEN_BOOTSTRAP_REPLAY_HOURS` of pool swaps for that token. A determined user clicking many cold token pages can fan this out.

### Market archive

`MARKETS_ENABLED=true` plus `MARKET_ARCHIVE_ENABLED=true` writes compressed swap chunks to R2 and replays factory + PoolManager logs across configured chains. This is the most RPC-heavy mode. On Ethereum and Base, prefer a paid provider with `*_BACKFILL_RPC_PROVIDERS` and a budget-aware `weight=` setup. R2 storage is cheap; R2 egress depends on traffic.

### Historical backfills

`npm run archive:backfill:dev -- --chain base --days 30` is a one-shot fill. On a 30-day Base window with default chunk sizes, this can be tens of thousands of log calls. Use `--dry-run` first to size it.

## Cheap-vs-expensive checklist before enabling something

1. How many RPC requests per minute will this generate at steady state?
2. Does it call Blockscout on every tick? If yes, do you have a paid key?
3. Does the worst-case cold cache load fan out a backfill on the first user request?
4. Will it run after `npm start` even if I do not open any web page? Many wallet-PnL knobs do.
5. Can I gate it behind `WEB_ADMIN_PASSWORD`, `OWNER_USER_IDS`, or `WALLET_PNL_GATE_*`?

## Provider quota tips

- Use `*_RPC_URLS` (plural) with at least two providers. The pool fails over and tracks per-provider failure rates.
- Use `*_BACKFILL_RPC_PROVIDERS` for archive/backfill traffic so heavy historical work does not starve live alerts. Each entry is `label|url|rps=1|blocks=2000|weight=1`.
- Raise `LOG_CHUNK_SIZE` only on paid providers. Free Base RPCs commonly reject ranges larger than ~500.
- `RPC_CALL_TIMEOUT_MS` defaults to 20s. Drop it lower if you find a provider that is silently slow but does not error.
- `POLL_INTERVAL_MS=30000` is a safer free-tier default. Lowering it multiplies cost.

## When self-hosting stops being cheaper

If you find yourself paying for two paid RPC providers per chain, a Blockscout PRO key, R2 storage with non-trivial egress, plus a VPS, plus on-call time to clean SQLite — the hosted intel pages are probably cheaper. That is the intended tradeoff. Self-hosting is for users who want full control or want to inspect and modify the scanner, not for users trying to dodge a subscription.
