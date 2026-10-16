# agent-runtime

**The estate's agent runtime: where a Home session or an agent's wire becomes bounded authority.**

A Cloudflare Worker, deployed once per estate (`demo-a2a-faithnet` for faithnet at `a2a.faithnet.io`, `imb-runtime` for
imbnet at `a2a.impact-agent.io`). Every person, organization and service agent of the estate is served here, each under
its own host and its own Durable Objects.

## What it does

- **The harness.** `POST /harness/ask` turns words into an intent, resolves parties in the asker's private tier, plans,
  and answers with one of `answer` · `authority_required` · `prompt` · `done`. An act runs only under a mandate the
  acting principal signed, bound to the intent's digest and verified per step on chain; reads run no gate.
- **The A2A door.** `POST /api/a2a` serves A2A 1.0: a conversation is answered by the harness, a delegated task by the
  agent's own task object under the sender's verified grant. A message is never authority.
- **The agent's serving plane.** Per agent: a task object (runs, triggers, progress) and an interactions object
  (inbox, topics, applications, invitations). The records live in the owner's vault; Durable Object storage is
  ordering, cursors and caches.
- **Treasuries and payments.** Payments redeem a mandate from the payer's treasury; standing wires derive a child
  mandate per payment; both parties receive a receipt.
- **Anonymous credentials.** `credential.request` (a member asks her organization, through her own agent, naming the
  public half of her device key) and `credential.issue` (the organization's act under its steward's mandate: roster →
  issuer facet → the key service's issuing key → a record without the claims → a vouch on its live-credential row →
  delivery into the member's vault by her own grant).
- **Routed asks.** An ask carried to another host carries the app delegation it was admitted under, or a pairwise
  asker when the target's card declares one — never the person's Home session.
- **Runtimes of its own.** A member's runtime is woken when a message is admitted, paired by a single-use code, and
  continues its own parked run under a chain derived from a standing grant.

## Run it

```bash
pnpm --filter @ap-home/agent-runtime typecheck && pnpm --filter @ap-home/agent-runtime test
wrangler deploy --env <estate>      # faithnet | impact-agent, from this directory
```

Vars are under `[env.<estate>.vars]` in `wrangler.toml`; secrets are set once per estate (`scripts/set-estate-secrets.sh`).
`CLAUDE.md` is the map of the source; `docs/architecture/harness-architecture-diagrams.md` explains the run.
