# agent-runtime — Claude guide

## What this app is
The estate's agent runtime Worker (deployed as `demo-a2a-faithnet` / `imb-runtime`): the A2A boundary where a Home
session or an agent's wire becomes bounded authority — the harness, the per-agent task and interactions objects, the
gateway mount, the standard A2A surface, the credential acts. Every act runs under a mandate; a message is never
authority (ADR-0041); the vault is the record and DO storage a serving plane (ADR-0055).

## What this app owns
- **Sessions, relay, tokens.** SIWE/passkey auth, CSRF/CORS, gasless Smart Agent calls, delegation-token minting.
- **`A2aTaskDO`** (spec 269) with skills `echo`, `orchestrate` (ADR-0044) and the messaging skills
  (`messaging.deliver` / `interactions.respond` / `interactions.deliverCredential`, `src/messaging-skills.ts`): a
  delivery is admitted into the recipient's vault inbox by the recipient's own delivery wire.
- **The mounted gateway** (`src/gateway-mount.ts`): a co-resident `PrincipalGatewayDO` with the MCP-backed vault
  injected; one op routed through it. **The org-assistant turn** (spec 327, `src/discussion-skill.ts`).
- **The Card Studio service side** (spec 347, `src/agent-card-studio.ts`): records in the agent's vault; JWS +
  EIP-712 binding verified here, never signed here; `RELEASED_CARDS` KV is a cache.
- **The harness** (spec 350, `src/harness-run.ts`): `POST /harness/ask` → `answer` · `authority_required` · `prompt` ·
  `done`; `/harness/run`, `/progress`, `/hear` (spec 369), `/triggers` (spec 375). Resume replays completed steps;
  custody is always the connected user. **Standard A2A** (`src/standard-a2a.ts`, spec 372): one wire, A2A 1.0.
- **The credential acts** (spec 444; `src/credential-issue.ts`, `src/credential-request.ts`): `credential.request` is
  the member's own act — her agent confirms her membership with the organization's object, takes the PUBLIC half of
  her device key (`credential.device-key:*`, a managed key preferred over a local stand-in) and leaves
  `credential.request:<her>` in the organization's vault. `credential.issue` is the organization's act under its
  steward's mandate: roster → `credential.issuer-facet:*` (put by the steward through `issuer.facet.put`) → the
  key service's issuing key (`ES256_ISSUE_SHA256` under issuance evidence, `src/credential-issuer-deps.ts`) →
  `credential.issued:<digest>` (never claim values) → the vouch `federation.projection-submission:live-credential:*`
  in the org's vault → `credential.anonymous:<digest>` delivered into the MEMBER's vault by her own grant.
- **Routed asks** (`src/subject-hop-credential.ts`): over the wire an ask carries the app delegation it was admitted
  under, or nothing — a Home session never rides to another host (spec 397 §11.5) except a named peer. A target whose
  card declares the pairwise asker (spec 442 §4.1) is asked under her pseudonym derived from `identity.pairwise-secret`,
  minted on first need in her own vault.
- **The runtime wake and pairing** (spec 400 W1b/W1c, `src/runtime-wake.ts`, `src/runtime-pairing.ts`); the open
  mandate (W2a): an agent continues its own parked run with the chain it derived from a standing grant.
- Declared-effect writes into a principal's own vault are allowlisted by record type (`EFFECT_WRITABLE_RECORDS` in
  `src/interactions-do.ts`); the grant's additive scopes live in `apps/shared/src/index.ts`.

## What this app does not own
Delegation semantics → `delegation`; MCP middleware → `mcp-runtime`; the vault tools → `apps/vault`; browser UX →
`apps/home`; contracts → Ring 0.

## Read these first
`package.json` → `src/index.ts` (route map + `harnessDeps`; contains a stray non-UTF8 byte — `grep -a`) →
`src/harness-run.ts` → [`docs/architecture/harness-architecture-diagrams.md`](../../docs/architecture/harness-architecture-diagrams.md)
(the reading map: intent flow, durable runs, knowledge tiers, playbooks via `src/playbook.ts`).

## Validate
`pnpm --filter @ap-home/agent-runtime typecheck` + `pnpm --filter @ap-home/agent-runtime test`.

## Deploy
`wrangler deploy --env <estate>` from this directory; the estate's vars are in `wrangler.toml` under `[env.<estate>.vars]`
and its secrets are set once (`scripts/set-estate-secrets.sh`). A deploy does not touch DO state; grants whose
session leaf expired report `current: false` until re-enabled (`scripts/enable-interactions-at.mts`).

Generated (ignore): `.wrangler/`, `dist/`, `node_modules/`.
