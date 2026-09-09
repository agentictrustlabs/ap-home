// InteractionsDO `endeavor.*` op family — the coordination serving plane (spec 334 §3, W2).
// Follows the channels.* pattern exactly: broker-verified session at ingress, steward/member gates
// resolved by the DO (injected here as closures), every read/write over the interactions grant,
// shared-doc RMW inside the DO's serialize() mutex, audit row before commit.
//
// THE REDUCER IS THE ONLY MUTATION PATH (ADR-0013 / spec 332 §9): every mutating op builds a
// spec-332 command, validates it against the state rehydrated from the append-only event log,
// appends the produced events, re-applies them, and persists log + projections — one mechanism,
// no fallback. `endeavor.post` is the deliberate exception in the OTHER direction: it writes a
// fabric message only and NEVER produces a coordination event (spec 334 §3 rule 2d).
//
// Vault record catalog (spec 332 §5 / task mandate):
//   coordination.requests                      — intake doc (pending EndeavorRequestV1 rows)
//   coordination.endeavor:events:<endeavorId>  — append-only CoordinationEventV1 log (source of truth)
//   coordination.endeavor:<endeavorId>         — projected CoordinationStateV1 (read cache, never trusted
//                                                for mutation — state is ALWAYS re-reduced from the log)
//   coordination.index                         — endeavorId → summary rows (list projection)
//   conversation.topic:conv_<endeavorId>       — the endeavor's fabric topic (rides the existing
//                                                `vault:conversation.topic:*` grant scope)
import type { Address, Hex32 } from '@agenticprimitives/types';
import {
  applyCoordinationEvent,
  initialCoordinationState,
  makeAllocationId,
  makeCommitmentId,
  makeCoordinationPlanId,
  makeEndeavorId,
  makeEndeavorRequestId,
  makeParticipationId,
  makeProposalId,
  validateCoordinationCommand,
  type CoordinationCommandV1,
  type CoordinationEventV1,
  type CoordinationStateV1,
  type EndeavorEntryPoint,
  type EndeavorLifecycle,
  type EndeavorRequestV1,
  type MilestoneDefinitionV1,
  type OutcomeCriterionV1,
  type CapabilityRequirementRef,
  type PlanEdgeV1,
  type PlanRevisionRef,
  type PlanStepId,
  type PlanStepV1,
  type SignedPayloadRef,
} from '@agenticprimitives/coordination';
import type { EntityRef } from '@agenticprimitives/situations';
import {
  appendBoardPost,
  canonicalizeMessage,
  sha256Hex32,
  type ChannelMessageEntryV1,
  type ChannelV1,
  type ConversationDescriptorV1,
  type AnyMessageEnvelope,
} from '@agenticprimitives/fabric/messaging';

// ── Vault record keys ──
export const COORDINATION_REQUESTS_RESOURCE = 'coordination.requests';
export const COORDINATION_INDEX_RESOURCE = 'coordination.index';
export const coordinationEventsResource = (endeavorId: string): string => `coordination.endeavor:events:${endeavorId}`;
export const coordinationStateResource = (endeavorId: string): string => `coordination.endeavor:${endeavorId}`;
/** The endeavor's fabric topic id — `conv_`-prefixed so envelope/descriptor validators admit it,
 *  deterministic from the endeavor id so no extra index doc is needed. Generated conversation ids
 *  are pure-hex suffixes, so `conv_end_*` can never collide with them. */
export const endeavorTopicId = (endeavorId: string): string => `conv_${endeavorId}`;
export const endeavorTopicResource = (endeavorId: string): string => `conversation.topic:${endeavorTopicId(endeavorId)}`;

const REQUESTS_CAP = 200;

// ── Doc shapes ──
type SubmitEvent = Extract<CoordinationEventV1, { kind: 'EndeavorRequestSubmitted' }>;

export interface CoordinationRequestRowV1 {
  request: EndeavorRequestV1;
  /** The exact `EndeavorRequestSubmitted` event — adoption seeds the endeavor's log with it. */
  event: SubmitEvent;
  status: 'pending' | 'adopted' | 'declined';
  endeavorId?: string;
  reason?: string;
  decidedAt?: string;
  declineEvent?: CoordinationEventV1;
}
export interface CoordinationRequestsDocV1 { version: 1; rows: CoordinationRequestRowV1[] }

export interface EndeavorIndexEntryV1 {
  endeavorId: string;
  title: string;
  lifecycle: EndeavorLifecycle;
  revision: number;
  /** Participants (any status, lowercased) — the §12 visibility filter's input, never authority. */
  participants: string[];
  requester: string;
  updatedAt: string;
  /** Adopted-plan progress (display projection only). */
  stepsTotal?: number;
  stepsSatisfied?: number;
}
export interface CoordinationIndexDocV1 { version: 1; endeavors: Record<string, EndeavorIndexEntryV1> }

// ── DO seams (injected by InteractionsDO — no new mechanism, the channels.* closures) ──
export interface EndeavorOpDeps {
  /** Managing principal SA (lowercased 0x) — this DO's shard. */
  principal: string;
  /** Managing principal as CAIP-10 (topic descriptor owner). */
  principalCaip: string;
  /** Broker-verified session SA (the ingress signature verification — same mechanism as channels.*). */
  sessionSa: string;
  sessionCaip: string;
  readDoc<T>(resource: string, empty: T): Promise<T>;
  writeDoc(resource: string, data: unknown): Promise<void>;
  serialize<T>(fn: () => Promise<T>): Promise<T>;
  /** Gate-time directory-listing membership (ERC-1271-re-proven) — null when not a member. */
  memberName(): Promise<string | null>;
  /** Presented org stewardship wire, verified + unrevoked. */
  isSteward(): Promise<boolean>;
  /** ERC-1271 verification against an SA (the DO's universal fail-closed path). */
  verifySignature(account: Address, digest: Hex32, signature: `0x${string}`): Promise<boolean>;
  /** Audit row (actor = session SA) — callers invoke it BEFORE the commit writes. */
  writeAudit(action: string, subject: { type: string; id: string }, timestamp?: string): Promise<void>;
  /** Persist a fabric message body at the envelope's own resource (hash-bound). */
  putTopicBody(envelope: AnyMessageEnvelope, bodyText: string): Promise<void>;
  /** OPTIONAL — spec 375: called after a command COMMITS with the events it appended, so the events can
   *  fire the participants' triggers. Fire-and-forget: the caller must not await inside `serialize`. */
  onCommitted?(endeavorId: string, events: CoordinationEventV1[], state: CoordinationStateV1): void;
  /** OPTIONAL — fire-and-forget hand-off to the org's own agent to DRAFT a multi-step plan from the
   *  adopted goal (spec 327 planner reused; the org is the actor via internal.endeavor.proposePlan).
   *  Absent (internal doors, unconfigured LLM) ⇒ no auto-draft, the steward authors the plan by hand. */
  draftPlanForGoal?(endeavorId: string, goal: string): void;
}

const json = (b: unknown, s = 200): Response =>
  new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });

// ── Pure helpers (unit-tested) ──

/** Rehydrate coordination state by reducing the append-only event log (logs are small in V1). */
export function reduceEventLog(events: CoordinationEventV1[]): CoordinationStateV1 {
  let state = initialCoordinationState();
  for (const e of events) state = applyCoordinationEvent(state, e);
  return state;
}

export function hasParticipation(state: CoordinationStateV1, viewerSa: string): boolean {
  const me = viewerSa.toLowerCase();
  return Object.values(state.participations).some(
    (p) => p.participant.toLowerCase() === me && (p.status === 'active' || p.status === 'invited'),
  );
}

const OPEN_LIFECYCLES = new Set<EndeavorLifecycle>(['adopted', 'active']);

/** §12 visibility over index rows: stewards see all; members see open endeavors + ones they
 *  participate in; anyone sees endeavors they participate in. */
export function visibleEndeavorRows(
  entries: EndeavorIndexEntryV1[],
  viewerSa: string,
  opts: { steward: boolean; member: boolean },
): EndeavorIndexEntryV1[] {
  if (opts.steward) return entries;
  const me = viewerSa.toLowerCase();
  return entries.filter(
    (e) => e.participants.includes(me) || (opts.member && OPEN_LIFECYCLES.has(e.lifecycle)),
  );
}

