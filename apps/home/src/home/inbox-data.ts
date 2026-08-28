// Home inbox persistence + rehydration (spec 310 W3 / spec 309 W6, app layer).
//
// The messaging/interactions packages own the semantics (validation, reducer,
// rules, fail-closed state machine, audited admission); this module is the
// app's storage adapter: one event-sourced KV document per person, rehydrated
// into the packages' in-memory stores per request (demo-scale by design), plus
// a KV-appended audit log. Fail-closed wiring is preserved end-to-end: the
// audited admitters run BEFORE anything is persisted, and an audit-write
// failure blocks the operation (spec 291 discipline).
import {
  createAuditedInboxDelivery,
  createInMemoryInboxProjector,
  summarizeConversations,
  summarizeDirectMessages,
  summarizeFolders,
  validateConversationDescriptor,
  type ContextRefV1,
  type ConversationDescriptorV1,
  type ConversationSummaryV1,
  type DirectMessageSummaryV1,
  type FolderSummaryV1,
  type InboxItemV1,
  type InboxProjector,
  type MessageEnvelopeV1,
  type MessageEnvelopeV2,
  type MessageEventV1,
  messageBodyResource,
} from '@agenticprimitives/fabric/messaging';
import {
  createAuditedInteractionStore,
  createInMemoryInteractionStore,
  precheckMandateSignature,
  validateActionCard,
  type ActionCardV1,
  type InteractionCaseV1,
  type InteractionMandateV1,
  type InteractionStore,
  type InteractionTransitionEventV1,
  type InteractionTransitionType,
} from '@agenticprimitives/fabric/interactions';
import { projectHomeInboxSummary, type HomeInboxSummaryV1 } from '@agenticprimitives/home';
// spec 322 W1 — the inbox DOC shape + pure operations are substrate (fabric); this module keeps only
// the app's storage adapter (KV/vault routing, audit sink) and the Home-specific compositions.
import {
  emptyInboxData,
  parseInboxData,
  hydrateInboxStores,
  upsertConversation,
  type InboxDataV1,
  isEnvelopeV2,
  performativeOf,
  type AnyMessageEnvelope,
  type CommitmentRecordV1,
  type DecisionRecordV1,
} from '@agenticprimitives/fabric';
// READ-only by type (spec 341 §5.2) — see `MessageBodyReader`.
import type { MessageBodyReader } from '../../server/connect/message-body-store';
import type { AuditEvent, AuditSink } from '@agenticprimitives/audit';
import type { Address, CanonicalAgentId } from '@agenticprimitives/types';
import { homeCaip10 } from './manifest';

/** The broker KV surface (raw strings, spec 232 §4). */
interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

const DATA_KEY = (person: string): string => `inbox-data:${person.toLowerCase()}`;
const AUDIT_KEY = (person: string): string => `inbox-audit:${person.toLowerCase()}`;

// InboxDataV1 moved to @agenticprimitives/fabric (spec 322 W1); re-exported for app importers.
export type { InboxDataV1 };
export async function loadInboxData(kv: KV, person: string): Promise<InboxDataV1> {
  const raw = await kv.get(DATA_KEY(person));
  return raw ? parseInboxData(raw) : emptyInboxData();
}

async function saveInboxData(kv: KV, person: string, doc: InboxDataV1): Promise<void> {
  await kv.put(DATA_KEY(person), JSON.stringify(doc));
}

/** Append-only audit adapter — the Home's one KV audit log (inbox admissions,
 *  case transitions, control-plane events). A failed append THROWS so the
 *  audited admitters fail closed (audit-before-commit — spec 291). */
export function homeAuditSink(kv: KV, person: string): AuditSink {
  return {
    async write(event: AuditEvent): Promise<void> {
      const raw = await kv.get(AUDIT_KEY(person));
      const rows = raw ? (JSON.parse(raw) as AuditEvent[]) : [];
      rows.push(event);
      await kv.put(AUDIT_KEY(person), JSON.stringify(rows));
    },
  };
}

