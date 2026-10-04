# demo-edge — Claude guide

The **Agentic Edge admission Worker** (spec 288 §6) — the demo's public ingress. It runs admission
(`edge-runtime` via the `edge-cloudflare` adapter), serves `/.well-known/agentic-authorization`, and
dispatches admitted bytes to **demo-mcp / demo-a2a over Service Bindings**. It owns **no authority**
([ADR-0043](../../docs/architecture/decisions/0043-edge-owns-admission-never-authority.md)) — the
downstream Workers still run the full Web3 pipeline.

## What it does (per request)
1. `GET /.well-known/agentic-authorization` → discovery doc from public on-chain config (spec 292).
2. `extractAdmissionRequest` → `runAdmission` (trusted-header hygiene → size/depth/envelope → Stage-1
   abuse via the Workers rate-limiter binding, fail-soft) → on success, `dispatchToBinding` forwards the
   **exact bytes** to the matched origin and sets the edge-minted `x-correlation-id`.
3. On any admission failure: a single generic error (never the internal classifier — info-leak).

The route catalog (`CATALOG` in `src/index.ts`) is app config: concrete paths + binding names live here,
never in the generic packages (ADR-0021).

## Deploy (read first)
- `cd apps/edge && wrangler deploy --env production` (gets a `workers.dev` URL; `workers_dev=true`).
- Service Bindings (`wrangler.toml`): `MCP → demo-mcp-production`, `A2A → demo-a2a-production` (same account).
- **Route lockdown is NOT done here.** Making demo-a2a/demo-mcp private (`workers_dev=false`, drop public
  routes) is sequenced LAST and gated on a caller-migration checklist (spec 288 §6) — pulling it early is
  an outage. Until then the downstream Workers keep their current public exposure; the edge fronts them.

## Hard rules
- **No authority imports** (ADR-0043): never import `delegation`/`mcp-runtime`/`tool-policy`/`entitlements`/
  `key-authorization`/`a2a`. Authority runs at the origin, reached only via the Service Binding.
- **Forward exact bytes** — never re-serialize (the native pipeline re-hashes for spec 287).
- **Single generic error** on admission failure; the correlation id is the only client-visible handle.

## Validate
`cd apps/edge && pnpm typecheck`.
