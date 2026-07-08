# Spec 312 — Context-linked messaging, community directory, and the synthesis inbox

**Status:** Draft v1 (2026-07-07) · **Builds on:** [spec 309](309-messaging-and-interactions.md) (messaging + interactions), [spec 310](310-agentic-trust-home-control-plane-and-inbox.md) (Home control plane + inbox), [spec 246](246-related-agents-vault.md) (private person↔org links), [spec 242](242-trust-credentials-and-public-assertions.md) (attestations).
**Doctrine:** ADR-0021 (packages generic, vertical vocabulary in apps), ADR-0025 (person↔org links are PRIVATE), ADR-0010 (SA address is the canonical id), ADR-0013 (no silent fallbacks).
**Architect-of-record for:** `ContextRefV1` + `ConversationDescriptorV1` in `@agenticprimitives/messaging`, `contextRefs` on `InteractionCaseV1`, the Home community directory + composer + related-messages surfaces, and the per-app messaging adapters.

## 1. Problem

Spec 309/310 shipped the pipes: signed envelopes, audited delivery, an approval queue, mandates. But the
inbox is a flat message list, and three product needs have no answer:

1. **People can't message each other.** A member of an organization (or of the broader community the
   org belongs to — an *alliance* in the faith vertical) has no way to find another member and start a
   conversation, and no way to ask an organization a question that "whoever answers for the org" can
   answer.
2. **Messages float free of the things they're about.** A conversation about a report, a claim, an
   attestation, a people-group segment, a member organization, or the alliance itself carries no typed
   link to that entity — so an entity's page cannot show its related messages, and the inbox cannot
   group or route by context.
3. **The inbox UX is a first cut.** It should synthesize the best engagement techniques from the tools
   people already trust: Outlook (folders/categories/rules/focused triage), Slack (threads, mentions,
   channel-like contexts, acknowledgment), Signal (verification cues, minimal metadata), Diode
   (local-first zero-server trust posture, invite flows).

## 2. Non-negotiable constraints

- **ADR-0025 stands.** Person↔org links stay private. There is NO world-readable roster of "members of
  org X" or "people in alliance Y". The community directory is **opt-in**: a person publishes a
  *directory listing* (a signed, revocable visibility choice) into a community-scoped index, or accepts
  an invitation. Discovery without opt-in remains name-based (public on-chain naming) only.
- **A message is never authority** (spec 309 §4.2). Context refs are *about-ness*, not access. Linking a
  message to a claim does not grant the recipient the claim's bytes; body/vault rules are unchanged.
- **Packages stay generic** (ADR-0021). `ContextRefV1.kind` is an open string; `alliance`,
  `member-org`, `people-group`, `report`, `claim`, `attestation` vocabularies are app-level kind
  registries. No faith vocabulary in `packages/*`.
- **One read path** (ADR-0013): related-messages panels read the same projection the inbox reads —
  filtered by context ref — never a second index that can drift.

## 3. Reference: patterns to port (product synthesis)

| Product | Technique | Port |
| --- | --- | --- |
| Outlook | Folders + categories + deterministic rules; focused inbox | Already have folders/rules; add context-scoped categories + a "Needs attention" (pending + urgent + mentions) triage band |
| Outlook | Shared mailbox / send-on-behalf | Org shared inbox: org stewards see the org's inbox; replies go out `from: orgSA` with the answering person's signature proof visible ("answered by") |
| Slack | Channels vs DMs; threads; @mentions | `ConversationDescriptorV1` with `contextRefs` ≈ a channel anchored to an entity; `threadId` already exists; mention = addressing a person in a context conversation |
| Slack | Emoji ack / message actions | Lightweight `receipt` kind acknowledgments ("seen", "agreed") — signed, auditable, one-tap |
| Signal | Safety number verification | Signature chip on every message: verified ERC-1271 → green "Signed by <name>"; unverifiable → explicit warning (never hidden) |
| Signal | Minimal metadata | Recipient partitioning (spec 309 §8.6) + context refs carry ids/hashes, not copies of entity data |
| Diode | Local-first, zero-server trust | Vault-resident bodies (shipped); render "where this lives" storage cues; invite-based counterparty onboarding |
| Diode / Signal | Invite flows | Directory listing is an invitation to be contacted; contact request = `relationship-proposal` interaction case (already a kind in spec 309) |

The UX-designer report (companion doc, `docs/architecture/inbox-ux-synthesis.md`) is the
component-level source of truth for the Home inbox redesign.

## 4. New primitives (Ring 0, generic)

