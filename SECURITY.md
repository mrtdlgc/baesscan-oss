# Security Policy

baes scan is a read-only DEX scanner and Telegram bot. It does not handle private keys, signatures, or any form of trading. Self-hosters are still responsible for the secrets they configure (Telegram bot tokens, RPC URLs with credentials, Blockscout keys, Cloudflare R2 access keys, and the database file).

## Reporting a vulnerability

**Do not** open a public GitHub issue for vulnerabilities. Public issues are indexed and may put live users at risk before a fix ships.

Report privately via GitHub's "Report a vulnerability" form on this repository (Security tab → Report a vulnerability).

Please include:

- a clear description of the issue and impact
- minimal reproduction steps
- the commit SHA or release tag you tested against
- any relevant logs (redact bot tokens, RPC URLs with embedded keys, wallet addresses you do not want public)

You should receive an acknowledgement within a few business days. Coordinated disclosure timelines are negotiated case by case.

## What is in scope

- Code in this repository (`src/`, `apps/seo`, `cloudflare/*` examples, scripts).
- Default behavior of a self-hosted deployment configured from `.env.example`.
- Reproducible issues against a current `main` or tagged release.

## What is out of scope

- The hosted [baesscan.com](https://baesscan.com) service. Report hosted-product issues through the public site contact.
- Third-party RPCs, Blockscout, GeckoTerminal, Telegram, or Cloudflare. Report those upstream.
- Self-inflicted misconfiguration (leaking your own bot token in a repo, exposing `state.db` publicly, etc.). We will still try to harden defaults if a default makes the misconfiguration easy.
- Issues that require a malicious owner / admin Telegram user; owner commands trust the configured owner.

## Reporting hygiene

When opening any issue or PR, **never paste**:

- Real Telegram bot tokens (`123456789:AA…`)
- RPC URLs with API keys (`https://…/v2/<key>`, `https://…?apikey=…`)
- Blockscout PRO API keys
- Cloudflare R2 access key id or secret access key
- Contents of `data/state.db`, `state.db-wal`, `state.db-shm`, or any local SQLite files
- Private wallet addresses you do not want indexed

If you accidentally leak a secret, rotate it immediately at the provider.

## The bot will never ask for private keys

baes scan is read-only. Any Telegram message, DM, or web page claiming to be baes scan and requesting a seed phrase, private key, or signed transaction for "verification" is a phishing attempt. Report it to the platform and ignore it.