/** §12 visibility for one endeavor: participants/stewards see it fully; members see open endeavors;
 *  the requester sees only their own request's status; everyone else sees nothing. */
export function endeavorViewFor(
  state: CoordinationStateV1,
  viewerSa: string,
  opts: { steward: boolean; member: boolean },
): 'full' | 'request-only' | 'none' {
  if (opts.steward) return 'full';
  const me = viewerSa.toLowerCase();
  if (hasParticipation(state, me)) return 'full';
  const lifecycle = state.endeavor?.lifecycle;
  if (opts.member && lifecycle && OPEN_LIFECYCLES.has(lifecycle)) return 'full';
  if (state.request?.record.requester.toLowerCase() === me) return 'request-only';
  return 'none';
}

export function indexEntryFromState(state: CoordinationStateV1, updatedAt: string): EndeavorIndexEntryV1 | null {
  const endeavor = state.endeavor;
  if (!endeavor) return null;
  const adopted = endeavor.adoptedPlanRef
    ? Object.values(state.plans).find(
        (p) => p.planId === endeavor.adoptedPlanRef!.planId && p.revision === endeavor.adoptedPlanRef!.revision,
      )
    : undefined;
  return {
    endeavorId: endeavor.endeavorId,
    title: endeavor.title,
    lifecycle: endeavor.lifecycle,
    revision: state.revision,
    participants: [...new Set(Object.values(state.participations).map((p) => p.participant.toLowerCase()))],
    requester: (state.request?.record.requester ?? '').toLowerCase(),
    updatedAt,
    ...(adopted
      ? {
          stepsTotal: adopted.steps.length,
          stepsSatisfied: adopted.steps.filter((s) => state.satisfiedSteps[s.stepId]).length,
        }
      : {}),
  };
}

/** Adopted plan (exact revision) — or, when none is adopted yet, the newest revision, so the
 *  detail view can render the proposal honestly (its `status` says which it is). */
function planProjection(state: CoordinationStateV1): {
  planId: string; revision: number; contentHash: string; status: string; proposedBy: string;
  steps: Array<{
    stepId: string; kind: string; description: string; satisfied: boolean; evidence?: string;
    /** What the step NEEDS, carried through so a reader can route it to a specialist. Dropped here
     *  until now, which meant a plan could name the capability and every consumer saw a step that
     *  declared none — routing would have decided "run it locally" for every step, forever, and
     *  looked exactly like a plan that never wanted a specialist. */
    capabilityRequirements?: CapabilityRequirementRef[];
  }>;
} | null {
  const adoptedRef = state.endeavor?.adoptedPlanRef;
  const all = Object.values(state.plans);
  const plan = adoptedRef
    ? all.find((p) => p.planId === adoptedRef.planId && p.revision === adoptedRef.revision)
    : all.sort((a, b) => b.revision - a.revision)[0];
  if (!plan) return null;
  return {
    planId: plan.planId,
    revision: plan.revision,
    contentHash: plan.contentHash,
    status: plan.status,
    proposedBy: plan.proposedBy.toLowerCase(),
    steps: plan.steps.map((s) => {
      const done = state.satisfiedSteps[s.stepId];
      return {
        stepId: s.stepId,
        kind: s.kind,
        description: s.description,
        satisfied: !!done,
        ...(s.capabilityRequirements?.length ? { capabilityRequirements: s.capabilityRequirements } : {}),
        ...(done ? { evidence: decodeEvidenceNote(done.evidenceRefs) } : {}),
      };
    }),
  };
}

/** Decode the free-text note encoded by `parseEvidenceRefs` / endeavor.satisfy back to display
 *  text (`urn:ap:evidence:` / `urn:ap:outcome:`); other refs render as their iri/id. */
function decodeEvidenceNote(refs: EntityRef[]): string | undefined {
  for (const r of refs) {
    if (r.kind !== 'resource') continue;
    const m = /^urn:ap:(?:evidence|outcome):(.*)$/.exec(r.iri);
    if (m) {
      try { return decodeURIComponent(m[1]!); } catch { return m[1]; }
    }
  }
  return undefined;
}

/** The agent/coordinator's outcome summary — the note recorded on EndeavorSatisfied, decoded back
 *  to display text. This is the requester-facing "what came of it" (spec 334 §7 outcome). */
function outcomeSummaryFromLog(events: CoordinationEventV1[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === 'EndeavorSatisfied') return decodeEvidenceNote([e.outcomeValidationRef]) ?? null;
  }
  return null;
}

/** The Provenance-trail rows: the ordered event log projected to display facts only. */
export function eventTrail(events: CoordinationEventV1[]): Array<{ type: string; at: string; actor?: string; summary?: string }> {
  return events.map((e) => {
    const actor =
      'proposedBy' in e ? e.proposedBy
      : 'adoptedBy' in e ? e.adoptedBy
      : 'rejectedBy' in e ? e.rejectedBy
      : 'invitedBy' in e ? e.invitedBy
      : 'decidedBy' in e ? e.decidedBy
      : 'recordedBy' in e ? e.recordedBy
      : 'declinedBy' in e ? e.declinedBy
      : 'proposer' in e ? e.proposer
      : 'participant' in e ? e.participant
      : e.kind === 'EndeavorRequestSubmitted' ? e.request.requester
      : undefined;
    const summary =
      e.kind === 'EndeavorRequestSubmitted' ? e.request.goal
      : e.kind === 'EndeavorAdopted' ? e.title
      : e.kind === 'PlanProposed' ? `revision ${e.planRevision}`
      : e.kind === 'PlanAdopted' ? `revision ${e.planRef.revision}`
      : e.kind === 'PlanStepSatisfied' ? decodeEvidenceNote(e.evidenceRefs) ?? e.stepId
      : e.kind === 'EndeavorSatisfied' ? decodeEvidenceNote([e.outcomeValidationRef])
      : 'reason' in e && e.reason ? e.reason
      : undefined;
    return {
      type: e.kind,
      at: e.occurredAt,
      ...(actor ? { actor } : {}),
      ...(summary ? { summary } : {}),
    };
  });
}

/** The caller's own coordination facts across the given endeavors — allocations awaiting their
 *  commitment + their commitments (spec 334 §7 My Work; decisions ship with the 333 wave). */
async function mineAcross(
  deps: EndeavorOpDeps,
  entries: EndeavorIndexEntryV1[],
  viewer: string,
): Promise<{ allocations: unknown[]; commitments: unknown[]; decisions: unknown[] }> {
  const allocations: unknown[] = [];
  const commitments: unknown[] = [];
  // PARALLEL per-endeavor reads (was a sequential for-await, so wall-time was the SUM of every
  // endeavor's log read — the dominant cost of endeavor.list, and doubly so through the /work
  // cross-org fan-out). The vault reads are independent, so fan them out: wall-time is now the
  // slowest single read, not their sum. Ordering is preserved by mapping then concatenating.
  const perEntry = await Promise.all(
    entries.map(async (entry) => {
      const log = await deps.readDoc<CoordinationEventV1[]>(coordinationEventsResource(entry.endeavorId), []);
      if (log.length === 0) return { allocations: [] as unknown[], commitments: [] as unknown[] };
      const state = reduceEventLog(log);
      const adoptedRef = state.endeavor?.adoptedPlanRef;
      const a2: unknown[] = [];
      const c2: unknown[] = [];
      for (const a of Object.values(state.allocations)) {
        if (a.participant.toLowerCase() !== viewer || a.status !== 'allocated') continue;
        a2.push({
          allocationId: a.allocationId,
          endeavorId: entry.endeavorId,
          endeavorTitle: entry.title,
          participant: a.participant,
          steps: a.steps,
          ...(adoptedRef ? { planRef: adoptedRef } : {}),
        });
      }
      for (const c of Object.values(state.commitments)) {
        if (c.participant.toLowerCase() !== viewer) continue;
        c2.push({
          commitmentId: c.commitmentId,
          endeavorId: entry.endeavorId,
          endeavorTitle: entry.title,
          allocationRef: c.allocationRef,
          participant: c.participant,
          planRef: c.planRef,
          steps: c.steps,
          status: c.status,
          ...(c.bounds ? { bounds: c.bounds } : {}),
        });
      }
      return { allocations: a2, commitments: c2 };
    }),
  );
  for (const r of perEntry) { allocations.push(...r.allocations); commitments.push(...r.commitments); }
  return { allocations, commitments, decisions: [] };
}

