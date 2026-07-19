// InteractionsDO — the per-principal SERIALIZED execution point for the interaction substrate
// (spec 322 W2; the embryo of spec 316's PrincipalGatewayDO). One instance per principal SA
// (idFromName = lowercase org/person SA): every board/directory mutation for that principal flows
// through THIS object, giving the single-writer ordering the vault's last-writer-wins storage
// cannot (spec 322 §5). Plane-B custody: the DO stores the principal's steward-signed interactions
// grant (the OPERATIONAL wire lives with its delegate service — spec 322 §2); callers never touch
// `/mcp/vault/*` for interaction records.
//
// Gates (spec 322 §4), all fail-closed:
//   caller    = a broker-verified Home session (any principal kind) → the session SA;
//   member    = a CURRENT directory listing whose ERC-1271 proof re-verifies AT GATE TIME against
//               the subject SA (index presence is never trust — the index is writable under the
//               execution grant);
//   steward   = a PRESENTED org→person stewardship DelegationWire, signature-verified against the
//               org (approved-hash 0x03 wires validate through the SA's ERC-1271 branch) and
//               checked unrevoked on-chain;
//   replay    = monotonic publishedAt per subject + tombstones honored by the gate.
// The VAULT enforces scopes only — never membership (stated so nobody optimizes this gate away).
// Audit: D1 (spec 322 §7), before commit.
import { createPublicClient, http, decodeAbiParameters, type Address, type Hex } from 'viem';
import { baseSepolia } from 'viem/chains';
import { hashDelegation, decodeVaultRecordScopeTerms, VAULT_RECORD_SCOPE_ENFORCER, type Delegation } from '@agenticprimitives/delegation';
import { A2A_ANY_SKILL, decodeAllowedMethodsTerms, decodeAllowedTargetsTerms, skillSelector } from '@agenticprimitives/a2a';
import {
  appendBoardPost,
  assistantTrigger,
  buildAssistantInboxReply,
  createBoardChannel,
  canSeeChannel,
  channelParticipationPolicy,
  canonicalizeMessage,
  createVaultMessageBodyStore,
  fixedWindowAllow,
  inboxAssistantTrigger,
  isListingCurrent,
  isRetryableVaultToolFailure,
  setTopicAssistant,
  setTopicRouting,
  sha256Hex32,
  validateDirectoryListing,
  CONSULT_SKILL_ID,
  ROUTED_CONSULTATION_CONTEXT_KIND,
  ROUTING_FANOUT_DEFAULT,
  consultGrantRecordKey,
  eligibleConsultMembers,
  verifiedBodiesFromBatch,
  type ChannelMessageEntryV1,
  type ChannelV1,
  type ConsultProvenanceV1,
  type ConsultRosterRowV1,
  type ContextRefV1,
  type ConversationDescriptorV1,
  type DirectoryListingV1,
  type FixedWindowState,
  type MessageEnvelopeV1,
  type MessageEventV1,
  type PersonAssistantV1,
  type TopicAssistantV1,
} from '@agenticprimitives/fabric/messaging';
import { AgentNamingClient } from '@agenticprimitives/agent-naming';
import type { Vault } from '@agenticprimitives/vault';

import { caip10, verifyHomeSession, verifyRelyingIdToken } from './custody-oidc.js';
import { verifyBridgeCall, nonceStoreFromKv, type NonceStore } from './bridge-hmac';
// Hoisted-function import from index.js — the documented safe cycle (see a2a-task-do.ts:38).
import { buildAuditSink, callMcpToolBound, interactionsSessionAccount, type Env, type IncomingDelegation } from './index.js';
import { checkConsultWireShape } from './consult-wire.js';

const ERC1271_ABI = [{ type: 'function', name: 'isValidSignature', stateMutability: 'view', inputs: [{ name: 'hash', type: 'bytes32' }, { name: 'signature', type: 'bytes' }], outputs: [{ type: 'bytes4' }] }] as const;
const ERC1271_MAGIC = '0x1626ba7e';
const IS_REVOKED_ABI = [{ type: 'function', name: 'isRevoked', stateMutability: 'view', inputs: [{ name: 'delegationHash', type: 'bytes32' }], outputs: [{ name: 'revoked', type: 'bool' }] }] as const;

// spec 324 §10 conversation/topic split (renamed from board.* in the W6 key migration): descriptors in
// `conversation.index`; per-topic message projections in `conversation.topic:<id>` (multi-writer conflicts
// shrink to same-topic; reads stop paying for the whole board; per-topic scopes become possible). NO dual-read
// from the old `board.*` keys (ADR-0013) — the scope rename forces a grant re-enable, which self-invalidates.
const CONVERSATION_INDEX_RESOURCE = 'conversation.index';
const TOPIC_RESOURCE = (conversationId: string): string => `conversation.topic:${conversationId}`;
const DIRECTORY_RESOURCE = 'directory.data';

// Topic participation (tbox/messaging.ttl §Topic participation). RESTRICTED topics ASSERT participation:
// apmsg:DiscussionInvitation rows live in `conversation.topic:invitations`; accepted participations
// (apmsg:DiscussionParticipation situation projections) in `conversation.topic:participation:<topicId>`.
// Both deliberately ride the EXISTING `vault:conversation.topic:*` grant scope (anchored prefix match) so
// no grant re-enable is needed; topic ids are generated `conv_*` so the sub-keys can't collide. OPEN topics
// NEVER touch these records — participation there is DERIVED from org membership (the directory-listing
// gate) at read time and MUST NOT be asserted (same doctrine as aporg:memberOf).
const DISCUSSION_INVITATIONS_RESOURCE = 'conversation.topic:invitations';
const TOPIC_PARTICIPATION_RESOURCE = (topicId: string): string => `conversation.topic:participation:${topicId}`;

// spec 327 §4b — the org's ASSISTANT PLAYBOOK: a steward-authored Agent Skill package (SKILL.md
// projection, ADR-0051 vocabulary) whose markdown becomes the LLM planner's system prompt for the
// discussion turn. ONE org-level doc, deliberately keyed under the `conversation.topic:` namespace
// so it rides the EXISTING `vault:conversation.topic:*` grant scope (the invitations/participation
// carve) — no grant re-enable. Steward-gated authoring; the harness reads it marker-gated.
const ASSISTANT_SKILL_RESOURCE = 'conversation.topic:assistant-skill';
const ASSISTANT_SKILL_MAX_CHARS = 8192;
interface AssistantSkillDocV1 { version: 'ap.assistant-skill.v1'; markdown: string; updatedBy: string; updatedAt: string }

// spec 327 — org-assistant dispatch bounds. Per-topic fixed window in DO storage: member-driven
// mention storms are bounded; drops are audited (`interactions.assistant.rateLimited`), never queued.
const ASSISTANT_RATE_KEY = (topicId: string): string => `assistant.rate:${topicId}`;
const ASSISTANT_RATE_WINDOW_MS = 10 * 60_000;
const ASSISTANT_RATE_MAX = 6;
/** Context bound for the assistant's topic reads (spec 327 §4). */
const ASSISTANT_READ_LIMIT = 20;
const ASSISTANT_BODY_CLIP = 2000;

// ── spec 328 — the PERSON inbox auto-reply assistant (the person twin of spec 327). ──
// Config + playbook are VAULT records, deliberately keyed under `conversation.topic:` so they ride
// the EXISTING `vault:conversation.topic:*` grant scope (the 327 §4b carve) — no grant re-enable.
const PERSON_ASSISTANT_RESOURCE = 'conversation.topic:person-assistant';
const PERSON_ASSISTANT_SKILL_RESOURCE = 'conversation.topic:person-assistant-skill';
/** DO-storage gate flag — a CACHE of the canonical vault record's `enabled`, maintained ONLY by
 *  the enable/disable ops (single writer), so disabled inboxes exit every scan in O(1) with no
 *  vault read. The canonical record is re-read before any dispatch AND at the write (§5). */
const INBOX_ASSISTANT_FLAG_KEY = 'assistant.inbox.on';
/** Seen ledger — envelope ids already scanned (bounded ring). Both commit paths (internal.deliver
 *  and the Home's whole-doc inbox.put) diff against it; first sight SEEDS without dispatching so
 *  history/replays never trigger. */
const INBOX_ASSISTANT_SEEN_KEY = 'assistant.inbox.seen';
const INBOX_ASSISTANT_SEEN_CAP = 300;
const INBOX_ASSISTANT_RATE_KEY = (conversationId: string): string => `assistant.rate:inbox:${conversationId}`;
/** Bound dispatches per scan — a whole-doc put can carry several new envelopes at once. */
const INBOX_ASSISTANT_MAX_PER_SCAN = 2;
/** Context bound for the assistant's conversation reads (spec 328 §4). */
const INBOX_ASSISTANT_READ_LIMIT = 8;

// spec 329 §3.1 — the DO-custodied ORG consult wire (the routing-enable ceremony's mint): a narrow
// org-signed delegation (delegator = this org, delegate = the interactions-session KMS key,
// allowedMethods = [discussion.consult selector]) that lets the org's runtime SIGN consult-rail
// message/send + tasks/get digests as the org. A stored wire lives with its delegate service
// (spec 322 §2); the KMS key itself never rests here. Clearing this key is the org-side routing
// kill switch (the on-chain revocation is the authority kill at every member's gate).
const ROUTING_ORG_WIRE_KEY = 'routing.orgWire';
interface RoutingOrgWireRecord { wire: IncomingDelegation; hash: string; sessionKey: string; enabledBy: string; enabledAt: string }

/** The scope set the CURRENT wave requires — a stored grant missing any of these is STALE and the
 *  steward re-signs via the Enable ceremony (grant re-signs are ceremonies, not migration). */
// NOTE: `vault:org.applications` is deliberately NOT here. It ships in the interactions grant (so fresh grants
// can write the applications doc), but it is a FEATURE-specific additive scope — gating the WHOLE interactions
// plane (channels/directory/inbox/invite) on it would strand any grant that predates it (or was signed in a
// deploy window) with a blanket "stale — re-enable". A grant lacking it simply can't write org.applications
// (the vault-record-scope caveat enforces that at the vault); everything else keeps working.
const REQUIRED_SCOPES = ['vault:conversation.index', 'vault:conversation.topic:*', 'vault:message.body:topic:*', 'vault:inbox.data', 'vault:directory.data', 'vault:relationships.data', 'vault:member.profile:*', 'vault:org.membership:*', 'vault:message.body:dm:*', 'vault:impact-profile', 'vault:skills.data', 'vault:home.manifest', 'vault:control-events.data'] as const;

// 1-1 inbox residency (spec 322 W3f): the DELIVERY grant is WRITE-ONLY — every inbox.data READ and
// dm-body READ rides the interactions grant THROUGH this DO (single writer, single reader path).
const INBOX_RESOURCE = 'inbox.data';
const DM_BODY_PREFIX = 'message.body:dm:';
// spec 324 §7 Tier-2 — the org's pending MembershipApplications doc, a plain whole-doc record in the org's
// vault (NOT the inbox — a non-member's application must surface reliably to the steward). Bridge-only: the
// Home appends on the applicant's behalf (applying is open) and reads on the steward's behalf.
const APPLICATIONS_RESOURCE = 'org.applications';

// Person-plane records (spec 322 W3d): the person's authoritative org-relationship doc and their
// per-org shareable profile cards. Self-gated ops only — the session SA must BE the principal.
const RELATIONSHIPS_RESOURCE = 'relationships.data';
const MEMBER_PROFILE_RESOURCE = (org: string): string => `member.profile:${org.toLowerCase()}`;

// spec 324 W3 — the AUTHORITATIVE OrganizationMembership record (a private SituationV2 + its credential),
// per org, in the party's own vault. Membership is NOT a delegation and NOT a directory listing (ADR-0048
// #3/#6): this record is the single source of truth; the related:* link, directory roster row, and gate
// caches are provenance-tagged projections of it. Self-gated writes (the principal owns their membership
// record); the org retains its own copy in the org's DO.
const MEMBERSHIP_RESOURCE = (org: string): string => `org.membership:${org.toLowerCase()}`;

// spec 323 W2 — owner-own capability DOCUMENTS (last-writer-wins whole-doc records), reachable ONLY
// self (session SA === principal) over the interactions grant. This is the delegation-authorized,
// KEK-encrypted replacement for the bearer/service-MAC `impact-profile` path (V-1 remediation) and
// the app-local `skills`/`home-manifest` KV. NOT append logs (control-events needs its own op).
const CAPABILITY_RECORDS = new Set(['impact-profile', 'skills.data', 'home.manifest', 'control-events.data']);
const CONTROL_EVENTS_RESOURCE = 'control-events.data';
const CONTROL_EVENTS_CAP = 200; // ring buffer — the person's portable timeline is a recent-window projection.

// spec 323 §3: wires whose DELEGATE is this person (stewardship, member-access) are the person's
// own private credentials — they ride the entry so any Home can act from the vault (ADR-0025).
// spec 323 W1-tail — kind/parent capture the managed-tree SHAPE (org / org-treasury / person-treasury
// and where it hangs), so a second Home reconstructs the FULL tree + inbox-control from the vault, not
// just member/steward org links.
// spec 324 W3 — provenance fields (membershipId / membershipSituationHash / enrollmentDecisionRef) make this
// projection traceable back to its authoritative OrganizationMembership Situation. `relationship:'member'`
// here is a projection LABEL, never authority (ADR-0048 #3): the delegations it carries are the authority
// artifacts issued BECAUSE of membership; the membership itself is the SituationV2 the provenance points to.
interface RelationshipEntryV1 { org: string; relationship: 'member' | 'steward'; orgName?: string; kind?: string; parent?: string; delegationHash?: string; delegations?: IncomingDelegation[]; membershipId?: string; membershipSituationHash?: string; enrollmentDecisionRef?: string; updatedAt: string }
interface RelationshipsDocV1 { orgs: Record<string, RelationshipEntryV1> }

// apmsg:DiscussionInvitation row (restricted topics only) — a directed proposal, NOT a participation;
// acceptance converts it into the participation row + members projection update.
interface DiscussionInvitationRowV1 { id: string; topicId: string; invitedAgent: string; invitedName?: string; invitedBy: string; invitedByName?: string; role: 'facilitator' | 'contributor'; status: 'invited' | 'accepted' | 'declined' | 'revoked'; createdAt: string; decidedAt?: string }
// apmsg:DiscussionParticipation projection row (restricted topics): personSA + discussion-scoped role +
// provenance back to the accepted invitation. The descriptor's `members[]` stays the fast-ACL projection
// of these rows (canSeeChannel); THIS doc is the situation-backed source.
interface DiscussionParticipationRowV1 { personSA: string; personName?: string; role: 'facilitator' | 'contributor'; situationRef: string; invitationRef: string; acceptedAt: string; status: 'active' | 'revoked'; revokedAt?: string }
/** Grants LEDGER row (spec 322 W3e §2): hash + metadata ONLY — the wire itself is a bearer secret. */
interface GrantLedgerRowV1 { hash: string; delegate: string; resources: string[]; storedAt: string }

interface IndexedListing { listing: DirectoryListingV1; label: string }
interface StoredState {
  grant?: IncomingDelegation;
  /** NEW-C1 — the PRINCIPAL-signed DEL-001 session-delegation leaf (principal → the interactions-session
   *  KMS key). Custodied at grant.put alongside `grant`. When present (+ GCP_KMS_INTERACTIONS_KEY_NAME set),
   *  vaultFor CLIENT-MINTS a bound token (callMcpToolBound) instead of server-mint — no DEMO_ALLOW_SERVER_MINT.
   *  Absent ⇒ vaultFor falls back to the server-mint bridge (existing principals migrate on next enable). */
  sessionLeaf?: IncomingDelegation;
  /** spec 323 W3 — the WRITE-ONLY delivery wire (owner → DELIVERY_SERVICE_SA), custodied HERE (a
   *  stored wire is a bearer secret; the DO is the delegate-service side, spec 322 §2). The DO is
   *  now the sole holder+wielder for dm-body writes — no app (not even the Home) keeps it. */
  deliveryGrant?: IncomingDelegation;
  /** Issuance ledger (spec 322 W3e): every grant ever custodied here, hash/metadata only. */
  ledger?: GrantLedgerRowV1[];
  /** subject(lowercase caip10) → highest publishedAt accepted (replay guard) + tombstone flag. */
  subjects?: Record<string, { publishedAt: string; tombstoned?: boolean }>;
}

const json = (b: unknown, s = 200): Response => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });

export class InteractionsDO {
  constructor(private state: DurableObjectState, private env: Env) {}

