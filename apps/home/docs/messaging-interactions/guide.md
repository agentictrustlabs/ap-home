# Messaging + Interactions — demo guide

How this app wires [spec 309](../../../../specs/309-messaging-and-interactions.md)'s two packages into a
working agentic inbox. Read this to adopt the same seam in your own app.

## The pieces

| Layer | Owner | Where in this app |
| --- | --- | --- |
| Envelope validation, body-hash binding, inbox reducer + rules, folder summaries | `@agenticprimitives/messaging` | consumed by `src/home/inbox-data.ts` |
| Case state machine, audited transitions, action cards (transport half) | `@agenticprimitives/interactions` | consumed by `src/home/inbox-data.ts` |
| Audited fail-closed admission (validate → body-hash → audit → commit) | `messaging.createAuditedInboxDelivery` | `deliverToInbox` in `src/home/inbox-data.ts` |
| Storage adapter (event-sourced KV doc per person, rehydrated per request) | **this app** | `src/home/inbox-data.ts` |
| Delivery endpoint (public transport half) | **this app** | `POST /connect/inbox/deliver` → `server/connect/inbox-deliver.ts` |
| Owner surface (session-gated read + decisions) | **this app** | `GET/POST /connect/inbox` → `server/connect/inbox.ts` + `app/(portal)/inbox/page.tsx` |

## Delivery flow (inbound)

1. Sender POSTs `{ label, envelope, bodyText, interactionCase?, card? }` to `/connect/inbox/deliver`.
2. The route binds label ⇔ addressee via one on-chain `reverseResolve` (ADR-0012/0013).
3. `createAuditedInboxDelivery` validates the envelope, enforces `bodyHash` over the UTF-8 body bytes,
   writes `messaging.deliver.accept|reject` to the KV audit log, and only then commits. An audit-write
   failure blocks admission (spec 291).
4. A `request` envelope carries a **draft** `InteractionCaseV1` (requester = sender, responder = recipient,
   root message = the envelope). The app drives `submit` + `admit` through `createAuditedInteractionStore`
   — role-checked, idempotent, audited (`interactions.transition.accept|reject`).
5. An optional sender-proposed `ActionCardV1` (transport half) is structurally validated and stored; the
   Home renders it with native components — no remote UI code ever executes.

## Decision flow (owner)

The Inbox page's Approve / Deny / Ask-info buttons POST `{ action: 'transition', interactionId, transition }`
with the home session. The session gate binds the caller to the person SA; the **state machine** enforces the
role (a session cannot approve a case it is not the responder of). Decisions are lifecycle facts —
**a message is never authority**; issuance routes through `delegation`/`entitlements`/VC packages and comes
back as an `AuthorityRef` on the case.

## Invariants to keep if you copy this

- Never persist before the audited admitter resolves (audit-before-commit).
- Never accept a case whose requester ≠ envelope sender or responder ≠ recipient.
- Rehydration replays the SAME events through the SAME reducers — a replay divergence is a hard error,
  not a repair opportunity (ADR-0013).
- Bodies are plaintext in this demo's KV; production apps put them in the vault
  (`messaging.createVaultMessageBodyStore`) and store only refs.
