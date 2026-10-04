# baes scan (OSS)

Read-only Telegram buy alerts and wallet intel for modern DEX launches. Self-host it with your own infrastructure, or use the hosted [baesscan.com](https://baesscan.com) intel pages if you do not want to maintain the index.

This repository is the alpha self-hosted/BYOK edition. You supply the Telegram bot token, RPC endpoints, optional Blockscout key, optional Cloudflare R2 bucket, and the database file. The bot does not request, store, or transmit private keys — it reads chain data and posts notifications.

> Self-hosting is useful if you want full control or want to inspect and modify the scanner. The hosted intel pages are the easier path if you do not want to pay for RPCs, run backfills, or maintain a clean database.

## What is baes scan?

A multi-chain Telegram buy-alert bot plus an optional web/intel surface. Pool discovery reads raw factory and PoolManager logs through your own RPC; with `BLOCKSCOUT_API_KEY` set, `/watch` and `/scan` first look for pools through Blockscout's indexed token transfers and fall back to the raw RPC scan. Buy alerts show market cap from Dexscreener when it is available and on-chain FDV otherwise. Dexscreener (with CoinGecko as a fallback) also prices quote tokens that are neither stablecoins nor the chain's native asset (`DISABLE_DEXSCREENER=true` turns Dexscreener off). GeckoTerminal is used only as an embedded chart frame.

Supported coverage:

| Chain | DEX adapters |
| --- | --- |
| Ethereum | Uniswap v2/v3/v4, PancakeSwap v2/v3, SushiSwap v2, Curve, Balancer |
| BNB Smart Chain | PancakeSwap v2/v3, Uniswap v2/v3/v4, THENA Algebra/known v2 pools, Biswap v2, ApeSwap v2 |
| Base | Uniswap v2/v3/v4, PancakeSwap v2/v3, SushiSwap v2, Aerodrome, Hydrex, Curve, Balancer |
| Arbitrum | Uniswap v2/v3/v4, PancakeSwap v2/v3, Camelot Algebra/v2, SushiSwap v2, Curve, Balancer |
| Optimism | Uniswap v2/v3/v4, Velodrome, Curve |
| Monad | Uniswap v2/v3/v4, PancakeSwap v3, Trader Joe LB/v2 |
| MegaETH | Kumbaya v3, Prism v3, Noxa v3 |
| Robinhood Chain | Uniswap v2/v3/v4, PancakeSwap v2/v3, SushiSwap v2/v3 |
| Polygon | Uniswap v3, QuickSwap Algebra/v2, SushiSwap v2, Curve, Balancer |
| Avalanche | Uniswap v3, Pharaoh v3, Blackhole v3, Trader Joe LB/v2, Pangolin v2, SushiSwap v2, Curve, Balancer |

## Hosted vs self-hosted

Hosted [baesscan.com](https://baesscan.com) provides:

- maintained wallet and pool data
- clean DB state
- production RPC and explorer provider routing
- Blockscout-backed discovery and recovery
- background wallet-PnL materialization
- no hosting or backfill babysitting

Self-hosting this repo gives you:

- a read-only scanner you can inspect and modify
- full control over Telegram bot, RPC providers, and DB
- the ability to run a private deployment for your group
- direct access to the raw `/api/chains`, contract-creator, and (optionally) intel pages

Self-hosting is not cheaper for serious wallet intel. It needs historical logs, reliable RPC access, replay windows, and ongoing database hygiene. See [docs/rpc-costs.md](docs/rpc-costs.md).

## What the OSS edition includes

- Telegram buy-alert bot (single replica)
- Read-only scanner runtime
- Chain registry, DEX adapters, swap parsers
- Pool discovery via raw factory/PoolManager logs
- Manual pool entry via `/pool`
- Owner/admin Telegram commands that are safe for self-hosters
- Web landing page, `/api/chains`, contract-creator lookup
- Self-hosted wallet-PnL and `/intel` alpha (disabled by default, BYOK)
- Example Cloudflare worker config for the optional market R2 read path
- Strong `.env.example` and self-hosting docs

## What it does not include

- No private-key trading, no signing, no transaction submission
- No managed RPC, Blockscout, or R2 credentials
- No guarantee of full historical coverage without backfills
- No promise that SQLite is ideal for every production workload
- No managed database cleanup
- No live production database state from the hosted service

## Requirements

- Node.js >= 22.5.0
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- At least one RPC endpoint for each chain you enable
- Optional: Blockscout PRO key, Cloudflare R2 bucket, paid RPCs for serious load

## Quick Start

```bash
cp .env.example .env
# Edit .env: set TELEGRAM_BOT_TOKEN and BASE_RPC_URL at minimum.
npm install
npm run build
npm start
```

Defaults are intentionally conservative:

```env
PRIMARY_CHAIN=base
ENABLED_CHAINS=base
MARKETS_ENABLED=false
TELEGRAM_MODE=polling
WALLET_PNL_ENABLED=false
```

To enable more chains, set the corresponding `*_RPC_URLS` and add them to `ENABLED_CHAINS`. Single-chain is the safe default so a fresh deploy does not accidentally burn RPC budget across every supported network.

To boot without Telegram credentials (web/diagnostic only):

```bash
TELEGRAM_ENABLED=false WEB_ENABLED=true npm start
```

## Telegram setup

The bot is the primary product surface. Each Telegram group stores its own chain, token, pools, and alert settings. Write actions require a group admin, an `ADMIN_USER_IDS` entry, or an owner. Group admins posting with "Remain Anonymous" are accepted. When a basic group is upgraded to a supergroup, its stored config moves to the new chat id automatically.

For local development and VPS deploys, use `TELEGRAM_MODE=polling`. For hosting platforms with public ingress, use `TELEGRAM_MODE=webhook` with `PUBLIC_BASE_URL` or `TELEGRAM_WEBHOOK_URL` set so the app can register the webhook.

Full command reference: [docs/self-hosting.md](docs/self-hosting.md).

A short tour:

```text
/watch                                          guided setup
/watch [chain] <token> [quote] <block> [dex] [protocol]
/pool [chain] <poolAddress> [targetToken]       manual pool entry
/pools | /status | /pause | /resume | /unwatch
/settings                                       inline panel for /set options
/testbuy                                        sample alert
/topic [here|off]                               route to a forum topic
```

## RPC cost warning

Wallet-PnL, market archive, and historical backfills can be RPC-expensive. Start with one chain and small windows. Read [docs/rpc-costs.md](docs/rpc-costs.md) before turning anything on:

```env
# WARNING: wallet-PnL and historical backfills can be RPC-expensive.
# Start with one chain and small windows before enabling broad scans.
WALLET_PNL_ENABLED=false
WALLET_PNL_ACTIVE_POOL_DISCOVERY_ENABLED=false
WALLET_PNL_TOKEN_BOOTSTRAP_ENABLED=false
```

## Wallet intel alpha

The `/intel` surface and wallet-PnL ledger are included as experimental BYOK features, **off by default**. Public ground rules:

- no private keys, no signing
- data is derived from public chain activity
- accuracy depends on RPC completeness, configured pools, and retained DB history
- local SQLite is acceptable for alpha, but serious use requires backups and monitoring
- first runs may be slow or incomplete until discovery/backfill catches up
- on Base, Uniswap v4 pools are only indexed when they use a trusted launchpad hook (built-in allowlist plus `WALLET_PNL_TRUSTED_V4_HOOKS`)
- `INTEL_ENABLED=false` removes every intel route and stops wallet-PnL and copy-shadow background jobs, leaving only the Telegram bot and landing page

Self-hosted wallet intel is infrastructure-heavy. The hosted baesscan.com intel pages exist because maintaining clean indexed data, RPC coverage, and recovery jobs costs time and provider spend.

## Deployment

- Docker: `Dockerfile` and `docker-compose.yml` mount `./data:/app/data` for SQLite persistence.
- VPS / managed PaaS: run `npm run build && npm start` with the `.env` populated and `data/` on durable storage. Use `TELEGRAM_MODE=webhook` and set `PUBLIC_BASE_URL` when the host has public ingress; otherwise leave `TELEGRAM_MODE=polling`.
- Cloudflare worker example: `cloudflare/market-worker/wrangler.toml.example` — copy to `wrangler.toml` and fill in your own bucket/route names. Only needed if you enable the optional R2 market archive read path.

Keep exactly one running replica per bot token. Long polling cannot be duplicated, and webhook mode must have a single active receiver.

## Security model

- The bot is **read-only**. It does not request private keys or seed phrases.
- Telegram permissions: standard message read/write inside groups it is added to.
- RPC and Blockscout keys are read from env at startup; they are never stored in the DB.
- See [docs/read-only-security.md](docs/read-only-security.md) for what is read, what is stored, and how to revoke credentials.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Verification

```bash
npm install
npm run typecheck
npm run build
npm run smoke:config
```

Optional live smoke against active pool fixtures (uses your configured RPCs):

```bash
npm run smoke:live
```

`smoke:live` has a default 2 minute global watchdog and 20 second per-pool timeout so a bad RPC cannot run unattended.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Public issues are enabled; please use the templates and never paste real bot tokens, RPC URLs with credentials, Blockscout keys, R2 secrets, or `state.db` contents into issues.

## License

[AGPL-3.0-or-later](LICENSE). If you run a modified version as a network service, you must publish your changes under the same license. See section 13 of the AGPL.
