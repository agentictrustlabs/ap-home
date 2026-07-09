# Spec 318 — Organization & Channel Messaging on the Fabric (+ Channel Agents as Service SAs)

**Status:** Draft v0 (2026-07-08)
**Builds on:** [spec 316](316-agentic-interaction-fabric.md) (the fabric — org SA gateway DO, ExchangeRecord, tiers, intent alignment §15), [spec 313](313-interactions-ia-chats-channels-find-networks.md) (Channels/Find/Networks IA — shipped app slice), [spec 312](312-context-linked-messaging-and-community-inbox.md) (context refs, conversations, directory), [spec 282](282-skills.md) (skills), [spec 291](291-verified-entitlements-and-d1-audit.md) (entitlements), [spec 317](317-messaging-fabric-substrate-migration.md) (delivery + record-scoped authority), [spec 247](247-delegated-member-records.md) (delegated records / vault residency).
**Architect-of-record for:** organization/channel (team/group) messaging on the fabric **and channel-participant Service Agents ("bots")**.
**Full landscape + capability→fabric mapping:** [`docs/architecture/agentic-interaction-fabric-analysis.md` §16](../docs/architecture/agentic-interaction-fabric-analysis.md#16-organization--channel-messaging-teamgroup-context--landscape--fabric-mapping--approach) (this spec is the design of record; §16 holds the exhaustive product survey).

## 1. Thesis

Group/channel messaging (Telegram/Discord/Slack-shaped: people communicating in the context of a **channel** inside an **organization**) is **not a separate product — it is the fabric primitive with the "recipient" being an organization context.** Three mappings do almost all the work:

- **Organization = an Organization Smart Agent** (ADR-0046) that owns its own `PrincipalGatewayDO` — the workspace/server/community surface.
- **Channel = a context** (a `ConversationDescriptor`, `participantPolicy:'open-to-context'`, anchored `{kind:'community', id}`) resident as a **shared projection in the org DO's single-writer ExchangeStream**; a post is an `ExchangeEvent`; fan-out is the org SA re-delivering signed receipts to member gateways (spec 316 Blocker 6 Defect B).
- **Roles/permissions = capability delegations from the org SA** — Discord's per-channel permission bitfields and Matrix power levels ARE attenuated caveats; **kick = revoke.** No separate RBAC engine.

And the extension this spec adds: **channel bots ARE Service Smart Agents** admitted by a scoped delegation and invoked intent-natively (§8) — not a bolt-on bot API.

## 2. Reference: smart-agent patterns to port

`/home/barb/smart-agent` has **no group/channel messaging analog** — it is the intent-marketplace + discovery reference, not a chat system. This is a **deliberate net-new capability area**; the patterns to port are the *authority* and *discovery* primitives, not a channel implementation:
- **Service-agent + delegation/caveat authority model** — smart-agent's scoped-delegation authority is exactly how channel roles + bot admission work here (§5, §8): authority is an attenuated, revocable delegation, never an ACL row.
- **Discovery / GraphDB (`packages/discovery`)** — channel/org discovery + bot (Service SA) discovery reuse the same KB/SPARQL read-tier pattern (public, on-chain-reproducible; ADR-0040), consumed via the registry-kit (§10).
- **Privacy-creds patterns (`packages/privacy-creds`)** — for token-gated membership that must not leak the member graph (§6), the selective-disclosure shape is the reference.
Divergence (stated per the hard rule): the channel/fan-out/confidentiality-mode/bot layers are new fabric work; smart-agent contributes the authority + discovery substrate they compose.

## 3. Landscape (condensed — full survey in analysis §16)

Nine axes distinguish group from 1:1: state locality, membership, RBAC, fan-out, group crypto, channel semantics (broadcast/discussion/forum/topic), moderation, discovery, org identity. Closest cousins by architecture: **centralized** (Slack/Discord/Teams/Telegram/Mattermost/Zulip — the UX target; Discord = richest RBAC, Telegram = broadcast-vs-discussion split); **federated** (Matrix Spaces+rooms+power-levels+Megolm; **ActivityPub Group actors** = Lemmy/Mobilizon, *a group is an actor whose inbox re-announces* — the closest "group = agent with inbox" analog); **decentralized/web3** (**Status Communities** — key-owned, channels, roles, token-gating over Waku, the closest web3 cousin; Nostr NIP-28/29/72; Farcaster channels; Lens v3 on-chain Groups/Feeds; XMTP MLS groups; Quiet = server-less Slack); **token-gating** (Guild.xyz, Collab.Land); **enterprise** (Entra/SCIM); **standards** (MLS RFC 9420 group crypto; **MIMI/IETF** cross-provider group interop; Matrix room DAG; Zulip streams+topics). See §16.2/§16.3 for the per-product mapping table.

## 4. Core model — org SA + gateway DO + channel-as-context

An **Organization SA** owns a `PrincipalGatewayDO` (`idFromName(orgSA)`) — its workspace surface. Channels are contexts resident in that DO's **single-writer ExchangeStream**; posts are `ExchangeEvent`s (`to` = the channel context); per-member fan-out is the org SA **re-delivering fresh signed receipts** to member gateways. The org DO is a **coordinator, not an authority hub**: membership is policy only (never delivery authority — Blocker 6), each post carries the poster's own SA sender-proof, and the org is **self-hostable** (its own `gatewayRoot` on-chain — the Quiet/Status-Communities property, anchored on the org SA). This **replaces** the shipped ad-hoc per-community KV doc (`CHANNELS_KEY`, `channels.ts`).

**Channel semantics = surface descriptors:** broadcast (write-scoped to few, read-open to members), discussion (write-open to members), forum/threads (`conversationId` + `contextRefs`), topic-streams (Zulip). One primitive, many shapes — the shape is the write-authority scope + the projection, not a new type.

## 5. Roles & permissions = capability delegations (the killer alignment)

The org SA issues **role delegations**, each attenuated by caveats:
- `member` → post to channels {X,Y}, read the channels its listing covers.
- `moderator` → member + delete/pin/label caveats on {channels}.
- `admin` → moderator + manage-channels / invite / issue-sub-delegations.

Discord's per-channel permission bitfield and Matrix power levels map **directly onto per-channel-scoped caveats** (`VAULT_RECORD_SCOPE` on the channel's records + allowed-action caveats). The delegation caveat system **IS** the permission system — on-chain-revocable, so **kick/demote = revoke/re-issue**, auditable, and re-verified server-side (ADR-0041). No parallel RBAC engine, no ACL table.

