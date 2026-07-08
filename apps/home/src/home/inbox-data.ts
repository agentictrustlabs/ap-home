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
  summarizeFolders,
  validateConversationDescriptor,
  type ContextRefV1,
  type ConversationDescriptorV1,
  type ConversationSummaryV1,
  type FolderSummaryV1,
  type InboxItemV1,
  type InboxProjector,
  type MessageEnvelopeV1,
  type MessageEventV1,
} from '@agenticprimitives/messaging';
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
} from '@agenticprimitives/interactions';
import { projectHomeInboxSummary, type HomeInboxSummaryV1 } from '@agenticprimitives/home';
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

export interface InboxDataV1 {
  version: 1;
  envelopes: MessageEnvelopeV1[];
  events: MessageEventV1[];
  /** messageId → plaintext body (the owner reading their own inbox). */
  bodies: Record<string, string>;
  /** Cases as they entered (draft) — current state is replayed from caseEvents. */
  draftCases: InteractionCaseV1[];
  caseEvents: InteractionTransitionEventV1[];
  /** interactionId → sender-proposed transport card (render half is ours). */
  cards: Record<string, ActionCardV1>;
  /** interactionId → the signed mandate the owner issued on approve (W5). */
  mandates?: Record<string, InteractionMandateV1>;
  /** Owner-side conversation descriptors (spec 312) — this side's copies. */
  conversations?: ConversationDescriptorV1[];
}

const EMPTY: InboxDataV1 = {
  version: 1,
  envelopes: [],
  events: [],
  bodies: {},
  draftCases: [],
  caseEvents: [],
  cards: {},
};

