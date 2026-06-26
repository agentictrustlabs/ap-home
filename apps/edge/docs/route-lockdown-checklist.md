# Route-lockdown caller-migration checklist (spec 288 §6)

**Status: IN PROGRESS — lockdown NOT yet enabled. Advisory mode only.**

Route lockdown is sequenced LAST and gated (spec 288 §6): pulling a Worker's public exposure before
*every* caller is repointed is an outage. This checklist is the gate — lockdown proceeds only as rows flip
to ✅, and every step is reversible. Last reviewed: 2026-06-26.

## Two lockdown mechanisms (distinct — don't conflate)

1. **`DEMO_REQUIRE_GATEWAY_ASSERTION` (per-route, reversible).** An origin route rejects any request lacking
   a valid edge-issued `GatewayAssertion` (spec 288 §4) — i.e. only edge-admitted traffic passes. The full
   Web3 authority still runs. Flip on/off with a `--var` (no code change). **This is the real lock.**
2. **`workers_dev = false` (kills the public `*.workers.dev` URL entirely).** Removes the Worker's public
   ingress. **NOT reachable for demo-a2a** — see the finding below.

## Finding: full `workers_dev=false` is NOT achievable for demo-a2a (and isn't the goal)

demo-a2a is not just an A2A endpoint — it is the demos' **relayer + session + custody + auth API** (40+
routes: `/session/*`, `/account/*`, `/custody/google/*`, `/custody/youversion/*`, `/auth/*`, `/rpc`,
`/paymaster/*`, `/name/*`, `/deployments`). Every browser app (demo-web-pro, demo-web-recovery,
demo-web-payment, demo-org, demo-gs, demo-jp) calls these **directly** over `VITE_DEMO_A2A_URL`
(= the `*.workers.dev` URL). Killing `workers_dev` would break all of them, and the edge does **not** (and
should not — ADR-0043, it owns admission not authority) front custody/session/relayer routes.

**So lockdown is scoped to the public *ingress* surfaces the edge actually fronts** — the MCP ingress and
the A2A task endpoint — enforced via `DEMO_REQUIRE_GATEWAY_ASSERTION`. `workers_dev` stays `true`; the
relayer surface stays reachable. (A true private origin would split the relayer API into its own
non-public Worker — out of scope here.)

## Surface inventory

Legend: **LOCKABLE** = edge-fronted public ingress, a lockdown candidate · **NOT-LOCKABLE** = direct
browser/internal caller (relayer/session/custody/discovery) the edge doesn't front · **DEV** = dev-only.

### demo-mcp
| Route | Class | Caller(s) | Edge fronts? | Verifies assertion? |
| --- | --- | --- | --- | --- |
| `POST /mcp/native` | LOCKABLE | demo-web-pro Act6 Native panel; native-mcp-smoke | yes (`mcp.native`) | ✅ yes (advisory) |
| `POST /mcp` (OAuth) | LOCKABLE | demo-web-pro Act6 OAuth panel | yes (`mcp.oauth`) | ❌ not yet |
| `POST /tools/*` | NOT-LOCKABLE | demo-a2a via **Service Binding** (service-MAC) | n/a (internal) | n/a (MAC) |
| `POST /oauth/token` | NOT-LOCKABLE | demo-web-pro (browser, mints the bearer) | no | n/a |
| `/custody/vault-key/*` | NOT-LOCKABLE | demo-web-pro (browser, ceremony) | no | n/a |
| `/.well-known/oauth-protected-resource[/mcp]` | NOT-LOCKABLE | public MCP clients (discovery) | no | n/a |
| `GET /health` | NOT-LOCKABLE | ops | no | n/a |
| `POST /_dev/seed` | DEV | dev only (guarded `NODE_ENV!=production`) | no | n/a |

### demo-a2a
| Route | Class | Caller(s) | Edge fronts? | Verifies assertion? |
| --- | --- | --- | --- | --- |
| `POST /api/a2a` | LOCKABLE | external A2A agents (via the agent-card endpoint) | yes (`a2a.task`) | ❌ not yet |
| `GET /.well-known/agent-card.json` | LOCKABLE | A2A discovery | yes (`a2a.card`) | ❌ not yet |
| `/session/*`, `/account/*` | NOT-LOCKABLE | demo-web-* / demo-org / demo-gs / demo-jp (relayer) | no | n/a |
| `/custody/google/*`, `/custody/youversion/*` | NOT-LOCKABLE | browser custody flows | no | n/a |
| `/auth/*`, `/rpc`, `/paymaster/*`, `/name/*`, `/deployments` | NOT-LOCKABLE | browser apps | no | n/a |
| `POST /mcp/person/pii`, `/mcp/org/sensitive`, `/mcp/vault/*` | NOT-LOCKABLE | demo-web-pro (Variant-A exercise) — calls demo-a2a directly | no | n/a |

