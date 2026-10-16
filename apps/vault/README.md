# vault

**The estate's vault: every person's and organization's records, behind delegated MCP.**

A Cloudflare Worker, deployed once per estate (faithnet at `mcp.faithnet.io`, imbnet at `mcp.impact-agent.io`). The vault
is the record; apps and Durable Objects hold references and caches, never copies (ADR-0055).

## What it does

- **Per-record scope.** Every read and write presents a delegation token minted under the owner's grant and checked
  against the record type it names; a grant that does not cover a record is refused for that record alone.
- **Per-owner keys.** Records are encrypted under the owner's own vault key, released through the estate's key-service
  tenant; nothing is decrypted for anyone the grant does not name.
- **Replay protection and audit.** Tokens are single-use (atomic in D1); every gated call leaves an audit event.
- **The record families** of every capability, each bound to an ontology class: inbox and topics, relationships,
  treasuries' receipts, playbooks, runs and provenance, the Library, and the credential families — an organization's
  issuer facet, issuances and member requests; a member's anonymous credentials, device-key references, presentation
  mandates and pairwise secret; the organization's live-credential vouch the federation projector reads.
- **Doors for other workers.** `/mcp/native` admits a worker that writes as an agent under a scoped vault credential
  (the federation projector, a self-hosted service). The public `/mcp` OAuth ingress is an interoperability demo for
  external MCP clients, labelled as such.

## Run it

```bash
pnpm --filter @ap-home/vault typecheck && pnpm --filter @ap-home/vault test
wrangler deploy --env <estate>      # from this directory
```

`CLAUDE.md` maps the source; `docs/audit/guide.md` walks the audit trail.