export async function loadInboxData(kv: KV, person: string): Promise<InboxDataV1> {
  const raw = await kv.get(DATA_KEY(person));
  return raw ? (JSON.parse(raw) as InboxDataV1) : { ...EMPTY, bodies: {}, cards: {}, envelopes: [], events: [], draftCases: [], caseEvents: [] };
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

/** Rebuild the in-memory stores by replay — same events, same projection. */
function hydrate(person: string, doc: InboxDataV1): { projector: InboxProjector; interactions: InteractionStore } {
  const projector = createInMemoryInboxProjector({ streamId: `home:${person.toLowerCase()}` });
  for (const envelope of doc.envelopes) projector.putMessage(envelope);
  for (const event of doc.events) projector.appendEvent(event);

  const interactions = createInMemoryInteractionStore();
  for (const c of doc.draftCases) interactions.putCase(c);
  for (const e of doc.caseEvents) {
    const r = interactions.applyEvent(e);
    if (!r.ok) throw new Error(`inbox replay diverged for ${e.interactionId}: ${r.reason}`);
  }
  return { projector, interactions };
}

export interface InboxView {
  items: InboxItemV1[];
  folders: FolderSummaryV1[];
  summary: HomeInboxSummaryV1;
  cases: InteractionCaseV1[];
  cards: Record<string, ActionCardV1>;
  bodies: Record<string, string>;
  mandates: Record<string, InteractionMandateV1>;
  /** Conversation-first rows (spec 312 §7.1) — newest activity first. */
  conversations: ConversationSummaryV1[];
  /** Owner's conversation descriptors, keyed by conversation id. */
  descriptors: Record<string, ConversationDescriptorV1>;
  /** Envelope metadata the UI needs (sender, subject, refs), keyed by messageId. */
  envelopeMeta: Record<
    string,
    { from: string; subject?: string; contextRefs?: ContextRefV1[]; signatureSigner?: string; createdAt: string }
  >;
}

export async function readInboxView(kv: KV, person: string): Promise<InboxView> {
  const doc = await loadInboxData(kv, person);
  const { projector, interactions } = hydrate(person, doc);
  const items = projector.listInbox();
  const cases = interactions.listCases();
  const envelopeMeta: InboxView['envelopeMeta'] = {};
  for (const e of doc.envelopes) {
    envelopeMeta[e.id] = {
      from: e.from,
      subject: e.subject,
      contextRefs: e.contextRefs,
      signatureSigner: e.signature?.signer,
      createdAt: e.createdAt,
    };
  }
  const descriptors: InboxView['descriptors'] = {};
  for (const d of doc.conversations ?? []) descriptors[d.id] = d;
  return {
    items,
    folders: summarizeFolders(items),
    summary: projectHomeInboxSummary({ items, cases }),
    cases,
    cards: doc.cards,
    bodies: doc.bodies,
    mandates: doc.mandates ?? {},
    conversations: summarizeConversations(items),
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
  envelope: MessageEnvelopeV1;
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

/**
 * Audited inbound delivery. Order (all fail-closed, nothing persisted early):
 * validate + body-hash + audit-accept (messaging.createAuditedInboxDelivery) →
 * case binding checks → audited submit+admit transitions → persist.
 */
export async function deliverToInbox(kv: KV, person: Address, payload: DeliverPayload): Promise<void> {
  const recipient: CanonicalAgentId = homeCaip10(person);
  const doc = await loadInboxData(kv, person);
  const { projector, interactions } = hydrate(person, doc);
  const audit = homeAuditSink(kv, person);

  const { envelope, bodyText } = payload;
  if (!envelope.to.some((t) => t.toLowerCase() === recipient.toLowerCase())) {
    throw new Error('envelope is not addressed to this agent');
  }

  const event: MessageEventV1 = {
    version: 'ap.message.event.v1',
    messageId: envelope.id,
    actor: envelope.from,
    eventType: 'delivered',
    at: new Date().toISOString(),
  };
  const delivery = createAuditedInboxDelivery({ projector, audit, recipient });
  await delivery.admit(envelope, event, new TextEncoder().encode(bodyText));

  // Typed request → register the case and drive submit/admit, audited.
  if (payload.interactionCase) {
    const c = payload.interactionCase;
    if (envelope.kind !== 'request') throw new Error('interaction case requires a request message');
    if (envelope.interactionId !== c.id) throw new Error('envelope/case interaction id mismatch');
    if (c.state !== 'draft') throw new Error('case must arrive in draft state');
    if (c.requester.toLowerCase() !== envelope.from.toLowerCase()) throw new Error('case requester must be the sender');
    if (c.responder.toLowerCase() !== recipient.toLowerCase()) throw new Error('case responder must be this agent');
    if (c.rootMessageId !== envelope.id) throw new Error('case root message must be this envelope');

    interactions.putCase(c);
    const audited = createAuditedInteractionStore({ store: interactions, audit });
    const at = new Date().toISOString();
    const mk = (transition: InteractionTransitionType, actor: CanonicalAgentId): InteractionTransitionEventV1 => ({
      version: 'ap.interaction.event.v1',
      interactionId: c.id,
      transition,
      actor,
      at,
      messageId: envelope.id,
      idempotencyKey: `${transition}:${c.id}`,
    });
    const submitted = await audited.applyEvent(mk('submit', c.requester));
    if (!submitted.ok) throw new Error(`case submit rejected: ${submitted.reason}`);
    const admitted = await audited.applyEvent(mk('admit', recipient));
    if (!admitted.ok) throw new Error(`case admit rejected: ${admitted.reason}`);
    doc.draftCases.push(c);
    doc.caseEvents.push(mk('submit', c.requester), mk('admit', recipient));

    if (payload.card) {
      if (payload.card.interactionId !== c.id) throw new Error('card interaction id mismatch');
      const cardErrors = validateActionCard(payload.card);
      if (cardErrors.length > 0) throw new Error(`invalid action card: ${cardErrors.join(', ')}`);
      doc.cards[c.id] = payload.card;
    }
  }

  if (payload.conversation) {
    if (payload.conversation.id !== envelope.conversationId) {
      throw new Error('conversation descriptor does not match envelope conversation');
    }
    const mine: ConversationDescriptorV1 = { ...payload.conversation, owner: recipient };
    const errors = validateConversationDescriptor(mine);
    if (errors.length > 0) throw new Error(`invalid conversation descriptor: ${errors.join(', ')}`);
    const existing = doc.conversations ?? [];
    // First descriptor wins for this owner; later proposals never overwrite.
    if (!existing.some((d) => d.id === mine.id)) doc.conversations = [...existing, mine];
  }

  doc.envelopes.push(envelope);
  doc.events.push(event);
  doc.bodies[envelope.id] = bodyText;
  await saveInboxData(kv, person, doc);
}

/**
 * Owner send (spec 312 W2/W3 composer). Both sides live on this Home (demo
 * topology): the recipient's copy goes through the SAME audited delivery
 * pipeline as external mail; the sender's copy is recorded as a 'sent' event
 * in their own store. One descriptor per conversation on each side.
 */
export async function sendFromInbox(
  kv: KV,
  person: Address,
  opts: {
    recipient: Address;
    subject?: string;
    bodyText: string;
    contextRefs?: ContextRefV1[];
    conversationId?: string;
    title?: string;
  },
): Promise<{ messageId: string; conversationId: string }> {
  const me = homeCaip10(person);
  const them = homeCaip10(opts.recipient);
  const now = new Date().toISOString();
  const { generateMessageId, generateConversationId, sha256Hex32 } = await import('@agenticprimitives/messaging');
  const conversationId = (opts.conversationId ?? generateConversationId()) as MessageEnvelopeV1['conversationId'];
  const envelope: MessageEnvelopeV1 = {
    version: 'ap.message.v1',
    id: generateMessageId(),
    conversationId,
    kind: 'plain',
    from: me,
    to: [them],
    subject: opts.subject,
    createdAt: now,
    classification: 'internal',
    body: { resource: `inline:home-send`, classification: 'internal', updatedAt: now },
    bodyHash: await sha256Hex32(new TextEncoder().encode(opts.bodyText)),
    bodyContentType: 'text/plain',
    contextRefs: opts.contextRefs,
  };
  const descriptor: ConversationDescriptorV1 = {
    version: 'ap.conversation.v1',
    id: conversationId,
    owner: them,
    title: opts.title ?? opts.subject,
    participants: [me, them],
    contextRefs: opts.contextRefs,
    participantPolicy: 'fixed',
    createdAt: now,
  };

  // Recipient side first — audited, fail-closed; nothing recorded on failure.
  await deliverToInbox(kv, opts.recipient, {
    envelope,
    bodyText: opts.bodyText,
    conversation: descriptor,
  });

  // Self-send: the delivered copy IS the record; no second copy.
  if (opts.recipient.toLowerCase() === person.toLowerCase()) {
    return { messageId: envelope.id, conversationId };
  }

  // Sender's own copy: same envelope, 'sent' perspective.
  const doc = await loadInboxData(kv, person);
  const { projector } = hydrate(person, doc);
  projector.putMessage(envelope);
  const sent: MessageEventV1 = {
    version: 'ap.message.event.v1',
    messageId: envelope.id,
    actor: me,
    eventType: 'sent',
    at: now,
  };
  projector.appendEvent(sent);
  doc.envelopes.push(envelope);
  doc.events.push(sent);
  doc.bodies[envelope.id] = opts.bodyText;
  const mine: ConversationDescriptorV1 = { ...descriptor, owner: me };
  if (!(doc.conversations ?? []).some((d) => d.id === conversationId)) {
    doc.conversations = [...(doc.conversations ?? []), mine];
  }
  await saveInboxData(kv, person, doc);
  return { messageId: envelope.id, conversationId };
}

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
