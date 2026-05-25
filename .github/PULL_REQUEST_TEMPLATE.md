<!--
DO NOT include in this PR:
- real Telegram bot tokens
- RPC URLs with embedded API keys
- Blockscout PRO keys
- Cloudflare R2 access keys
- contents of data/state.db
See SECURITY.md.
-->

## Summary

What changes, and why.

## Scope

- [ ] Bug fix
- [ ] New feature
- [ ] Chain or DEX adapter
- [ ] Docs only
- [ ] Refactor

## Cost / risk notes

Does this PR add new RPC calls, Blockscout calls, or background work? Is the new behavior opt-in via an env var? Did you update `.env.example` with cost warnings?

## Verification

- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `npm run smoke:config`
- [ ] `npm run smoke:live` (if RPC behavior changed)
- [ ] Updated README / docs where user-visible behavior changed
- [ ] Added or updated a live-smoke fixture if a new chain/DEX adapter

## Security checklist

- [ ] No signing, wallet management, or transaction submission is introduced
- [ ] No third-party indexer calls without an explicit env opt-in
- [ ] No private credentials are committed
