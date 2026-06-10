# demo-mcp

**Tools that check who sent the agent — not just who the agent claims to be.**

MCP gave agents a universal tool socket. It did not give them an authority model. This Cloudflare Worker is the [agenticprimitives](../../README.md) proof that the gap closes cleanly: a person-repository MCP server where **every tool call is gated by a user-signed delegation and every token is replay-protected** — verified server-side, against the chain's word, before any data moves.

## The chain it proves

> Delegation token arrives → signature and caveats verified → JTI single-use check against D1 (replay protection) → tool executes for exactly the principal the delegation names → audit event recorded.

The Worker holds demo PII and per-agent vault records in D1, and exposes delegation-verified tools:

- `get_profile` — read the caller's profile
- `get_pii` — sensitive fields, gated at a higher bar
- `get_org_sensitive` — organization-scoped sensitive reads
- `get_vault_record` / `set_vault_record` / `list_vault_record` — the per-agent MCP vault ([spec 247](../../specs/247-per-agent-mcp-vault.md)) that [`demo-jp`](../demo-jp) and [`demo-gs`](../demo-gs) use as their source of truth
- `update_profile` — declared but still a 501 stub (honest status, see below)

Replay protection is not a middleware afterthought: the JTI store uses D1's atomic `INSERT … ON CONFLICT … RETURNING`, so a replayed token loses the race at the database, not in application code. Tools carry classification tags (`@sa-tool`, `@sa-auth`, `@sa-risk-tier`) per [spec 204](../../specs/204-tool-policy.md), and the canonical audit walkthrough lives in [`docs/audit/guide.md`](docs/audit/guide.md).

Browser apps never call this Worker directly — [`demo-a2a`](../demo-a2a) fronts it, so the delegation chain stays intact at every hop.

## Packages composed

- [`@agenticprimitives/mcp-runtime`](../../packages/mcp-runtime) — delegation-gated MCP middleware
- [`@agenticprimitives/delegation`](../../packages/delegation) — token verification, `JtiStore` contract
- [`@agenticprimitives/tool-policy`](../../packages/tool-policy) — tool classification taxonomy
- [`@agenticprimitives/audit`](../../packages/audit) — evidence events for every gated call
- [`@agenticprimitives/key-custody`](../../packages/key-custody) / [`agent-naming`](../../packages/agent-naming) / [`types`](../../packages/types)

## Run it

```bash
# Everything at once, from the repo root:
pnpm dev

# Or just this Worker:
pnpm dev:mcp    # wrangler dev on http://127.0.0.1:8788

# Apply D1 migrations locally:
pnpm --filter @agenticprimitives-demo/mcp d1:migrate:local
```

A dev-only `/_dev/seed` route exists for seeding test data; it is not part of the delegated surface.

## Status

Reference implementation, not a product. The read tools, vault tools, JTI replay protection, and audit trail run live against Base Sepolia and local Anvil; `update_profile` remains a stub. Production launch of the substrate is gated on the public checklist in the [root README](../../README.md); every security finding is tracked live in [`docs/audits/findings.yaml`](../../docs/audits/findings.yaml).

Validate: `pnpm check:demo-mcp`.
