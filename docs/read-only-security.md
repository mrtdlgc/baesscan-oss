# Read-Only Security Model

baes scan is read-only by design. It does not custody, sign, or submit transactions. This document spells out what the bot reads, what it stores, what credentials it needs, and how to revoke them.

If you find behavior in the code that contradicts this document, please open a security report (see [SECURITY.md](../SECURITY.md)).

## What the bot reads

From the configured chain RPCs:

- Latest block number and headers
- Factory / PoolManager event logs in bounded ranges (controlled by `POOL_SCAN_LOOKBACK_BLOCKS`, hard-capped to 50k)
- Pair / pool swap logs in bounded ranges
- ERC-20 metadata (`name`, `symbol`, `decimals`, `totalSupply`)
- Transaction and block details for sender attribution
- `balanceOf` for the optional intel holder gate

From Blockscout (when `BLOCKSCOUT_API_KEY` is set):

- `getcontractcreation` for contract-creator lookups
- Bounded log ranges for optional wallet-PnL pool discovery and optional archive ingestion

From Telegram:

- Messages and updates in chats it has been added to
- `getChat` to resolve titles, usernames, and invite links (only what Telegram exposes to bots)

From GeckoTerminal: optionally embedded as a chart frame on web pages, not used for pool discovery or alert data.

## What the bot does NOT read

- Wallet private keys, mnemonics, or signing material. The bot has no concept of them.
- User keystrokes, browser history, or anything off-chain about a wallet's owner.
- Telegram DMs from users who have not opened the bot.
- Any RPC method that requires the node operator to expose privileged endpoints.

## What the bot stores

Locally in `data/state.db` (or the JSON fallback):

- Per-chat configuration: tracked tokens, pools, alert thresholds, emoji settings, alert topic ids, banned chat ids, enabled state.
- Pool metadata learned during discovery.
- A bounded recent-swap window for alert dedup.
- Optional wallet-PnL ledger rows: normalized DEX trades, FIFO cost basis, per-token aggregates. Retained for `WALLET_PNL_RETENTION_DAYS` (default 3).
- Cached creation-contract lookups, snapshot blobs, and historical-backfill results.

Cached in process memory:

- RPC pool health counters, learned `eth_getLogs` ranges.
- Recent alerts to suppress duplicates.

Not stored:

- Bot tokens, RPC URLs with embedded keys, Blockscout keys, R2 credentials. Those are read from environment at startup.
- User Telegram passwords or 2FA secrets. Telegram does not give bots access to these.
- Wallet private keys (the bot does not handle them at all).

## What credentials it needs

| Credential | Purpose | Where it lives | How to revoke |
| --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Send and receive Telegram messages | env only | Rotate with `/revoke` in [@BotFather](https://t.me/BotFather) |
| `*_RPC_URLS` | Read chain state | env only | Rotate at the RPC provider dashboard |
| `BLOCKSCOUT_API_KEY` | Optional contract-creator and archive lookups | env only | Rotate at Blockscout |
| `R2_*` | Optional market archive storage | env only | Rotate at Cloudflare |
| `INTEL_SESSION_SECRET` | Optional gated `/intel` session cookies | env only | Set a new value and redeploy |
| `WEB_ADMIN_PASSWORD` | Optional `/admin/copy-shadow` page | env only | Set a new value and redeploy |

None of these are persisted to the SQLite database. Revoking the source credential and restarting the process is sufficient.

## Telegram permissions the bot needs

Inside a group:

- Read messages (otherwise it cannot see `/watch`).
- Send messages (to post alerts).
- For forum supergroups: ability to post in the target topic.

It does **not** need: admin rights, "add members" rights, "delete messages" rights, "manage chat" rights. Self-hosters who give the bot admin are giving it more access than it needs.

## Owner trust model

`OWNER_USER_IDS` is a trusted set. Owners can broadcast, view sanitized DB rows, and ban chats. Treat owner ids the way you would treat root SSH on the host: only your own Telegram numeric id should be there. There is no separate password.

`ADMIN_USER_IDS` is a softer scope used for per-chat write commands when a user is not a Telegram-side group admin.

## How to verify these claims yourself

- `src/index.ts` is the entry point.
- `src/bot/` contains every Telegram command handler. Grep for `bot.command(` and `bot.action(`.
- `src/services/` has the RPC, Blockscout, R2, and wallet-PnL service code.
- `src/store/` has the SQLite and JSON storage backends. Schema is in `sqliteStore.ts`.
- `src/config/env.ts` is the single source of truth for required env vars.
- There is no `eth_sendTransaction`, no `signMessage`, no `Wallet(`, no `eth_sign` call path anywhere in `src/`. (Grep the tree.)

If you add features, keep this property true. Any PR that introduces a signing primitive will be rejected.

## Reporting issues

See [SECURITY.md](../SECURITY.md). Do not paste live bot tokens, RPC URLs with embedded keys, Blockscout keys, R2 secrets, or `state.db` contents into public issues.
