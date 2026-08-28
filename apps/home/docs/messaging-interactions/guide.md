# Messaging + Interactions — demo guide

How **demo-sso-next** (Personal Trust Home) wires Agentic Interaction into a working inbox and talks
to **demo-a2a**.

| Layer | Doc |
| --- | --- |
| Semantics (`apix:`) | [ADR-0058](../../../../docs/architecture/decisions/0058-agentic-interaction-canonical-bounded-context.md) · [spec 340](../../../../specs/340-agentic-interaction.md) |
| Fabric runtime | [spec 316](../../../../specs/316-agentic-interaction-fabric.md) · [fabric architecture](../../../../packages/fabric/docs/architecture.md) |
| This app's vault notes | [vault-architecture.md](../vault-architecture.md) |

**Invariant:** a message / communicative act is never authority. Cases reference mandates; execution
re-verifies delegation on the A2A→MCP hop (ADR-0041).

---

## The pieces (live)

| Layer | Owner | Where in this app / demo-a2a |
| --- | --- | --- |
| Envelope validation, body-hash, inbox reducers | `@agenticprimitives/fabric/messaging` | `server/connect/inbox*.ts`, `message-body-store.ts` |
| Case FSM, cards, mandates (transport half) | `@agenticprimitives/fabric/interactions` | inbox transitions + `src/home/mandate.ts` |
| Audited admission | `createAuditedInboxDelivery` | `/connect/inbox/deliver` |
| **Durable inbox + bodies + board** | **demo-a2a `InteractionsDO`** | Via `server/lib/interactions-bridge.ts` → `POST {A2A}/interactions/<owner>/<op>` |
| Grants (interactions + delivery) | demo-a2a | Browser/onboarding → `/a2a/interactions/<sa>/grant*` |
| Owner UI | this app | `/connect/inbox` + `app/(portal)/messages` |
| Org topics / assistant | InteractionsDO + `A2aTaskDO` | `/connect/channels` · discussion skill in demo-a2a |

Terminology: **message** = communication; **interaction case** = decision workflow over messages;
**Mandate / delegation** = authority; **A2A Task** = authorized execution. Spec 316 unifies transport
on `ExchangeRecordV1`; spec 340 adds the durable `Interaction` aggregate — Home still drives cases
via fabric `/interactions` while topics are the **vault board** that demo-a2a serves (spec 340 §C).

---

## Topology — Home ↔ demo-a2a

```mermaid
sequenceDiagram
    autonumber
    participant UI as Home UI /messages
    participant SRV as demo-sso-next /connect/*
    participant BR as interactions-bridge HMAC
    participant IDO as InteractionsDO on demo-a2a
    participant MCP as demo-mcp vault
    participant CHAIN as On-chain naming / ERC-1271

    UI->>SRV: session-gated send / read / transition
    SRV->>CHAIN: resolveName / reverseResolve as needed
    SRV->>BR: inbox.get|put · dm.body.* · invite.* …
    BR->>IDO: POST /interactions/&lt;ownerSA&gt;/&lt;op&gt;
    Note over BR,IDO: Fail-closed if A2A_CUSTODY_URL / bridge secret unset
    IDO->>MCP: vault record ops under scoped grant
    IDO-->>SRV: projection / body (hash-verified)
    SRV-->>UI: conversations + bodies + cases
```

Onboarding also posts grants directly (proxied) to `/a2a/interactions/<sa>/grant` and
`grant.delivery.put` so the DO can admit mail while the owner is offline.

---

## Flow — two agents chatting (T0)

Alice and Bob both use this Home; delivery still goes through **recipient-side** InteractionsDO
admission (same pipeline external senders hit via `/connect/inbox/deliver`).

