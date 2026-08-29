# chain-rpc-gateway — Claude guide

Deployed Cloudflare infra (apps/*), **not** a primitive: fronts a private chain RPC origin with per-app
tokens, a method allow-list, per-app rate limits (Durable Object) and a read cache. Read
[`README.md`](README.md) first.

## Rules
- **The implementation is chain-agnostic.** No vertical or deployment names in `src/`, `test/`, or
  scripts; `ORIGIN`, `ESTIMATE_GAS_CAP`, Worker names, domains and KV ids live only in
  `wrangler.toml [env.<name>]` (ADR-0021). Empty `ESTIMATE_GAS_CAP` = no injection.
- **Never deploy bare.** `pnpm run deploy` refuses without `WRANGLER_ENV=<env>`. The bare `name` is for
  `wrangler dev`. A second chain is another `[env.*]`, never another repo or a renamed Worker.
- **An env's Worker name never changes** — its KV `TOKENS`, `RateLimiter` DO storage and custom domain
  are bound to it; renaming 401s every token. The shared migration tag `v1` is applied — do not bump.
- Tokens: `t:<sha256(token)>` KV records, minted/revoked by the operator (README). No secrets in git.
- Behaviour constants (`src/config.ts`) change only with a test in `test/config.test.ts`.

## Out of scope here
The node / VM / tunnel / access layer (the origin side), token issuance tooling, consumer `RPC_URL`s,
`scripts/deploy-cloudflare.ts` (Base Sepolia demo stack).

## Validate
`pnpm check:chain-rpc-gateway` (typecheck + test), then `WRANGLER_ENV=<env> pnpm --filter @agenticprimitives-demo/chain-rpc-gateway run deploy`.
