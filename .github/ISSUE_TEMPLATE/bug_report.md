---
name: Bug report
about: Report a self-hosting bug in baes scan OSS
title: "[bug] "
labels: bug
---

<!--
DO NOT PASTE:
- Telegram bot tokens
- RPC URLs with embedded API keys
- Blockscout PRO API keys
- Cloudflare R2 access keys
- Contents of data/state.db or any SQLite/WAL/SHM files
- Wallet addresses you do not want public

Redact any of the above before submitting. See SECURITY.md.
-->

## What happened?

A clear description of the bug.

## Expected behavior

What you expected instead.

## Reproduction

1. ...
2. ...
3. ...

The exact Telegram command or web URL that misbehaved, with addresses redacted if needed.

## Environment

- Commit SHA or release tag:
- Node version (`node -v`):
- OS / host (VPS, Coolify, Docker, Railway, bare metal):
- Chain and DEX involved:
- Storage backend (`STORAGE_BACKEND`):

## Relevant `.env` (with values redacted)

```env
PRIMARY_CHAIN=
ENABLED_CHAINS=
MARKETS_ENABLED=
WALLET_PNL_ENABLED=
TELEGRAM_MODE=
```

## Logs (redacted)

```
paste relevant lines, with tokens / RPC URLs replaced by REDACTED
```
