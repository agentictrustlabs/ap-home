# Home inbox UX synthesis — Diode / Signal / Outlook / Slack

Companion to [spec 312](../../specs/312-context-linked-messaging-and-community-inbox.md) §7. This is
the component-level contract for the `demo-sso-next` inbox; the primitives it renders live in
`messaging` / `interactions` / `home`.

## Interaction archetypes

| Archetype | Entry point | Underlying primitive |
| --- | --- | --- |
| Person ↔ person | Directory listing or name search → composer | `MessageEnvelopeV1` in a `fixed` conversation |
| Person → org ("ask the org") | Org page / relying site → org shared inbox | envelope `to: [orgSA]`, `open-to-context` conversation |
| Org → person (steward answers) | Org context switch in Home | envelope `from: orgSA` + steward `signature.signer` |
| Message about a thing | Entity page → "Discuss" / chip filter | `contextRefs` on envelope + case |
| Stranger contact | Name search, no listing | `relationship-proposal` case; conversation materializes only on approval |

## Technique → component map

### Outlook (triage discipline)
1. **Focused triage band, not folders-first.** Top of inbox: "Needs attention" = pending approvals +
   urgent + direct mentions. Folders become a filter row (`All · Pending · Sent · Archive`).
2. **Deterministic rules surface.** Rules are visible and editable ("messages about Grace Chapel →
   label `org:grace-chapel`") — powered by `contextRefAnyOf`; never a black-box ML feed.
3. **Shared mailbox.** Org stewards switch context (spec 310 `HomeContextV1`) and see the org's inbox;
   every outgoing reply renders "Grace Chapel · answered by Sarah K" from the dual signer fields.

### Slack (context + acknowledgment)
4. **Conversation-first list** (`summarizeConversations`): one row per conversation, unread count,
   last-activity time, pending badge — not one row per message.
5. **Context chips = channels.** A conversation anchored to an entity renders its `contextRefs` as
   chips; clicking filters the whole inbox (`listByContext`). Entity pages embed the same filtered
   list as "Related messages" — one read path.
6. **One-tap acknowledgment.** "Acknowledge" sends a signed `receipt` message (spec 309 receipt
   builders) — the trust-grade version of an emoji ack; it lands in the sender's timeline as evidence.

### Signal (trust cues)
7. **Signature chip on every message.** Verified ERC-1271 → quiet check + signer name; unverifiable →
   loud amber warning. Failures loud, successes quiet.
8. **Minimal metadata.** Previews truncated; bodies stay vault-resident; context refs carry ids/hashes,
   never copies of entity data. No read receipts leak without an explicit signed receipt.

### Diode (local-first trust posture)
9. **"Where this lives" cue.** Message detail shows vault residency + audit ref popover — the user can
   see their data never sat plaintext on a relay.
10. **Invitation-based discovery.** No global roster: the directory shows only self-signed
    `DirectoryListingV1` records (opt-in, revocable). Unknown recipients get a contact-request card,
    mirroring Diode/Signal invite flows.

## Page structure (Home inbox)

```
[ Needs attention ]  n pending · m urgent        ← triage band (Outlook)
[ All | Pending | Sent | Archive ]  [chip: ctx…] ← filter row + active context chip
┌─ conversation row ───────────────────────────┐
│ ● Sarah K · Grace Chapel   [org] [report:q3] │ ← unread dot, chips (Slack)
│   "Re: Q3 report — can you confirm…"    2h   │
└──────────────────────────────────────────────┘
conversation view: message bubbles + signature chip (Signal) + ack button,
approval cards inline where interactionId is present, composer at bottom.
```

## Anti-goals

- No presence/typing indicators (metadata leak, no trust value).
- No algorithmic ranking — deterministic rules + recency only (ADR-0013 spirit).
- No unsolicited conversation materialization: stranger mail without an approved contact request
  never renders as a conversation.