### 4.1 `ContextRefV1` (`@agenticprimitives/messaging`)

```ts
/** Typed "about-ness" pointer. Display metadata only — NEVER authority. */
export interface ContextRefV1 {
  /** App-defined kind, e.g. 'org-agent' | 'community' | 'segment' | 'content-hash' | 'attestation'. */
  kind: string;
  /** Stable id: CAIP-10, URI, attestation UID, content hash, app id. */
  id: string;
  /** Optional content/credential binding (attestation UID digest, doc hash…). */
  hash?: Hex32;
  /** Display-only label; not authoritative, not verified. */
  label?: string;
}
```

- `MessageEnvelopeV1.contextRefs?: ContextRefV1[]` (bounded, ≤ 8) — covered by the canonical envelope
  hash, so refs are signed with the message.
- `InboxItemV1.contextRefs` — projected copy so rules and views filter without re-reading envelopes.
- `InboxRulePredicateV1.contextRefAnyOf?: { kind: string; id?: string }[]` — deterministic rule
  predicate ("messages about this org → label `org:<name>`").
- `InboxProjector.listByContext(ref: { kind: string; id: string })` — THE related-messages read path.

### 4.2 `ConversationDescriptorV1` (`@agenticprimitives/messaging`)

The `ConversationRef` promised in spec 309 §5, made concrete:

```ts
export interface ConversationDescriptorV1 {
  version: 'ap.conversation.v1';
  id: ConversationId;
  /** The agent whose store owns this descriptor copy (each side keeps its own). */
  owner: CanonicalAgentId;
  title?: string;
  participants: CanonicalAgentId[];
  /** Entities this conversation is anchored to. */
  contextRefs?: ContextRefV1[];
  /** Who may append: fixed participant set, or open-to-context (org inbox). */
  participantPolicy: 'fixed' | 'owner-managed' | 'open-to-context';
  createdAt: string;
  archived?: boolean;
}
```

Descriptors are projection metadata (a Slack-channel-shaped view over `conversationId`), not transport:
admission still validates envelopes independently; a descriptor never authorizes delivery.

### 4.3 `InteractionCaseV1.contextRefs` (`@agenticprimitives/interactions`)

Optional `contextRefs?: ContextRefV1[]` (type re-declared locally — no new dependency edge), parallel
to `evidenceRefs`/`authorityRefs`: an access request *about* a specific report/claim renders on that
entity's page alongside its messages.

### 4.4 Directory listing (`@agenticprimitives/home`)

```ts
/** A person's OPT-IN, signed, revocable choice to be discoverable in a community context. */
export interface DirectoryListingV1 {
  type: 'ap.home.directory-listing.v1';
  subject: CanonicalAgentId;          // the person SA (self-published only)
  /** The community context this listing is scoped to (org SA, community id…). */
  context: ContextRefV1;
  displayName: string;
  roles?: string[];                    // display-only
  inboxEndpoint?: string;              // where signed envelopes can be delivered
  visibility: 'community' | 'public';
  publishedAt: string;
  expiresAt?: string;
  proof: ProofRefV1;                   // ERC-1271 by the subject — self-sovereign listing
}
```

ADR-0025 compliance: the listing asserts "I choose to be visible in this context" — it is created by
the subject, signed by the subject, revocable by the subject, and it lives in the community operator's
app index (not on-chain, not in `agent-relationships`). Membership is never inferred; only listings
are shown.

## 5. What goes where

| Capability | Owner | Notes |
| --- | --- | --- |
| `ContextRefV1`, `ConversationDescriptorV1`, context rules + `listByContext` | `messaging` | generic |
| `contextRefs` on cases | `interactions` | generic |
| `DirectoryListingV1` validation | `home` | generic contract; storage is app's |
| Directory storage/index + kind registry (`alliance`, `member-org`, `people-group`, `report`, `claim`, `attestation`) | apps (`demo-sso-next` + verticals) | vertical vocabulary lives here |
| Org shared inbox (stewards read org inbox, answer as org) | `demo-sso-next` app layer over spec 246 stewardship delegations | authority = existing delegation, NOT a new mechanism |
| Related-messages panels on entity views | each app | one read path: `listByContext` |
| Composer + contact-request flow | `demo-sso-next` (Home) | contact request = `relationship-proposal` case |

## 6. App wiring (which demo gets what)

