# Self-Hosting baes scan

This guide is for running the OSS edition with your own infrastructure. If you do not want to maintain RPCs, backfills, and a clean database, use the hosted [baesscan.com](https://baesscan.com) intel pages instead.

## What you need

- Node.js >= 22.5.0
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- One RPC endpoint per chain you intend to enable
- Optional: Blockscout PRO API key for contract-creator lookups, wallet-PnL pool bootstrap, and archive log fetches
- Optional: Cloudflare R2 bucket for the market archive
- A host with persistent disk for `data/state.db` (VPS, Coolify, Docker, bare metal)

## First boot

```bash
git clone <your fork of this repo>
cd baesscan-oss
cp .env.example .env
# Edit .env: at minimum set TELEGRAM_BOT_TOKEN and BASE_RPC_URL
npm install
npm run build
npm run smoke:config
npm start
```

Defaults are intentionally conservative: one chain (Base), markets disabled, wallet-PnL disabled, Telegram in polling mode. This keeps a fresh deploy from accidentally burning RPC budget.

To boot in a no-secret diagnostic mode (web only, no Telegram):

```bash
TELEGRAM_ENABLED=false WEB_ENABLED=true npm start
```

## Telegram setup

1. Create the bot with [@BotFather](https://t.me/BotFather), copy the token into `TELEGRAM_BOT_TOKEN`.
2. Add the bot to your group. To receive buy alerts in a forum topic, use `/topic here` from that topic.
3. Set `OWNER_USER_IDS` to your Telegram numeric user id. Owner ids also receive DM alerts when the bot joins or leaves a chat — each owner must open the bot once before Telegram will accept bot-initiated DMs.
4. For VPS / bare-metal, keep `TELEGRAM_MODE=polling`. For platforms with public ingress (Railway, Fly, Cloud Run, Render, Coolify with a public domain), prefer `TELEGRAM_MODE=webhook` and set `PUBLIC_BASE_URL` so the app can register the webhook automatically.

Run **exactly one** replica per bot token. Long polling cannot be duplicated and webhook mode must have a single active receiver.

## Telegram commands (quick reference)

```text
/watch                                          guided setup
/watch [chain] <token> [quote] <block> [dex] [protocol] [clanker|flaunch|hooks] [next|all]
/scan  [chain] <token> [quote] <block> [dex] [protocol]   discovery only, saves nothing
/pool                                           guided pool entry
/pool [chain] <poolAddress> [targetToken]
/pool [chain] <v4PoolId> <targetToken> <poolCreationBlock>
/pool [chain] <currency0> <currency1> <fee> <tickSpacing> <hooks> <targetToken>
/pools          list tracked pools
/status         latest chain block and this chat's config
/pause | /resume | /unwatch
/testbuy        sample alert through current formatting
/topic [here|off]
/chatid
/settings       inline panel for every /set option
/help
```

Settings:

```text
/set minusd <n>      Minimum USD buy
/set minquote <n>    Minimum quote-token buy
/set emoji <text>    Emoji or text repeated in the buy bar
/set emojistep <n>   USD value per emoji
/set maxemojis <n>   Cap repeated emojis
/set media <url|off> Alert media by URL
/set tx <on|off>     Show/hide explorer tx links
/set chart <on|off>  Show/hide chart links
/set topic <here|id|off>
/set backfill <blocks>
/set clanker <on|off>
```

Owner-only:

```text
/rpcscan [all|chain] [cached]
/baesctl_stats
/baesctl_db [chats|chat <id>|pools <id>|banned|runtime]
/baesctl_listchats
/baesctl_ban <chatId> [reason]
/baesctl_unban <chatId>
/baesctl_broadcast <message>
```

`/rpcscan` reports per-provider attempt and failure counts, the active provider, learned routing policy, latest successful and failed blocks. The pool uses these to cool down flaky providers and learn `eth_getLogs` range caps.

`/baesctl_db` is read-only sanitized SQLite visibility for environments where you cannot browse the data volume directly. It does not expose a raw SQL console.

## Chains and RPCs

Set only the chains you actually want to poll:

```env
PRIMARY_CHAIN=base
ENABLED_CHAINS=base,arbitrum
BASE_RPC_URLS=https://...,https://...
ARBITRUM_RPC_URLS=https://...
```

`*_RPC_URLS` is comma-separated, primary first. The pool fails over rather than fanning out, so the primary handles each call alone unless it fails.

`LOG_CHUNK_SIZE=500` is a safer public-RPC default on Base; raise it only on paid providers. `RPC_CALL_TIMEOUT_MS` defaults to 20s so a stuck provider fails over instead of pinning a web request.

## Optional: Blockscout PRO

```env
BLOCKSCOUT_API_KEY=...
BLOCKSCOUT_API_BASE_URL=https://api.blockscout.com/v2/api
BLOCKSCOUT_LOG_SOURCE=disabled   # or fallback / preferred
```

Used for contract-creator lookups, optional wallet-PnL pool bootstrap, and optional archive log ingestion. Read [docs/rpc-costs.md](rpc-costs.md) before enabling `preferred`.

## Optional: web and intel surface

```env
WEB_ENABLED=true
WEB_PORT=3000
PUBLIC_BASE_URL=https://your-host.example
```

The intel surface is **off** by default in the OSS edition (no token gate configured). If you want a holder gate, set `WALLET_PNL_GATE_TOKEN_ADDRESS`, `WALLET_PNL_GATE_CHAIN` (must be in `ENABLED_CHAINS`), and `WALLET_PNL_GATE_MIN_BALANCE`. Set `INTEL_SESSION_SECRET` to a long random string for signed gate cookies.

## Optional: wallet-PnL alpha

Off by default. See the [Wallet intel alpha](../README.md#wallet-intel-alpha) section and [docs/rpc-costs.md](rpc-costs.md) for cost notes.

## Optional: market archive and Cloudflare R2

Off by default. Enable only if you have R2 credentials and RPC capacity for historical backfills. See [docs/cloudflare-snapshots.md](cloudflare-snapshots.md).

## Storage

SQLite is the default and is acceptable for alpha use. Persist `data/state.db` to durable storage. Back it up with `sqlite3 .backup` rather than copying a live DB file. The wallet-PnL gated analytics path is designed for SQLite; the JSON fallback (`STORAGE_BACKEND=json`) is intended for local development only.

## Deployment patterns

- Docker / docker-compose: included `Dockerfile` and `docker-compose.yml`. Volume mount `./data:/app/data`.
- VPS / managed PaaS: `npm run build && npm start` with `.env` populated and `data/` on durable storage. Use `TELEGRAM_MODE=webhook` and set `PUBLIC_BASE_URL` when the host has public ingress; otherwise stay on `TELEGRAM_MODE=polling`.
- Backup `data/state.db` with `sqlite3 .backup` on a schedule. Do not copy a live SQLite file blindly.
- Cloudflare workers: optional. Example config in `cloudflare/market-worker/wrangler.toml.example`. Copy to `wrangler.toml`, fill in your own bucket/route names. Only needed if you enable the optional R2 market archive read path.

## Verifying

```bash
npm run typecheck
npm run build
npm run smoke:config
npm run smoke:live   # uses your configured RPCs; watchdog of ~2 minutes
```

The public repo should fail with a clear error when required live credentials are missing and should boot in `TELEGRAM_ENABLED=false WEB_ENABLED=true` without any private credentials.