export async function loadInboxAudit(kv: KV, person: string): Promise<AuditEvent[]> {
  const raw = await kv.get(AUDIT_KEY(person));
  return raw ? (JSON.parse(raw) as AuditEvent[]) : [];
}

/** Rebuild the in-memory stores by replay — same events, same projection (fabric, spec 322 W1). */
function hydrate(person: string, doc: InboxDataV1): { projector: InboxProjector; interactions: InteractionStore } {
  return hydrateInboxStores(`home:${person.toLowerCase()}`, doc);
}
export interface InboxView {
  items: InboxItemV1[];
  folders: FolderSummaryV1[];
  summary: HomeInboxSummaryV1;
  cases: InteractionCaseV1[];
  /**
   * spec 340 W10b-2 — the determination and the obligation, keyed by interaction id.
   *
   * These are NOT derived from `case.state` and must not be re-derived from it. A determination has
   * its own lifecycle and its own signer: a case can be `revoked` while its grant remains a recorded
   * fact, and an obligation can be outstanding after execution finished. `case.state` answers "how far
   * did the work get"; these answer "what was decided" and "what is owed".
   *
   * Empty for any case whose history never produced one — absence is an answer, not a reason to fall
   * back to reading the case state (ADR-0013).
   */
  decisions: Record<string, DecisionRecordV1>;
  commitments: Record<string, CommitmentRecordV1>;
  cards: Record<string, ActionCardV1>;
  bodies: Record<string, string>;
  mandates: Record<string, InteractionMandateV1>;
  /** Conversation-first rows (spec 312 §7.1) — newest activity first. */
  conversations: ConversationSummaryV1[];
  /** Direct-message buckets (spec 313 §2 amendment — the Slack model): every conversation with the
   *  same counterparty folded into one row, newest activity first, naming its last message. */
  directMessages: DirectMessageSummaryV1[];
  /** Owner's conversation descriptors, keyed by conversation id. */
  descriptors: Record<string, ConversationDescriptorV1>;
  /** Envelope metadata the UI needs (sender, subject, refs), keyed by messageId. */
  envelopeMeta: Record<
    string,
    {
      from: string;
      subject?: string;
      /**
       * V1 ONLY — `undefined` on an `ap.message.v2` envelope, which dropped the taxonomy.
       * Readers MUST NOT infer "not plain" from its absence; branch on presence (see `use-inbox`).
       */
      kind?: string;
      /** Both versions, via the dual-read seam. What the message DOES, which is what `kind` stood in for. */
      performative: string;
      /** The causal edge. Under V2 this — not a taxonomy — is what distinguishes a reply (spec 340 §R.4). */
      inReplyTo?: string;
      interactionId?: string;
      contextRefs?: ContextRefV1[];
      signatureSigner?: string;
      createdAt: string;
      /** spec 328 / spec 324 §9 — acting-agent provenance; drives the "agent" chip. */
      actor?: string;
    }
  >;
}

// ─── Message-body residency (spec 317 — CUT OVER) ─────────────────────────────────────────────────────────
// Message bodies live in the owner's VAULT, full stop — written and read through the fabric body store
// (`createOwnerMessageBodyStore` → edge → a2a server-mint → demo-mcp, hash-verified; spec 316 §11a). The old
// KV `doc.bodies` map is dead storage: never written, never read (deletes > deprecations — pre-cutover
// bodies are gone with it). ONE mechanism (ADR-0013): no store (owner hasn't signed their delivery grant) ⇒
// writes FAIL loudly, reads resolve NO bodies — empty is the answer, never a KV fallback.

/** Resolve every envelope's body — from the owner's VAULT, the only body residency (spec 317 cutover;
 *  the KV `doc.bodies` map is dead storage, never read or written — deletes > deprecations). No store
 *  (the owner hasn't provisioned their delivery grant) ⇒ NO bodies: empty is the answer (ADR-0013),
 *  never a KV fallback — the UI's "Enable vault storage" action is the one path to readable bodies.
 *  Vault reads go to `message.body:<id>` — the resource `putBody` actually keys by — never the
 *  sender-supplied `envelope.body.resource` (an external app's envelope may carry an `inline:*` stub). */