/** Canonical commitment payload digest — deterministic JSON (sorted keys) over the fields the
 *  participant signs. The adopted plan revision hash is INSIDE the preimage (`planRef.hash`), so a
 *  signature over a stale revision can never verify against the current adopted ref (rule 2b). */
export function commitmentPayloadDigest(payload: {
  endeavorId: string;
  allocationRef: string;
  planRef: PlanRevisionRef;
  steps: PlanStepId[];
}): Promise<Hex32> {
  return sha256Hex32(canonicalizeMessage({
    endeavorId: payload.endeavorId,
    allocationRef: payload.allocationRef,
    planRef: { planId: payload.planRef.planId, revision: payload.planRef.revision, hash: payload.planRef.hash },
    steps: payload.steps,
  }));
}

/** Command validation rejects map to HTTP: actor-gate rejects ("only the …") are 403; state
 *  conflicts (stale hash, wrong status, duplicates) are 409. Never a weaker retry path. */
export function commandRejectStatus(reason: string): number {
  return /^only /i.test(reason) || /must be (recorded|proposed) by/i.test(reason) || /proposer must be/i.test(reason) ? 403 : 409;
}

// ── Fail-closed wire parsing (shape pinning — junk never reaches the log) ──

const HEX32_RE = /^0x[0-9a-f]{64}$/;
const ADDR_RE = /^0x[0-9a-f]{40}$/;
const STEP_KINDS = new Set(['contribution', 'interaction', 'decision', 'aggregation', 'validation']);
const EDGE_KINDS = new Set(['precedes', 'depends-on', 'alternative', 'condition', 'compensates', 'refines']);
const ENTRY_POINTS = new Set<EndeavorEntryPoint>(['home-request', 'discussion-ask', 'inbox-ask', 'a2a-intent']);
const SIG_SCHEMES = new Set(['erc1271', 'erc6492', 'ecdsa', 'webauthn']);
const ASSERTION_STRENGTHS = new Set(['declared', 'claimed', 'demonstrated']);

export function parsePlanSteps(raw: unknown): PlanStepV1[] | null {
  // Boundary 2 of 2 — see the propose-side log. In vs out, so a strip here is visible rather than
  // inferred; this parser has already dropped this field once, silently.
  if (Array.isArray(raw)) {
    console.log('[parsePlanSteps] in:',
      JSON.stringify(raw.map((x) => (x as Record<string, unknown>)?.capabilityRequirements ?? null)));
  }
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const steps: PlanStepV1[] = [];
  for (const s of raw) {
    const o = (s ?? {}) as Record<string, unknown>;
    const stepId = String(o.stepId ?? '');
    const kind = String(o.kind ?? '');
    const description = String(o.description ?? '').trim();
    if (!stepId.startsWith('step_') || stepId.length <= 5 || !STEP_KINDS.has(kind) || !description) return null;
    // CAPABILITY REQUIREMENTS SURVIVE THE WIRE. PlanStepV1 has carried this field all along and this
    // parser silently dropped it, so a plan could name the capability a step needs and the stored
    // plan would not — which makes routing a step to the agent that holds the capability impossible
    // no matter what the planner said. Shape-pinned like everything else here: a malformed entry is
    // skipped, not trusted, and never fails the whole plan (a reference is not authority, ADR-0053).
    const caps: CapabilityRequirementRef[] = [];
    if (Array.isArray(o.capabilityRequirements)) {
      for (const c of o.capabilityRequirements) {
        const co = (c ?? {}) as Record<string, unknown>;
        const iri = String(co.capabilityIri ?? '').trim();
        const strength = String(co.minAssertionStrength ?? 'declared');
        if (!iri || iri.length > 300) continue;
        if (!ASSERTION_STRENGTHS.has(strength)) continue;
        caps.push({ capabilityIri: iri, minAssertionStrength: strength as CapabilityRequirementRef['minAssertionStrength'] });
      }
    }
    steps.push({
      stepId: stepId as PlanStepId, kind: kind as PlanStepV1['kind'], description,
      ...(caps.length ? { capabilityRequirements: caps } : {}),
    });
  }
  console.log('[parsePlanSteps] out:', JSON.stringify(steps.map((x) => x.capabilityRequirements ?? null)));
  return steps;
}

export function parsePlanEdges(raw: unknown): PlanEdgeV1[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const edges: PlanEdgeV1[] = [];
  for (const e of raw) {
    const o = (e ?? {}) as Record<string, unknown>;
    const from = String(o.from ?? '');
    const to = String(o.to ?? '');
    const kind = String(o.kind ?? '');
    if (!from.startsWith('step_') || !to.startsWith('step_') || !EDGE_KINDS.has(kind)) return null;
    edges.push({ from: from as PlanStepId, to: to as PlanStepId, kind: kind as PlanEdgeV1['kind'] });
  }
  return edges;
}

export function parseMilestones(raw: unknown): MilestoneDefinitionV1[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const milestones: MilestoneDefinitionV1[] = [];
  for (const m of raw) {
    const o = (m ?? {}) as Record<string, unknown>;
    const milestoneId = String(o.milestoneId ?? '').trim();
    const title = String(o.title ?? '').trim();
    if (!milestoneId || !title) return null;
    const criteria = Array.isArray(o.criteria)
      ? o.criteria
          .map((c) => ({ criterionId: String((c as Record<string, unknown>)?.criterionId ?? '').trim() }))
          .filter((c) => c.criterionId)
      : [];
    milestones.push({ milestoneId, title, criteria });
  }
  return milestones;
}

export function parsePlanRef(raw: unknown): PlanRevisionRef | null {
  const o = (raw ?? {}) as Record<string, unknown>;
  const planId = String(o.planId ?? '');
  const revision = Number(o.revision);
  const hash = String(o.hash ?? '').toLowerCase();
  if (!planId.startsWith('plan_') || planId.length <= 5) return null;
  if (!Number.isInteger(revision) || revision < 1) return null;
  if (!HEX32_RE.test(hash)) return null;
  return { planId: planId as PlanRevisionRef['planId'], revision, hash: hash as Hex32 };
}

export function parseStepIds(raw: unknown): PlanStepId[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const steps: PlanStepId[] = [];
  for (const s of raw) {
    const id = String(s ?? '');
    if (!id.startsWith('step_') || id.length <= 5) return null;
    steps.push(id as PlanStepId);
  }
  return steps;
}

export function parseSignedPayloadRef(raw: unknown): SignedPayloadRef | null {
  const o = (raw ?? {}) as Record<string, unknown>;
  const payloadHash = String(o.payloadHash ?? '').toLowerCase();
  const signer = String(o.signer ?? '').toLowerCase();
  const scheme = String(o.scheme ?? '');
  const signature = String(o.signature ?? '');
  if (!HEX32_RE.test(payloadHash) || !ADDR_RE.test(signer) || !SIG_SCHEMES.has(scheme)) return null;
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) return null;
  return {
    payloadHash: payloadHash as Hex32,
    signer: signer as Address,
    scheme: scheme as SignedPayloadRef['scheme'],
    signature: signature as `0x${string}`,
  };
}

function parseCriteria(raw: unknown, goal: string): OutcomeCriterionV1[] | null {
  if (raw === undefined || raw === null) {
    // V1 intake default: adoption without explicit criteria records the requester's confirmation
    // as the single reviewable success condition (the reducer requires ≥ 1 criterion).
    return [{ criterionId: `crit_${crypto.randomUUID()}`, kind: 'reviewable', statement: `Requester confirms the goal is satisfied: ${goal}` }];
  }
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const criteria: OutcomeCriterionV1[] = [];
  for (const c of raw) {
    const o = (c ?? {}) as Record<string, unknown>;
    const kind = String(o.kind ?? '');
    const statement = String(o.statement ?? '').trim();
    if (!['measurable', 'attestable', 'reviewable'].includes(kind) || !statement) return null;
    criteria.push({
      criterionId: String(o.criterionId ?? '').trim() || `crit_${crypto.randomUUID()}`,
      kind: kind as OutcomeCriterionV1['kind'],
      statement,
    });
  }
  return criteria;
}

function parseEndeavorId(raw: unknown): string | null {
  const id = String(raw ?? '');
  return id.startsWith('end_') && id.length > 4 ? id : null;
}

