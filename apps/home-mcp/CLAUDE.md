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
a wiped store means "authorize again") · `src/a2a.ts` (`askAsPerson`) · `src/tools.ts` (`ask`, `grant_link`) ·
`src/whitelabel.ts` (name, instructions, scopes — the only branded module).

## Validate / deploy

`npx tsc --noEmit -p .` + `npx vitest run` (the AS: DCR, PKCE, resource binding, rotation, revocation). Live gate
`scripts/verify-home-mcp.mts` (nightly row `verify-home-mcp`). Deploy `npx wrangler deploy --env faithnet`; secrets
`HOME_MCP_PRIVATE_KEY` (its address is the `delegate` on the Home's `home-mcp` client registration) and `TOKEN_SECRET`.
Live: `https://home-mcp-faithnet.richardpedersen3.workers.dev` (the faithnet.io zone is at its domain limit).

## Not here

Discovery/engagement contracts (W2), authority through the host (W3), the `/you?run=` deep link in the Home (W3).
