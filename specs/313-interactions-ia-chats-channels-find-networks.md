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

### 2.1 Direct messages are keyed by WHO, not by subject (W6 amendment, 2026-08-28)

A direct message is the **pair** — one DM between two agents, ever, the Slack model. The rail is
bucketed per counterparty, not per `conv_` id, and a "new message" to someone you already talk to
continues that DM. A subject line is not a conversation boundary and the composer no longer asks for
one; a `subject` on the wire is optional metadata (a relying app's "Collaboration inquiry — …") that
renders as the preview only until a body is loaded.

Two pure fabric pieces carry this (`@agenticprimitives/fabric/messaging`):

- `directConversationId(a, b)` → `conv_dm_<sha256(sorted pair)[0:32]>` — deterministic and
  order-independent, so both sides mint the same id with no coordination and a first message racing
  from each end lands in ONE thread. demo-a2a `messaging.send` uses it whenever the caller names no
  `conversationId`; an explicit id (assistant replies, invites continuing a thread) still wins.
- `summarizeDirectMessages({ owner, items, descriptors, envelopes })` → `DirectMessageSummaryV1[]` —
  one bucket per counterparty set, folding EVERY conversation with them (pre-amendment random-id
  threads included — no migration, the projection absorbs them), newest first, naming its last
  message and whether the owner sent it (`lastFromOwner` ⇒ "You: …").

Requests keep their pinned "Needs attention" band; a request's thread lives inside the DM with the
party that raised it. Replies address the **recipient**, never a thread id — the agent derives the
pair's id — so a reply never has to choose which folded conversation to continue. A small group
(more than one counterparty) is its own bucket and is read-only from this surface (two-party sends).
Neither piece is authority: a bucket is a view over the owner's own projection, and admission still
validates every envelope on its own (spec 312 §4.2).

## 3. Channels (app-layer composition)

> **Full org/channel architecture is [spec 318](318-organization-channel-messaging.md)** (design of record): org SA +
> gateway DO; **roles = org delegations** (kick = revoke); token-gating = entitlement credentials; two per-channel
> confidentiality modes {org-readable vault vs MLS member-private}; intent-native org agent; and **channel bots as
> Service Smart Agents** (admission delegation + skills + intent invocation). The exhaustive product survey +
> capability→fabric mapping is in [analysis §16](../docs/architecture/agentic-interaction-fabric-analysis.md#16-organization--channel-messaging-teamgroup-context--landscape--fabric-mapping--approach).
> The app-layer composition below is the shipped-today slice; spec 318 is where it graduates.

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
- **W4 — v2 consolidation (SHIPPED):** user feedback showed Inbox/Chats/Find all end in "send a
  message" — three tabs, three composers. Merged into ONE `/messages` surface (Telegram/Slack model):
  pending requests pinned on top, every conversation in one rail (chat vs request is now
  presentation — a case badge and in-thread decision card — not navigation), reply box for two-party
  threads, KB search + compose in the header, open-thread = read. `/inbox`, `/chats`, `/find`
  redirect to `/messages`. §2's mechanical partition rule still governs WHAT renders where; only the
  navigation collapsed. Channels (communities) and Networks (org presence) remain separate
  destinations.
- **W5 (later):** unread badges per surface, channel mentions, org-to-org collaboration cases
  (relationship-proposal), MLS-profile channels.
- **W6 — Slack-style direct messages (SHIPPED 2026-08-28, §2.1):** the rail is bucketed by
  counterparty (`view.directMessages`), each row shows the last message ("You: …" when yours) and a
  Slack-style date; "New message" is a To: typeahead (known DMs ranked above KB hits) with no
  subject field; sends name the recipient and the agent derives the deterministic pair id. Rail
  previews hydrate by exact message id (`GET /connect/inbox?messageIds=…`, one read per bucket whose
  newest message is unseen — the metadata-first list of VL-W4 is preserved).
- **W6b — scoped To: picker (SHIPPED 2026-08-28):** the recipient row leads with a SCOPE switch —
  **Names** (naming-service KB; empty query lists everyone indexed, re-queried as you type) ·
  **Organizations** (a select of the person's org-class agents, steward or member, then the org's
  `directory.list` roster) · **Workspaces** (teams + app-workspace agents, same roster read) — and the
  list populates on selection and filters as you type. Layout is Slack's "New message": one search
  box, scopes in a left pane (Names · each Organization · each Workspace), people on the right.
  **The roster is a UNION of two projections of membership** (not a fallback chain, ADR-0013):
  the community directory (`directory.list` — members who published a listing; readable by any
  member) ∪ the steward's members index (`/connect/received-delegations` — invite-redeemed members,
  readable when the person stewards the org). It carries **nameless members**: a member with no
  naming-service name is listed by their org-local `localName` / listing `displayName` / join
  `displayName` (`publicName` null, chip "unnamed"; a member who chose no name shows their address,
  or the name the Home already resolved) and is addressed by ADDRESS like anyone else (ADR-0010).
  Picking someone you already DM opens that DM. Picking never authorizes — the wire ceremony still
  gates the first send to a new counterparty. `src/lib/recipient-directory.ts` (pure roster/merge/
  filter helpers, tested) + `chat/RecipientPicker.tsx`; e2e `tests/e2e-sso/dm-scoped-picker.spec.ts`.
