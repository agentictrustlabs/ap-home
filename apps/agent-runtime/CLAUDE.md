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
  `index.ts` supplies the substrate. **`POST /harness/ask {session, addressee, message, presented?, supplied?}`**
  is the conversational entry (spec 350 §3.6/§3.7): it returns ONE of `answer` · `authority_required` (the
  `MandateRequirementV1` the plan needs — 401, never 403) · `prompt` · `done`. Reads go to the PUBLIC agent
  directory through the `DISCOVERY_MCP` service binding (`ask-discovery.ts` — ADR-0040: public, on-chain-derived
  facts, read-only, no GraphDB credential here, and the indexer stays the KB's only writer); the private vault
  is not reachable from this surface. **faithnet only** (`demo-discovery-mcp-faithnet`; the production binding
  is find_members' and projects Base Sepolia). Live checks:
  `scripts/verify-harness-payment.mts`, `-team-create.mts`, `verify-ask-surface.mts`. **`POST /harness/hear`**
  (spec 369): audio → words, Workers AI Whisper behind `TranscriberPort` (`src/voice.ts`), biased by what the
  agent knows about the asker and repaired against known labels; in memory only. Every ask reply carries `spoken`.
  **Spec 370 (parity waves):** a resume REPLAYS completed steps (`executed` on the checkpoint, P1); progress lines
  long-polled at `POST /harness/progress` (P2, `harness-progress.ts`); coordination reads/acts bound thinly onto the
  Endeavor substrate (P4, `coordination-bindings.ts`); **triggers** (P5, `triggers.ts`): the playbook's `triggers[]`
  sync to the agent's task DO on every ask and fire under its single alarm as `runUnattendedAsk` — the agent asks
  as itself with no mandate; an act parks open to stewards; `POST /harness/triggers` + `/triggers/fire` (stewards).
  **Spec 371:** reads declare `answers`/`answer`; `balance-read.ts` (`treasury.balance.read`) renders
  "alice2.treasury holds 190.1 USDC."; question admission + a question-fidelity check on the composer.
  **Spec 372 S2 (`standard-a2a.ts`):** `POST /api/a2a` serves the A2A **1.0** PascalCase methods too — the
  Home session as a bearer is the principal, the executor is `/harness/ask` in-process, the reply kind is
  the task state (`prompt` → INPUT_REQUIRED, `authority_required` → AUTH_REQUIRED). The live card gains the
  1.0 fields; a released card is untouched. A door, never a grant.

## What this app does not own

- Package delegation semantics → `packages/delegation`.
- MCP middleware primitives → `packages/mcp-runtime`.
- MCP tool implementation → `apps/demo-mcp`.
- Browser UX → `apps/demo-web*`.
- Contract source → `packages/contracts`.

## Read These First

`package.json` (scripts) → `src/index.ts` (route map + wiring; contains a stray non-UTF8 byte — `grep -a`) →
`src/validate.ts` → `../demo-mcp/CLAUDE.md` when changing MCP proxy behavior.

**How the harness works (the whole picture):** start at the **Reading map** in
[`docs/architecture/harness-architecture-diagrams.md`](../../docs/architecture/harness-architecture-diagrams.md)
— it indexes, by question, the intent flow (`harness-run.ts` → `orchestration/loop.ts` → `delegation/mandate.ts`),
persistent/long-lasting runs (`harness-runs.ts`, `a2a-task-do.ts`, `harness-workflow*.ts` — spec 350 W3 + spec 362),
the knowledge/memory tiers (`ask-discovery.ts` + `@agenticprimitives/context` + vault; specs 356–358), and how
`~/skills` archetypes reach a run (`playbook.ts` `loadPlaybook`; spec 354).

## Validate

`pnpm --filter @agenticprimitives-demo/a2a typecheck` + `pnpm --filter @agenticprimitives-demo/a2a test`.

## Deploy — NEVER bare `wrangler deploy`

Deploy ONLY via `pnpm deploy:cloudflare` (repo root). The wrangler.toml production vars are fail-closed
placeholders (`ALLOWED_ORIGINS=""`, `MCP_URL=""`); the script injects the real values via `--var` (plus
PAYMASTER, BROKER_ISS/JWKS, edge flags, KMS backend). A bare `wrangler deploy --env production` wipes
them → every browser POST fails CSRF with 403 (2026-07-07 incident; fixed by `wrangler rollback`).

Generated (ignore): `.wrangler/`, `dist/`, `node_modules/`.