async function resolveBodies(doc: InboxDataV1, bodyStore?: MessageBodyReader, scope?: BodyScope): Promise<Record<string, string>> {
  if (!bodyStore) return {};
  const out: Record<string, string> = {};
  // VL-W4 — metadata-first: the list/poll passes NO body store (bodies stay lazy); a thread hydrate passes
  // a store + conversationId so we resolve ONLY that conversation's bodies (not the whole inbox); a rail
  // preview hydrate passes the exact message ids it needs (one per DM bucket — the last message).
  const envelopes = scope?.conversationId
    ? doc.envelopes.filter((e) => e.conversationId === scope.conversationId)
    : scope?.messageIds
      ? doc.envelopes.filter((e) => scope.messageIds!.has(e.id))
      : doc.envelopes;
  await Promise.all(envelopes.map(async (e) => {
    // Normalized ref = where persistBody wrote it; loadBody still hash-verifies against envelope.bodyHash.
    // Fail-closed: a missing record or a bodyHash mismatch throws — omit rather than serve bad bytes.
    const normalized: AnyMessageEnvelope = { ...e, body: { ...e.body, resource: messageBodyResource(e.id) } };
    try { out[e.id] = new TextDecoder().decode(await bodyStore.loadBody(normalized)); } catch { /* omitted */ }
  }));
  return out;
}

// `persistBody` is gone with its callers (spec 341 §5.2): the Home no longer writes message bodies
// anywhere. Reading them (`resolveBodies` → `loadBody`) is unchanged — an owner reading their own mail
// is not the same operation as writing into someone else's.

/** Which bodies a read resolves: one conversation's, an explicit set of messages', or (unscoped) all. */
export interface BodyScope {
  conversationId?: string;
  messageIds?: Set<string>;
}

export async function readInboxView(kv: KV, person: string, bodyStore?: MessageBodyReader, scope?: BodyScope): Promise<InboxView> {
  const doc = await loadInboxData(kv, person);
  const { projector, interactions } = hydrate(person, doc);
  const items = projector.listInbox();
  const cases = interactions.listCases();
  const envelopeMeta: InboxView['envelopeMeta'] = {};
  for (const e of doc.envelopes) {
    envelopeMeta[e.id] = {
      from: e.from,
      subject: e.subject,
      ...(isEnvelopeV2(e) ? {} : { kind: e.kind }),
      performative: performativeOf(e),
      inReplyTo: e.inReplyTo,
      interactionId: e.interactionId,
      contextRefs: e.contextRefs,
      signatureSigner: e.signature?.signer,
      createdAt: e.createdAt,
      ...(e.actor ? { actor: e.actor } : {}),
    };
  }
  const descriptors: InboxView['descriptors'] = {};
  for (const d of doc.conversations ?? []) descriptors[d.id] = d;
  // spec 340 W10b-2. Read off the machines that own them — the replay that rebuilt `interactions`
  // populated these from the SAME stored event log, so they cost no extra storage and no migration.
  const decisions: InboxView['decisions'] = {};
  const commitments: InboxView['commitments'] = {};
  for (const c of cases) {
    const d = interactions.getDecision(c.id);
    if (d) decisions[c.id] = d;
    const m = interactions.getCommitment(c.id);
    if (m) commitments[c.id] = m;
  }
  return {
    items,
    folders: summarizeFolders(items),
    summary: projectHomeInboxSummary({ items, cases }),
    cases,
    decisions,
    commitments,
    cards: doc.cards,
    bodies: await resolveBodies(doc, bodyStore, scope),
    mandates: doc.mandates ?? {},
    conversations: summarizeConversations(items),
    directMessages: summarizeDirectMessages({
      owner: person,
      items,
      descriptors,
      envelopes: Object.fromEntries(doc.envelopes.map((e) => [e.id, { from: e.from, to: e.to }])),
    }),
    descriptors,
    envelopeMeta,
  };
}