  /** ARCH-H1 — a per-instance RMW mutex. A Durable Object serves concurrent requests that interleave
   *  across the MCP round-trip, so two appends to the SAME doc both read rev N and one silently
   *  overwrites the other (lost update). This serializes read→modify→write for the ops that share a
   *  doc across DISTINCT writers — channel posts (many members), deliveries (many senders), timeline
   *  appends (many server flows). Reads never take it; self-only single-writer ops don't need it. */
  private mutating: Promise<unknown> = Promise.resolve();
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutating.then(fn, fn);
    this.mutating = run.then(() => undefined, () => undefined);
    return run;
  }


  private pub() {
    return createPublicClient({ chain: baseSepolia, transport: http(this.env.RPC_URL) });
  }

  /** spec 327 §3 — post-commit org-assistant dispatch. Fire-and-forget (the member's post already
   *  committed; a DO stays alive while work is pending): per-topic fixed-window rate limit, then an
   *  in-Worker call to the org's OWN A2aTaskDO (`/internal/discussion-respond`, the 318 §8.1
   *  intent-native gateway) carrying the ARCH-H2 internal marker. Every drop/failure is AUDITED and
   *  DROPPED — no retry into another mechanism (ADR-0013), no queue, no effect on the human post. */
  private dispatchAssistant(opts: { entry: ChannelV1; channelId: string; principal: string; triggerAuthor: string; triggerBody: string }): void {
    const assistant = opts.entry.assistant;
    const secret = this.env.A2A_CUSTODY_BRIDGE_SECRET;
    if (!assistant || !secret) return;
    const audit = buildAuditSink(this.env);
    void (async () => {
      const key = ASSISTANT_RATE_KEY(opts.channelId);
      const now = Date.now();
      const rate = ((await this.state.storage.get(key)) ?? { windowStart: now, count: 0 }) as { windowStart: number; count: number };
      const inWindow = now - rate.windowStart < ASSISTANT_RATE_WINDOW_MS;
      if (inWindow && rate.count >= ASSISTANT_RATE_MAX) {
        await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.assistant.rateLimited', outcome: 'denied', actor: { type: 'service', id: opts.principal }, subject: { type: 'channel', id: opts.channelId } });
        return;
      }
      await this.state.storage.put(key, inWindow ? { windowStart: rate.windowStart, count: rate.count + 1 } : { windowStart: now, count: 1 });
      const stub = this.env.A2A_TASKS.get(this.env.A2A_TASKS.idFromName(opts.principal));
      const resp = await stub.fetch(new Request(`https://do/internal/discussion-respond?agent=${opts.principal}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ap-internal': secret },
        body: JSON.stringify({
          principal: opts.principal, channelId: opts.channelId, topicTitle: opts.entry.title,
          trigger: assistant.trigger, displayName: assistant.displayName, mentionHandle: assistant.mentionHandle,
          triggerAuthor: opts.triggerAuthor, triggerBody: opts.triggerBody,
        }),
      }));
      const out = (await resp.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!resp.ok || out.ok === false) throw new Error(out.error ?? `assistant respond failed (${resp.status})`);
      await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.assistant.dispatch', outcome: 'success', actor: { type: 'service', id: opts.principal }, subject: { type: 'channel', id: opts.channelId } });
    })().catch((e) => {
      void audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.assistant.dispatchFailed', outcome: 'error', actor: { type: 'service', id: opts.principal }, subject: { type: 'channel', id: opts.channelId }, reason: e instanceof Error ? e.message : String(e) }).catch(() => undefined);
    });
  }

  /** spec 328 §3 — post-commit person-inbox assistant scan. Called (fire-and-forget) after ANY
   *  inbox.data commit — the in-Worker a2a merge (`internal.deliver`) and the Home's whole-doc
   *  write (`inbox.put`) — so every ingress triggers identically. The seen-ledger RMW rides the
   *  DO's single-writer mutex (queued, never awaited by the caller — the caller may itself hold
   *  the mutex); the trigger evaluation + dispatch run off the lock. Every drop/failure is
   *  AUDITED and DROPPED (ADR-0013): no retry, no queue, no effect on the committed delivery. */
  private queueInboxAssistantScan(principal: string, envelopes: MessageEnvelopeV1[]): void {
    const audit = buildAuditSink(this.env);
    const secret = this.env.A2A_CUSTODY_BRIDGE_SECRET;
    if (!secret) return;
    void this.serialize<MessageEnvelopeV1[]>(async () => {
      if (!(await this.state.storage.get(INBOX_ASSISTANT_FLAG_KEY))) return [];
      const seen = (await this.state.storage.get(INBOX_ASSISTANT_SEEN_KEY)) as string[] | undefined;
      const ids = envelopes.map((e) => e.id);
      if (!seen) {
        // First sight (enable seeds explicitly; this covers a DO-storage reset): SEED, never dispatch.
        await this.state.storage.put(INBOX_ASSISTANT_SEEN_KEY, ids.slice(-INBOX_ASSISTANT_SEEN_CAP));
        return [];
      }
      const seenSet = new Set(seen);
      const fresh = envelopes.filter((e) => !seenSet.has(e.id));
      if (fresh.length === 0) return [];
      await this.state.storage.put(INBOX_ASSISTANT_SEEN_KEY, [...seen, ...fresh.map((e) => e.id)].slice(-INBOX_ASSISTANT_SEEN_CAP));
      return fresh;
    }).then(async (fresh) => {
      if (fresh.length === 0) return;
      // Canonical enablement + config: the VAULT record (the flag above is only the O(1) gate cache).
      const st = ((await this.state.storage.get('state')) ?? {}) as StoredState;
      const g = st.grant;
      if (!g) return;
      const cfg = await this.readDoc<PersonAssistantV1 | null>(g, PERSON_ASSISTANT_RESOURCE, null);
      const now = Date.now();
      const candidates = fresh.filter((e) => inboxAssistantTrigger(cfg, e, principal, now)).slice(0, INBOX_ASSISTANT_MAX_PER_SCAN);
      for (const envelope of candidates) {
        const rateKey = INBOX_ASSISTANT_RATE_KEY(envelope.conversationId);
        const prev = (await this.state.storage.get(rateKey)) as FixedWindowState | undefined;
        const rate = fixedWindowAllow(prev, Date.now(), { windowMs: ASSISTANT_RATE_WINDOW_MS, max: ASSISTANT_RATE_MAX });
        if (!rate.allowed) {
          await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.inboxAssistant.rateLimited', outcome: 'denied', actor: { type: 'service', id: principal }, subject: { type: 'conversation', id: envelope.conversationId } });
          continue;
        }
        await this.state.storage.put(rateKey, rate.next);
        try {
          const stub = this.env.A2A_TASKS.get(this.env.A2A_TASKS.idFromName(principal));
          const resp = await stub.fetch(new Request(`https://do/internal/inbox-respond?agent=${principal}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-ap-internal': secret },
            body: JSON.stringify({
              principal, conversationId: envelope.conversationId, messageId: envelope.id,
              senderCaip: envelope.from, ...(envelope.subject ? { subject: envelope.subject } : {}),
              displayName: cfg?.displayName ?? '',
            }),
          }));
          const out = (await resp.json().catch(() => ({}))) as { ok?: boolean; error?: string };
          if (!resp.ok || out.ok === false) throw new Error(out.error ?? `inbox assistant respond failed (${resp.status})`);
          await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.inboxAssistant.dispatch', outcome: 'success', actor: { type: 'service', id: principal }, subject: { type: 'conversation', id: envelope.conversationId } });
        } catch (e) {
          await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.inboxAssistant.dispatchFailed', outcome: 'error', actor: { type: 'service', id: principal }, subject: { type: 'conversation', id: envelope.conversationId }, reason: e instanceof Error ? e.message : String(e) }).catch(() => undefined);
        }
      }
    }).catch((e) => {
      void audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.inboxAssistant.dispatchFailed', outcome: 'error', actor: { type: 'service', id: principal }, subject: { type: 'inbox', id: principal }, reason: e instanceof Error ? e.message : String(e) }).catch(() => undefined);
    });
  }

  private async erc1271(account: Address, digest: Hex, signature: Hex): Promise<boolean> {
    try {
      const magic = (await this.pub().readContract({ address: account, abi: ERC1271_ABI, functionName: 'isValidSignature', args: [digest, signature] })) as Hex;
      return magic.toLowerCase() === ERC1271_MAGIC;
    } catch { return false; }
  }

  /** One delegation-authorized demo-mcp tool call (bound-mint transport). NEW-C1 — per-op transport
   *  selection: when the principal has custodied a DEL-001 session leaf (st.sessionLeaf,
   *  PRINCIPAL-signed, binding the interactions-session KMS key) AND that key is configured,
   *  CLIENT-MINT a bound token (callMcpToolBound, enforceBinding) — the leaf's delegator MUST equal
   *  this grant's delegator (the principal / token sub), else it's not the right principal's leaf. */
  private async mcpVaultTool(
    grant: IncomingDelegation,
    toolName: 'get_vault_record' | 'get_vault_records' | 'set_vault_record' | 'list_vault_record',
    toolArgs: Record<string, unknown>,
  ): Promise<Response> {
    const env = this.env;
    if ((env.GCP_KMS_INTERACTIONS_KEY_NAME ?? '').trim()) {
      const st = ((await this.state.storage.get('state')) ?? {}) as StoredState;
      const leaf = st.sessionLeaf;
      if (leaf && leaf.delegator.toLowerCase() === grant.delegator.toLowerCase()) {
        return callMcpToolBound({ env, toolName, grant, sessionLeaf: leaf, toolArgs });
      }
      // CRIT-2 W4 — the interactions-session key IS configured but this principal has NO custodied leaf
      // (it enabled before leaf-signing shipped). FAIL-CLOSED (ADR-0013 one-mechanism): require a
      // re-enable to custody the DEL-001 leaf; do NOT switch to the server-mint bridge. Server-mint is
      // retired. The Home's activateInteractionsIfNeeded self-heals this on the principal's next login.
      return new Response(
        JSON.stringify({ ok: false, error: 'session_leaf_required', detail: 'interactions vault access needs a re-enable to custody the DEL-001 session leaf (server-mint retired — CRIT-2)' }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      );
    }
    // CRIT-2 W6 — server-mint retired. The interactions-session KMS key is REQUIRED for interactions vault
    // ops (bound-mint above / DO-side proof). Unconfigured ⇒ FAIL-CLOSED (dev must provision
    // GCP_KMS_INTERACTIONS_KEY_NAME); prod always sets it, taking the bound/409 branch above. No fallback.
    return new Response(
      JSON.stringify({ ok: false, error: 'interactions_key_unprovisioned', detail: 'GCP_KMS_INTERACTIONS_KEY_NAME is unset — interactions vault ops require it (server-mint retired, CRIT-2)' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // 2026-07-18 LIVE REGRESSION — a THROTTLED vault call is not an auth failure. demo-mcp's stage-2
  // soft rate limiter (120 verified calls/60s per principal+capability) rejects with the same opaque
  // 401 `{ error: 'auth failed', code: 'rate-limited' }` as a credential reject, and this DO used to
  // rethrow that string verbatim: a member opening a busy org's Discussions board saw a raw
  // "auth failed" instead of the board. The limiter rejects BEFORE the tool handler runs (nothing
  // executed), and its window frees in well under a second (observed retryAfterMs 8–394ms), so a
  // rate-limited response is RETRIED with a short backoff and, if it persists, surfaces as an
  // explicit throttle error — never as an authorization verdict.
  private static readonly VAULT_THROTTLE_BACKOFF_MS = 250;
  private static vaultThrottledError(op: string): Error {
    return new Error(`vault ${op} throttled (rate-limited) — this agent's storage budget is momentarily exhausted; retry shortly`);
  }

  /** The fabric Vault port over the delegation-authorized demo-mcp transport (plane B). */
  private vaultFor(grant: IncomingDelegation): Vault {
    const callTool = (toolName: 'get_vault_record' | 'get_vault_records' | 'set_vault_record' | 'list_vault_record', toolArgs: Record<string, unknown>): Promise<Response> =>
      this.mcpVaultTool(grant, toolName, toolArgs);
    return {
      async write({ resource, data }: { owner: string; resource: string; data: unknown; classification?: string }): Promise<void> {
        // A rate-limited write was rejected at verify time (never executed) — same bounded retry as reads.
        for (let attempt = 0; attempt < 4; attempt++) {
          const resp = await callTool('set_vault_record', { recordType: resource, data });
          const out = (await resp.json().catch(() => ({}))) as { ok?: boolean; error?: string; code?: string };
          if (resp.ok && out.ok !== false) return;
          if (isRetryableVaultToolFailure(resp.status, out)) {
            if (attempt < 3) { await new Promise((r) => setTimeout(r, InteractionsDO.VAULT_THROTTLE_BACKOFF_MS * (attempt + 1))); continue; }
            throw InteractionsDO.vaultThrottledError('write');
          }
          throw new Error(out.error ?? `vault write failed (${resp.status})`);
        }
        throw InteractionsDO.vaultThrottledError('write');
      },
      async read<T>({ resource }: { owner: string; resource: string }): Promise<{ data: T } | null> {
        // BOUNDED RETRY (2026-07-11) — cold-cache first read; demo-mcp caches the deterministic vault-key
        // verdict, so only the first op per isolate touches the chain. A real empty (`ok:true, record:null`)
        // returns immediately — empty is an answer, an auth error is not (ADR-0013: retry the SAME call).
        // NOTE: get_vault_record returns the payload under `data` (NOT `record`) — the field-name mismatch
        // was THE "saved but reads back empty" bug.
        let lastErr = 'vault read failed';
        for (let attempt = 0; attempt < 4; attempt++) {
          const resp = await callTool('get_vault_record', { recordType: resource });
          const out = (await resp.json().catch(() => ({}))) as { ok?: boolean; data?: T | null; error?: string; code?: string };
          if (!resp.ok) {
            // Transient throughput reject (stage-2 limiter) ⇒ back off + retry; never an auth verdict.
            if (isRetryableVaultToolFailure(resp.status, out)) {
              if (attempt < 3) { await new Promise((r) => setTimeout(r, InteractionsDO.VAULT_THROTTLE_BACKOFF_MS * (attempt + 1))); continue; }
              throw InteractionsDO.vaultThrottledError('read');
            }
            throw new Error(out.error ?? `vault read failed (${resp.status})`);
          }
          if (out.ok === false) { lastErr = out.error ?? 'vault read unauthorized'; if (attempt < 3) { await new Promise((r) => setTimeout(r, 120)); continue; } throw new Error(lastErr); }
          return out.data === null || out.data === undefined ? null : { data: out.data };
        }
        throw new Error(lastErr);
      },
      // spec 315 — enumerate the owner's OWN vault record types. demo-mcp's list_vault_record is
      // record-scope-FILTERED to the interactions grant, so this returns ONLY the Home-managed records
      // (app-specific records under other grants stay invisible — least-privilege). Bare record types.
      async list(): Promise<Array<{ resource: string; updatedAt: string }>> {
        const resp = await callTool('list_vault_record', {});
        const out = (await resp.json().catch(() => ({}))) as { ok?: boolean; records?: Array<{ record_type: string; updated_at: string }>; error?: string };
        if (!resp.ok || out.ok === false) throw new Error(out.error ?? `vault list failed (${resp.status})`);
        return (out.records ?? []).map((r) => ({ resource: r.record_type, updatedAt: r.updated_at }));
      },
    } as unknown as Vault;
  }

  /** BATCHED message-body read: ONE `get_vault_records` round-trip for a whole topic's bodies,
   *  hash-verified per envelope (fabric `verifiedBodiesFromBatch` — the same spec 309 §8.4
   *  verification as `loadBody`, one mechanism). Replaces the per-message delegated reads whose
   *  O(board size) call volume per poll exhausted the org principal's stage-2 verified-call budget
   *  (the 2026-07-18 live regression: gate reads on the same budget then rejected and the member's
   *  board surfaced a raw "auth failed"). Requires demo-mcp ≥ VL-W2 (`get_vault_records`, deployed
   *  2026-07-13) — the deployed fleet has it; there is deliberately NO per-record fallback path
   *  (ADR-0013 one-mechanism). Fail-closed PER RECORD: unverifiable bodies are omitted. */
  private async readTopicBodies(grant: IncomingDelegation, envelopes: MessageEnvelopeV1[]): Promise<Record<string, string>> {
    if (envelopes.length === 0) return {};
    const recordTypes = [...new Set(envelopes.map((e) => e.body.resource))];
    let records: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 4; attempt++) {
      const resp = await this.mcpVaultTool(grant, 'get_vault_records', { recordTypes });
      const out = (await resp.json().catch(() => ({}))) as { ok?: boolean; records?: Record<string, unknown>; error?: string; code?: string };
      if (!resp.ok || out.ok === false) {
        if (isRetryableVaultToolFailure(resp.status, out)) {
          if (attempt < 3) { await new Promise((r) => setTimeout(r, InteractionsDO.VAULT_THROTTLE_BACKOFF_MS * (attempt + 1))); continue; }
          throw InteractionsDO.vaultThrottledError('read');
        }
        throw new Error(out.error ?? `vault batch read failed (${resp.status})`);
      }
      records = out.records ?? {};
      break;
    }
    const bytes = await verifiedBodiesFromBatch(envelopes, records);
    const decoder = new TextDecoder();
    return Object.fromEntries(Object.entries(bytes).map(([id, b]) => [id, decoder.decode(b)]));
  }

  private async readDoc<T>(grant: IncomingDelegation, resource: string, empty: T): Promise<T> {
    const r = await this.vaultFor(grant).read<T>({ owner: '', resource });
    return (r?.data as T) ?? empty;
  }

  private async writeDoc(grant: IncomingDelegation, resource: string, data: unknown): Promise<void> {
    await this.vaultFor(grant).write({ owner: '', resource, data, classification: 'internal' } as never);
  }

  /** GATE-TIME listing verification (spec 322 §4): current + ERC-1271-proven + not tombstoned. */
  private async memberName(grant: IncomingDelegation, principal: string, sessionSaCaip: string): Promise<string | null> {
    const rows = await this.readDoc<IndexedListing[]>(grant, DIRECTORY_RESOURCE, []);
    const me = sessionSaCaip.toLowerCase();
    const now = new Date().toISOString();
    const mine = rows.find((l) => l.listing.subject.toLowerCase() === me && isListingCurrent(l.listing, now));
    if (!mine) return null;
    const st = ((await this.state.storage.get('state')) ?? {}) as StoredState;
    if (st.subjects?.[me]?.tombstoned) return null;
    const { proof, ...draft } = mine.listing;
    const digest = await sha256Hex32(canonicalizeMessage(draft));
    const subjectAddr = mine.listing.subject.match(/0x[0-9a-fA-F]{40}$/)?.[0] as Address | undefined;
    if (!subjectAddr || !(await this.erc1271(subjectAddr, digest as Hex, proof.signature as Hex))) return null;
    void principal;
    return mine.listing.displayName;
  }

  /** Does the wire carry the STEWARDSHIP shape, not a data grant? (SEC-C1). A stewardship/site
   *  delegation (`buildApprovedSiteDelegation`) carries an `allowedTargetsEnforcer` caveat (governance
   *  targets: agent-relationship / naming / registry) and NEVER a vault-record-scope caveat. Every
   *  org→person DATA grant — member-access, membership, delivery, interactions — instead carries a
   *  VAULT_RECORD_SCOPE_ENFORCER caveat. Requiring the governance caveat AND rejecting the scope
   *  caveat separates a steward from a member: without this, a member's own org→member member-access
   *  delegation (same delegator=org, delegate=member, org-signed, unrevoked) passed as a steward
   *  proof → member→steward escalation (kick members, dump the ledger, act as steward). */
  private hasStewardshipShape(wire: IncomingDelegation): boolean {
    // NEW-H2 — FAIL CLOSED on an unconfigured enforcer. If ALLOWED_TARGETS_ENFORCER is unset (wrangler
    // binds "" for a placeholder var), the old `enforcer(c) === ''` matched ANY caveat with a missing/empty
    // enforcer → a record-scoped member wire (with a blank-enforcer caveat) would pass as stewardship
    // (member→steward escalation). A stewardship wire is unrecognizable without the real governance-targets
    // address, so no address ⇒ no stewardship.
    const targetEnforcer = (this.env.ALLOWED_TARGETS_ENFORCER ?? '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(targetEnforcer)) return false;
    const caveats = wire.caveats ?? [];
    const enforcer = (c: { enforcer?: string }): string => (c.enforcer ?? '').toLowerCase();

    // STEWARD-SHAPE-CONFUSION-1 — stewardship must be a POSITIVE identity, not "allowedTargets present ∧ no
    // record-scope". Payment mandates ([payment, timestamp, allowedTargets, allowedMethods]) and A2A message
    // grants ([timestamp, allowedTargets, allowedMethods]) ALSO carry allowedTargets and no record-scope, so
    // the old negative test accepted any of them as a steward proof → member/outsider → steward escalation
    // (the SEC-C1 hole reached through a different wire shape). The genuine steward/site wire
    // (`buildSiteDelegation`/`siteCaveats`): carries NO allowedMethods and NO record-scope caveat, AND its
    // allowedTargets terms pin the GOVERNANCE contracts (agentRelationship + agentNameRegistry + subregistry).
    // A payment mandate targets an asset; an a2a grant targets the recipient agent — neither names the
    // governance registries — and both add allowedMethods, so both are rejected here.
    const methodsEnforcer = (this.env.ALLOWED_METHODS_ENFORCER ?? '').toLowerCase();
    if (methodsEnforcer && caveats.some((c) => enforcer(c) === methodsEnforcer)) return false; // a2a grant / payment mandate
    if (caveats.some((c) => enforcer(c) === VAULT_RECORD_SCOPE_ENFORCER.toLowerCase())) return false; // data grant (SEC-C1)

    const rel = (this.env.AGENT_RELATIONSHIP ?? '').toLowerCase();
    const reg = (this.env.AGENT_NAME_REGISTRY ?? '').toLowerCase();
    // Fail closed if we can't positively identify the governance targets (prod injects both; org-create
    // already depends on them). No governance anchor ⇒ no stewardship.
    if (!/^0x[0-9a-f]{40}$/.test(rel) || !/^0x[0-9a-f]{40}$/.test(reg)) return false;
    const targetsCav = caveats.find((c) => enforcer(c) === targetEnforcer);
    if (!targetsCav?.terms) return false;
    let targets: string[];
    try {
      targets = (decodeAbiParameters([{ type: 'address[]' }], targetsCav.terms as Hex)[0] as readonly Address[]).map((a) => a.toLowerCase());
    } catch { return false; }
    // The site wire pins [agentRelationship, agentNameRegistry, subregistry]; require BOTH registries to be
    // present so a wire whose allowedTargets name anything else (asset, agent SA, host endpoint) is not
    // stewardship.
    return targets.includes(rel) && targets.includes(reg);
  }

  /** Organization-resource-access proof (SEC-H1): a presented org→member organizationResourceAccessDelegation wire — the ORG's
   *  authorization that this person may join (minted at invite time, `issueMemberAccessDelegation`).
   *  delegator = the org (this principal), delegate = the caller, org-signed + unrevoked, AND
   *  carrying the DATA-grant shape (a vault-record-scope caveat) so a governance/stewardship wire
   *  can't be replayed here. Without it a self-signed listing alone made anyone a member of any org
   *  (self-join → read its private channels). */
  private async hasMemberAccess(principal: string, sessionSa: Address, wire: IncomingDelegation | undefined): Promise<boolean> {
    if (!wire) return false;
    if (wire.delegator.toLowerCase() !== principal.toLowerCase()) return false;
    if (wire.delegate.toLowerCase() !== sessionSa.toLowerCase()) return false;
    const hasRecordScope = (wire.caveats ?? []).some((c) => (c.enforcer ?? '').toLowerCase() === VAULT_RECORD_SCOPE_ENFORCER.toLowerCase());
    if (!hasRecordScope) return false; // a stewardship/governance wire is not member-access
    const d: Delegation = { ...wire, salt: BigInt(wire.salt), caveats: wire.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: (c.args ?? '0x') as Hex })) } as Delegation;
    const digest = hashDelegation(d, Number(this.env.CHAIN_ID ?? 84532), this.env.DELEGATION_MANAGER as Address);
    if (!(await this.erc1271(wire.delegator as Address, digest, wire.signature as Hex))) return false;
    try {
      const revoked = (await this.pub().readContract({ address: this.env.DELEGATION_MANAGER as Address, abi: IS_REVOKED_ABI, functionName: 'isRevoked', args: [digest] })) as boolean;
      return !revoked;
    } catch { return false; }
  }

  /** Steward proof: a presented org→person organizationStewardshipDelegation wire, org-verified + unrevoked on-chain, AND
   *  carrying the stewardship caveat shape (SEC-C1 — never a data grant). */
  private async isSteward(principal: string, sessionSa: Address, wire: IncomingDelegation | undefined): Promise<boolean> {
    if (!wire) return false;
    if (wire.delegator.toLowerCase() !== principal.toLowerCase()) return false;
    if (wire.delegate.toLowerCase() !== sessionSa.toLowerCase()) return false;
    if (!this.hasStewardshipShape(wire)) return false; // SEC-C1: a member-access grant is NOT stewardship
    const d: Delegation = { ...wire, salt: BigInt(wire.salt), caveats: wire.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: (c.args ?? '0x') as Hex })) } as Delegation;
    const digest = hashDelegation(d, Number(this.env.CHAIN_ID ?? 84532), this.env.DELEGATION_MANAGER as Address);
    if (!(await this.erc1271(wire.delegator as Address, digest, wire.signature as Hex))) return false;
    try {
      const revoked = (await this.pub().readContract({ address: this.env.DELEGATION_MANAGER as Address, abi: IS_REVOKED_ABI, functionName: 'isRevoked', args: [digest] })) as boolean;
      return !revoked;
    } catch { return false; } // fail-closed on chain-read failure
  }


  /** Does the stored grant cover the CURRENT wave's scope set? Stale ⇒ steward re-enables. */
  private grantIsCurrent(grant: IncomingDelegation): boolean {
    const cav = (grant.caveats ?? []).find((c) => (c.enforcer ?? '').toLowerCase() === VAULT_RECORD_SCOPE_ENFORCER.toLowerCase());
    if (!cav?.terms) return false;
    try {
      const resources = new Set(decodeVaultRecordScopeTerms(cav.terms as Hex).flatMap((g) => g.resources));
      return REQUIRED_SCOPES.every((r) => resources.has(r));
    } catch { return false; }
  }

  /** Bridge-HMAC gate for the Home-server channel (SEC-010 envelope; audience pins the op). */
  private async bridgeGate(request: Request, rawBody: string, op: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const secret = this.env.A2A_CUSTODY_BRIDGE_SECRET;
    const kv = this.env.BRIDGE_NONCES;
    if (!secret || !kv) return { ok: false, reason: 'bridge not configured' };
    const nonces: NonceStore = nonceStoreFromKv(kv);
    return verifyBridgeCall({ request, rawBody, secret, expectedAudience: `interactions.${op}`, nonces });
  }

  /** spec 323 W4 — the PORTABLE gate for owner-facing residency ops: the OWNER's broker session
   *  (verifyHomeSession, session SA === principal) is accepted DIRECTLY, so ANY Home holding the
   *  owner's session drives them with NO shared bridge secret. Caller-selected (not a fallback,
   *  ADR-0013): a request that carries `session` takes the Web3-authenticated owner path; one that
   *  carries the SEC-010 envelope instead takes the incumbent demo-a2a↔Home server transport. Each
   *  fails closed. (Non-owner-facing ops — invite.* — stay bridge-only: they are org-steward /
   *  token-redeem substrate flows, not the owner acting on their own records.) */
  private async ownerOrBridge(request: Request, rawBody: string, op: string, principal: string, session: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (session) {
      const g = await verifyHomeSession(session, this.env);
      if (!g.ok) return { ok: false, reason: g.error };
      if (g.sa.toLowerCase() !== principal) return { ok: false, reason: 'these records belong to the principal — self access only' };
      return { ok: true };
    }
    return this.bridgeGate(request, rawBody, op);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean); // interactions/<principal>/<op>
    const principal = (parts[1] ?? '').toLowerCase();
    const op = parts[2] ?? '';
    if (!/^0x[0-9a-fA-F]{40}$/.test(principal)) return json({ error: 'bad principal' }, 400);
    const rawBody = await request.text();
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(rawBody) as Record<string, unknown>; } catch { /* empty body ok */ }

    // ── Grant custody (plane B): the Worker pre-verifies the steward session + delegator match. ──
    if (op === 'grant' && request.method === 'POST') {
      const wire = body.delegation as IncomingDelegation | undefined;
      if (!wire?.signature || wire.delegator.toLowerCase() !== principal) return json({ error: 'delegation with delegator = principal required' }, 400);
      // Verify the wire IS the principal's before storing (junk-overwrite DoS guard): ERC-1271 over
      // the delegation digest against the delegator (approved-hash 0x03 wires validate through the
      // SA's approved-hash branch). Fail-closed: an unverifiable grant is never stored.
      const d: Delegation = { ...wire, salt: BigInt(wire.salt), caveats: wire.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: (c.args ?? '0x') as Hex })) } as Delegation;
      const digest = hashDelegation(d, Number(this.env.CHAIN_ID ?? 84532), this.env.DELEGATION_MANAGER as Address);
      if (!(await this.erc1271(wire.delegator as Address, digest, wire.signature as Hex))) {
        return json({ error: 'grant signature failed verification against the delegator' }, 403);
      }
      // NEW-H6 (Phase B): pin the delegate to the configured interactions service SA. `vaultFor` runs every
      // op as requester=grant.delegate, so a grant issued to any OTHER delegate would route the principal's
      // entire vault surface through the wrong delegate. Inert until provisioned (INTERACTIONS_SERVICE_SA
      // unset ⇒ no pin, the pre-Phase-B behavior).
      const expectedInteractionsSa = (this.env.INTERACTIONS_SERVICE_SA ?? '').toLowerCase();
      if (/^0x[0-9a-f]{40}$/.test(expectedInteractionsSa) && wire.delegate.toLowerCase() !== expectedInteractionsSa) {
        return json({ error: 'grant delegate must be the configured interactions service SA (NEW-H6)' }, 403);
      }
      const st = ((await this.state.storage.get('state')) ?? {}) as StoredState;
      st.grant = wire;
      // NEW-C1 — custody the PRINCIPAL-signed DEL-001 session leaf (principal → interactions-session key), if
      // supplied. Verify it ERC-1271 against the principal (== grant delegator) so the DO never bound-mints
      // with a junk leaf; demo-mcp re-checks the binding at enforceBinding. Absent ⇒ server-mint bridge.
      const leafWire = body.sessionLeaf as IncomingDelegation | undefined;
      if (leafWire?.signature) {
        if (leafWire.delegator.toLowerCase() !== wire.delegator.toLowerCase()) {
          return json({ error: 'session leaf delegator must equal the grant delegator (the principal) — NEW-C1' }, 400);
        }
        const ld: Delegation = { ...leafWire, salt: BigInt(leafWire.salt), caveats: leafWire.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: (c.args ?? '0x') as Hex })) } as Delegation;
        const ldigest = hashDelegation(ld, Number(this.env.CHAIN_ID ?? 84532), this.env.DELEGATION_MANAGER as Address);
        if (!(await this.erc1271(leafWire.delegator as Address, ldigest, leafWire.signature as Hex))) {
          return json({ error: 'session leaf signature failed verification against the principal (NEW-C1)' }, 403);
        }
        st.sessionLeaf = leafWire;
      }
      // Ledger row (W3e): hash + delegate + decoded resources — never the wire (bearer secret).
      let resources: string[] = [];
      try {
        const cav = wire.caveats.find((c) => (c.enforcer ?? '').toLowerCase() === VAULT_RECORD_SCOPE_ENFORCER.toLowerCase());
        if (cav?.terms) resources = decodeVaultRecordScopeTerms(cav.terms as Hex).flatMap((g) => g.resources);
      } catch { /* undecodable scopes → empty resources row; the currency gate handles enforcement */ }
      st.ledger = [...(st.ledger ?? []), { hash: digest, delegate: wire.delegate.toLowerCase(), resources, storedAt: new Date().toISOString() }].slice(-50);
      await this.state.storage.put('state', st);
      return json({ ok: true });
    }
    // spec 323 W3 — custody the write-only DELIVERY wire in the DO (verified like /grant). Same
    // ERC-1271-against-delegator junk-guard; the wire never returns to any app.
    if (op === 'grant.delivery.put' && request.method === 'POST') {
      const wire = body.delegation as IncomingDelegation | undefined;
      if (!wire?.signature || wire.delegator.toLowerCase() !== principal) return json({ error: 'delivery delegation with delegator = principal required' }, 400);
      const d: Delegation = { ...wire, salt: BigInt(wire.salt), caveats: wire.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: (c.args ?? '0x') as Hex })) } as Delegation;
      const digest = hashDelegation(d, Number(this.env.CHAIN_ID ?? 84532), this.env.DELEGATION_MANAGER as Address);
      if (!(await this.erc1271(wire.delegator as Address, digest, wire.signature as Hex))) return json({ error: 'delivery grant signature failed verification against the delegator' }, 403);
      // NEW-H6 (Phase B): pin the delivery delegate to the configured delivery service SA (inert until provisioned).
      const expectedDeliverySa = (this.env.DELIVERY_SERVICE_SA ?? '').toLowerCase();
      if (/^0x[0-9a-f]{40}$/.test(expectedDeliverySa) && wire.delegate.toLowerCase() !== expectedDeliverySa) {
        return json({ error: 'delivery grant delegate must be the configured delivery service SA (NEW-H6)' }, 403);
      }
      const st = ((await this.state.storage.get('state')) ?? {}) as StoredState;
      st.deliveryGrant = wire;
      st.ledger = [...(st.ledger ?? []), { hash: digest, delegate: wire.delegate.toLowerCase(), resources: ['(delivery:write-only)'], storedAt: new Date().toISOString() }].slice(-50);
      await this.state.storage.put('state', st);
      return json({ ok: true });
    }
    if (op === 'status') {
      const st = ((await this.state.storage.get('state')) ?? {}) as StoredState;
      return json({ ok: true, granted: !!st.grant, current: !!st.grant && this.grantIsCurrent(st.grant), deliveryGranted: !!st.deliveryGrant });
    }

    // ── 1-1 inbox residency (spec 322 W3f) — the Home-server channel + in-Worker delivery. ──
    // The Home reaches this principal's mail ONLY here (bridge-HMAC-authenticated, the same SEC-010
    // envelope as the custody bridge); the a2a messaging skills merge deliveries here in-Worker
    // (`internal.deliver` — the public route refuses `internal.*`, so only Worker code reaches it).
    // The standing DELIVERY grant is write-only: it can no longer read anyone's mail.
    if (op === 'inbox.get' || op === 'inbox.put' || op === 'inbox.body.get' || op === 'internal.deliver' || op === 'internal.dm.body.put' || op === 'internal.channels.read' || op === 'internal.channels.post' || op === 'internal.inbox.read' || op === 'internal.inbox.post' || op === 'internal.consult.context' || op === 'internal.consult.eligible' || op === 'internal.consult.orgWire' || op === 'internal.consult.grant' || op === 'controlevents.append' || op === 'dm.body.put' || op === 'invite.get' || op === 'invite.put' || op === 'applications.get' || op === 'applications.put') {
      // Owner-facing residency ops accept the OWNER's session OR the bridge (spec 323 W4 — a portable
      // Home needs no secret). invite.* are substrate steward/redeem flows → bridge only. internal.*
      // are in-Worker (a2a deliver skill / spec 327 assistant pipeline) → no external gate.
      const OWNER_FACING = op === 'inbox.get' || op === 'inbox.put' || op === 'inbox.body.get' || op === 'controlevents.append' || op === 'dm.body.put';
      if (op.startsWith('internal.')) {
        // ARCH-H2 — the public router refuses internal.*, but the DO must NOT trust that alone.
        // Require an internal marker only in-Worker callers can supply (the bridge secret, shared by
        // co-resident DOs in this Worker). Any other path reaching internal.* fails closed.
        const secret = this.env.A2A_CUSTODY_BRIDGE_SECRET;
        if (!secret || request.headers.get('x-ap-internal') !== secret) return json({ error: 'internal op — not authorized' }, 403);
      } else {
        const bg = OWNER_FACING
          ? await this.ownerOrBridge(request, rawBody, op, principal, String(body.session ?? ''))
          : await this.bridgeGate(request, rawBody, op);
        if (!bg.ok) return json({ error: `unauthorized: ${bg.reason}` }, 401);
      }
      const st0 = ((await this.state.storage.get('state')) ?? {}) as StoredState;
      const g = st0.grant;
      if (!g) return json({ error: 'no interactions grant — enable interactions for this agent first' }, 409);
      if (!this.grantIsCurrent(g)) return json({ error: 'interactions grant is stale — re-enable (scope widened this wave)' }, 409);
      try {
        if (op === 'inbox.get') {
          const doc = await this.readDoc<unknown>(g, INBOX_RESOURCE, null);
          return json({ ok: true, doc });
        }
        if (op === 'inbox.put') {
          if (body.doc === undefined) return json({ error: 'doc required' }, 400);
          await this.writeDoc(g, INBOX_RESOURCE, body.doc);
          // spec 328 §3 — post-commit assistant scan (the HOME ingress: the two-party send/deliver
          // orchestration lands here as a whole-doc write). Fire-and-forget; the seen-ledger diff
          // finds what's new. Never affects this response.
          const scanEnvs = (body.doc as { envelopes?: MessageEnvelopeV1[] } | null)?.envelopes;
          if (Array.isArray(scanEnvs)) this.queueInboxAssistantScan(principal, scanEnvs);
          return json({ ok: true });
        }
        if (op === 'applications.get') {
          const doc = await this.readDoc<unknown>(g, APPLICATIONS_RESOURCE, { applications: [] });
          return json({ ok: true, doc });
        }
        if (op === 'applications.put') {
          if (body.doc === undefined) return json({ error: 'doc required' }, 400);
          await this.writeDoc(g, APPLICATIONS_RESOURCE, body.doc);
          return json({ ok: true });
        }
        if (op === 'inbox.body.get') {
          // dm-namespace ONLY — the bridge cannot be aimed at arbitrary vault records (the grant's
          // record scope enforces the same bound at the vault; this is the belt to that suspender).
          const resource = String(body.resource ?? '');
          if (!resource.startsWith(DM_BODY_PREFIX)) return json({ error: 'dm body resources only' }, 400);
          const r = await this.vaultFor(g).read<unknown>({ owner: '', resource });
          return json({ ok: true, record: r?.data ?? null });
        }
        // ── spec 327 — the org-assistant pipeline's two internal ops (in-Worker marker only). ──
        if (op === 'internal.channels.read') {
          // Bounded topic context for the assistant turn: last N entries + clipped bodies. Same
          // storage path as the session-gated channels.read; reachable ONLY via the internal marker.
          const channelId = String(body.channelId ?? '');
          if (!channelId) return json({ error: 'channelId required' }, 400);
          const index = await this.readDoc<ChannelV1[]>(g, CONVERSATION_INDEX_RESOURCE, []);
          const entry = index.find((c) => c.descriptor.id === channelId);
          if (!entry) return json({ error: 'unknown channel' }, 404);
          const limit = Math.min(Math.max(Number(body.limit ?? ASSISTANT_READ_LIMIT) || ASSISTANT_READ_LIMIT, 1), ASSISTANT_READ_LIMIT);
          const messages = (await this.readDoc<ChannelMessageEntryV1[]>(g, TOPIC_RESOURCE(channelId), [])).slice(-limit);
          // ONE batched, hash-verified body read (same seam as the session-gated channels.read);
          // fail-closed omit per body — an unverifiable body renders empty, never fails the turn.
          const bodyById = await this.readTopicBodies(g, messages.map((m) => m.envelope)).catch(() => ({} as Record<string, string>));
          const rows = messages.map((m) => ({ id: m.envelope.id, from: m.envelope.from, authorName: m.authorName, ...(m.actor ? { actor: m.actor } : {}), createdAt: m.envelope.createdAt, bodyText: (bodyById[m.envelope.id] ?? '').slice(0, ASSISTANT_BODY_CLIP) }));
          // spec 327 §4b — the assistant's context read also carries the org playbook (one round trip;
          // absent ⇒ the turn uses the built-in default playbook — a config default, not a fallback).
          const skill = await this.readDoc<AssistantSkillDocV1 | null>(g, ASSISTANT_SKILL_RESOURCE, null);
          return json({ ok: true, title: entry.title, messages: rows, ...(skill?.markdown ? { skillMarkdown: skill.markdown } : {}) });
        }
        if (op === 'internal.channels.post') {
          // The assistant's reply write (spec 327 §5). `from`/`actor` are PINNED server-side to the
          // org principal — the caller supplies only { channelId, bodyText }; it cannot author as
          // anyone. Disable wins races: a reply landing after the steward disables is rejected.
          const channelId = String(body.channelId ?? '');
          const bodyText = String(body.bodyText ?? '').trim();
          if (!channelId || !bodyText) return json({ error: 'channelId + bodyText required' }, 400);
          // spec 329 §6 — the routing turns' posts may carry the `routed-consultation` contextRef
          // (chip) + PROV attribution. PINNED: only that ref kind is accepted from the caller (the
          // in-Worker assistant pipeline), so this seam can never smuggle arbitrary refs.
          const extraRefs = (Array.isArray(body.contextRefs) ? (body.contextRefs as ContextRefV1[]) : [])
            .filter((r) => r?.kind === ROUTED_CONSULTATION_CONTEXT_KIND && typeof r.id === 'string' && r.id.trim())
            .slice(0, 2);
          const prov = body.prov && typeof body.prov === 'object' ? (body.prov as ConsultProvenanceV1) : undefined;
          const audit = buildAuditSink(this.env);
          return this.serialize(async () => { // ARCH-H1 — same single-writer append as every board post
            const index = await this.readDoc<ChannelV1[]>(g, CONVERSATION_INDEX_RESOURCE, []);
            const entry = index.find((c) => c.descriptor.id === channelId);
            if (!entry) return json({ error: 'unknown channel' }, 404);
            const assistant = entry.assistant;
            if (!assistant) return json({ error: 'assistant is not enabled on this topic' }, 409);
            const orgCaip = caip10(Number(this.env.CHAIN_ID ?? 84532), principal as Address) as MessageEnvelopeV1['from'];
            const messages = await this.readDoc<ChannelMessageEntryV1[]>(g, TOPIC_RESOURCE(channelId), []);
            const composed: ChannelV1[] = [{ ...entry, messages }];
            const r = await appendBoardPost(composed, { channelId, from: orgCaip, authorName: assistant.displayName, bodyText, actor: orgCaip, ...(extraRefs.length ? { contextRefs: extraRefs } : {}), ...(prov ? { prov } : {}) });
            if (!r.ok) return json({ error: r.error }, 400);
            await audit.write({ id: crypto.randomUUID(), timestamp: r.envelope.createdAt, action: 'interactions.channels.assistantPost', outcome: 'success', actor: { type: 'service', id: principal }, subject: { type: 'channel-post', id: r.envelope.id } });
            const store = createVaultMessageBodyStore(this.vaultFor(g), principal);
            await store.putBody({ messageId: r.envelope.id, bytes: new TextEncoder().encode(bodyText), contentType: 'text/plain', classification: 'internal', resource: r.envelope.body.resource });
            await this.writeDoc(g, TOPIC_RESOURCE(channelId), composed[0]!.messages);
            return json({ ok: true, messageId: r.envelope.id });
          });
        }
        // ── spec 328 — the person-inbox assistant's two internal ops (in-Worker marker only). ──
        if (op === 'internal.inbox.read') {
          // Bounded conversation context for the assistant turn: last N envelopes + clipped
          // decoded bodies, plus the owner's playbook (one round trip — the 327 §4b pattern).
          const conversationId = String(body.conversationId ?? '');
          if (!conversationId) return json({ error: 'conversationId required' }, 400);
          const cfg = await this.readDoc<PersonAssistantV1 | null>(g, PERSON_ASSISTANT_RESOURCE, null);
          if (!cfg?.enabled) return json({ error: 'assistant is not enabled for this inbox' }, 409);
          const doc = await this.readDoc<{ envelopes?: MessageEnvelopeV1[] }>(g, INBOX_RESOURCE, {});
          const rows = (doc.envelopes ?? []).filter((e) => e.conversationId === conversationId).slice(-INBOX_ASSISTANT_READ_LIMIT);
          const messages = await Promise.all(rows.map(async (e) => {
            let text = '';
            if (e.body?.resource?.startsWith(DM_BODY_PREFIX)) {
              try {
                const r = await this.vaultFor(g).read<{ b64?: string }>({ owner: '', resource: e.body.resource });
                if (r?.data?.b64) text = new TextDecoder().decode(Uint8Array.from(atob(r.data.b64), (c) => c.charCodeAt(0))).slice(0, ASSISTANT_BODY_CLIP);
              } catch { /* fail-closed omit body */ }
            }
            const fromAddr = (String(e.from).match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase();
            return { id: e.id, from: e.from, mine: fromAddr === principal, ...(e.actor ? { actor: e.actor } : {}), createdAt: e.createdAt, bodyText: text };
          }));
          const skill = await this.readDoc<AssistantSkillDocV1 | null>(g, PERSON_ASSISTANT_SKILL_RESOURCE, null);
          return json({ ok: true, displayName: cfg.displayName, messages, ...(skill?.markdown ? { skillMarkdown: skill.markdown } : {}) });
        }
        if (op === 'internal.inbox.post') {
          // The assistant's reply write (spec 328 §5). `from`/`actor` are PINNED server-side to
          // the person principal (buildAssistantInboxReply); the caller supplies only
          // { conversationId, bodyText } — it cannot author as anyone, and the counterparty comes
          // from the OWNER'S OWN two-party descriptor, never the wire. Counterparty copy FIRST,
          // fail-closed; disable wins races (config re-read here).
          const conversationId = String(body.conversationId ?? '');
          const bodyText = String(body.bodyText ?? '').trim();
          if (!conversationId || !bodyText) return json({ error: 'conversationId + bodyText required' }, 400);
          const audit = buildAuditSink(this.env);
          const internalSecret = this.env.A2A_CUSTODY_BRIDGE_SECRET ?? '';
          return this.serialize(async () => { // ARCH-H1 — same single-writer merge as every inbox mutation
            const cfg = await this.readDoc<PersonAssistantV1 | null>(g, PERSON_ASSISTANT_RESOURCE, null);
            if (!cfg?.enabled) return json({ error: 'assistant is not enabled for this inbox' }, 409);
            const dg = st0.deliveryGrant;
            if (!dg) return json({ error: 'no delivery grant — enable inbox delivery for this agent first' }, 409);
            const doc = (await this.readDoc<Record<string, unknown>>(g, INBOX_RESOURCE, null as never)) ?? { version: 1, envelopes: [], events: [], draftCases: [], caseEvents: [], cards: {} };
            const personCaip = caip10(Number(this.env.CHAIN_ID ?? 84532), principal as Address) as MessageEnvelopeV1['from'];
            const built = await buildAssistantInboxReply(doc.conversations as ConversationDescriptorV1[] | undefined, { principal: personCaip, conversationId, bodyText });
            if (!built.ok) return json({ error: built.error }, 409);
            const { envelope, counterpartyAddr, bodyBytes } = built;
            // Counterparty copy FIRST, fail-closed (the sendFromInbox "recipient side first" rule):
            // the counterparty's DO performs both admissions with ITS OWN held wires — exactly the
            // pair of calls the a2a messaging.deliver skill makes. Their internal.deliver runs
            // THEIR assistant scan, which skips this envelope (actor set — loop closed).
            let bin = '';
            for (const b of bodyBytes) bin += String.fromCharCode(b);
            const stored = { b64: btoa(bin), contentType: 'text/plain', bodyHash: envelope.bodyHash };
            const stub = this.env.INTERACTIONS.get(this.env.INTERACTIONS.idFromName(counterpartyAddr));
            const callOther = async (cop: string, payload: unknown): Promise<void> => {
              const resp = await stub.fetch(new Request(`https://do/interactions/${counterpartyAddr}/${cop}`, {
                method: 'POST', headers: { 'content-type': 'application/json', 'x-ap-internal': internalSecret }, body: JSON.stringify(payload),
              }));
              const out = (await resp.json().catch(() => ({}))) as { ok?: boolean; error?: string };
              if (!resp.ok || out.ok === false) throw new Error(out.error ?? `${cop} failed (${resp.status})`);
            };
            await callOther('internal.dm.body.put', { resource: envelope.body.resource, data: stored });
            await callOther('internal.deliver', { envelope });
            // Own copy: body under the person's OWN delivery wire; envelope + 'sent' event under
            // the interactions grant (the sender's-copy half of sendFromInbox).
            await this.vaultFor(dg).write({ owner: '', resource: envelope.body.resource, data: stored, classification: 'internal' } as never);
            const envs = (doc.envelopes as MessageEnvelopeV1[] | undefined) ?? [];
            doc.envelopes = [...envs, envelope];
            const sent: MessageEventV1 = { version: 'ap.message.event.v1', messageId: envelope.id, actor: envelope.from, eventType: 'sent', at: envelope.createdAt };
            doc.events = [...((doc.events as unknown[] | undefined) ?? []), sent];
            await audit.write({ id: crypto.randomUUID(), timestamp: envelope.createdAt, action: 'interactions.inboxAssistant.post', outcome: 'success', actor: { type: 'service', id: principal }, subject: { type: 'message', id: envelope.id } });
            await this.writeDoc(g, INBOX_RESOURCE, doc);
            // Mark the reply seen — a later whole-doc diff never re-presents it (its actor marker
            // would skip anyway; this keeps the ledger honest).
            const seen = (await this.state.storage.get(INBOX_ASSISTANT_SEEN_KEY)) as string[] | undefined;
            if (seen) await this.state.storage.put(INBOX_ASSISTANT_SEEN_KEY, [...seen, envelope.id].slice(-INBOX_ASSISTANT_SEEN_CAP));
            return json({ ok: true, messageId: envelope.id });
          });
        }
        // ── spec 329 §3.2 — the consult turn's harness pre-read (in-Worker marker only): the
        // member's SKILL.md playbook (the spec-328 §4b record — ONE playbook governs auto-replies
        // AND consult answers) + their display name. Deliberately NOT gated on the auto-reply
        // assistant being enabled: consultability is its own opt-in (the delegation); the playbook
        // is guidance either way. Read-only; returns markdown + name, never bodies or mail.
        if (op === 'internal.consult.context') {
          const skill = await this.readDoc<AssistantSkillDocV1 | null>(g, PERSON_ASSISTANT_SKILL_RESOURCE, null);
          const cfg = await this.readDoc<PersonAssistantV1 | null>(g, PERSON_ASSISTANT_RESOURCE, null);
          return json({
            ok: true,
            ...(skill?.markdown?.trim() ? { skillMarkdown: skill.markdown } : {}),
            ...(cfg?.displayName ? { displayName: cfg.displayName } : {}),
          });
        }
        // ── spec 329 W2/W3 — the org's routing internal ops (in-Worker marker only). ──
        if (op === 'internal.consult.eligible') {
          // The `find_members` ELIGIBILITY read (spec 329 §4): roster ∩ topic participants ∩
          // consultable-hinted ∩ grant-present, computed HERE (the org's single-reader execution
          // point) with the fabric pure intersection — the planner never widens this set.
          const channelId = String(body.channelId ?? '');
          if (!channelId) return json({ error: 'channelId required' }, 400);
          const index = await this.readDoc<ChannelV1[]>(g, CONVERSATION_INDEX_RESOURCE, []);
          const entry = index.find((c) => c.descriptor.id === channelId);
          if (!entry) return json({ error: 'unknown channel' }, 404);
          const routing = entry.routing;
          const wireRec = (await this.state.storage.get(ROUTING_ORG_WIRE_KEY)) as RoutingOrgWireRecord | undefined;
          if (!routing || !entry.assistant || !wireRec) {
            return json({ ok: true, enabled: false, maxFanout: 0, members: [] });
          }
          const now = new Date().toISOString();
          const rows = await this.readDoc<IndexedListing[]>(g, DIRECTORY_RESOURCE, []);
          const roster: ConsultRosterRowV1[] = rows.map((l) => ({
            subject: l.listing.subject,
            displayName: l.listing.displayName || l.label,
            consultable: l.listing.consultable === true,
            // spec 329 §12 — the member's self-asserted primary role in THIS org, straight from
            // their signed listing (never derived, never steward-set).
            ...(l.listing.orgRole?.trim() ? { orgRole: l.listing.orgRole.trim() } : {}),
            current: isListingCurrent(l.listing, now),
          }));
          const grantKeys = await this.state.storage.list({ prefix: consultGrantRecordKey('') });
          const grantMembers = [...grantKeys.keys()].map((k) => k.slice(consultGrantRecordKey('').length));
          const members = eligibleConsultMembers({ roster, channel: entry, grantMembers, orgSA: principal });
          return json({ ok: true, enabled: true, maxFanout: routing.maxFanout, members });
        }
        if (op === 'internal.consult.orgWire') {
          // The §3.1 wire, handed ONLY in-Worker to the org's own A2aTaskDO (the routing signer).
          const wireRec = (await this.state.storage.get(ROUTING_ORG_WIRE_KEY)) as RoutingOrgWireRecord | undefined;
          if (!wireRec) return json({ ok: true, wire: null });
          return json({ ok: true, wire: wireRec.wire, sessionKey: wireRec.sessionKey });
        }
        if (op === 'internal.consult.grant') {
          // ask_member's SEND-TIME grant re-read (spec 329 §8 stale-opt-in rule): the wire is
          // fetched fresh per send AND per turn-2 collection — a member whose grant row is gone is
          // dropped/marked revoked immediately, before the member's own gate would even be asked.
          const member = String(body.member ?? '').toLowerCase();
          if (!/^0x[0-9a-f]{40}$/.test(member)) return json({ error: 'member (address) required' }, 400);
          const rec = (await this.state.storage.get(consultGrantRecordKey(member))) as { wire?: IncomingDelegation } | undefined;
          return json({ ok: true, wire: rec?.wire ?? null });
        }
        if (op === 'invite.get' || op === 'invite.put') {
          // spec 323 W3.2 — the org's invite records (`org.invite:*`) read/written via the DO-held
          // delivery wire (its r+w scope covers org.invite); replaces orgVault's KV-wire transport so
          // the Home stores no org wire either. Namespace-pinned belt to the wire's own record scope.
          const dg = st0.deliveryGrant;
          if (!dg) return json({ error: 'no delivery grant — enable storage for this org first' }, 409);
          const resource = String(body.resource ?? '');
          if (!resource.startsWith('org.invite:')) return json({ error: 'org.invite resources only' }, 400);
          if (op === 'invite.get') {
            const r = await this.vaultFor(dg).read<unknown>({ owner: '', resource });
            return json({ ok: true, record: r?.data ?? null });
          }
          if (body.data === undefined) return json({ error: 'data required' }, 400);
          await this.vaultFor(dg).write({ owner: '', resource, data: body.data, classification: 'internal' } as never);
          return json({ ok: true });
        }
        if (op === 'dm.body.put' || op === 'internal.dm.body.put') {
          // spec 323 W3 — dm body WRITE via the DO-held DELIVERY wire (the only wire scoped to write
          // dm bodies). `dm.body.put` = the Home's split-plane writer over the bridge; the in-Worker
          // `internal.dm.body.put` is the a2a deliver skill. dm-namespace pinned (belt to the wire's
          // own write-only record scope).
          const dg = st0.deliveryGrant;
          if (!dg) return json({ error: 'no delivery grant — enable inbox delivery for this agent first' }, 409);
          const resource = String(body.resource ?? '');
          if (!resource.startsWith(DM_BODY_PREFIX)) return json({ error: 'dm body resources only' }, 400);
          if (body.data === undefined) return json({ error: 'data required' }, 400);
          // DM-BODY-OVERWRITE-1 — the resource id is sender-controlled beyond the dm: prefix and the write is
          // last-writer-wins. A sender who knows an existing message id could overwrite that slot with a body
          // whose hash no longer matches the persisted envelope's bodyHash → the recipient's loadBody sees a
          // hash mismatch and silently drops the message (per-message censorship). DM bodies are write-once:
          // reject an overwrite whose bodyHash differs (an idempotent same-hash re-delivery still succeeds).
          const incomingHash = (body.data as { bodyHash?: string } | null)?.bodyHash;
          // The write-once guard READS the existing body — but the DELIVERY grant (dg) is WRITE-ONLY on dm
          // bodies (record scope `message.body:dm:*` : write), so reading with it is record_scope_denied and
          // NO dm ever writes. Read via the INTERACTIONS grant instead (st0.grant carries `message.body:dm:*`
          // : read); the delivery grant still performs the WRITE. Participants enable both planes together,
          // so require the interactions grant here and fail CLOSED if absent (ADR-0013 — never silently permit
          // an overwrite). `read` returns null only for a genuine-absent body (bounded-retries transients,
          // throws on auth/decrypt failure), so a real failure fails the write closed.
          const readGrant = st0.grant;
          if (!readGrant) return json({ error: 'interactions grant required to verify dm body write-once — enable messaging for this agent' }, 409);
          const existing = await this.vaultFor(readGrant).read<{ bodyHash?: string }>({ owner: '', resource });
          if (existing?.data?.bodyHash && incomingHash && existing.data.bodyHash !== incomingHash) {
            return json({ error: 'dm body already exists with a different hash — bodies are write-once' }, 409);
          }
          await this.vaultFor(dg).write({ owner: '', resource, data: body.data, classification: 'internal' } as never);
          return json({ ok: true });
        }
        if (op === 'controlevents.append') {
          // spec 323 W2.3 — the person's portable control-plane timeline (`control-events.data`),
          // append-only under the single writer. Server flows (inbox decisions, manifest publish)
          // append via the SEC-010 bridge; the person READS their own via record.get (session-gated).
          const event = body.event;
          if (event === undefined || event === null) return json({ error: 'event required' }, 400);
          return this.serialize(async () => { // ARCH-H1 — serialize the timeline append (many server flows)
            const rows = await this.readDoc<unknown[]>(g, CONTROL_EVENTS_RESOURCE, []);
            rows.push(event);
            await this.writeDoc(g, CONTROL_EVENTS_RESOURCE, rows.slice(-CONTROL_EVENTS_CAP));
            return json({ ok: true });
          });
        }
        // internal.deliver — append-only merge of a validated envelope (the skill already verified
        // addressing + bodyHash and persisted the body under the delivery grant).
        const envelope = body.envelope as MessageEnvelopeV1 | undefined;
        if (!envelope?.id) return json({ error: 'envelope required' }, 400);
        return this.serialize(async () => { // ARCH-H1 — serialize the inbox merge (many senders → one inbox)
          const doc = (await this.readDoc<Record<string, unknown>>(g, INBOX_RESOURCE, null as never)) ?? { version: 1, envelopes: [], events: [], draftCases: [], caseEvents: [], cards: {} };
          const envs = (doc.envelopes as MessageEnvelopeV1[] | undefined) ?? [];
          if (!envs.some((e) => e.id === envelope.id)) {
            doc.envelopes = [...envs, envelope];
            doc.events = [
              ...((doc.events as unknown[] | undefined) ?? []),
              { version: 'ap.message.event.v1', messageId: envelope.id, actor: envelope.from, eventType: 'delivered', at: new Date().toISOString() },
            ];
            await this.writeDoc(g, INBOX_RESOURCE, doc);
            // spec 328 §3 — post-commit assistant scan (the A2A ingress). Queued behind this
            // serialize slot, NOT awaited (we hold the mutex); never affects this response.
            this.queueInboxAssistantScan(principal, doc.envelopes as MessageEnvelopeV1[]);
          }
          return json({ ok: true, messageId: envelope.id });
        });
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 409);
      }
    }

    // ── Skills — caller = broker-verified Home session (any principal kind), OR a REGISTERED relying
    // app's OIDC id_token. A relying app (e.g. uupg) drives these ops directly over the standard a2a
    // path with the id_token it holds — NOT a Home session (its aud is a client_id, not DEMO_SSO_AUD),
    // so verifyHomeSession is tried first and verifyRelyingIdToken second. Both resolve to the person's
    // SA; AUTHORIZATION is still enforced below by the on-chain steward/member gate. ──
    let gate = await verifyHomeSession(String(body.session ?? ''), this.env);
    if (!gate.ok) {
      const relying = await verifyRelyingIdToken(String(body.session ?? ''), this.env);
      if (relying.ok) gate = relying;
    }
    if (!gate.ok) return json({ error: gate.error }, gate.status);
    const sessionSa = gate.sa;
    const sessionCaip = gate.caip;

    const st = ((await this.state.storage.get('state')) ?? {}) as StoredState;
    const grant = st.grant;
    if (!grant) return json({ error: 'no interactions grant — a steward must enable storage for this agent' }, 409);
    if (!this.grantIsCurrent(grant)) return json({ error: 'interactions grant is stale — a steward must re-enable storage (scope widened this wave)' }, 409);
    const audit = buildAuditSink(this.env);

    try {
      if (op === 'directory.publish') {
        const listing = body.listing as DirectoryListingV1 | undefined;
        if (!listing) return json({ error: 'listing required' }, 400);
        const errors = validateDirectoryListing(listing);
        if (errors.length > 0) return json({ error: `invalid listing: ${errors.join(', ')}` }, 400);
        if (listing.subject.toLowerCase() !== sessionCaip.toLowerCase()) {
          // A steward publishing ANOTHER subject's ORG listing (spec 313 §4 Networks): the presented
          // stewardship wire must be delegated BY the listing subject to the session SA.
          const subjAddr = listing.subject.match(/0x[0-9a-fA-F]{40}$/)?.[0];
          const w = body.subjectStewardship as IncomingDelegation | undefined;
          const ok = !!subjAddr && (await this.isSteward(subjAddr, sessionSa, w));
          if (!ok) return json({ error: 'listing subject must be the session principal (or present its stewardship wire)' }, 403);
          // DIR-INJECT-1 — proving you steward the SUBJECT is NOT enough: `principal` here is the DIRECTORY
          // OWNER (this org shard) and `listing.context.id`/communityId is caller-chosen, so without this
          // check any steward of any org could inject their org's card into an arbitrary victim org's
          // membership index (the doc `memberName` trusts) — the SEC-H1 self-publish gate reached through the
          // cross-subject branch. The directory OWNER must also have authorized this caller.
          const ownerAuthorized =
            (await this.isSteward(principal, sessionSa, body.stewardship as IncomingDelegation | undefined)) ||
            (await this.hasMemberAccess(principal, sessionSa, body.memberAccess as IncomingDelegation | undefined));
          if (!ownerAuthorized) return json({ error: 'this organization has not authorized you to publish listings into its directory' }, 403);
        } else {
          // SELF-publish (join / update own listing). SEC-H1: a self-signed listing is NOT enough —
          // the ORG must have authorized this member. Require the org→you member-access grant (from an
          // invite), OR prove you steward this org (the creator's / steward's own self-card).
          const authorized =
            (await this.hasMemberAccess(principal, sessionSa, body.memberAccess as IncomingDelegation | undefined)) ||
            (await this.isSteward(principal, sessionSa, body.stewardship as IncomingDelegation | undefined));
          if (!authorized) return json({ error: 'this organization has not authorized you to join — an invite (member-access grant) or stewardship is required' }, 403);
        }
        const { proof, ...draft } = listing;
        const digest = await sha256Hex32(canonicalizeMessage(draft));
        const proofSubject = (listing.subject.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? sessionSa) as Address;
        if (!(await this.erc1271(proofSubject, digest as Hex, proof.signature as Hex))) return json({ error: 'listing signature failed ERC-1271 verification' }, 403);
        // DIR-INJECT-1 — the replay/tombstone/dedup key is the LISTING SUBJECT, not the caller session. For a
        // self-publish these are equal; for a steward-of-subject publish they differ, and keying on the caller
        // let a tombstoned (subject-keyed) listing be re-injected and duplicate subject rows accumulate.
        const me = listing.subject.toLowerCase();
        // NEW-M1 (ARCH-H1 residual) — the directory doc + st.subjects RMW is a shared-doc write across
        // concurrent joins; serialize it (re-reading both inside the lock) so two simultaneous joins can't
        // lost-update each other's listing. The expensive ERC-1271 proof stays outside the lock.
        return this.serialize(async () => {
          const fresh = ((await this.state.storage.get('state')) ?? {}) as StoredState;
          // Replay guard: monotonic publishedAt per subject; publishing clears any tombstone (rejoin).
          const prev = fresh.subjects?.[me]?.publishedAt;
          if (prev && Date.parse(listing.publishedAt) <= Date.parse(prev)) return json({ error: 'stale listing (publishedAt must be monotonic)' }, 409);
          const rows = (await this.readDoc<IndexedListing[]>(grant, DIRECTORY_RESOURCE, [])).filter((l) => l.listing.subject.toLowerCase() !== me);
          rows.push({ listing, label: String(body.label ?? '') });
          await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.directory.publish', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'listing', id: me } });
          await this.writeDoc(grant, DIRECTORY_RESOURCE, rows);
          fresh.subjects = { ...(fresh.subjects ?? {}), [me]: { publishedAt: listing.publishedAt } };
          await this.state.storage.put('state', fresh);
          return json({ ok: true });
        });
      }

      if (op === 'directory.revoke') {
        const me = sessionCaip.toLowerCase();
        const rows = (await this.readDoc<IndexedListing[]>(grant, DIRECTORY_RESOURCE, [])).filter((l) => l.listing.subject.toLowerCase() !== me);
        await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.directory.revoke', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'listing', id: me } });
        await this.writeDoc(grant, DIRECTORY_RESOURCE, rows);
        st.subjects = { ...(st.subjects ?? {}), [me]: { publishedAt: st.subjects?.[me]?.publishedAt ?? new Date().toISOString(), tombstoned: true } };
        await this.state.storage.put('state', st);
        return json({ ok: true });
      }

      if (op === 'directory.remove') {
        // STEWARD removal of another member's listing (spec 321 W3 continuity under the DO): the
        // caller presents the stewardship wire; the subject's listing is dropped + tombstoned so a
        // replayed old listing cannot re-enter (spec 322 §4).
        const steward = await this.isSteward(principal, sessionSa, body.stewardship as IncomingDelegation | undefined);
        if (!steward) return json({ error: 'stewardship proof required' }, 403);
        const subject = String(body.subject ?? '').toLowerCase();
        if (!subject) return json({ error: 'subject required' }, 400);
        const rows = (await this.readDoc<IndexedListing[]>(grant, DIRECTORY_RESOURCE, [])).filter((l) => !l.listing.subject.toLowerCase().endsWith(subject));
        await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.directory.remove', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'listing', id: subject } });
        await this.writeDoc(grant, DIRECTORY_RESOURCE, rows);
        const key = Object.keys(st.subjects ?? {}).find((k) => k.endsWith(subject)) ?? subject;
        st.subjects = { ...(st.subjects ?? {}), [key]: { publishedAt: st.subjects?.[key]?.publishedAt ?? new Date().toISOString(), tombstoned: true } };
        await this.state.storage.put('state', st);
        return json({ ok: true });
      }

      if (op === 'directory.list') {
        const name = await this.memberName(grant, principal, sessionCaip);
        const steward = await this.isSteward(principal, sessionSa, body.stewardship as IncomingDelegation | undefined);
        if (!name && !steward) return json({ error: 'join this community first — publish a directory listing to enter' }, 403);
        const now = new Date().toISOString();
        const rows = (await this.readDoc<IndexedListing[]>(grant, DIRECTORY_RESOURCE, [])).filter((l) => isListingCurrent(l.listing, now));
        return json({ ok: true, listings: rows });
      }

      if (op === 'channels.list' || op === 'channels.read') {
        const name = await this.memberName(grant, principal, sessionCaip);
        const steward = await this.isSteward(principal, sessionSa, body.stewardship as IncomingDelegation | undefined);
        if (!name && !steward) return json({ error: 'join this community first — publish a directory listing to enter its channels' }, 403);
        // Conversation/topic split (§10): descriptors from conversation.index; ONE topic's messages from its own doc.
        const index = await this.readDoc<ChannelV1[]>(grant, CONVERSATION_INDEX_RESOURCE, []);
        const bodies: Record<string, string> = {};
        // Topic participation: a viewer (an org MEMBER — the gate above) sees every OPEN topic plus only the
        // RESTRICTED topics they PARTICIPATE in (steward/custodian sees all). Legacy `visibility` records are
        // mapped to participationPolicy on read (public→open, private→restricted) — lazy, no data migration.
        let wire = index
          .filter((c) => canSeeChannel(c, sessionSa, steward))
          .map((c) => ({ ...c, participationPolicy: channelParticipationPolicy(c), messages: [] as { envelope: MessageEnvelopeV1; authorName: string }[] }));
        if (op === 'channels.read' && typeof body.channelId === 'string') {
          const messages = await this.readDoc<{ envelope: MessageEnvelopeV1; authorName: string }[]>(grant, TOPIC_RESOURCE(body.channelId), []);
          wire = wire.map((c) => (c.descriptor.id === body.channelId ? { ...c, messages } : c));
          // Bodies load at the envelope's OWN resource (channel namespace) — never re-normalized.
          // ONE batched round-trip for the whole topic (was one delegated read PER MESSAGE — the
          // O(board size) per-poll amplification behind the 2026-07-18 "auth failed" regression).
          Object.assign(bodies, await this.readTopicBodies(grant, messages.map((m) => m.envelope)));
        }
        return json({ ok: true, channels: wire, bodies, you: name ?? 'Steward', steward });
      }

      if (op === 'channels.create') {
        const name = await this.memberName(grant, principal, sessionCaip);
        const steward = await this.isSteward(principal, sessionSa, body.stewardship as IncomingDelegation | undefined);
        if (!name && !steward) return json({ error: 'join this community first — publish a directory listing to enter its channels' }, 403);
        // Participation policy: `open` (every org member participates — derived, no stored list) or
        // `restricted` (invite-only). Legacy callers still say visibility public/private. Any member may
        // create an OPEN topic; creating a RESTRICTED one is a facilitator act — steward/custodian only.
        const restricted = body.participationPolicy === 'restricted' || body.visibility === 'private';
        if (restricted && !steward) return json({ error: 'only the organization custodian may create a restricted topic (facilitators are then invited per topic)' }, 403);
        return this.serialize(async () => { // ARCH-H1 — the conversation.index RMW is a shared-doc write; serialize it too
          const index = await this.readDoc<ChannelV1[]>(grant, CONVERSATION_INDEX_RESOURCE, []);
          const r = createBoardChannel(index, {
            contextId: principal, owner: sessionCaip as ChannelV1['descriptor']['owner'], title: String(body.title ?? ''), createdBy: name ?? 'Steward',
            participationPolicy: restricted ? 'restricted' : 'open',
            members: Array.isArray(body.members) ? (body.members as unknown[]).map((m) => String(m)) : [],
            creatorSa: sessionSa,
          });
          if (!r.ok) return json({ error: r.error }, r.error.includes('already exists') ? 409 : 400);
          if (restricted) {
            // The creator is the topic's first FACILITATOR — an asserted participation (self-accepted;
            // the creation ceremony is its own consent). Seeds the situation doc the ops below extend.
            const now = new Date().toISOString();
            const rows: DiscussionParticipationRowV1[] = [{
              personSA: sessionSa.toLowerCase(), ...(name ? { personName: name } : {}), role: 'facilitator',
              situationRef: `sit_dp_${crypto.randomUUID()}`, invitationRef: 'creator', acceptedAt: now, status: 'active',
            }];
            await this.writeDoc(grant, TOPIC_PARTICIPATION_RESOURCE(r.channel.descriptor.id), rows);
          }
          await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.channels.create', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'channel', id: r.channel.descriptor.id } });
          await this.writeDoc(grant, CONVERSATION_INDEX_RESOURCE, index); // index holds descriptors only (messages stay [])
          return json({ ok: true, channelId: r.channel.descriptor.id });
        });
      }

      if (op === 'channels.post') {
        const name = await this.memberName(grant, principal, sessionCaip);
        // A listed member posts as themselves; the community's STEWARD may also post (they administer it),
        // authored as "Steward" — mirrors the list/read/create gate and the `you: name ?? 'Steward'` label.
        const posterSteward = name ? false : await this.isSteward(principal, sessionSa, body.stewardship as IncomingDelegation | undefined);
        if (!name && !posterSteward) return json({ error: 'join this community first — publish a directory listing to enter its channels' }, 403);
        // Board split (W3): only the ONE channel doc is read + rewritten — same-channel conflicts only.
        const channelId = String(body.channelId ?? '');
        return this.serialize(async () => { // ARCH-H1 — serialize the channel append (many members → one channel doc)
          const index = await this.readDoc<ChannelV1[]>(grant, CONVERSATION_INDEX_RESOURCE, []);
          const entry = index.find((c) => c.descriptor.id === channelId);
          if (!entry) return json({ error: 'unknown channel' }, 404);
          // Post gate: OPEN topic ⇒ the org-member gate above suffices (participation is derived from
          // membership). RESTRICTED topic ⇒ only its PARTICIPANTS post — the members[] projection of the
          // accepted DiscussionParticipation situations (the steward/custodian facilitates every topic).
          if (!canSeeChannel(entry, sessionSa, posterSteward)) return json({ error: 'not a participant of this restricted topic — ask a facilitator for an invitation' }, 403);
          const messages = await this.readDoc<{ envelope: MessageEnvelopeV1; authorName: string }[]>(grant, TOPIC_RESOURCE(channelId), []);
          const composed: ChannelV1[] = [{ ...entry, messages }];
          const r = await appendBoardPost(composed, { channelId, from: sessionCaip as MessageEnvelopeV1['from'], authorName: name ?? 'Steward', bodyText: String(body.bodyText ?? '') });
          if (!r.ok) return json({ error: r.error }, r.error === 'unknown channel' ? 404 : 400);
          await audit.write({ id: crypto.randomUUID(), timestamp: r.envelope.createdAt, action: 'interactions.channels.post', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'channel-post', id: r.envelope.id } });
          const store = createVaultMessageBodyStore(this.vaultFor(grant), principal);
          // Channel bodies live in the CHANNEL namespace (the envelope's own resource — closes FAB-SSO-2).
          await store.putBody({ messageId: r.envelope.id, bytes: new TextEncoder().encode(String(body.bodyText ?? '').trim()), contentType: 'text/plain', classification: 'internal', resource: r.envelope.body.resource });
          await this.writeDoc(grant, TOPIC_RESOURCE(channelId), composed[0]!.messages);
          // spec 327 §3 — post-commit assistant trigger: fire-and-forget AFTER the member's post is
          // durable; a failed/limited dispatch is audited + dropped, never affecting this response.
          if (assistantTrigger(entry, { from: sessionCaip as MessageEnvelopeV1['from'], bodyText: String(body.bodyText ?? '') })) {
            this.dispatchAssistant({ entry, channelId, principal, triggerAuthor: name ?? 'Steward', triggerBody: String(body.bodyText ?? '').trim() });
          }
          return json({ ok: true, messageId: r.envelope.id });
        });
      }

      // ── spec 327 §4b — the org's assistant PLAYBOOK (Agent Skill package / SKILL.md projection):
      //    steward-authored markdown that becomes the LLM planner's system prompt. Org-level (one doc,
      //    all topics); the must-post contract stays STRUCTURAL (single tool) regardless of its text. ──
      if (op === 'channels.assistantSkill.get' || op === 'channels.assistantSkill.put') {
        const steward = await this.isSteward(principal, sessionSa, body.stewardship as IncomingDelegation | undefined);
        if (!steward) return json({ error: 'only the organization custodian may author the assistant playbook' }, 403);
        if (op === 'channels.assistantSkill.get') {
          const doc = await this.readDoc<AssistantSkillDocV1 | null>(grant, ASSISTANT_SKILL_RESOURCE, null);
          return json({ ok: true, skill: doc });
        }
        const markdown = String(body.markdown ?? '');
        if (markdown.length > ASSISTANT_SKILL_MAX_CHARS) return json({ error: `playbook too long (max ${ASSISTANT_SKILL_MAX_CHARS} chars)` }, 400);
        const doc: AssistantSkillDocV1 = { version: 'ap.assistant-skill.v1', markdown, updatedBy: sessionSa.toLowerCase(), updatedAt: new Date().toISOString() };
        await audit.write({ id: crypto.randomUUID(), timestamp: doc.updatedAt, action: 'interactions.channels.assistantSkillPut', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'assistant-skill', id: principal } });
        await this.writeDoc(grant, ASSISTANT_SKILL_RESOURCE, doc);
        return json({ ok: true });
      }

      // ── spec 327 — the org assistant on a topic (318 §8.1: the org's OWN agent, steward-enabled). ──
      if (op === 'channels.assistantEnable' || op === 'channels.assistantDisable') {
        const steward = await this.isSteward(principal, sessionSa, body.stewardship as IncomingDelegation | undefined);
        if (!steward) return json({ error: 'only the organization custodian may manage the topic assistant' }, 403);
        const channelId = String(body.channelId ?? '');
        if (!channelId) return json({ error: 'channelId required' }, 400);
        if (op === 'channels.assistantDisable') {
          return this.serialize(async () => { // conversation.index RMW — same single-writer rule as create
            const index = await this.readDoc<ChannelV1[]>(grant, CONVERSATION_INDEX_RESOURCE, []);
            const r = setTopicAssistant(index, channelId, undefined);
            if (!r.ok) return json({ error: r.error }, 404);
            await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.channels.assistantDisable', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'channel', id: channelId } });
            await this.writeDoc(grant, CONVERSATION_INDEX_RESOURCE, index);
            return json({ ok: true });
          });
        }
        const trigger: TopicAssistantV1['trigger'] = body.trigger === 'all' ? 'all' : 'mention';
        // Capture the org's primary name ONCE at enable time (ADR-0012: one reverseResolveString view
        // call; re-enabling refreshes after a name rotation). A resolver failure fails the ceremony
        // closed — it never silently enables a nameless assistant (ADR-0013).
        let primaryName: string | null = null;
        if (this.env.RPC_URL && this.env.AGENT_NAME_REGISTRY && this.env.AGENT_NAME_UNIVERSAL_RESOLVER) {
          try {
            primaryName = await new AgentNamingClient({
              rpcUrl: this.env.RPC_URL,
              chainId: Number(this.env.CHAIN_ID ?? 84532),
              registry: this.env.AGENT_NAME_REGISTRY as Address,
              universalResolver: this.env.AGENT_NAME_UNIVERSAL_RESOLVER as Address,
            }).reverseResolve(principal as Address);
          } catch (e) {
            return json({ error: `could not resolve the organization's primary name: ${e instanceof Error ? e.message : String(e)}` }, 502);
          }
        }
        const mentionHandle = primaryName ? (primaryName.split('.')[0] ?? '').toLowerCase() : '';
        const displayName = primaryName ?? String(body.displayName ?? '').trim();
        if (trigger === 'mention' && !mentionHandle) return json({ error: 'this organization has no primary name to mention — set one first, or enable the assistant with trigger "all"' }, 409);
        if (!displayName) return json({ error: 'displayName required when the organization has no primary name' }, 400);
        return this.serialize(async () => {
          const index = await this.readDoc<ChannelV1[]>(grant, CONVERSATION_INDEX_RESOURCE, []);
          const r = setTopicAssistant(index, channelId, { trigger, mentionHandle, displayName, enabledBy: sessionSa.toLowerCase(), enabledAt: new Date().toISOString() });
          if (!r.ok) return json({ error: r.error }, r.error === 'unknown channel' ? 404 : 400);
          await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.channels.assistantEnable', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'channel', id: channelId } });
          await this.writeDoc(grant, CONVERSATION_INDEX_RESOURCE, index);
          return json({ ok: true, assistant: r.channel.assistant });
        });
      }

      // ── spec 329 §3.1/§7 — steward member-routing ceremony + per-topic toggle. The ENABLE mints
      //    (first time) the DO-held ORG consult wire: org → the interactions-session KMS key,
      //    consult-selector-only, steward-signed with the org's custody credential — the runtime's
      //    authority to SIGN consult-rail messages as the org (no raw key at rest). Disable clears
      //    the topic flag immediately (and optionally the wire) + cancels pending consults. ──
      if (op === 'consult.routingEnable' || op === 'consult.routingDisable' || op === 'consult.routingStatus') {
        const steward = await this.isSteward(principal, sessionSa, body.stewardship as IncomingDelegation | undefined);
        if (!steward) return json({ error: 'only the organization custodian may manage member routing' }, 403);
        if (op === 'consult.routingStatus') {
          const wireRec = (await this.state.storage.get(ROUTING_ORG_WIRE_KEY)) as RoutingOrgWireRecord | undefined;
          // The session-key address the CLIENT needs to mint the wire (the NEW-C1 key, §3.1 pairing).
          let sessionKey: string | null = null;
          try { sessionKey = (await interactionsSessionAccount(this.env)).address; } catch { /* unprovisioned ⇒ null */ }
          return json({ ok: true, wirePresent: !!wireRec, enabledAt: wireRec?.enabledAt ?? null, sessionKey });
        }
        const channelId = String(body.channelId ?? '');
        if (!channelId) return json({ error: 'channelId required' }, 400);
        if (op === 'consult.routingDisable') {
          return this.serialize(async () => {
            const index = await this.readDoc<ChannelV1[]>(grant, CONVERSATION_INDEX_RESOURCE, []);
            const r = setTopicRouting(index, channelId, undefined);
            if (!r.ok) return json({ error: r.error }, 404);
            await this.writeDoc(grant, CONVERSATION_INDEX_RESOURCE, index);
            if (body.clearWire === true) await this.state.storage.delete(ROUTING_ORG_WIRE_KEY);
            // Steward disable = immediate: pending consults for this topic are cancelled at the
            // org's task runtime (in-Worker, marker-gated). Best-effort — the turn-2 poller also
            // re-checks the wire/flag and drops on absence (belt to this suspender).
            try {
              const stub = this.env.A2A_TASKS.get(this.env.A2A_TASKS.idFromName(principal));
              await stub.fetch(new Request(`https://do/internal/routing-cancel?agent=${principal}`, {
                method: 'POST', headers: { 'content-type': 'application/json', 'x-ap-internal': this.env.A2A_CUSTODY_BRIDGE_SECRET ?? '' },
                body: JSON.stringify({ channelId }),
              }));
            } catch { /* audited by the poller's own drop path */ }
            await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.routing.disable', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'channel', id: channelId } });
            return json({ ok: true });
          });
        }
        // consult.routingEnable — verify + custody the wire (when supplied / first enable), then flag the topic.
        const wireRec = (await this.state.storage.get(ROUTING_ORG_WIRE_KEY)) as RoutingOrgWireRecord | undefined;
        const incoming = body.delegation as IncomingDelegation | undefined;
        if (!wireRec && !incoming) return json({ error: 'org consult wire required — the routing ceremony signs it first' }, 400);
        if (incoming) {
          if (incoming.delegator.toLowerCase() !== principal) return json({ error: 'org consult wire delegator must be this organization' }, 400);
          // Delegate MUST be the interactions-session KMS key (the §3.1 pairing) — fail-closed if unprovisioned.
          let sessionKey: string;
          try { sessionKey = (await interactionsSessionAccount(this.env)).address.toLowerCase(); } catch {
            return json({ error: 'interactions-session KMS key unprovisioned — routing needs GCP_KMS_INTERACTIONS_KEY_NAME' }, 503);
          }
          if (incoming.delegate.toLowerCase() !== sessionKey) return json({ error: 'org consult wire delegate must be the interactions-session key' }, 400);
          const tsEnf = (this.env.TIMESTAMP_ENFORCER ?? '').toLowerCase();
          const amEnf = (this.env.ALLOWED_METHODS_ENFORCER ?? '').toLowerCase();
          if (![tsEnf, amEnf].every((a) => /^0x[0-9a-f]{40}$/.test(a))) return json({ error: 'consult enforcers not configured — cannot verify the wire shape' }, 503);
          const shapeErr = checkConsultWireShape(incoming, { timestamp: tsEnf, allowedMethods: amEnf }, Math.floor(Date.now() / 1000));
          if (shapeErr) return json({ error: shapeErr }, 400);
          const d: Delegation = { ...incoming, salt: BigInt(incoming.salt), caveats: incoming.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: (c.args ?? '0x') as Hex })) } as Delegation;
          const digest = hashDelegation(d, Number(this.env.CHAIN_ID ?? 84532), this.env.DELEGATION_MANAGER as Address);
          if (!(await this.erc1271(incoming.delegator as Address, digest, incoming.signature as Hex))) {
            return json({ error: 'org consult wire signature failed verification against the organization' }, 403);
          }
          try {
            const revoked = (await this.pub().readContract({ address: this.env.DELEGATION_MANAGER as Address, abi: IS_REVOKED_ABI, functionName: 'isRevoked', args: [digest] })) as boolean;
            if (revoked) return json({ error: 'org consult wire is already revoked on-chain' }, 403);
          } catch { return json({ error: 'revocation check unavailable — wire not stored (fail-closed)' }, 503); }
          const rec: RoutingOrgWireRecord = { wire: incoming, hash: digest, sessionKey, enabledBy: sessionSa.toLowerCase(), enabledAt: new Date().toISOString() };
          await this.state.storage.put(ROUTING_ORG_WIRE_KEY, rec);
          st.ledger = [...(st.ledger ?? []), { hash: digest, delegate: sessionKey, resources: ['(routing:consult-sign)'], storedAt: rec.enabledAt }].slice(-50);
          await this.state.storage.put('state', st);
        }
        const rawFanout = Number(body.maxFanout ?? ROUTING_FANOUT_DEFAULT);
        return this.serialize(async () => {
          const index = await this.readDoc<ChannelV1[]>(grant, CONVERSATION_INDEX_RESOURCE, []);
          const r = setTopicRouting(index, channelId, { maxFanout: rawFanout, enabledBy: sessionSa.toLowerCase(), enabledAt: new Date().toISOString() });
          if (!r.ok) return json({ error: r.error }, r.error === 'unknown channel' ? 404 : 409);
          await this.writeDoc(grant, CONVERSATION_INDEX_RESOURCE, index);
          await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.routing.enable', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'channel', id: channelId } });
          return json({ ok: true, routing: r.channel.routing });
        });
      }

      // ── Topic participation ops (restricted topics; tbox/messaging.ttl §Topic participation) ──
      if (op === 'channels.participants' || op === 'channels.invite' || op === 'channels.acceptInvite' || op === 'channels.revokeParticipant') {
        const name = await this.memberName(grant, principal, sessionCaip);
        const steward = await this.isSteward(principal, sessionSa, body.stewardship as IncomingDelegation | undefined);
        if (!name && !steward) return json({ error: 'join this community first — publish a directory listing to enter its channels' }, 403);
        const channelId = String(body.channelId ?? '');
        if (!channelId) return json({ error: 'channelId required' }, 400);
        const index = await this.readDoc<ChannelV1[]>(grant, CONVERSATION_INDEX_RESOURCE, []);
        const entry = index.find((c) => c.descriptor.id === channelId);
        if (!entry) return json({ error: 'unknown channel' }, 404);
        const policy = channelParticipationPolicy(entry);

        if (op === 'channels.participants') {
          if (!canSeeChannel(entry, sessionSa, steward)) return json({ error: 'not a participant of this restricted topic' }, 403);
          if (policy === 'open') {
            // OPEN ⇒ participation is DERIVED from org membership — render the org directory, never a
            // stored per-topic list (the aporg:memberOf doctrine).
            const now = new Date().toISOString();
            const rows = (await this.readDoc<IndexedListing[]>(grant, DIRECTORY_RESOURCE, [])).filter((l) => isListingCurrent(l.listing, now));
            return json({ ok: true, policy, participants: rows.map((l) => ({ personSA: l.listing.subject.toLowerCase().match(/0x[0-9a-f]{40}$/)?.[0] ?? l.listing.subject.toLowerCase(), personName: l.label, role: 'contributor', derived: true })) });
          }
          const rows = await this.readDoc<DiscussionParticipationRowV1[]>(grant, TOPIC_PARTICIPATION_RESOURCE(channelId), []);
          const invites = (await this.readDoc<DiscussionInvitationRowV1[]>(grant, DISCUSSION_INVITATIONS_RESOURCE, [])).filter((i) => i.topicId === channelId && i.status === 'invited');
          return json({ ok: true, policy, participants: rows.filter((r) => r.status === 'active'), pendingInvites: invites });
        }

        if (op === 'channels.acceptInvite') {
          // The INVITEE converts their invitation into a DiscussionParticipation situation. Serialize:
          // invitations doc + participation doc + descriptor projection are a multi-doc RMW.
          return this.serialize(async () => {
            const invites = await this.readDoc<DiscussionInvitationRowV1[]>(grant, DISCUSSION_INVITATIONS_RESOURCE, []);
            const inv = invites.find((i) => i.topicId === channelId && i.invitedAgent.toLowerCase() === sessionSa.toLowerCase() && i.status === 'invited');
            if (!inv) return json({ error: 'no pending invitation for you on this topic' }, 404);
            const now = new Date().toISOString();
            inv.status = 'accepted'; inv.decidedAt = now;
            const rows = (await this.readDoc<DiscussionParticipationRowV1[]>(grant, TOPIC_PARTICIPATION_RESOURCE(channelId), [])).filter((r) => r.personSA !== sessionSa.toLowerCase() || r.status !== 'active');
            rows.push({ personSA: sessionSa.toLowerCase(), ...(name ? { personName: name } : inv.invitedName ? { personName: inv.invitedName } : {}), role: inv.role, situationRef: `sit_dp_${crypto.randomUUID()}`, invitationRef: inv.id, acceptedAt: now, status: 'active' });
            // Refresh the members[] fast-ACL projection on the descriptor from the accepted participations.
            const fresh = await this.readDoc<ChannelV1[]>(grant, CONVERSATION_INDEX_RESOURCE, []);
            const fe = fresh.find((c) => c.descriptor.id === channelId);
            if (fe) { fe.members = [...new Set(rows.filter((r) => r.status === 'active').map((r) => r.personSA))]; await this.writeDoc(grant, CONVERSATION_INDEX_RESOURCE, fresh); }
            await this.writeDoc(grant, TOPIC_PARTICIPATION_RESOURCE(channelId), rows);
            await this.writeDoc(grant, DISCUSSION_INVITATIONS_RESOURCE, invites);
            await audit.write({ id: crypto.randomUUID(), timestamp: now, action: 'interactions.channels.accept-invite', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'discussion-participation', id: `${channelId}:${sessionSa.toLowerCase()}` } });
            return json({ ok: true, role: inv.role });
          });
        }

        // invite + revoke are FACILITATOR acts: the steward/custodian, or an active participant whose
        // discussion-scoped role is facilitator (the topic creator seeds that on restricted create).
        if (policy !== 'restricted') return json({ error: 'open topics have no invitations — every organization member already participates' }, 400);
        const partRows = await this.readDoc<DiscussionParticipationRowV1[]>(grant, TOPIC_PARTICIPATION_RESOURCE(channelId), []);
        const facilitator = steward || partRows.some((r) => r.personSA === sessionSa.toLowerCase() && r.status === 'active' && r.role === 'facilitator');
        if (!facilitator) return json({ error: 'only a facilitator of this topic (or the organization custodian) may manage its participants' }, 403);

        if (op === 'channels.invite') {
          const invitedAgent = String(body.personSA ?? '').toLowerCase();
          if (!/^0x[0-9a-f]{40}$/.test(invitedAgent)) return json({ error: 'personSA (0x address) required' }, 400);
          // Topic invitations select among EXISTING organization members only (a current directory
          // listing). Bringing a NEW person in is MEMBERSHIP enrollment (spec 324 §12) — never a topic act.
          const nowInv = new Date().toISOString();
          const roster = (await this.readDoc<IndexedListing[]>(grant, DIRECTORY_RESOURCE, [])).filter((l) => isListingCurrent(l.listing, nowInv));
          if (!roster.some((l) => l.listing.subject.toLowerCase().endsWith(invitedAgent))) {
            return json({ error: 'topic invitations are for existing organization members only — invite them to the organization first (membership enrollment)' }, 403);
          }
          const role: 'facilitator' | 'contributor' = body.role === 'facilitator' ? 'facilitator' : 'contributor';
          return this.serialize(async () => {
            const invites = await this.readDoc<DiscussionInvitationRowV1[]>(grant, DISCUSSION_INVITATIONS_RESOURCE, []);
            if (invites.some((i) => i.topicId === channelId && i.invitedAgent === invitedAgent && i.status === 'invited')) return json({ error: 'an invitation for this person is already pending' }, 409);
            if (partRows.some((r) => r.personSA === invitedAgent && r.status === 'active')) return json({ error: 'already a participant of this topic' }, 409);
            const inv: DiscussionInvitationRowV1 = {
              id: `dinv_${crypto.randomUUID()}`, topicId: channelId, invitedAgent,
              ...(body.personName ? { invitedName: String(body.personName) } : {}),
              invitedBy: sessionSa.toLowerCase(), ...(name ? { invitedByName: name } : {}),
              role, status: 'invited', createdAt: new Date().toISOString(),
            };
            invites.push(inv);
            await this.writeDoc(grant, DISCUSSION_INVITATIONS_RESOURCE, invites.slice(-500));
            await audit.write({ id: crypto.randomUUID(), timestamp: inv.createdAt, action: 'interactions.channels.invite', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'discussion-invitation', id: inv.id } });
            // The CALLER sends the invitee's Home-inbox message with the discussion-topic contextRef —
            // the DO records the invitation artifact only.
            return json({ ok: true, inviteId: inv.id, topicTitle: entry.title });
          });
        }

        // channels.revokeParticipant — facilitator removes a participant (or cancels a pending invite).
        const personSA = String(body.personSA ?? '').toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(personSA)) return json({ error: 'personSA (0x address) required' }, 400);
        return this.serialize(async () => {
          const now = new Date().toISOString();
          const rows = await this.readDoc<DiscussionParticipationRowV1[]>(grant, TOPIC_PARTICIPATION_RESOURCE(channelId), []);
          for (const r of rows) { if (r.personSA === personSA && r.status === 'active') { r.status = 'revoked'; r.revokedAt = now; } }
          const invites = await this.readDoc<DiscussionInvitationRowV1[]>(grant, DISCUSSION_INVITATIONS_RESOURCE, []);
          for (const i of invites) { if (i.topicId === channelId && i.invitedAgent === personSA && i.status === 'invited') { i.status = 'revoked'; i.decidedAt = now; } }
          const fresh = await this.readDoc<ChannelV1[]>(grant, CONVERSATION_INDEX_RESOURCE, []);
          const fe = fresh.find((c) => c.descriptor.id === channelId);
          if (fe) { fe.members = [...new Set(rows.filter((r) => r.status === 'active').map((r) => r.personSA))]; await this.writeDoc(grant, CONVERSATION_INDEX_RESOURCE, fresh); }
          await this.writeDoc(grant, TOPIC_PARTICIPATION_RESOURCE(channelId), rows);
          await this.writeDoc(grant, DISCUSSION_INVITATIONS_RESOURCE, invites);
          await audit.write({ id: crypto.randomUUID(), timestamp: now, action: 'interactions.channels.revoke-participant', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'discussion-participation', id: `${channelId}:${personSA}` } });
          return json({ ok: true });
        });
      }

      if (op === 'grants.list') {
        // Steward-or-self visibility into the issuance ledger (spec 322 W3e).
        const self = sessionSa.toLowerCase() === principal;
        const steward = self ? false : await this.isSteward(principal, sessionSa, body.stewardship as IncomingDelegation | undefined);
        if (!self && !steward) return json({ error: 'stewardship proof required' }, 403);
        return json({ ok: true, grants: st.ledger ?? [] });
      }

      // ── Person-plane ops (spec 322 W3d) — STRICTLY self: the session SA must BE the principal. ──
      if (op === 'relationships.get' || op === 'relationships.merge' || op === 'member.profile.put') {
        if (sessionSa.toLowerCase() !== principal) return json({ error: 'this record belongs to the principal — self access only' }, 403);
        if (op === 'relationships.get') {
          const doc = await this.readDoc<RelationshipsDocV1>(grant, RELATIONSHIPS_RESOURCE, { orgs: {} });
          return json({ ok: true, relationships: doc });
        }
        if (op === 'relationships.merge') {
          const entry = body.entry as Partial<RelationshipEntryV1> | undefined;
          const org = String(entry?.org ?? '').toLowerCase();
          if (!/^0x[0-9a-fA-F]{40}$/.test(org)) return json({ error: 'entry.org (address) required' }, 400);
          const doc = await this.readDoc<RelationshipsDocV1>(grant, RELATIONSHIPS_RESOURCE, { orgs: {} });
          if (body.remove === true) delete doc.orgs[org];
          else {
            const prev = doc.orgs[org];
            doc.orgs[org] = {
              org,
              // steward ⊇ member: a subsequent 'member' merge must NEVER downgrade an existing steward (spec
              // 324 W3 fix — recording the creator as a member was silently stripping their steward inbox
              // control, resolveInboxOwner then 403'd them from their own application queue).
              relationship: entry?.relationship === 'steward' || prev?.relationship === 'steward' ? 'steward' : 'member',
              ...(entry?.orgName ? { orgName: String(entry.orgName) } : {}),
              ...(entry?.kind ? { kind: String(entry.kind) } : prev?.kind ? { kind: prev.kind } : {}),
              ...(entry?.parent ? { parent: String(entry.parent).toLowerCase() } : prev?.parent ? { parent: prev.parent } : {}),
              // spec 324 W3 — provenance back to the authoritative OrganizationMembership Situation.
              ...(entry?.membershipId ? { membershipId: String(entry.membershipId) } : prev?.membershipId ? { membershipId: prev.membershipId } : {}),
              ...(entry?.membershipSituationHash ? { membershipSituationHash: String(entry.membershipSituationHash) } : prev?.membershipSituationHash ? { membershipSituationHash: prev.membershipSituationHash } : {}),
              ...(entry?.enrollmentDecisionRef ? { enrollmentDecisionRef: String(entry.enrollmentDecisionRef) } : prev?.enrollmentDecisionRef ? { enrollmentDecisionRef: prev.enrollmentDecisionRef } : {}),
              ...(entry?.delegationHash ? { delegationHash: String(entry.delegationHash) } : {}),
              // Wires accumulate (a member-access grant may arrive after the membership entry);
              // self-gated op — only the person can place credentials in their own doc.
              ...(Array.isArray(entry?.delegations) || prev?.delegations
                ? { delegations: [...(prev?.delegations ?? []), ...((entry?.delegations as IncomingDelegation[] | undefined) ?? [])].slice(-8) }
                : {}),
              updatedAt: new Date().toISOString(),
            };
          }
          await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.relationships.merge', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'org-link', id: org } });
          await this.writeDoc(grant, RELATIONSHIPS_RESOURCE, doc);
          return json({ ok: true });
        }
        const org = String(body.org ?? '').toLowerCase();
        if (!/^0x[0-9a-fA-F]{40}$/.test(org)) return json({ error: 'org (address) required' }, 400);
        const profile = (body.profile ?? {}) as Record<string, unknown>;
        await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.member-profile.put', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'member-profile', id: org } });
        await this.writeDoc(grant, MEMBER_PROFILE_RESOURCE(org), profile);
        return json({ ok: true });
      }

      // ── spec 328 — the person's auto-reply inbox assistant (owner-controlled; STRICTLY self:
      //    an org steward or relying app cannot enable someone's assistant). Config + playbook are
      //    vault records under the existing `conversation.topic:*` scope; the DO keeps only the
      //    O(1) gate flag + the seen ledger (caches/dedup, never the source of truth). ──
      if (op === 'inbox.assistantGet' || op === 'inbox.assistantEnable' || op === 'inbox.assistantDisable' || op === 'inbox.assistantSkill.get' || op === 'inbox.assistantSkill.put') {
        if (sessionSa.toLowerCase() !== principal) return json({ error: 'the inbox assistant belongs to the principal — self access only' }, 403);
        if (op === 'inbox.assistantGet') {
          const cfg = await this.readDoc<PersonAssistantV1 | null>(grant, PERSON_ASSISTANT_RESOURCE, null);
          const skill = await this.readDoc<AssistantSkillDocV1 | null>(grant, PERSON_ASSISTANT_SKILL_RESOURCE, null);
          return json({ ok: true, assistant: cfg, skill });
        }
        if (op === 'inbox.assistantSkill.get') {
          const doc = await this.readDoc<AssistantSkillDocV1 | null>(grant, PERSON_ASSISTANT_SKILL_RESOURCE, null);
          return json({ ok: true, skill: doc });
        }
        if (op === 'inbox.assistantSkill.put') {
          const markdown = String(body.markdown ?? '');
          if (markdown.length > ASSISTANT_SKILL_MAX_CHARS) return json({ error: `playbook too long (max ${ASSISTANT_SKILL_MAX_CHARS} chars)` }, 400);
          const doc: AssistantSkillDocV1 = { version: 'ap.assistant-skill.v1', markdown, updatedBy: sessionSa.toLowerCase(), updatedAt: new Date().toISOString() };
          await audit.write({ id: crypto.randomUUID(), timestamp: doc.updatedAt, action: 'interactions.inbox.assistantSkillPut', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'assistant-skill', id: principal } });
          await this.writeDoc(grant, PERSON_ASSISTANT_SKILL_RESOURCE, doc);
          return json({ ok: true });
        }
        if (op === 'inbox.assistantDisable') {
          const cfg = await this.readDoc<PersonAssistantV1 | null>(grant, PERSON_ASSISTANT_RESOURCE, null);
          if (cfg) await this.writeDoc(grant, PERSON_ASSISTANT_RESOURCE, { ...cfg, enabled: false });
          await this.state.storage.delete(INBOX_ASSISTANT_FLAG_KEY);
          await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.inbox.assistantDisable', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'inbox', id: principal } });
          return json({ ok: true });
        }
        // inbox.assistantEnable — capture the person's primary name ONCE at enable time (ADR-0012:
        // one reverseResolve view call; re-enabling refreshes after a name rotation). A resolver
        // failure fails the ceremony closed — never a silently nameless assistant (ADR-0013).
        let primaryName: string | null = null;
        if (this.env.RPC_URL && this.env.AGENT_NAME_REGISTRY && this.env.AGENT_NAME_UNIVERSAL_RESOLVER) {
          try {
            primaryName = await new AgentNamingClient({
              rpcUrl: this.env.RPC_URL,
              chainId: Number(this.env.CHAIN_ID ?? 84532),
              registry: this.env.AGENT_NAME_REGISTRY as Address,
              universalResolver: this.env.AGENT_NAME_UNIVERSAL_RESOLVER as Address,
            }).reverseResolve(principal as Address);
          } catch (e) {
            return json({ error: `could not resolve your primary name: ${e instanceof Error ? e.message : String(e)}` }, 502);
          }
        }
        const displayName = primaryName ?? String(body.displayName ?? '').trim();
        if (!displayName) return json({ error: 'you have no primary name to reply as — claim a name first, or supply a displayName' }, 409);
        const cfg: PersonAssistantV1 = { version: 'ap.person-assistant.v1', enabled: true, trigger: 'all', displayName, enabledBy: sessionSa.toLowerCase(), enabledAt: new Date().toISOString() };
        // Seed the seen ledger from the CURRENT inbox so pre-enable history NEVER triggers (§3).
        const inboxDoc = await this.readDoc<{ envelopes?: MessageEnvelopeV1[] }>(grant, INBOX_RESOURCE, {});
        await this.state.storage.put(INBOX_ASSISTANT_SEEN_KEY, ((inboxDoc.envelopes ?? []).map((e) => e.id)).slice(-INBOX_ASSISTANT_SEEN_CAP));
        await audit.write({ id: crypto.randomUUID(), timestamp: cfg.enabledAt, action: 'interactions.inbox.assistantEnable', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'inbox', id: principal } });
        await this.writeDoc(grant, PERSON_ASSISTANT_RESOURCE, cfg);
        await this.state.storage.put(INBOX_ASSISTANT_FLAG_KEY, true); // gate cache LAST — never flags an unwritten config
        return json({ ok: true, assistant: cfg });
      }

      // ── Owner-own capability records (spec 323 W2) — STRICTLY self; whitelisted recordType. ──
      // `record.get`/`record.put { record }`: the delegation-authorized, KEK-encrypted home for the
      // person's own profile/skills/manifest, replacing the V-1 bearer path + app-local KV. The
      // interactions grant's record scope + the vault's KEK gate BOTH bound this at demo-mcp; the
      // self-check + whitelist here are the belt to those suspenders.
      if (op === 'record.list') {
        // spec 315 vault viewer — the person enumerates their OWN Home-managed vault records (self-gated).
        // demo-mcp's list is record-scope-filtered to the interactions grant, so app-specific records under
        // other grants never appear (least-privilege).
        if (sessionSa.toLowerCase() !== principal) return json({ error: 'this vault belongs to the principal — self access only' }, 403);
        const records = await this.vaultFor(grant).list('');
        return json({ ok: true, records });
      }
      if (op === 'record.get' || op === 'record.put') {
        if (sessionSa.toLowerCase() !== principal) return json({ error: 'this record belongs to the principal — self access only' }, 403);
        const recordType = String(body.recordType ?? '');
        if (!recordType) return json({ error: 'recordType required' }, 400);
        // WRITES stay whitelisted (only the known capability records may be written from here). READS defer
        // to demo-mcp's record-scope gate (the interactions grant's scope) so the vault viewer (spec 315)
        // can VIEW any Home-managed record; an out-of-scope record is denied at demo-mcp, never silently.
        // The self-check above + the KEK gate + the grant scope remain.
        if (op === 'record.put' && !CAPABILITY_RECORDS.has(recordType)) {
          return json({ error: `recordType must be one of: ${[...CAPABILITY_RECORDS].join(', ')}` }, 400);
        }
        if (op === 'record.get') {
          const r = await this.vaultFor(grant).read<unknown>({ owner: '', resource: recordType });
          return json({ ok: true, record: r?.data ?? null });
        }
        if (body.record === undefined) return json({ error: 'record required' }, 400);
        await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.record.put', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'record', id: recordType } });
        await this.vaultFor(grant).write({ owner: '', resource: recordType, data: body.record, classification: 'internal' } as never);
        return json({ ok: true });
      }

      // ── OrganizationMembership record (spec 324 W3) — STRICTLY self; the AUTHORITATIVE membership Situation
      //    + credential per org, in the principal's OWN vault. Membership ≠ Delegation ≠ Listing (ADR-0048
      //    #3/#6): this is the single source of truth the related:*/directory/gate projections point back to.
      //    Writing it grants NO authority — the delegations issued *because of* membership are separate. ──
      if (op === 'membership.get' || op === 'membership.put') {
        if (sessionSa.toLowerCase() !== principal) return json({ error: 'this membership record belongs to the principal — self access only' }, 403);
        const org = String(body.org ?? '').toLowerCase();
        if (!/^0x[0-9a-fA-F]{40}$/.test(org)) return json({ error: 'org (address) required' }, 400);
        if (op === 'membership.get') {
          const r = await this.vaultFor(grant).read<unknown>({ owner: '', resource: MEMBERSHIP_RESOURCE(org) });
          return json({ ok: true, membership: r?.data ?? null });
        }
        if (body.membership === undefined) return json({ error: 'membership (SituationV2) required' }, 400);
        await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.membership.put', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'org-membership', id: org } });
        await this.vaultFor(grant).write({ owner: '', resource: MEMBERSHIP_RESOURCE(org), data: { membership: body.membership, credential: body.credential ?? null }, classification: 'internal' } as never);
        return json({ ok: true });
      }

      // ── spec 329 §2.1 — consultability grant custody (member → org) on the ORG's DO. The wire
      //    is a capability and lives WITH its delegate service (the org SA is the delegate; this
      //    DO is the org's execution point — the spec-322 §2 / 323 W3 custody rule), keyed by the
      //    spec's record name `org.consult-grant:<memberSA>`. NOTE (deviation from §2.1's vault
      //    residency, recorded in the spec): the deployed grant scopes cover no
      //    `vault:org.consult-grant:*` resource, and widening them forces a fleet-wide re-enable
      //    ceremony — so W1 custodies the wire in DO storage under the SAME key; W2's
      //    `find_members` eligibility read comes here. Fail-closed verification at store time:
      //    self-consent (session SA === delegator), delegate === this org, allowedTargets ===
      //    [the member], allowedMethods === the `discussion.consult` selector ONLY (never
      //    A2A_ANY_SKILL), timestamp caveat present, ERC-1271 + unrevoked on-chain. The MEMBER's
      //    A2A gate re-verifies everything again per message — this store is eligibility, never
      //    the authority (the delegation itself is).
      if (op === 'consult.grantPut' || op === 'consult.grantStatus' || op === 'consult.grantRevoke') {
        if (op === 'consult.grantPut') {
          const wire = body.delegation as IncomingDelegation | undefined;
          if (!wire?.signature || !wire.delegator || !wire.delegate) return json({ error: 'signed consultability delegation required' }, 400);
          const member = wire.delegator.toLowerCase();
          // The member consents for THEMSELVES only (the same self gate as inbox.assistantEnable).
          if (sessionSa.toLowerCase() !== member) return json({ error: 'consultability is the member\'s own consent — self grant only' }, 403);
          if (wire.delegate.toLowerCase() !== principal) return json({ error: 'consult grant delegate must be this organization' }, 400);
          // Caveat shape (spec 329 §2.1): allowedTargets = [memberSA]; allowedMethods = [consult
          // selector] (never the any-skill sentinel); timestamp-bounded. Fail closed on missing
          // enforcer config — an unverifiable shape is never stored.
          const tsEnf = (this.env.TIMESTAMP_ENFORCER ?? '').toLowerCase();
          const atEnf = (this.env.ALLOWED_TARGETS_ENFORCER ?? '').toLowerCase();
          const amEnf = (this.env.ALLOWED_METHODS_ENFORCER ?? '').toLowerCase();
          if (![tsEnf, atEnf, amEnf].every((a) => /^0x[0-9a-f]{40}$/.test(a))) {
            return json({ error: 'consult grant enforcers not configured — cannot verify the grant shape' }, 503);
          }
          const caveats = wire.caveats ?? [];
          const byEnforcer = (addr: string) => caveats.find((c) => (c.enforcer ?? '').toLowerCase() === addr);
          if (!byEnforcer(tsEnf)) return json({ error: 'consult grant must be timestamp-bounded' }, 400);
          const atCav = byEnforcer(atEnf);
          const amCav = byEnforcer(amEnf);
          if (!atCav?.terms || !amCav?.terms) return json({ error: 'consult grant must carry allowedTargets + allowedMethods caveats' }, 400);
          try {
            const targets = decodeAllowedTargetsTerms(atCav.terms as Hex).map((t) => t.toLowerCase());
            if (targets.length !== 1 || targets[0] !== member) return json({ error: 'consult grant allowedTargets must name exactly the member agent' }, 400);
            const selectors = decodeAllowedMethodsTerms(amCav.terms as Hex).map((s) => s.toLowerCase());
            const want = skillSelector(CONSULT_SKILL_ID).toLowerCase();
            if (selectors.some((s) => s === A2A_ANY_SKILL.toLowerCase())) return json({ error: 'consult grant must never carry the any-skill sentinel' }, 400);
            if (selectors.length !== 1 || selectors[0] !== want) return json({ error: 'consult grant allowedMethods must name exactly the discussion.consult selector' }, 400);
          } catch {
            return json({ error: 'consult grant caveat terms are undecodable' }, 400);
          }
          // ERC-1271 against the member + unrevoked on-chain (fail-closed junk-overwrite guard).
          const d: Delegation = { ...wire, salt: BigInt(wire.salt), caveats: wire.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: (c.args ?? '0x') as Hex })) } as Delegation;
          const digest = hashDelegation(d, Number(this.env.CHAIN_ID ?? 84532), this.env.DELEGATION_MANAGER as Address);
          if (!(await this.erc1271(wire.delegator as Address, digest, wire.signature as Hex))) {
            return json({ error: 'consult grant signature failed verification against the member' }, 403);
          }
          try {
            const revoked = (await this.pub().readContract({ address: this.env.DELEGATION_MANAGER as Address, abi: IS_REVOKED_ABI, functionName: 'isRevoked', args: [digest] })) as boolean;
            if (revoked) return json({ error: 'consult grant is already revoked on-chain' }, 403);
          } catch { return json({ error: 'revocation check unavailable — grant not stored (fail-closed)' }, 503); }
          const grantedAt = new Date().toISOString();
          await this.state.storage.put(consultGrantRecordKey(member), { wire, member, grantedAt, hash: digest });
          st.ledger = [...(st.ledger ?? []), { hash: digest, delegate: principal, resources: [consultGrantRecordKey(member)], storedAt: grantedAt }].slice(-50);
          await this.state.storage.put('state', st);
          await audit.write({ id: crypto.randomUUID(), timestamp: grantedAt, action: 'interactions.consult.grantPut', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'consult-grant', id: `${principal}:${member}` } });
          return json({ ok: true, grantedAt });
        }
        if (op === 'consult.grantStatus') {
          // Self (the member asking about their own grant) or the org steward. Metadata only —
          // the wire itself never leaves the DO (capability hygiene).
          const member = String(body.member ?? sessionSa).toLowerCase();
          const self = sessionSa.toLowerCase() === member;
          const steward = self ? false : await this.isSteward(principal, sessionSa, body.stewardship as IncomingDelegation | undefined);
          if (!self && !steward) return json({ error: 'consult grant status is self-or-steward only' }, 403);
          const rec = (await this.state.storage.get(consultGrantRecordKey(member))) as { grantedAt?: string } | undefined;
          return json({ ok: true, granted: !!rec, grantedAt: rec?.grantedAt ?? null });
        }
        // consult.grantRevoke — the member withdraws their opt-in (or the steward clears it).
        // Removal here is the ORG-side eligibility kill (immediate: W2's find_members reads this
        // store); the on-chain revocation — the authority kill at the MEMBER's gate — is the
        // member's own client-side act (revokeGrantedDelegation), mirroring org-member-remove.
        const member = String(body.member ?? sessionSa).toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(member)) return json({ error: 'member (address) required' }, 400);
        const self = sessionSa.toLowerCase() === member;
        const steward = self ? false : await this.isSteward(principal, sessionSa, body.stewardship as IncomingDelegation | undefined);
        if (!self && !steward) return json({ error: 'consult grant revoke is self-or-steward only' }, 403);
        await this.state.storage.delete(consultGrantRecordKey(member));
        await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.consult.grantRevoke', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'consult-grant', id: `${principal}:${member}` } });
        return json({ ok: true });
      }

      return json({ error: `unknown op: ${op}` }, 400);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 409);
    }
  }
}