/** Evidence for step/endeavor completion: a free-text note from the UI becomes ONE resource
 *  EntityRef (`urn:ap:evidence:<encoded>`), so the reducer's "requires evidence" invariant is met
 *  without inventing a vault artifact for a demo note. The provenance projection decodes it back. */
/** How much of a step's deliverable the log keeps INLINE.
 *
 *  It was 4000 characters, which is fine for "booked the venue" and destroys the one case the
 *  coordination plane now has to carry: a document. An ontology, a draft, a report — the artefact
 *  IS the deliverable, and a silently clipped one is worse than none, because it reads as complete.
 *
 *  Inline is the honest shape here rather than a vault ref: the evidence is what a requester who was
 *  granted `endeavor.state` is entitled to read, and a ref would put it behind a vault scope that
 *  the Operational Intent grant deliberately does not carry. The cost is a larger event log, paid by
 *  the endeavor that produced the document. If deliverables outgrow this, the answer is an artifact
 *  store with its own read authority — not a bigger number.
 *
 *  EXPORTED because the work skill clips the deliverable BEFORE it ever reaches here. That clip was a
 *  separate 4000 and this ceiling never governed anything on that path — raising this number alone
 *  changed nothing. One constant now, so the two cannot drift again. */
// 256k, not 64k. An ontology CHANGE PLAN is a deliverable, not a note: Update produced one and it
// arrived at EXACTLY 64,000 characters — cut mid-triple, so the editor refused to save it and the
// number was the only clue. The gateway admits 1 MB and the archetype path already carries 400k;
// this was the last 64k cap in the chain.
export const EVIDENCE_MAX = 256_000;

/** Spec 382 W2 — typed receipt refs a satisfied step may carry: the receipt namespace only, deduplicated, bounded. */
export function typedReceiptRefs(refs: unknown): EntityRef[] {
  if (!Array.isArray(refs)) return [];
  const seen = new Set<string>();
  const out: EntityRef[] = [];
  for (const r of refs.slice(0, 16)) {
    const iri = String(r ?? '').trim();
    if (!/^urn:ap:receipt:(run|mandate|tx|commitment|offer|fulfillment):[A-Za-z0-9._:-]{1,200}$/.test(iri) || seen.has(iri)) continue;
    seen.add(iri); out.push({ kind: 'resource', iri });
  }
  return out;
}

function parseEvidenceRefs(note: unknown): EntityRef[] {
  const text = String(note ?? '').trim();
  if (!text) return [];
  return [{ kind: 'resource', iri: `urn:ap:evidence:${encodeURIComponent(text.slice(0, EVIDENCE_MAX))}` }];
}

// ── The mutation spine: validate command → append events → re-reduce → persist projections. ──
// MUST run inside deps.serialize (the callers hold the mutex across this whole RMW).
async function appendToEndeavorLog(
  deps: EndeavorOpDeps,
  op: string,
  endeavorId: string,
  command: CoordinationCommandV1,
  subject: { type: string; id: string },
): Promise<{ ok: true; state: CoordinationStateV1; events: CoordinationEventV1[] } | { ok: false; response: Response }> {
  const log = await deps.readDoc<CoordinationEventV1[]>(coordinationEventsResource(endeavorId), []);
  if (log.length === 0) return { ok: false, response: json({ error: 'unknown endeavor' }, 404) };
  const state = reduceEventLog(log);
  const r = validateCoordinationCommand(state, command);
  if (!r.ok) return { ok: false, response: json({ error: r.reason }, commandRejectStatus(r.reason)) };
  let next = state;
  for (const e of r.events) next = applyCoordinationEvent(next, e);
  const now = new Date().toISOString();
  await deps.writeAudit(`interactions.${op}`, subject, now);
  await deps.writeDoc(coordinationEventsResource(endeavorId), [...log, ...r.events]);
  await deps.writeDoc(coordinationStateResource(endeavorId), next);
  const entry = indexEntryFromState(next, now);
  if (entry) {
    const index = await deps.readDoc<CoordinationIndexDocV1>(COORDINATION_INDEX_RESOURCE, { version: 1, endeavors: {} });
    index.endeavors[endeavorId] = entry;
    await deps.writeDoc(COORDINATION_INDEX_RESOURCE, index);
  }
  // Spec 375 — the appended events fire the participants' triggers. Scheduled, never awaited: a fired run
  // may call back into this object, and awaiting it inside the mutex would deadlock the log.
  try { deps.onCommitted?.(endeavorId, r.events, next); } catch (e) { console.warn('[endeavor] onCommitted threw:', e instanceof Error ? e.message : String(e)); }
  return { ok: true, state: next, events: r.events };
}