/** Related-messages read path for entity views (spec 312 §8.2): the SAME
 *  projection the inbox renders, filtered by context — never a second index. */
export async function readMessagesByContext(
  kv: KV,
  person: string,
  ref: { kind: string; id?: string },
): Promise<InboxItemV1[]> {
  const doc = await loadInboxData(kv, person);
  const { projector } = hydrate(person, doc);
  return projector.listByContext(ref);
}

export interface DeliverPayload {
  envelope: AnyMessageEnvelope;
  /** Plaintext body; its UTF-8 bytes must match envelope.bodyHash (enforced). */
  bodyText: string;
  /** Draft case for `request` messages — requester=from, responder=recipient. */
  interactionCase?: InteractionCaseV1;
  /** Optional sender-proposed approval card (transport half, spec 309 §6.4). */
  card?: ActionCardV1;
  /** Optional sender-proposed conversation descriptor (spec 312 §4.2). The
   *  recipient stores their OWN copy (owner rewritten) — descriptors are
   *  projection metadata and never authorize anything. */
  conversation?: ConversationDescriptorV1;
}

// `deliverToInbox` is DELETED too (spec 341 §5.2), and its last caller went with it.
//
// It was the ADMISSION side — what a Home does with a message that arrived — and that was a real
// distinction while `/connect/inbox/deliver` existed. But that endpoint was the second unauthenticated
// hop: `access-control-allow-origin: *`, no signature on the envelope, `envelope.from` taken on trust.
// Relying apps now deliver through the SENDER'S OWN AGENT, so admission happens where every other
// admission happens — at the recipient's InteractionsDO, after the recipient's A2A gate.
//
// Nothing at the Home writes into anyone's inbox any more. That is the property §5.2 was after, and it
// is stronger than "the deliver endpoint verifies a signature": there is no deliver endpoint.

// `sendFromInbox` and `replyInConversation` are DELETED (spec 341 §5.1c).
//
// They composed as the sender and wrote BOTH copies — including straight into the RECIPIENT's vault,
// over a standing grant and a shared HMAC secret. Possession of that secret was the authorization.
// Sending is now an authorized A2A delivery performed by the sender's own agent (person or org),
// re-verified at the recipient's gate like a stranger's message would be.
//
// `deliverToInbox` above SURVIVES and is not the same thing: it is the ADMISSION side — what a
// recipient's own execution point does with a message that already passed a gate.

/** Owner-side message action (mark read / archive). */
export async function applyMessageAction(
  kv: KV,
  person: Address,
  messageId: string,
  eventType: 'read' | 'archived',
): Promise<void> {
  const doc = await loadInboxData(kv, person);
  const { projector } = hydrate(person, doc);
  const event: MessageEventV1 = {
    version: 'ap.message.event.v1',
    messageId: messageId as MessageEventV1['messageId'],
    actor: homeCaip10(person),
    eventType,
    at: new Date().toISOString(),
  };
  projector.appendEvent(event); // throws for unknown messages — fail-closed
  doc.events.push(event);
  await saveInboxData(kv, person, doc);
}

/** Owner-side case decision (approve / deny / ask-info / …), audited. The
 *  machine enforces the role; the session gate upstream enforced the person. */
export async function applyCaseTransition(
  kv: KV,
  person: Address,
  interactionId: string,
  transition: InteractionTransitionType,
  reason?: string,
): Promise<InteractionCaseV1> {
  const doc = await loadInboxData(kv, person);
  const { interactions } = hydrate(person, doc);
  const audited = createAuditedInteractionStore({ store: interactions, audit: homeAuditSink(kv, person) });
  const event: InteractionTransitionEventV1 = {
    version: 'ap.interaction.event.v1',
    interactionId: interactionId as InteractionTransitionEventV1['interactionId'],
    transition,
    actor: homeCaip10(person),
    at: new Date().toISOString(),
    reason,
    idempotencyKey: `${transition}:${interactionId}:${Date.now()}`,
  };
  const result = await audited.applyEvent(event);
  if (!result.ok) throw new Error(`transition rejected: ${result.reason}`);
  doc.caseEvents.push(event);
  await saveInboxData(kv, person, doc);
  return result.case;
}