## 6. Membership + token-gating = entitlements

Membership today = a **current directory listing** in the community (opt-in consent, spec 312/313). This spec adds **gated membership**: join/role issuance predicated on a **verified entitlement credential** (`entitlements` + `verifiable-credentials`) — the AP-native Guild.xyz/Collab.Land, but the gate is a **signed VC re-verified server-side**, not a bot polling wallet balances. The org's join flow: verify the credential → issue the scoped `member` role delegation. Token-gated private communities use selective-disclosure creds (§2 privacy-creds) so gating does not leak the member graph (ADR-0025/0040).

## 7. Two per-channel confidentiality modes

Most products force a global choice; the fabric makes it **per-channel**, chosen by the admin:
- **Org-readable** — bodies are **org-vault-resident plaintext** (spec 247 shape); members read via a scoped read delegation. The Slack/Teams "workspace owns the data" model → enables org search, retention, and compliance/e-discovery, and lets the in-channel org agent read context (§8).
- **Member-private** — bodies are **MLS-sealed (RFC 9420) to the channel group**; the org DO stores ciphertext + coordinates the stream but **cannot read** the plaintext. The Signal/Matrix-E2EE model; membership change = MLS epoch change. (Adopt MLS — do not invent group crypto; analysis §13 #1.)

Envelopes/receipts carry hashes + `VaultRef` only in both modes (residency invariant, spec 316 §11a); the mode changes where/how the *body* is sealed, not the exchange record.

## 8. Channel agents ("bots") ARE Service Smart Agents

**Every channel bot is a Service Smart Agent** (ADR-0046, `prov:SoftwareAgent`) — never a Person or Org, and never a special "bot account" outside the model. This collapses Slack apps / Discord bots / Telegram Bot API into **one primitive: a Service SA with a channel-participation delegation + advertised skills**, unified with the whole agentic fabric.

**8.1 Two things people call "a bot" — keep them distinct:**
- **The org's OWN agent** (§15 intent-native) — the org SA acting via its DO's T2 orchestration loop in its own channel. This is **not a separate agent**; it is the org *being agentic* (answering, summarizing, acting) under its own authority. No admission needed — it is the principal.
- **A participant Service Agent** — a **distinct** Service SA (its own SA address) that the org **admits** into a channel. This is the "bot" this section specs.

**8.2 Identity + discovery.** A participant bot is a Service SA with a canonical SA address (ADR-0010), an **agent-card advertising its skills** (spec 282 → A2A skills), and discovery via the KB / registry-kit + ENSIP-26 endpoint records (spec 316 §11.3). "Add a bot" = **discover a Service SA by skill and issue it a channel delegation** — an agentic marketplace action, not an app-store install.

**8.3 Admission = a scoped delegation from the org SA.** The org grants the bot a channel-participation delegation, caveated exactly like a role (§5): which channels, `read` / `post` / `react` / `run-command`, rate limits, expiry, and a **tool allowlist**. Removing the bot = **revoke**. A compromised bot is bounded by its caveats (least-privilege) and instantly revocable — the security property centralized bot tokens lack.

**8.4 Invocation = intent-native (not a webhook).** An @-mention or slash-command in a channel is an **intent expressed to the bot's Service SA** (spec 316 §15). The bot's **own orchestration loop** (its own gateway DO, or an A2A task) plans → composes MCP tools under its delegated authority → posts the result back as an `ExchangeEvent` in the channel. A notification integration (CI/CD, GitHub) is the degenerate case: a Service SA with a **post-only** channel delegation and no read.

**8.5 Authority to ACT is re-verified Web3 authority — a bot is not privileged.** A bot holds **only** what it is delegated + the entitlements it can present; every action re-runs the delegation + caveat + entitlement + tool-policy gates server-side (ADR-0041), identically to any principal. If an action exceeds the bot's authority, the bot **raises a `request` (a case)** to the appropriate principal — a member, a moderator, the org quorum — and the case FSM (spec 316 §2) drives the human-in-the-loop approval before the bot proceeds. Bots therefore **cannot escalate**; they can only ask.

**8.6 Acting on behalf of.** A bot acting *for* a person/org does so under a **delegation from that principal**, and provenance records `prov:actedOnBehalfOf` (spec 316 §6). A bot posting "as the org" is the org's Service agent under an org delegation; a bot doing work for a user holds that user's scoped delegation. There is no ambient "bot can act as anyone" — authority always traces to a signing principal.

**8.7 Provenance + audit.** Every bot post/action is an `ExchangeEvent` carrying its `authorityRef` (the delegation hash it acted under) + a PROV-O trace (who delegated, the plan/P-Plan, the tools invoked) — so a channel's history is a fully attributable, machine-readable record of *which agent did what under whose authority*, not an opaque "BotName posted". This is a capability no incumbent bot platform offers.

**8.8 Taxonomy (all Service class):** notification bot (post-only), command bot (read+post+orchestration, intent-invoked), autonomous agent (proactive; holds action delegations; raises cases for approvals), bridge/integration agent (mirrors an external system under a post/read delegation). The org's own agent is the one exception — it is the Org SA itself (§8.1), not a Service participant.

## 9. Fan-out + scale (Blocker 7)

High-fan-in org principals **shard** the fan-out and go **async**: the org DO is single-writer per shard; per-member delivery is the org *re-delivering* fresh receipts, not a synchronous N-write. Cold-DO budget + keep-warm alarms apply (spec 316 §3). Bots consume the same fan-out as members (they are gateway-addressable Service SAs).

## 10. Moderation, discovery, interop

- **Moderation** = org moderation delegations (§5) + **AT-Protocol-style labelers** (moderation-as-a-service over the trust graph; analysis §13 #5); audit-before-commit is already enforced (channels.ts discipline).
- **Discovery/join** = public via the KB / **Networks** (spec 313); private via **invite credential** (§6); org + bot agent records via **ENSIP-26**.
- **Interop** = a **MIMI/MLS** bridge lets an org channel federate with other providers' group chat — **external** per ADR-0037 (registry-kit / bridge repo), never Ring-0.

## 11. Waves — part of the messaging work

Sequenced **on top of** the fabric core (spec 316 gateway-DO wave + spec 317 delivery), because a channel is the org SA's gateway DO:
- **C1** — channel state onto the org SA's `PrincipalGatewayDO` ExchangeStream (replaces `CHANNELS_KEY`, `channels.ts`); org-readable mode; membership = directory listing (as today).
- **C2** — **roles = org delegations** (member/mod/admin caveats; kick = revoke).
- **C3** — **token-gated join** via entitlement credentials (§6).
- **C4** — **channel agents / bots as Service SAs** (§8): admission delegation + skill discovery + intent invocation + the case-based approval escalation. *This is the headline of "bots in channels".*
- **C5** — **MLS member-private channels** (§7 mode 2).
- **C6** — labeler moderation; **C7** — MIMI bridge (external).

Each wave lands with its verification gate green; C1–C4 are the messaging-work slice (the user's scope). Wedge (analysis §14): enterprise self-custody team collaboration + **agent-operated org channels** are the first customers — "the org owns its data and its agents act in-channel under revocable, auditable authority" is the feature.

## 12. Doctrine alignment

- **ADR-0046** — org = Organization SA; bots = **Service SAs** (person/org never); the org's own agent = the Org SA itself.
- **ADR-0041 + ADR-0044** — bot authority is re-verified Web3 authority; invocation is intent → orchestration (T2), not a webhook; bots ask (raise a case), never escalate.
- **ADR-0010** — every org, member, and bot IS its SA address; names/cards/skills are facets.
- **ADR-0025 + ADR-0040** — org-readable bodies live in the org vault (delegated read); token-gating doesn't leak the member graph; the public tier stays on-chain-reproducible.
- **Delegation caveats = the permission + admission system** (spec 202/208) — no parallel RBAC or bot-token model; kick/remove = revoke.
- **Residency invariant** (spec 316 §11a) — exchanges carry hashes/refs; the confidentiality mode changes only where the body is sealed.
