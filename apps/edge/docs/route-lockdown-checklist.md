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

### Surface 2 — demo-mcp `POST /mcp` (OAuth ingress) — ✅ LOCKED (2026-06-26)
- [x] Added gateway-assertion verification to the `/mcp` handler (shared `checkGatewayAssertion` helper —
      native refactored to it too; operationId `mcp.oauth`, raw-body digest, gates before the OAuth logic).
- [x] Repointed demo-web-pro Act6 OAuth panel: the bearer-gated `/mcp` call → the edge
      (`config.demoEdgeUrl ?? demoMcpUrl`); the `/oauth/token` MINT stays direct (NOT-LOCKABLE). Deployed.
- [x] Locked under the same `DEMO_REQUIRE_GATEWAY_ASSERTION` flag. Verified live: direct `/mcp` →
      **401 gateway_assertion_required**; via-edge → past the gate (`missing_token` from the OAuth logic).

### Surface 3 — demo-a2a `POST /api/a2a` + agent-card
- [x] **Gateway-assertion verification WIRED on `/api/a2a`** (operationId `a2a.task`) — shared
      `checkGatewayAssertion` helper ported to demo-a2a (JSON-RPC-shaped 401s); the edge mints the assertion
      on dispatch and the worker verifies it. Admission proof ONLY — the A2aTaskDO's delegation + signature
      authority still runs. Deployed live (2026-06-26). Agent-card stays **public** (discovery; flows through
      the edge AND directly — verified 200 both ways).
- [x] **ADVISORY, not required** (`DEMO_REQUIRE_GATEWAY_ASSERTION="false"` on demo-a2a). Deliberate: see the
      blocker below.
- [ ] **BLOCKER for require-mode — the edge must convey per-agent identity.** `/api/a2a` resolves its target
      agent from the per-agent subdomain Host (`<handle>.impact-agent.io`), served **directly** by demo-a2a's
      Worker route. The single-host edge (`demo-edge-production.workers.dev/api/a2a`) does not convey which
      agent, so a via-edge task request reaches the worker but `400`s on "must target personal subdomain"
      *before* the runtime; and requiring the assertion would `401` a legitimate subdomain-direct caller (who
      carries no edge assertion). Resolve by having the edge convey the target agent on dispatch — e.g. accept
      `<handle>` in the path/header and inject a trusted `X-Agent-Subdomain` when forwarding to the A2A binding
      (demo-a2a's `resolveAgentHost` already reads that header; admission header-hygiene currently strips it).
      This is a spec-288-§6 design decision (the edge asserting agent identity to the origin), not a deploy step.
- [ ] Flip require-mode on `/api/a2a` once the above lands.

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
- **Surface 2 (`/mcp` OAuth) LOCKED** — shared `checkGatewayAssertion` helper; demo-web-pro OAuth panel's
  `/mcp` call repointed at the edge (token mint stays direct); verified live (direct 401, via-edge past gate).
  Both demo-mcp MCP ingress surfaces are now private behind the edge.
- **Surface 3 (`/api/a2a`) verification WIRED + deployed (advisory)** — the edge mints + demo-a2a verifies the
  GatewayAssertion; the agent-card stays public discovery. Require-mode is held pending the edge→agent-identity
  conveyance (below). `GATEWAY_ASSERTION_SECRET` rotated consistently across demo-edge + demo-mcp + demo-a2a
  (2026-06-26 deploy).

## Next concrete steps
- **Resolve edge→agent identity conveyance** (the require-mode blocker for `/api/a2a`): have the edge accept
  the target `<handle>` (path or header) and inject a trusted `X-Agent-Subdomain` when dispatching to the A2A
  binding, so a via-edge task request routes to the right agent AND require-mode can be enabled without
  breaking the subdomain ingress. Spec-288-§6 design decision. Then flip `/api/a2a` to require-mode.