| App | Messaging integration |
| --- | --- |
| **demo-sso-next (Home)** | The synthesis inbox (§7): conversations, context chips, directory, composer, org shared inbox, approval queue. Reference implementation. |
| **demo-jp** | "Message the program" + context-linked conversations on: agreement timeline (`attestation`/`agreement` refs), people-group pages (`people-group` ref), member trust panel (contact facilitator via Home delivery). JP composes envelopes with `contextRefs` and delivers to the member's Home inbox endpoint. |
| **demo-gs** | "Discuss this need/offering": conversations anchored to need/offering URIs + evidence refs; expert ↔ seeker contact via opt-in listings. |
| **demo-org** | Relying-site "ask the org" entry point → delivers a `request` envelope to the org's shared inbox. |
| **demo-directory** | Read-only: related-messages count/link on people-group segment views (no send path — it's a public crowd directory). |

Sending path everywhere: apps never write a recipient's store; they POST signed envelopes to the
recipient Home's `/connect/inbox/deliver` (spec 310), now accepting `contextRefs` + optional
`conversation` descriptor.

## 7. The Home synthesis inbox (UX contract)

Detailed component spec: `docs/architecture/inbox-ux-synthesis.md` (UX-designer report). Summary of
the five pillars:

1. **Conversation-first list** with a triage band ("Needs attention": pending approvals, urgent,
   mentions) above conversations, folders demoted to a filter row (Outlook focused-inbox shape).
2. **Context chips everywhere** — every conversation/message shows its context refs as chips; clicking
   a chip filters the inbox to that context; entity pages embed the same filtered view as a
   "Related messages" panel.
3. **Directory + composer** — "New message" opens the community directory (opt-in listings, grouped by
   org/community) + name search; unknown recipients get the contact-request (relationship-proposal)
   flow instead of silent delivery.
4. **Org shared inbox** — stewards switch into the org context (spec 310 `HomeContextV1`), see the
   org's inbox, answer as the org with their personal signature visible ("Grace Chapel · answered by
   Sarah K").
5. **Trust cues, not trust noise** — signature chip (Signal safety-number analog), audit-ref popover,
   vault-residency footnote; verification failures are loud, successes are quiet.

## 8. Security invariants

1. Context refs are covered by the envelope hash — a relabeled/re-anchored message fails verification.
2. `listByContext` is the ONLY related-messages mechanism; no app-side shadow indexes (ADR-0013).
3. Directory listings are self-signed + revocable; consumers verify `proof` against the subject SA and
   drop expired/revoked listings. No listing ⇒ not discoverable ⇒ contact-request flow only.
4. Org shared inbox reads/writes ride the EXISTING spec 246 stewardship delegation — no new authority
   mechanism; every answer-as-org envelope carries both the org `from` and the steward's
   `signature.signer`.
5. Delivery admission is unchanged (audited, fail-closed); descriptors and refs never bypass it.
6. Contact requests to non-listed agents require the recipient's approval (interaction case) before
   the sender appears in their conversation list — no unsolicited conversation materialization.

## 9. Implementation waves

- **W1 — Context primitives.** `ContextRefV1` + envelope/projection/rules/`listByContext` in
  `messaging`; `contextRefs` on `InteractionCaseV1`; `ConversationDescriptorV1` + validation;
  `DirectoryListingV1` in `home`. Unit tests; hash coverage tests.
- **W2 — Home synthesis inbox.** Conversation-first UI per the UX report: triage band, conversation
  view, context chips + filter, signature chips, ack actions. Inbox data layer gains descriptors +
  context indexes.
- **W3 — Directory + composer + contact requests.** Listing publish/revoke on the You page (community
  scoped), `/connect/directory` index in the Home app, composer with directory picker, contact-request
  flow via `relationship-proposal` cases.
- **W4 — Org shared inbox.** Org context switch, steward read via stewardship delegation,
  answer-as-org send path, "answered by" rendering.
- **W5 — App wiring.** demo-jp + demo-gs + demo-org send paths with vertical kind registries;
  related-messages panels on agreement/people-group/need/offering views; demo-directory read-only
  counts.

## 10. Open questions

1. Should `ConversationDescriptorV1` sync between participants (each side already keeps its own copy —
   do we exchange descriptor updates as `system` messages, or accept divergence)? Leaning: exchange as
   `system` messages, last-writer-wins per owner.
2. Community identity: is an *alliance* an org SA (so `context = { kind: 'org-agent', id: <caip10> }`)
   or an app-defined community id? Leaning: org SA where one exists (WEA could be an org SA), app id
   otherwise — the kind registry absorbs the difference.
3. Directory index placement: Home app KV (per-community) now; a future `demo-discovery` surface for
   cross-Home communities (ADR-0037: that's integration-layer, external repo).
