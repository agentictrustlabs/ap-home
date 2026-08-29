# chain-rpc-gateway

A Cloudflare Worker that fronts a **private chain JSON-RPC origin** for apps that cannot reach it
directly: per-app tokens, a JSON-RPC method allow-list, per-app rate limits, a read cache, and an
optional `eth_estimateGas` gas-cap injection. Deployed infrastructure (the same class as
[`apps/demo-edge`](../demo-edge)), not a Ring-0 primitive. The implementation is chain-agnostic;
every hostname, origin and Worker name lives in a `wrangler.toml` `[env.<name>]` block (ADR-0021).

```
clients ──Bearer or ?k=──▶ chain-rpc-gateway ──ORIGIN──▶ private RPC origin ──▶ node
```

## What is here / what is not

| Here | Not here (stays where it is) |
| --- | --- |
| `src/index.ts` — CORS, Bearer/`?k=`, allow-list, gas-cap inject, cache, forward | The node, its VM/terraform, the tunnel + access layer in front of the origin |
| `src/config.ts` — `READ_METHODS` / `WRITE_METHODS` / `CACHE_TTL_S` / `injectEstimateGasCap` | Token issuance beyond the KV command below (no package, no secrets in git) |
| `src/ratelimit.ts` — `RateLimiter` Durable Object (per-app token bucket) | Consumer `RPC_URL` values |

## Auth

`Authorization: Bearer <token>` **or** `?k=<token>` in the URL (header-less clients — a viem client in
the browser, forge). A token that ships in a browser bundle is issued with `writeRps: 0`, so it can
only read. Tokens are looked up by hash; the raw token is never stored.

Mint / revoke (operator action, per env):

```bash
TOKEN=$(openssl rand -base64 32 | tr -d '=/+' )                       # give this to ONE app
KEY="t:$(printf '%s' "$TOKEN" | sha256sum | cut -d' ' -f1)"
wrangler kv key put --binding TOKENS --env <env> "$KEY" '{"app":"<app-name>","readRps":20,"writeRps":0}'
wrangler kv key delete --binding TOKENS --env <env> "$KEY"            # revoke
```

## Behaviour

- Allowed methods: the read set + `eth_sendRawTransaction`. Anything else → `403` / `-32601`.
- Batches ≤ 50. Rate limit per `app` (reads / writes separately) → `429` / `-32005`.
- Read cache: chain identity 1 h; keyed reads (block hash / receipt / explicit block) 30 s; tip reads
  2 s; `pending` never. Errors and `null` results are never cached (receipt polls stay live).
- `ESTIMATE_GAS_CAP` (hex) is injected into `eth_estimateGas` calls that set no `gas`; empty = never.
- CORS reflects `Origin` — auth is the token, never a cookie.

## Environments and deploy

Each private chain is one `[env.<name>]` in `wrangler.toml` carrying its Worker name, custom domain,
`ORIGIN`, `ESTIMATE_GAS_CAP`, KV and DO bindings. **The Worker name of an env must never change** —
its KV, DO storage and custom domain are bound to it, and a rename 401s every issued token.
The bare `name` at the top of `wrangler.toml` exists for `wrangler dev` only; `pnpm run deploy` refuses
to run without `WRANGLER_ENV`, so a second Worker cannot be published by accident.

```bash
pnpm --filter @agenticprimitives-demo/chain-rpc-gateway typecheck
pnpm --filter @agenticprimitives-demo/chain-rpc-gateway test
WRANGLER_ENV=<env> pnpm --filter @agenticprimitives-demo/chain-rpc-gateway run deploy
```

Smoke after a deploy (with an issued read token, `$GW` = the env's custom domain):

```bash
curl -s "$GW" -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'                    # → the env's chain id
curl -s "$GW/?k=$TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0x"]}'   # writeRps 0 → 429; unlisted → 403
```

The Base Sepolia demo stack (`scripts/deploy-cloudflare.ts`) does not include this Worker — it
fronts private chains only.
