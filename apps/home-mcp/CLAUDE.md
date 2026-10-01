# home-mcp — Claude guide

## What this app is (spec 397)

The Home MCP: **Claude.ai's entrance to a PERSON's own agent.** A public, conformant remote MCP server (Streamable
HTTP, `@agenticprimitives/mcp-protocol`) that is toward MCP clients an **OAuth 2.1 authorization server + resource
server** (RFC 8414 metadata · RFC 7591 dynamic registration · PKCE S256 required · RFC 8707 resource indicators ·
opaque rotating tokens · RFC 7009 revoke · RFC 9728 PRM via `@agenticprimitives/mcp-oauth`) and toward the person a
**registered relying app of the Home** (`client_id=home-mcp`, template `ask-as-me`, spec 230's parallel issuance).
Deliberately NOT bound by the ADR-0057 "MCP is private" rule — the deviation is declared in spec 397 §8.

## The one idea

The bearer a client holds names *which client of which person* is calling and **never leaves this Worker**. What
reaches her agent is her own `ask-as-me` delegation (person → this Worker's key, caveats: timestamp + allowedMethods
pinned to `harness.ask`), presented as the existing `A2A-Session` scheme (spec 372 S3c) on `POST /harness/ask` at the
a2a origin: an assertion signed by `HOME_MCP_PRIVATE_KEY` over the exact body, session-wrapped with her wire. Her
agent verifies the wire against her on chain per request, spends the assertion once, and runs **as her** with no Home
session. Acts still park `authority_required` → `grant_link` sends her to her Home to sign. No inbound token is ever
passed through (ADR-0041).

## Files

`src/index.ts` (routes: `/.well-known/oauth-protected-resource[/mcp]`, `/.well-known/oauth-authorization-server`,
`/oauth/register|authorize|callback|token|revoke`, `/oauth/demo-connect` (persona path for the live gate, gated by
`DEMO_CONNECT_ENABLED`), `POST /mcp`, `/health`) · `src/oauth.ts` (the AS) · `src/store.ts` (`HomeMcpStoreDO` — clients,
pending, codes, tokens, persons; wires sealed AES-GCM under a KEK from `TOKEN_SECRET`; a rebuild, never a bereavement:
a wiped store means "authorize again") · `src/a2a.ts` (`askAsPerson`) · `src/tools.ts` (`ask`, `discover_agents`, `engage`, `my_runs`, `run`, `grant_link` — discover/engage are ONE supplied step each at her agent, `discovery.agents.find` / `engagement.agent.invoke` in `apps/demo-a2a/src/enterprise-tools.ts`; my_runs/run read her records under the same credential) · `src/stream.ts` (SSE frames, progress, elicitation shape — W3: a `tools/call` with `Accept: text/event-stream` streams progress, elicits a data prompt when the client declared it at initialize, never a signature) ·
`src/whitelabel.ts` (name, instructions, scopes — the only branded module) · `src/act.ts` (spec 397 §11 — ACT-AS-ME: scope `act` for a
registration the operator allowed (`x-act-registration` secret or `ACT_CLIENT_IDS`), the Home's `home-mcp-act` client, her standing wires
sealed beside the ask wire (`act_enc`), and on a parked `authority_required` the derivation of the mandate from the covering wire with
`HOME_MCP_ACT_KEY`, resumed on the same run with `presented: [child, standing]` + `via`; no covering wire ⇒ parked as before). · `src/operator.ts` (§11.4 — `GET /oauth/clients` + `POST /oauth/clients/:id/act` under `x-act-registration`
(`scripts/home-mcp-act-client.mts`), and the connection key `/connect/key` → Home → `/connect/key/done`: the Worker as its own curated
client `home-mcp-key`, a 30-day bearer shown once, for a host that cannot finish OAuth — Muse guide `docs/architecture/muse-integration.md`).

## Validate / deploy

`npx tsc --noEmit -p .` + `npx vitest run` (the AS: DCR, PKCE, resource binding, rotation, revocation). Live gates
`verify-home-mcp` (W1) · `-browser-path` · `-discovery` (W2) · `-authority` (W3: signed at her Home via /you?run=) · `-stream` (W3) · `-revoke` (W4: Connected assistants → on chain) · `-instructions`. Deploy `npx wrangler deploy --env faithnet`; secrets
`HOME_MCP_PRIVATE_KEY` (its address is the `delegate` on the Home's `home-mcp` client registration) and `TOKEN_SECRET`.
Live: `https://home-mcp.faithnet.io` (the faithnet.io zone is at its domain limit). Act secrets: `HOME_MCP_ACT_KEY` (its address is the
`home-mcp-act` client's `delegate`; `/health` prints `actKeyAddress`) + `ACT_REGISTRATION_SECRET` (the live gate `verify-home-mcp-act`
reads it as `HOME_MCP_ACT_REGISTRATION_SECRET`; the operator keeps both in `~/.agenticprimitives/home-mcp-act.env`).

## Key rotation (runbook)

`GET /health` shows `keyAddress`; it must equal the `delegate` on the Home's `home-mcp` client (`apps/demo-sso-next/src/whitelabel/config.ts`).
To rotate: generate a new key, `wrangler secret put HOME_MCP_PRIVATE_KEY --env faithnet`, set the new address as that `delegate`, push
the Home, deploy this Worker. Nothing else: every existing connection's assertion stops recovering to its wire's delegate, her agent
refuses it, the transport answers 401 with the challenge, the host re-authorizes and the Home mints a wire to the new key.
Registrations and demo connects are bounded per caller and overall per hour (429); a person may hold 100 connected clients (live tokens count; expired or revoked ones do not).

## Not here

A live gate for an off-deployment target (needs faithnet-b awake and `A2A_TRUSTED_ORIGINS` set there); package extraction of the AS.