## Caller-migration checklist (the gate)

Lockdown of a LOCKABLE surface flips on only when ALL its rows are ✅.

### Prerequisites (shared)
- [x] **Edge issues GatewayAssertions** (spec 288 §4) — demo-edge signs on dispatch (`GATEWAY_ASSERTION_SECRET`).
- [x] **Origin can verify** — `verifyGatewayAssertion` + the HMAC verifier wired (demo-mcp native; advisory).
- [x] **Shared secret provisioned** — `GATEWAY_ASSERTION_SECRET` set on demo-edge + demo-mcp.
- [x] **Edge CORS** — DONE (2026-06-26): demo-edge answers the browser preflight (OPTIONS → 204 + ACAO)
      and tags its OWN responses for an allowed `EDGE_ALLOWED_ORIGINS` Origin; dispatched requests keep the
      origin's ACAO (Origin is not a stripped header, so no double-tag). Verified live: preflight from
      `agenticprimitives-demo-pro.pages.dev` → 204 + ACAO; `evil.example` → no ACAO. Browser callers can now
      be repointed at the edge.

### Surface 1 — demo-mcp `POST /mcp/native` — ✅ LOCKED (2026-06-26)
- [x] Origin verifies the assertion.
- [x] Repointed the only caller (demo-web-pro Act6 Native panel) `config.demoMcpUrl` → `config.demoEdgeUrl`
      (`VITE_DEMO_EDGE_URL`, propagated in deploy-cloudflare.ts §8); deployed. native-mcp-smoke supports
      `NATIVE_MCP_BASE=<edge>`.
- [x] **`DEMO_REQUIRE_GATEWAY_ASSERTION=true`** set in demo-mcp wrangler.toml + deployed. Verified live:
      direct `/mcp/native` → **401 gateway_assertion_required**; via-edge → **200**. Reversible: remove the
      toml line + redeploy → advisory.

### Surface 2 — demo-mcp `POST /mcp` (OAuth ingress)
- [ ] Add gateway-assertion verification to the `/mcp` handler (same pattern as native; operationId `mcp.oauth`).
- [ ] Repoint demo-web-pro Act6 OAuth panel → the edge URL.
- [ ] Flip require-mode (shares the same `DEMO_REQUIRE_GATEWAY_ASSERTION`, or a per-route flag).

### Surface 3 — demo-a2a `POST /api/a2a` + agent-card
- [ ] Add gateway-assertion verification to `/api/a2a` (operationId `a2a.task`).
- [ ] The public A2A endpoint today is the `<handle>.impact-agent.io` subdomain served **directly** by
      demo-a2a (Worker route), not the edge. Decide: front the subdomains through the edge, OR advertise
      the edge endpoint in the agent-card. (Larger — A2A discovery + subdomain routing.)
- [ ] Flip require-mode on `/api/a2a`.

## Reversibility + rollback

- Require-mode is a single `--var DEMO_REQUIRE_GATEWAY_ASSERTION:true|<omit>` on the next deploy — no code
  change, instant rollback by redeploying without it (default = advisory).
- NEVER set `workers_dev=false` on demo-a2a (breaks the relayer for every browser app).
- Always re-verify after a demo-a2a deploy: a stray `--keep-vars` or missing `--var ALLOWED_ORIGINS`
  clobbers CORS (see [[feedback_targeted_worker_deploy_replicate_vars]] / the deploy memory).
- Probe after each flip: direct call (expect 401 once required) + via-edge call (expect 200).

## Done so far this pass
- Surface inventory + the `workers_dev=false`-not-reachable finding.
- The two-mechanism model + the per-surface gate.
- **Edge CORS shipped + deployed** (the shared prerequisite) — browser callers can now target the edge.
- **Surface 1 (`/mcp/native`) LOCKED** — demo-web-pro Native panel repointed at the edge; require-mode
  enabled + verified live (direct 401, via-edge 200). The first surface is private-behind-the-edge.

## Next concrete steps
- **Surface 2 (`/mcp` OAuth)** — add gateway-assertion verification to the `/mcp` handler (operationId
  `mcp.oauth`), repoint demo-web-pro Act6's OAuth panel → the edge, then it locks under the same flag.
- **Surface 3 (`/api/a2a`)** — add verification + resolve the subdomain-vs-edge discovery question.
