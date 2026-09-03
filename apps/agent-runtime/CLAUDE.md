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
- The **Card Studio service side** (spec 347 §9 / ADR-0062, `src/agent-card-studio.ts`, route
  `POST /agent-cards/:op` mirroring `/mcp/vault/*`): the Home presents the stewardship delegation; every
  record (`agent-cards:* projections:* bindings:* approvals:*`) lives in the AGENT's vault via
  `callMcpToolWithProof`; `RELEASED_CARDS` KV is a serving-plane cache the well-known route serves
  byte-for-byte (rebuild, never a bereavement). Client-produced ES256 JWS + EIP-712 SA binding are
  VERIFIED here, never signed here; publication plans return `{to,value,data}` calls the Home executes with
  the custodian, then `recordPublication` verifies with `readContract` only. Service-agent callers get
  `STEWARD_DEFAULT_SCOPES`; `SEPARATION_OF_DUTIES=strict` refuses editor-approves. Guide:
  `apps/demo-sso-next/docs/agent-cards/guide.md`.

- **The harness under a mandate** (spec 350 W2, `src/harness-run.ts`, route `POST /harness/run {session, intent,
  presented, approvals?, supplied?, runRef?}`): `treasury.payment.execute` redeems the mandate on chain from
  `HARNESS_AGENT_SA`; `organization.team.create` does what the Home's team button does, conversationally —
  asks (§3.5 prompts) for the connected credential and its signature over a genesis it derives from the ask,
  re-derives + checks the signed op, submits. Custody is ALWAYS the connected user. `teamGenesisDeps` in
  `index.ts` supplies the substrate. Live checks: `scripts/verify-harness-payment.mts`, `-team-create.mts`.

## What this app does not own

- Package delegation semantics → `packages/delegation`.
- MCP middleware primitives → `packages/mcp-runtime`.
- MCP tool implementation → `apps/demo-mcp`.
- Browser UX → `apps/demo-web*`.
- Contract source → `packages/contracts`.

## Read These First

`package.json` (scripts) → `src/index.ts` (route map + wiring; contains a stray non-UTF8 byte — `grep -a`) →
`src/validate.ts` → `../demo-mcp/CLAUDE.md` when changing MCP proxy behavior.

## Validate

`pnpm --filter @agenticprimitives-demo/a2a typecheck` + `pnpm --filter @agenticprimitives-demo/a2a test`.

## Deploy — NEVER bare `wrangler deploy`

Deploy ONLY via `pnpm deploy:cloudflare` (repo root). The wrangler.toml production vars are fail-closed
placeholders (`ALLOWED_ORIGINS=""`, `MCP_URL=""`); the script injects the real values via `--var` (plus
PAYMASTER, BROKER_ISS/JWKS, edge flags, KMS backend). A bare `wrangler deploy --env production` wipes
them → every browser POST fails CSRF with 403 (2026-07-07 incident; fixed by `wrangler rollback`).

Generated (ignore): `.wrangler/`, `dist/`, `node_modules/`.