```mermaid
sequenceDiagram
    autonumber
    participant AUI as Alice — /messages
    participant SRV as Home /connect/inbox
    participant NAME as AgentNameRegistry
    participant IDO as Bob InteractionsDO
    participant AUD as Audit (fail-closed)
    participant BUI as Bob — /messages

    AUI->>SRV: POST {action:'send', toName, bodyText}
    Note over SRV: sender = session SA only
    SRV->>NAME: resolveName → Bob SA (empty ⇒ 404, no fallback)
    Note over SRV: MessageEnvelopeV1 + bodyHash; body → vault ref via bridge
    SRV->>IDO: audited deliver (bridge)
    IDO->>AUD: messaging.deliver.accept
    Note over IDO: commit delivered event → inbox projection
    SRV-->>AUI: {messageId, conversationId}
    BUI->>SRV: GET inbox (poll)
    SRV->>IDO: inbox.get + body.get — hash-verify
    SRV-->>BUI: conversations + names + bodies
```

Key properties: sender never writes Bob's store directly; body hash bound in envelope; read/delivered
are projection facts, not case states.

> **Note (spec 341 §5.1c):** the `POST /connect/inbox {action:'send'}` step above is historical — the
> browser now asks the sender's OWN agent (`/a2a/interactions/<sa>/messaging.send`); the Home is not in
> the transfer. The properties listed still hold.

### Direct messages are the pair (spec 313 §2.1)

`/messages` is Slack-shaped: one DM per counterparty. A send that names no `conversationId` lands in
`directConversationId(sender, recipient)` — deterministic from the pair, identical from either side —
and the rail renders `view.directMessages` (`summarizeDirectMessages`, fabric), which folds every
conversation with the same counterparty into one row with its last message. No subject line; the
composer is a To: typeahead. Rail previews hydrate by exact message id (`?messageIds=`) so the list
stays metadata-first.

---

## Flow — request → approval → mandate (T2 tempo)

```mermaid
sequenceDiagram
    autonumber
    participant REQ as Requester
    participant DLV as POST /connect/inbox/deliver
    participant IDO as Bob InteractionsDO + case store
    participant BUI as Bob — Needs attention
    participant SIG as Bob ROOT credential

    REQ->>DLV: envelope + draft InteractionCaseV1 + optional card
    DLV->>IDO: audited admission → case draft→submitted
    BUI->>SIG: Approve — sign scoped delegation + InteractionMandateV1
    BUI->>SRV: transition approve + mandate
    Note over SRV: structure → session SA → ERC-1271 → actingAgent = requester
    Note over IDO: case approved; AuthorityRef = delegation hash
    REQ->>REQ: later exercises DELEGATION via A2A→MCP — thread was never authority
```

---

## Org assistant in discussion topics (spec 327)

Steward enables the **org's own agent** on a topic. Member posts `@org…` → `InteractionsDO`
evaluates trigger **server-side** (UI never orchestrates — ADR-0044) → rate-limited
`A2aTaskDO` `/internal/discussion-respond` → reply posted as **Org SA** on the vault board.
No new grants. Failures drop; no silent fallback (ADR-0013).

---

## Where this is going

| Today | Target (spec 316 / ADR-0058) |
| --- | --- |
| Home ↔ HMAC bridge ↔ **InteractionsDO** on demo-a2a | Per-principal **PrincipalGatewayDO** (or equivalent self-hosted gateway) |
| Topics = vault board; Interaction id projected | Interaction as root aggregate every exchange pins |
| Case FSM on Home + fabric `/interactions` | Decision/commitment machines fully driven (spec 340 W10+) |
| Poll inbox | Gateway delta stream; Home as render client |

Invariants that must survive: audit-before-commit, body-hash binding, recipient-side admission,
message ≠ authority, one mechanism per read/auth path (ADR-0013).

---

## Invariants if you copy this seam

- Never persist before the audited admitter resolves.
- Never accept a case whose requester ≠ envelope sender or responder ≠ recipient.
- Rehydration replays the same events through the same reducers.
- Bodies via vault + InteractionsDO — not app KV as source of truth.
- Bridge misconfig ⇒ no mail I/O (fail-closed), never a weaker path.
