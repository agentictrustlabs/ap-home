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
- The per-agent A2A Task runtime (`A2aTaskDO`, spec 269) + its `SkillHandler`s: `echo`, `orchestrate`
  (ADR-0044), and the **A2A messaging skills** `messaging.deliver` / `interactions.respond` /
  `interactions.deliverCredential` (`src/messaging-skills.ts`, spec 309 §7 / **316 §11a**). Delivery rides
  standard `message/send`; the skill delegation-authorizes it, then admits DIRECTLY into the recipient's
  **vault** inbox (`message.body:<id>` + `inbox.data`, via `ctx.delegation`) — no Home callback. A message
  is never authority (ADR-0041).
- The **mounted gateway** (ADR-0055 amendment): `src/gateway-mount.ts` builds a co-resident
  `PrincipalGatewayDO` — no second DO binding, no migration tag — with the MCP-backed vault INJECTED, and
  `InteractionsDO` routes exactly ONE op through it (`gateway.inbox.get`, mirroring `inbox.get` on the
  same record). The gateway supplies the verdict cache + request-id ledger; the record never leaves the
  owner's vault. `exchangeStore`/`interactionStore` stay DO-local only because this op touches neither.
- The **org-assistant turn** (spec 327, 318 §8.1): `InteractionsDO.channels.post` detects a topic
  @-mention → in-Worker dispatch to the org's `A2aTaskDO` `/internal/discussion-respond` (marker-gated,
  NOT on the agent card) → `src/discussion-skill.ts` runs the shared loop → reply lands via
  `internal.channels.post`, `from`/`actor` pinned to the org SA.

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

## Deploy — NEVER bare `wrangler deploy`

Deploy ONLY via `pnpm deploy:cloudflare` (repo root). The wrangler.toml production vars are
fail-closed placeholders (`ALLOWED_ORIGINS=""`, `MCP_URL=""`); the script injects the real values
via `--var` (plus PAYMASTER, BROKER_ISS/JWKS, edge flags, KMS backend). A bare
`wrangler deploy --env production` wipes them → every browser POST fails CSRF with 403
(2026-07-07 incident; fixed by `wrangler rollback`).

## Generated Files

`.wrangler/`, `dist/`, `node_modules/`.
