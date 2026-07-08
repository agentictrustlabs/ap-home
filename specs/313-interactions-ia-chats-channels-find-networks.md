# Spec 313 — Interactions IA: Inbox, Chats, Channels, Find, Networks

**Status:** Draft v1 (2026-07-08) · **Builds on:** [spec 312](312-context-linked-messaging-and-community-inbox.md) (context refs, conversations, directory), [spec 310](310-agentic-trust-home-control-plane-and-inbox.md) (Home), [spec 280](280-agent-naming-service.md) (naming), [spec 246](246-related-agents-vault.md) (person↔org links).
**Doctrine:** ADR-0021 (IA + product surfaces are app layer; primitives unchanged), ADR-0025 (no inferred rosters — listings only), ADR-0013 (one read path per surface).
**Architect-of-record for:** the `demo-sso-next` Interactions information architecture and the Channels / Find / Networks app surfaces.

## 1. Problem

Spec 312's inbox landed everything — approvals, mail, DMs — on one page. Real products separate by
*interaction tempo*: Gmail handles high-complexity triage, Signal handles focused person↔person
threads, Slack/Discord/Telegram handle many-to-many channels, LinkedIn handles discovery and
professional presence. One surface doing all four does each badly.

## 2. The IA (left-nav "Interactions" group)

| Surface | Tempo / analog | What renders there | Read path |
| --- | --- | --- | --- |
| **Inbox** | Gmail triage | Pending approvals (cases), typed requests, system/receipt mail — anything with an `interactionId` or non-`plain` kind | own inbox projection, non-chat subset |
| **Chats** | Signal | Person↔person `plain` conversations (no case attached); thread view, reply box, signature cues | own inbox projection, chat subset |
| **Channels** | Slack/Discord/Telegram | Community-scoped shared boards (`participantPolicy: 'open-to-context'`) — post + read for community members | per-community channel store |
| **Find** | LinkedIn search | Exact name lookup (naming service) + opt-in community listings + your own trust graph (orgs you steward / are related to) | naming `resolveName` + listings index + managed-agents vault |
| **Networks** | LinkedIn/Discord servers | Org presence: publish your ORG's listing, browse other orgs, contact an org's inbox | listings index (org subjects) |

The partition rule is mechanical, not heuristic: a conversation is a **chat** iff none of its
messages carry an `interactionId` and all are kind `plain`; everything else is **inbox**. One
conversation never renders in both.

## 3. Channels (app-layer composition)

A channel is a `ConversationDescriptorV1` with `participantPolicy: 'open-to-context'` anchored to
`{ kind: 'community', id }`, stored WITH its messages in a per-community KV document (the channel is
shared state, unlike per-person inboxes). Gates, fail-closed:

1. Session required for read AND post (no anonymous community reads).
2. **Membership = a current directory listing in that community** (the spec 312 opt-in artifact —
   joining a community's channels and being discoverable there are the same consent).
3. Posts are envelope-shaped (`MessageEnvelopeV1`, validated, body-hash-bound) and audited to the
   community audit log before commit (same audit-before-commit discipline as inbox delivery).

Channels are NOT encrypted-group primitives (MLS etc. — spec 309 §10 future work); they are
internal-classification community boards. The descriptor/envelope shapes keep them portable.

## 4. Find + Networks (discoverability, ADR-0025-shaped)

- **Find people:** (a) exact agent-name lookup — public naming service, one mechanism; (b) community
  directory listings — opt-in only; (c) *your* orgs and their communities as starting points (your
  managed-agents vault — private to you). No global people search exists because no global roster
  exists.
- **Networks (orgs):** orgs publish `DirectoryListingV1` with `subject = org SA` into the reserved
  community index `networks`. The publish gate verifies ERC-1271 **against the subject org SA** (the
  steward's root credential controls the org SA, so the steward can sign for it) + the org must have a
  claimed name (MAM-D8 guarantees orgs are named). Browsing Networks is session-gated; contacting an
  org delivers to the org's own inbox via the standard delivery pipeline.
- **Prompts:** empty states nudge the LinkedIn-style presence loop — claim a name → publish your
  profile/connection record (spec 280) → publish a community listing (spec 312) → publish your org to
  Networks. Each is a signed, revocable, opt-in artifact; nothing is auto-published.

## 5. Invariants

1. Primitives unchanged — this spec is app IA + composition only (ADR-0021).
2. Chat/inbox partition is deterministic (interactionId/kind rule) — never ML/heuristic.
3. Channel read/post requires a current community listing; revoking your listing exits the
   community's channels and directory at once (one consent artifact).
4. Org listings verify against the ORG SA; a person can never list an org their credential does not
   control.
5. All sends (chat reply, channel post, org contact) go through envelope validation + audit-first
   admission; no second, lighter path.

## 6. Waves

- **W1:** Nav group + Chats page (thread view, reply) + Inbox slimmed to triage. SHIPPED with this spec.
- **W2:** Channels (create/post/read, listing-gated). SHIPPED.
- **W3:** Find + Networks + discoverability prompts. SHIPPED.
- **W4 (later):** unread badges per surface, channel mentions, org-to-org collaboration cases
  (relationship-proposal), MLS-profile channels.