// ── Op dispatch ──
export async function handleEndeavorOp(
  deps: EndeavorOpDeps,
  op: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const viewer = deps.sessionSa.toLowerCase() as Address;
  const principal = deps.principal.toLowerCase() as Address;

  // ── endeavor.request — any authenticated session (the requester's own signed session). ──
  if (op === 'endeavor.request') {
    const goal = String(body.goal ?? '').trim();
    if (!goal) return json({ error: 'goal required' }, 400);
    const entryPointRaw = String(body.entryPoint ?? 'home-request') as EndeavorEntryPoint;
    if (!ENTRY_POINTS.has(entryPointRaw)) return json({ error: 'unknown entryPoint' }, 400);
    const intakeContext = Array.isArray(body.intakeContext)
      ? (body.intakeContext as Array<Record<string, unknown>>)
          .map((r) => ({ kind: String(r?.kind ?? '').trim(), id: String(r?.id ?? '').trim() }))
          .filter((r) => r.kind && r.id)
          .slice(0, 8)
      : [];
    const command: CoordinationCommandV1 = {
      kind: 'SubmitEndeavorRequest',
      actor: viewer,
      issuedAt: new Date().toISOString(),
      requestId: makeEndeavorRequestId(crypto.randomUUID()),
      targetPrincipal: principal,
      goal,
      entryPoint: entryPointRaw,
      ...(intakeContext.length ? { intakeContext } : {}),
    };
    const r = validateCoordinationCommand(initialCoordinationState(), command);
    if (!r.ok) return json({ error: r.reason }, commandRejectStatus(r.reason));
    const event = r.events[0] as SubmitEvent;
    return deps.serialize(async () => {
      const doc = await deps.readDoc<CoordinationRequestsDocV1>(COORDINATION_REQUESTS_RESOURCE, { version: 1, rows: [] });
      await deps.writeAudit('interactions.endeavor.request', { type: 'endeavor-request', id: event.requestId });
      const row: CoordinationRequestRowV1 = { request: event.request, event, status: 'pending' };
      doc.rows = [...doc.rows, row].slice(-REQUESTS_CAP);
      await deps.writeDoc(COORDINATION_REQUESTS_RESOURCE, doc);
      // Spec 375 — a request is RECORDED before any log exists (adoption seeds the log with this very
      // event); the recording is the commit that fires `EndeavorRequestSubmitted` triggers.
      try { deps.onCommitted?.(event.requestId, [event], initialCoordinationState()); } catch (e) { console.warn('[endeavor] onCommitted threw:', e instanceof Error ? e.message : String(e)); }
      return json({ ok: true, requestId: event.requestId });
    });
  }

  // ── endeavor.list / endeavor.get — read-only, §12 visibility. ──
  if (op === 'endeavor.list') {
    const [name, steward] = await Promise.all([deps.memberName(), deps.isSteward()]);
    const index = await deps.readDoc<CoordinationIndexDocV1>(COORDINATION_INDEX_RESOURCE, { version: 1, endeavors: {} });
    const requests = await deps.readDoc<CoordinationRequestsDocV1>(COORDINATION_REQUESTS_RESOURCE, { version: 1, rows: [] });
    const endeavors = visibleEndeavorRows(Object.values(index.endeavors), viewer, { steward, member: !!name });
    // METADATA-FIRST (VL-W4 parity): the requester's outcome window takes the endeavor lifecycle from
    // the INDEX doc we already read — no per-request event-log read. `outcomeSummary` is intentionally
    // deferred to `endeavor.get` (the detail view), so the list is 2 reads flat regardless of request
    // count instead of 2 + N. The "Your requests" status line (adopted/completed) is driven by the
    // lifecycle; the inline outcome text now loads on "View result".
    const endeavorById = new Map(Object.values(index.endeavors).map((e) => [e.endeavorId, e]));
    const requestRows = (steward ? requests.rows : requests.rows.filter((r) => r.request.requester.toLowerCase() === viewer))
      .map((r) => {
        const idx = r.endeavorId ? endeavorById.get(r.endeavorId) : undefined;
        return {
          requestId: r.request.requestId,
          requester: r.request.requester,
          goal: r.request.goal,
          entryPoint: r.request.entryPoint,
          submittedAt: r.request.submittedAt,
          status: r.status,
          ...(r.endeavorId ? { endeavorId: r.endeavorId } : {}),
          ...(r.reason ? { reason: r.reason } : {}),
          ...(idx?.lifecycle ? { endeavorLifecycle: idx.lifecycle } : {}),
        };
      });
    // §7 My Work: the caller's own allocations/commitments across VISIBLE endeavors only.
    const mine = await mineAcross(deps, endeavors, viewer);
    return json({ ok: true, endeavors, requests: requestRows, mine, steward, member: !!name, you: viewer });
  }

  if (op === 'endeavor.get') {
    const endeavorId = parseEndeavorId(body.endeavorId);
    if (!endeavorId) return json({ error: 'endeavorId required' }, 400);
    const [name, steward] = await Promise.all([deps.memberName(), deps.isSteward()]);
    const log = await deps.readDoc<CoordinationEventV1[]>(coordinationEventsResource(endeavorId), []);
    if (log.length === 0) return json({ error: 'unknown endeavor' }, 404);
    const state = reduceEventLog(log);
    const view = endeavorViewFor(state, viewer, { steward, member: !!name });
    if (view === 'none') return json({ error: 'not visible to this session' }, 403);
    if (view === 'request-only') {
      const req = state.request;
      return json({
        ok: true,
        view,
        request: req ? { requestId: req.record.requestId, goal: req.record.goal, submittedAt: req.record.submittedAt, status: req.status } : null,
        // The requester's window into their own request's result: the endeavor's lifecycle + the
        // agent's outcome summary once satisfied (they see the "what came of it" without full access).
        endeavorLifecycle: state.endeavor?.lifecycle ?? null,
        outcomeSummary: outcomeSummaryFromLog(log),
      });
    }
    const entry = indexEntryFromState(state, new Date().toISOString());
    return json({
      ok: true,
      view,
      steward,
      revision: state.revision,
      // The Work-detail projection: the endeavor row with its outcome criteria embedded
      // (display strings), the adopted plan with per-step satisfied facts, and the ordered
      // event log as the Provenance trail.
      endeavor: state.endeavor
        ? {
            ...state.endeavor,
            ...(entry ? { stepsTotal: entry.stepsTotal, stepsSatisfied: entry.stepsSatisfied } : {}),
            ...(state.outcome
              ? { outcome: { criteria: state.outcome.criteria.map((c) => c.statement) } }
              : {}),
          }
        : null,
      outcome: state.outcome ?? null,
      outcomeSummary: outcomeSummaryFromLog(log),
      request: state.request ? { requestId: state.request.record.requestId, requester: state.request.record.requester, goal: state.request.record.goal, status: state.request.status } : null,
      plan: planProjection(state),
      plans: Object.values(state.plans),
      participations: Object.values(state.participations),
      proposals: Object.values(state.proposals),
      allocations: Object.values(state.allocations).map((a) => ({
        ...a,
        ...(state.endeavor?.adoptedPlanRef ? { planRef: state.endeavor.adoptedPlanRef } : {}),
      })),
      commitments: Object.values(state.commitments),
      decisions: [],
      satisfiedSteps: Object.values(state.satisfiedSteps),
      milestones: Object.values(state.milestones),
      events: eventTrail(log),
    });
  }

  // ── endeavor.create — steward-gated triage decision: adopt or decline a pending request. ──
  if (op === 'endeavor.create') {
    if (!(await deps.isSteward())) return json({ error: 'only the organization custodian may triage endeavor requests' }, 403);
    const requestId = String(body.requestId ?? '');
    if (!requestId.startsWith('ereq_')) return json({ error: 'requestId required' }, 400);
    const decision = body.decision === 'decline' ? 'decline' : body.decision === 'adopt' ? 'adopt' : null;
    if (!decision) return json({ error: 'decision must be "adopt" or "decline"' }, 400);
    return deps.serialize(async () => {
      const doc = await deps.readDoc<CoordinationRequestsDocV1>(COORDINATION_REQUESTS_RESOURCE, { version: 1, rows: [] });
      const row = doc.rows.find((r) => r.request.requestId === requestId);
      if (!row) return json({ error: 'unknown request' }, 404);
      if (row.status !== 'pending') return json({ error: `request is ${row.status}, not pending` }, 409);
      const state0 = applyCoordinationEvent(initialCoordinationState(), row.event);
      const now = new Date().toISOString();

      if (decision === 'decline') {
        const reason = String(body.reason ?? '').trim() || 'declined';
        const command: CoordinationCommandV1 = {
          kind: 'DeclineEndeavorRequest',
          actor: principal,
          issuedAt: now,
          requestId: row.request.requestId,
          reason,
        };
        const r = validateCoordinationCommand(state0, command);
        if (!r.ok) return json({ error: r.reason }, commandRejectStatus(r.reason));
        await deps.writeAudit('interactions.endeavor.create', { type: 'endeavor-request', id: requestId }, now);
        row.status = 'declined';
        row.reason = reason;
        row.decidedAt = now;
        row.declineEvent = r.events[0];
        await deps.writeDoc(COORDINATION_REQUESTS_RESOURCE, doc);
        return json({ ok: true, requestId, status: 'declined' });
      }

      const goal = row.request.goal;
      const criteria = parseCriteria(body.criteria, goal);
      if (!criteria) return json({ error: 'criteria must be a non-empty array of { kind, statement }' }, 400);
      const endeavorId = makeEndeavorId(crypto.randomUUID());
      const command: CoordinationCommandV1 = {
        kind: 'AdoptEndeavor',
        actor: principal,
        issuedAt: now,
        requestId: row.request.requestId,
        endeavorId,
        situationId: `sit_${crypto.randomUUID()}`,
        title: String(body.title ?? '').trim() || goal.slice(0, 80),
        outcome: { outcomeId: `out_${crypto.randomUUID()}`, criteria },
        // The acting steward is the endeavor's coordinator (spec 332 §6: adoption asserts the
        // sponsor/coordinator participations). Selection only — no delegation is minted here.
        initialParticipations: [{ participationId: makeParticipationId(crypto.randomUUID()), participant: viewer, role: 'coordinator' }],
      };
      const r = validateCoordinationCommand(state0, command);
      if (!r.ok) return json({ error: r.reason }, commandRejectStatus(r.reason));
      let next = state0;
      for (const e of r.events) next = applyCoordinationEvent(next, e);
      await deps.writeAudit('interactions.endeavor.create', { type: 'endeavor', id: endeavorId }, now);
      await deps.writeDoc(coordinationEventsResource(endeavorId), [row.event, ...r.events]);
      await deps.writeDoc(coordinationStateResource(endeavorId), next);
      try { deps.onCommitted?.(endeavorId, [row.event, ...r.events], next); } catch (e) { console.warn('[endeavor] onCommitted threw:', e instanceof Error ? e.message : String(e)); }
      const entry = indexEntryFromState(next, now);
      if (entry) {
        const index = await deps.readDoc<CoordinationIndexDocV1>(COORDINATION_INDEX_RESOURCE, { version: 1, endeavors: {} });
        index.endeavors[endeavorId] = entry;
        await deps.writeDoc(COORDINATION_INDEX_RESOURCE, index);
      }
      row.status = 'adopted';
      row.endeavorId = endeavorId;
      row.decidedAt = now;
      await deps.writeDoc(COORDINATION_REQUESTS_RESOURCE, doc);
      // The org's OWN agent drafts a first plan revision from the goal (fire-and-forget; the steward
      // reviews/edits/adopts it). No auto-draft when the hook is absent (unconfigured / internal door).
      deps.draftPlanForGoal?.(endeavorId, goal);
      return json({ ok: true, endeavorId, revision: next.revision, planDraftRequested: !!deps.draftPlanForGoal });
    });
  }

  // ── endeavor.proposePlan — participant-or-member gated; the reducer enforces the participant
  //    semantic (proposer must be the managing principal or an active participant). ──
  if (op === 'endeavor.proposePlan') {
    const endeavorId = parseEndeavorId(body.endeavorId);
    if (!endeavorId) return json({ error: 'endeavorId required' }, 400);
    const steps = parsePlanSteps(body.steps);
    if (!steps) return json({ error: 'steps must be a non-empty array of { stepId: step_*, kind, description }' }, 400);
    const edges = parsePlanEdges(body.edges);
    if (!edges) return json({ error: 'invalid edges' }, 400);
    const milestones = parseMilestones(body.milestones);
    if (!milestones) return json({ error: 'invalid milestones' }, 400);
    const planIdRaw = String(body.planId ?? '');
    const planId = planIdRaw ? (planIdRaw.startsWith('plan_') && planIdRaw.length > 5 ? planIdRaw : null) : makeCoordinationPlanId(crypto.randomUUID());
    if (!planId) return json({ error: 'planId must be plan_*' }, 400);
    const [name, steward] = await Promise.all([deps.memberName(), deps.isSteward()]);
    return deps.serialize(async () => {
      const log = await deps.readDoc<CoordinationEventV1[]>(coordinationEventsResource(endeavorId), []);
      if (log.length === 0) return json({ error: 'unknown endeavor' }, 404);
      const state = reduceEventLog(log);
      if (!name && !steward && !hasParticipation(state, viewer)) {
        return json({ error: 'join this community (or this endeavor) first' }, 403);
      }
      let maxRevision = 0;
      for (const p of Object.values(state.plans)) {
        if (p.planId === planId && p.revision > maxRevision) maxRevision = p.revision;
      }
      const command: CoordinationCommandV1 = {
        kind: 'ProposePlan',
        // Spec 382 — A STEWARD ACTS AS THE ORGANIZATION (the stewardship wire proves it), as adoption already does: when the org auto-adopted, no steward is a participant, and the reducer rightly refuses a plan from a non-participant.
      actor: steward ? principal : viewer,
        issuedAt: new Date().toISOString(),
        endeavorId: endeavorId as `end_${string}`,
        planId: planId as `plan_${string}`,
        revision: maxRevision + 1,
        steps,
        edges,
        milestones,
      };
      const r = validateCoordinationCommand(state, command);
      if (!r.ok) return json({ error: r.reason }, commandRejectStatus(r.reason));
      let next = state;
      for (const e of r.events) next = applyCoordinationEvent(next, e);
      const now = new Date().toISOString();
      await deps.writeAudit('interactions.endeavor.proposePlan', { type: 'coordination-plan', id: `${planId}@${maxRevision + 1}` }, now);
      await deps.writeDoc(coordinationEventsResource(endeavorId), [...log, ...r.events]);
      await deps.writeDoc(coordinationStateResource(endeavorId), next);
      try { deps.onCommitted?.(endeavorId, r.events, next); } catch (e) { console.warn('[endeavor] onCommitted threw:', e instanceof Error ? e.message : String(e)); }
      const entry = indexEntryFromState(next, now);
      if (entry) {
        const index = await deps.readDoc<CoordinationIndexDocV1>(COORDINATION_INDEX_RESOURCE, { version: 1, endeavors: {} });
        index.endeavors[endeavorId] = entry;
        await deps.writeDoc(COORDINATION_INDEX_RESOURCE, index);
      }
      const proposed = r.events[0];
      const contentHash = proposed && proposed.kind === 'PlanProposed' ? proposed.contentHash : null;
      return json({ ok: true, planId, revision: maxRevision + 1, contentHash });
    });
  }

  // ── endeavor.adoptPlan — steward-gated; binds the EXACT proposed revision hash. ──
  if (op === 'endeavor.adoptPlan') {
    if (!(await deps.isSteward())) return json({ error: 'only the organization custodian may adopt a plan' }, 403);
    const endeavorId = parseEndeavorId(body.endeavorId);
    if (!endeavorId) return json({ error: 'endeavorId required' }, 400);
    const planRef = parsePlanRef(body.planRef);
    if (!planRef) return json({ error: 'planRef { planId, revision, hash } required' }, 400);
    const command: CoordinationCommandV1 = {
      kind: 'AdoptPlan',
      // Spec 382 — steward-gated: the steward acts AS THE ORGANIZATION (its own endeavor), proven by the wire.
      actor: principal,
      issuedAt: new Date().toISOString(),
      endeavorId: endeavorId as `end_${string}`,
      planRef,
    };
    return deps.serialize(async () => {
      const r = await appendToEndeavorLog(deps, 'endeavor.adoptPlan', endeavorId, command, { type: 'coordination-plan', id: `${planRef.planId}@${planRef.revision}` });
      if (!r.ok) return r.response;
      return json({ ok: true, adoptedPlanRef: r.state.endeavor?.adoptedPlanRef ?? null, revision: r.state.revision });
    });
  }

  // ── endeavor.propose — participant-or-member gated contribution offer. ──
  if (op === 'endeavor.propose') {
    const endeavorId = parseEndeavorId(body.endeavorId);
    if (!endeavorId) return json({ error: 'endeavorId required' }, 400);
    const planRef = parsePlanRef(body.planRef);
    if (!planRef) return json({ error: 'planRef { planId, revision, hash } required' }, 400);
    const steps = parseStepIds(body.steps);
    if (!steps) return json({ error: 'steps (step_* ids) required' }, 400);
    const note = String(body.note ?? '').trim();
    const [name, steward] = await Promise.all([deps.memberName(), deps.isSteward()]);
    const proposalId = makeProposalId(crypto.randomUUID());
    return deps.serialize(async () => {
      const log = await deps.readDoc<CoordinationEventV1[]>(coordinationEventsResource(endeavorId), []);
      if (log.length === 0) return json({ error: 'unknown endeavor' }, 404);
      const state = reduceEventLog(log);
      if (!name && !steward && !hasParticipation(state, viewer)) {
        return json({ error: 'join this community (or this endeavor) first' }, 403);
      }
      const command: CoordinationCommandV1 = {
        kind: 'ProposeContribution',
        actor: viewer,
        issuedAt: new Date().toISOString(),
        endeavorId: endeavorId as `end_${string}`,
        proposalId,
        planRef,
        steps,
        ...(note ? { note } : {}),
      };
      // Spec 382 — A MEMBER'S OFFER IS ADMITTED AT THE ORGANIZATION'S OWN DOOR. The reducer admits a proposal
      // only from a participant or invitee, and adoption asserted only the coordinator: a member who
      // offered was refused for want of a participation nobody could give them (no invite op existed). A
      // member is already standing at the organization's door (the directory listing is what let them in);
      // the organization invites them as a contributor and their offer accepts it — three commands, one
      // append, each validated by the reducer in turn. Nothing here is authority (spec 332 §9 rule 1).
      const pre: CoordinationCommandV1[] = [];
      if (!hasParticipation(state, viewer) && (name || steward)) {
        const participationId = makeParticipationId(crypto.randomUUID());
        const issuedAt = new Date().toISOString();
        pre.push(
          { kind: 'InviteParticipant', actor: principal, issuedAt, endeavorId: endeavorId as `end_${string}`, participationId, participant: viewer, role: 'contributor' },
          { kind: 'AcceptParticipation', actor: viewer, issuedAt, endeavorId: endeavorId as `end_${string}`, participationId },
        );
      }
      let next = state;
      const appended: CoordinationEventV1[] = [];
      for (const c of [...pre, command]) {
        const r = validateCoordinationCommand(next, c);
        if (!r.ok) return json({ error: r.reason }, commandRejectStatus(r.reason));
        for (const e of r.events) { next = applyCoordinationEvent(next, e); appended.push(e); }
      }
      const now = new Date().toISOString();
      await deps.writeAudit('interactions.endeavor.propose', { type: 'contribution-proposal', id: proposalId }, now);
      await deps.writeDoc(coordinationEventsResource(endeavorId), [...log, ...appended]);
      await deps.writeDoc(coordinationStateResource(endeavorId), next);
      try { deps.onCommitted?.(endeavorId, appended, next); } catch (e) { console.warn('[endeavor] onCommitted threw:', e instanceof Error ? e.message : String(e)); }
      const entry = indexEntryFromState(next, now);
      if (entry) {
        const index = await deps.readDoc<CoordinationIndexDocV1>(COORDINATION_INDEX_RESOURCE, { version: 1, endeavors: {} });
        index.endeavors[endeavorId] = entry;
        await deps.writeDoc(COORDINATION_INDEX_RESOURCE, index);
      }
      return json({ ok: true, proposalId });
    });
  }

  // ── endeavor.allocate — steward-gated SELECTION. Records the decision only: no delegation,
  //    entitlement, or grant is minted or widened here (spec 334 §3 rule 2a). ──
  if (op === 'endeavor.allocate') {
    if (!(await deps.isSteward())) return json({ error: 'only the organization custodian may allocate contributions' }, 403);
    const endeavorId = parseEndeavorId(body.endeavorId);
    if (!endeavorId) return json({ error: 'endeavorId required' }, 400);
    const proposalRef = String(body.proposalRef ?? '');
    if (!proposalRef.startsWith('prop_')) return json({ error: 'proposalRef required' }, 400);
    const participant = String(body.participant ?? '').toLowerCase();
    if (!ADDR_RE.test(participant)) return json({ error: 'participant (0x address) required' }, 400);
    const steps = parseStepIds(body.steps);
    if (!steps) return json({ error: 'steps (step_* ids) required' }, 400);
    const allocationId = makeAllocationId(crypto.randomUUID());
    const command: CoordinationCommandV1 = {
      kind: 'AllocateContribution',
      // Spec 382 — steward-gated: the steward acts AS THE ORGANIZATION (its own endeavor), proven by the wire.
      actor: principal,
      issuedAt: new Date().toISOString(),
      endeavorId: endeavorId as `end_${string}`,
      allocationId,
      proposalRef: proposalRef as `prop_${string}`,
      participant: participant as Address,
      steps,
    };
    return deps.serialize(async () => {
      const r = await appendToEndeavorLog(deps, 'endeavor.allocate', endeavorId, command, { type: 'allocation', id: allocationId });
      if (!r.ok) return r.response;
      return json({ ok: true, allocationId });
    });
  }

  // ── endeavor.commit — ONLY the allocated participant's own session. The commitment payload
  //    digest binds the EXACT adopted plan revision hash; mismatch is 409, never coerced (rule 2b). ──
  if (op === 'endeavor.commit') {
    const endeavorId = parseEndeavorId(body.endeavorId);
    if (!endeavorId) return json({ error: 'endeavorId required' }, 400);
    const allocationRef = String(body.allocationRef ?? '');
    if (!allocationRef.startsWith('alloc_')) return json({ error: 'allocationRef required' }, 400);
    const planRef = parsePlanRef(body.planRef);
    if (!planRef) return json({ error: 'planRef { planId, revision, hash } required' }, 400);
    const steps = parseStepIds(body.steps);
    if (!steps) return json({ error: 'steps (step_* ids) required' }, 400);
    const signature = parseSignedPayloadRef(body.signature);
    if (!signature) return json({ error: 'signature { payloadHash, signer, scheme, signature } required' }, 400);
    if (signature.signer.toLowerCase() !== viewer) {
      return json({ error: 'commitments are signed by the participant — the signer must be your session SA' }, 403);
    }
    const deadline = String((body.bounds as Record<string, unknown> | undefined)?.deadline ?? '').trim();
    const commitmentId = makeCommitmentId(crypto.randomUUID());
    return deps.serialize(async () => {
      const log = await deps.readDoc<CoordinationEventV1[]>(coordinationEventsResource(endeavorId), []);
      if (log.length === 0) return json({ error: 'unknown endeavor' }, 404);
      const state = reduceEventLog(log);
      const adopted = state.endeavor?.adoptedPlanRef;
      if (!adopted) return json({ error: 'no adopted plan to commit against' }, 409);
      if (planRef.planId !== adopted.planId || planRef.revision !== adopted.revision || planRef.hash !== adopted.hash) {
        return json({ error: 'commitment plan revision hash is stale — commitments bind the exact adopted revision hash' }, 409);
      }
      const allocation = state.allocations[allocationRef];
      if (!allocation) return json({ error: 'unknown allocation' }, 404);
      if (allocation.participant.toLowerCase() !== viewer) {
        return json({ error: 'only the allocated participant may commit — this allocation names another participant' }, 403);
      }
      // The signed payload must be the canonical commitment digest (it INCLUDES the adopted plan
      // revision hash); then the signature must verify against the participant SA (ERC-1271
      // universal path — owner ECDSA / passkey validate through the SA's 1271 branch). Fail-closed.
      const digest = await commitmentPayloadDigest({ endeavorId, allocationRef, planRef, steps });
      if (signature.payloadHash !== digest) {
        return json({ error: 'commitment payload hash does not bind the adopted plan revision (stale or malformed payload)', expectedPayloadHash: digest }, 409);
      }
      if (!(await deps.verifySignature(viewer, digest, signature.signature))) {
        return json({ error: 'commitment signature failed verification against the participant' }, 403);
      }
      const command: CoordinationCommandV1 = {
        kind: 'CommitContribution',
        actor: viewer,
        issuedAt: new Date().toISOString(),
        endeavorId: endeavorId as `end_${string}`,
        commitmentId,
        allocationRef: allocationRef as `alloc_${string}`,
        planRef,
        steps,
        signature,
        ...(deadline ? { bounds: { deadline } } : {}),
      };
      const r = validateCoordinationCommand(state, command);
      if (!r.ok) return json({ error: r.reason }, commandRejectStatus(r.reason));
      let next = state;
      for (const e of r.events) next = applyCoordinationEvent(next, e);
      const now = new Date().toISOString();
      await deps.writeAudit('interactions.endeavor.commit', { type: 'commitment', id: commitmentId }, now);
      await deps.writeDoc(coordinationEventsResource(endeavorId), [...log, ...r.events]);
      await deps.writeDoc(coordinationStateResource(endeavorId), next);
      // Spec 382 — THE COMMITMENT IS THE ONE EVENT THAT HANDS WORK TO SOMEBODY, and this op alone never told
      // anyone it had committed: the participants' `on-commitment` triggers (375) never fired and no run
      // was parked. Same hook, same shape as every other op.
      try { deps.onCommitted?.(endeavorId, r.events, next); } catch (e) { console.warn('[endeavor] onCommitted threw:', e instanceof Error ? e.message : String(e)); }
      const entry = indexEntryFromState(next, now);
      if (entry) {
        const index = await deps.readDoc<CoordinationIndexDocV1>(COORDINATION_INDEX_RESOURCE, { version: 1, endeavors: {} });
        index.endeavors[endeavorId] = entry;
        await deps.writeDoc(COORDINATION_INDEX_RESOURCE, index);
      }
      return json({ ok: true, commitmentId });
    });
  }

  // ── endeavor.decide — spec 333 wave. @agenticprimitives/coordination ships NO RecordDecision
  //    command yet (`/decisions` is a reserved stub), so this op fails honestly rather than faking
  //    a decision record outside the reducer (ADR-0013: one mechanism, no imitation path). ──
  // ── endeavor.satisfyStep — record a plan step as satisfied with completion evidence. Gated by
  //    the reducer to the managing principal or an active participant (execution is done by the
  //    people doing the work, not only the steward). ──
  if (op === 'endeavor.satisfyStep') {
    const endeavorId = parseEndeavorId(body.endeavorId);
    if (!endeavorId) return json({ error: 'endeavorId required' }, 400);
    const stepId = String(body.stepId ?? '');
    if (!stepId.startsWith('step_') || stepId.length <= 5) return json({ error: 'stepId (step_*) required' }, 400);
    // Spec 382 W2 — the receipt refs ride TYPED (`urn:ap:receipt:run:…`, `mandate:…`, `tx:…`, `commitment:…`),
    // each its own EntityRef, beside the note. A reader that wants the run or the transaction gets a ref,
    // not a sentence to parse. Refs are bounded to the receipt namespace: a step is not satisfied by prose.
    const evidenceRefs = [...typedReceiptRefs(body.evidenceRefs), ...parseEvidenceRefs(body.evidence)];
    if (evidenceRefs.length === 0) return json({ error: 'evidence (a short note of what was done) is required to mark a step done' }, 400);
    const command: CoordinationCommandV1 = {
      kind: 'RecordStepSatisfied',
      // Spec 382 — a steward records as the organization; a participant records as themselves (the reducer re-gates both).
      actor: (await deps.isSteward()) ? principal : viewer,
      issuedAt: new Date().toISOString(),
      endeavorId: endeavorId as `end_${string}`,
      stepId: stepId as PlanStepId,
      evidenceRefs,
    };
    return deps.serialize(async () => {
      const r = await appendToEndeavorLog(deps, 'endeavor.satisfyStep', endeavorId, command, { type: 'plan-step', id: stepId });
      if (!r.ok) return r.response;
      return json({ ok: true, stepId });
    });
  }

  // ── endeavor.satisfy — mark the whole endeavor complete (outcome validated). Managing principal
  //    or sponsor/coordinator only (reducer-gated). ──
  if (op === 'endeavor.satisfy') {
    const endeavorId = parseEndeavorId(body.endeavorId);
    if (!endeavorId) return json({ error: 'endeavorId required' }, 400);
    const note = String(body.note ?? '').trim() || 'Outcome confirmed by the coordinator';
    const command: CoordinationCommandV1 = {
      kind: 'SatisfyEndeavor',
      // Spec 382 — a steward records as the organization; a participant records as themselves (the reducer re-gates both).
      actor: (await deps.isSteward()) ? principal : viewer,
      issuedAt: new Date().toISOString(),
      endeavorId: endeavorId as `end_${string}`,
      outcomeValidationRef: { kind: 'resource', iri: `urn:ap:outcome:${encodeURIComponent(note.slice(0, EVIDENCE_MAX))}` },
    };
    return deps.serialize(async () => {
      const r = await appendToEndeavorLog(deps, 'endeavor.satisfy', endeavorId, command, { type: 'endeavor', id: endeavorId });
      if (!r.ok) return r.response;
      return json({ ok: true, endeavorId, lifecycle: r.state.endeavor?.lifecycle ?? null });
    });
  }

  // ── endeavor.abandon — close the endeavor without satisfying it. Managing principal or
  //    sponsor/coordinator only (reducer-gated). ──
  if (op === 'endeavor.abandon') {
    const endeavorId = parseEndeavorId(body.endeavorId);
    if (!endeavorId) return json({ error: 'endeavorId required' }, 400);
    const reason = String(body.reason ?? '').trim();
    const command: CoordinationCommandV1 = {
      kind: 'AbandonEndeavor',
      actor: viewer,
      issuedAt: new Date().toISOString(),
      endeavorId: endeavorId as `end_${string}`,
      ...(reason ? { reason } : {}),
    };
    return deps.serialize(async () => {
      const r = await appendToEndeavorLog(deps, 'endeavor.abandon', endeavorId, command, { type: 'endeavor', id: endeavorId });
      if (!r.ok) return r.response;
      return json({ ok: true, endeavorId, lifecycle: r.state.endeavor?.lifecycle ?? null });
    });
  }

  if (op === 'endeavor.decide') {
    return json({ error: 'decision recording ships with the spec 333 wave — @agenticprimitives/coordination has no RecordDecision command yet' }, 501);
  }

  // ── endeavor.post — conversation about the endeavor. Fabric message ONLY, context-linked with
  //    the endeavor ref; the DO NEVER infers a coordination event from message text (rule 2d). ──
  if (op === 'endeavor.post') {
    const endeavorId = parseEndeavorId(body.endeavorId);
    if (!endeavorId) return json({ error: 'endeavorId required' }, 400);
    const bodyText = String(body.bodyText ?? '').trim();
    if (!bodyText) return json({ error: 'bodyText required' }, 400);
    const [name, steward] = await Promise.all([deps.memberName(), deps.isSteward()]);
    return deps.serialize(async () => {
      const log = await deps.readDoc<CoordinationEventV1[]>(coordinationEventsResource(endeavorId), []);
      if (log.length === 0) return json({ error: 'unknown endeavor' }, 404);
      const state = reduceEventLog(log);
      if (!name && !steward && !hasParticipation(state, viewer)) {
        return json({ error: 'join this community (or this endeavor) first' }, 403);
      }
      const topicId = endeavorTopicId(endeavorId);
      const messages = await deps.readDoc<ChannelMessageEntryV1[]>(endeavorTopicResource(endeavorId), []);
      const title = state.endeavor?.title ?? endeavorId;
      const descriptor: ConversationDescriptorV1 = {
        version: 'ap.conversation.v1',
        id: topicId as ConversationDescriptorV1['id'],
        owner: deps.principalCaip as ConversationDescriptorV1['owner'],
        title,
        participants: [deps.principalCaip as ConversationDescriptorV1['owner']],
        contextRefs: [{ kind: 'endeavor', id: endeavorId }],
        participantPolicy: 'open-to-context',
        createdAt: state.request?.record.submittedAt ?? new Date().toISOString(),
      };
      const channel: ChannelV1 = { descriptor, title, createdBy: 'coordination', messages };
      const composed: ChannelV1[] = [channel];
      const r = await appendBoardPost(composed, {
        channelId: topicId,
        from: deps.sessionCaip as AnyMessageEnvelope['from'],
        authorName: name ?? (steward ? 'Steward' : viewer),
        bodyText,
      });
      if (!r.ok) return json({ error: r.error }, 400);
      await deps.writeAudit('interactions.endeavor.post', { type: 'endeavor-post', id: r.envelope.id }, r.envelope.createdAt);
      await deps.putTopicBody(r.envelope, bodyText);
      await deps.writeDoc(endeavorTopicResource(endeavorId), composed[0]!.messages);
      return json({ ok: true, messageId: r.envelope.id });
    });
  }

  // ── endeavor.withdrawCommitment — spec 382 W2. The committed participant takes their promise back; the
  //    step returns to the pool. Only the participant (the reducer's gate); a reason is theirs to give. ──
  if (op === 'endeavor.withdrawCommitment') {
    const endeavorId = parseEndeavorId(body.endeavorId);
    if (!endeavorId) return json({ error: 'endeavorId required' }, 400);
    const commitmentId = String(body.commitmentId ?? '');
    if (!commitmentId.startsWith('commit_')) return json({ error: 'commitmentId (commit_*) required' }, 400);
    const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 400) : undefined;
    const command: CoordinationCommandV1 = {
      kind: 'WithdrawCommitment', actor: viewer, issuedAt: new Date().toISOString(),
      endeavorId: endeavorId as `end_${string}`, commitmentId: commitmentId as `commit_${string}`, ...(reason ? { reason } : {}),
    };
    return deps.serialize(async () => {
      const r = await appendToEndeavorLog(deps, 'endeavor.withdrawCommitment', endeavorId, command, { type: 'commitment', id: commitmentId });
      if (!r.ok) return r.response;
      return json({ ok: true, commitmentId });
    });
  }
  // ── endeavor.reallocate — spec 382 W2. A steward moves a committed (or withdrawn) contribution to another
  //    participant: a NEW allocation for them to commit to. Nothing is granted; the new participant's
  //    commitment is signed by them, as ever. ──
  if (op === 'endeavor.reallocate') {
    if (!(await deps.isSteward())) return json({ error: 'only the organization custodian may reallocate contributions' }, 403);
    const endeavorId = parseEndeavorId(body.endeavorId);
    if (!endeavorId) return json({ error: 'endeavorId required' }, 400);
    const commitmentId = String(body.commitmentId ?? '');
    if (!commitmentId.startsWith('commit_')) return json({ error: 'commitmentId (commit_*) required' }, 400);
    const participant = String(body.participant ?? '').toLowerCase();
    if (!ADDR_RE.test(participant)) return json({ error: 'participant (0x address) required' }, 400);
    const allocationId = makeAllocationId(crypto.randomUUID());
    const command: CoordinationCommandV1 = {
      kind: 'ReallocateContribution', actor: principal, issuedAt: new Date().toISOString(),
      endeavorId: endeavorId as `end_${string}`, commitmentId: commitmentId as `commit_${string}`, allocationId, participant: participant as Address,
    };
    return deps.serialize(async () => {
      const r = await appendToEndeavorLog(deps, 'endeavor.reallocate', endeavorId, command, { type: 'allocation', id: allocationId });
      if (!r.ok) return r.response;
      return json({ ok: true, allocationId, commitmentId });
    });
  }
  return json({ error: 'unknown endeavor op' }, 404);
}
