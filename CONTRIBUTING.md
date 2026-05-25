# Contributing to baes scan (OSS)

Thanks for your interest in baes scan. This repository is the self-hosted alpha. Contributions that help self-hosters run the scanner reliably, add coverage for new chains/DEXes, or harden the read-only security model are very welcome.

## Before you open an issue

1. Check existing issues and pull requests.
2. Read [docs/self-hosting.md](docs/self-hosting.md) and [docs/rpc-costs.md](docs/rpc-costs.md) first — many "bugs" are actually RPC quota or backfill issues.
3. Do **not** paste real bot tokens, RPC URLs with credentials, Blockscout keys, R2 secrets, or `state.db` contents into issues. See [SECURITY.md](SECURITY.md) for reporting hygiene.

When you file a bug, include:

- the commit SHA you are running
- the relevant `.env` keys (with values redacted)
- the chain and DEX involved
- the exact Telegram command or web URL that misbehaved
- log output with secrets redacted

## Development setup

```bash
npm install
cp .env.example .env
# fill in TELEGRAM_BOT_TOKEN and at least one *_RPC_URLS value
npm run typecheck
npm run build
npm run smoke:config
```

For a no-secret diagnostic boot:

```bash
TELEGRAM_ENABLED=false WEB_ENABLED=true npm start
```

For live RPC coverage of bundled pool fixtures:

```bash
npm run smoke:live
```

## Pull request guidelines

- Open an issue first for non-trivial changes so we can agree on scope.
- Keep PRs focused. Mixing a chain adapter, a bot command, and a refactor in one PR makes review slow.
- Run `npm run typecheck` and `npm run build` locally before pushing.
- If you add a new env var, document it in `.env.example` with comments that explain cost and safety implications.
- If you add a new chain or DEX adapter, add a fixture to the live smoke set so future RPC regressions are visible.
- Update README/docs when behavior visible to self-hosters changes.

## Things we will probably not merge

- Anything that adds signing, wallet management, or transaction submission. This bot is read-only by design.
- Features that silently make outbound calls to third-party indexers or analytics services without an env opt-in.
- Removing the AGPL notice or relicensing.
- Bundling private API keys, RPC URLs, or production deployment details.

## Suggested issue labels

```text
bug
docs
self-hosting
rpc-cost
chain-support
dex-adapter
telegram
wallet-intel-alpha
good-first-issue
security
```

## Code of conduct

Be kind. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

By contributing you agree that your contributions are licensed under the project license, [AGPL-3.0-or-later](LICENSE).
