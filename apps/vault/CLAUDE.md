# demo-mcp — Claude guide

## What this app is

Cloudflare Worker MCP demo server. It exposes delegated tools and records audit
events while consuming `@agenticprimitives/mcp-runtime`, `delegation`,
`tool-policy`, and `audit`.

## What this app owns

- MCP tool routes used by demos (service-MAC `/tools/*`).
- OAuth ingress for public HTTP MCP clients (spec 277 Phase 6): RFC 9728 discovery
  (`/.well-known/oauth-protected-resource[/mcp]`), an open demo authorization
  endpoint (`/oauth/token`, fail-closed behind `DEMO_OAUTH_MINT_ENABLED`), and a
  bearer-gated `/mcp` route. OAuth is ONLY ingress —
  the real authority chain (`readSensitive`: entitlement → KAS → required audit →
  decrypt) re-runs server-side off the grant bundle's principal. App-side HS256
  sign/verify + the vault-backed grant-bundle store live in `src/oauth.ts`.
- D1-backed demo data and local migrations.
- Delegation/JTI replay checks as app wiring around package primitives.
- Audit demo guide in `docs/audit/guide.md`.

## What this app does not own

- Delegation token format → `packages/delegation`.
- Generic MCP middleware → `packages/mcp-runtime`.
- Tool risk taxonomy → `packages/tool-policy`.
- Audit schema/sinks → `packages/audit`.
- A2A relayer/session routes → `apps/demo-a2a`.

## Read These First

1. `package.json` — Worker and D1 scripts.
2. `src/index.ts` — tool declarations and routes.
3. `docs/audit/guide.md` — canonical audit walkthrough.
4. `../../specs/206-audit.md`.

## Validate

```bash
pnpm --filter @agenticprimitives-demo/mcp typecheck
```

## Generated Files

`.wrangler/`, `dist/`, `node_modules/`.
