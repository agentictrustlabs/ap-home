# demo-a2a — Claude guide

## What this app is

Cloudflare Worker that acts as the demo A2A boundary. It verifies browser
sessions, handles gasless smart-account calls, mints delegation tokens, and
proxies selected MCP requests during local demos.

## What this app owns

- HTTP routes for SIWE/passkey demo auth and session bootstrap.
- Demo relayer behavior for contract calls and UserOps.
- Delegation-token minting for MCP calls.
- Local Worker bindings and CSRF/CORS enforcement.

## What this app does not own

- Package delegation semantics → `packages/delegation`.
- MCP middleware primitives → `packages/mcp-runtime`.
- MCP tool implementation → `apps/demo-mcp`.
- Browser UX → `apps/demo-web*`.
- Contract source → `packages/contracts`.

## Read These First

1. `package.json` — Worker scripts.
2. `src/index.ts` — route map and app wiring.
3. `src/validate.ts` — request validation.
4. `../demo-mcp/CLAUDE.md` when changing MCP proxy behavior.

## Validate

```bash
pnpm --filter @agenticprimitives-demo/a2a typecheck
```

## Generated Files

`.wrangler/`, `dist/`, `node_modules/`.