/**
 * spec 340 W10b-2 — what a case transition DETERMINED, read back off the owning machines.
 *
 * Separate from `applyCaseTransition`'s return on purpose. That returns the case, which answers how
 * far the work got; this answers what was decided and what is owed. Callers that need both ask for
 * both, rather than one being inferred from the other.
 *
 * Nothing extra is stored: the emission rode the same `caseEvents` append the transition already
 * wrote, so this is a replay of bytes that are on disk either way.
 */
export async function readCaseDetermination(
  kv: KV,
  person: Address,
  interactionId: string,
): Promise<{ decision: DecisionRecordV1 | null; commitment: CommitmentRecordV1 | null }> {
  const doc = await loadInboxData(kv, person);
  const { interactions } = hydrate(person, doc);
  const id = interactionId as InteractionCaseV1['id'];
  return { decision: interactions.getDecision(id), commitment: interactions.getCommitment(id) };
}

/**
 * Approve WITH a signed mandate (spec 310 W5). Fail-closed gates, in order:
 *   1. mandate structure + principal must BE this person (facet of self only)
 *   2. precheck (signed, signer === principal)
 *   3. ERC-1271 against the person SA over the RE-DERIVED digest (injected
 *      verifier — never trust a client-supplied digest)
 *   4. mandate.actingAgent must be the case's requester
 * Only then the audited approve transition runs, carrying the mandate's
 * delegation hash as the case's AuthorityRef; the mandate is stored with the
 * case. Any gate failing means NO transition and NO stored mandate.
 */
export async function applyApproveWithMandate(
  kv: KV,
  person: Address,
  interactionId: string,
  mandate: InteractionMandateV1,
  verifyDigest: (digest: `0x${string}`, signature: `0x${string}`) => Promise<boolean>,
  recomputeDigest: (draft: Omit<InteractionMandateV1, 'signature'>) => Promise<`0x${string}`>,
): Promise<InteractionCaseV1> {
  const me = homeCaip10(person);
  if (mandate.version !== 'ap.interaction.mandate.v1') throw new Error('unknown mandate version');
  if (mandate.principal.toLowerCase() !== me.toLowerCase()) throw new Error('mandate principal must be your agent');
  const pre = precheckMandateSignature(mandate);
  if (!pre.verified) throw new Error(`mandate precheck failed: ${pre.reason}`);

  const { signature, ...draft } = mandate;
  const digest = await recomputeDigest(draft);
  if (!(await verifyDigest(digest, signature!.signature))) {
    throw new Error('mandate signature failed ERC-1271 verification');
  }

  const doc = await loadInboxData(kv, person);
  const { interactions } = hydrate(person, doc);
  const current = interactions.getCase(interactionId as InteractionCaseV1['id']);
  if (!current) throw new Error('unknown interaction');
  if (mandate.actingAgent.toLowerCase() !== current.requester.toLowerCase()) {
    throw new Error('mandate actingAgent must be the case requester');
  }

  const audited = createAuditedInteractionStore({ store: interactions, audit: homeAuditSink(kv, person) });
  const event: InteractionTransitionEventV1 = {
    version: 'ap.interaction.event.v1',
    interactionId: interactionId as InteractionTransitionEventV1['interactionId'],
    transition: 'approve',
    actor: me,
    at: new Date().toISOString(),
    idempotencyKey: `approve:${interactionId}:${mandate.mandateId}`,
    authorityRef: { kind: 'delegation', hash: mandate.delegationHash },
    signature,
  };
  const result = await audited.applyEvent(event);
  if (!result.ok) throw new Error(`transition rejected: ${result.reason}`);
  doc.caseEvents.push(event);
  doc.mandates = { ...(doc.mandates ?? {}), [interactionId]: mandate };
  await saveInboxData(kv, person, doc);
  return result.case;
}
