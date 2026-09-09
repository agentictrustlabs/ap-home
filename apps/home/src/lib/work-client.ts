// Coordination work-surface client (spec 334) — the browser side of the
// `/connect/work` proxy, which forwards to the managing principal's
// InteractionsDO `endeavor.*` ops on demo-a2a. Intent-first (ADR-0044): every
// call here posts a GOAL or a signed lifecycle command; nothing names an MCP
// tool or sequences calls. Record shapes follow spec 332 §5; the serving plane
// (built against the same spec) re-validates and re-gates everything —
// nothing client-sent is trusted.
import { canonicalizeMessage, sha256Hex32 } from '@agenticprimitives/fabric/messaging';
import type {
  HomeContributionEntryV1,
  HomeDecisionCardV1,
  HomeEndeavorSummaryV1,
  EndeavorLifecycle,
} from '@agenticprimitives/home';
import type { Address, CanonicalAgentId, Hex } from '@agenticprimitives/types';
import { CHAIN_ID } from './chain';

// ─── Wire rows (spec 332 §5 shapes, projected by endeavor.list / endeavor.get) ───

export type EndeavorEntryPoint = 'home-request' | 'discussion-ask' | 'inbox-ask' | 'a2a-intent';

export interface EndeavorRequestRow {
  requestId: string;
  requester: string;
  targetPrincipal?: string;
  goal: string;
  entryPoint: EndeavorEntryPoint;
  submittedAt: string;
  status?: 'pending' | 'adopted' | 'declined';
  /** Set when the request was adopted — the Endeavor it became. */
  endeavorId?: string;
  /** Set when declined — the steward's recorded reason. */
  reason?: string;
  /** Lifecycle of the endeavor this request became (so the requester sees "completed"). */
  endeavorLifecycle?: EndeavorLifecycle;
  /** The agent's outcome summary once the endeavor is satisfied (requester-facing result). */
  outcomeSummary?: string;
}

export interface EndeavorRow {
  endeavorId: string;
  title: string;
  lifecycle: EndeavorLifecycle;
  stepsTotal?: number;
  stepsSatisfied?: number;
  updatedAt?: string;
  requestRef?: string;
  deadline?: string;
}

export interface PlanRevisionRef {
  planId: string;
  revision: number;
  hash: string;
}

export interface PlanStepRow {
  stepId: string;
  kind: 'contribution' | 'interaction' | 'decision' | 'aggregation' | 'validation';
  description: string;
  satisfied?: boolean;
  /** The recorded completion deliverable for this step (decoded evidence note), when satisfied. */
  evidence?: string;
}

export interface PlanRow {
  planId: string;
  revision: number;
  contentHash: string;
  status: 'proposed' | 'adopted' | 'superseded' | 'rejected';
  /** Who proposed this revision — the ORG address itself means the org agent's suggested draft. */
  proposedBy?: string;
  steps: PlanStepRow[];
  /** Spec 382 W3 — the milestones the plan defines (achievements are the detail's `milestones`). */
  milestones?: Array<{ milestoneId: string; title: string; criteria?: Array<{ criterionId: string }> }>;
}

export interface ParticipationRow {
  participationId: string;
  participant: string;
  participantName?: string;
  role: 'sponsor' | 'coordinator' | 'contributor' | 'validator' | 'beneficiary' | 'observer';
}

export interface AllocationRow {
  allocationId: string;
  endeavorId?: string;
  endeavorTitle?: string;
  participant: string;
  steps: string[];
  planRef?: PlanRevisionRef;
  deadline?: string;
}

export interface CommitmentRow {
  commitmentId: string;
  endeavorId?: string;
  endeavorTitle?: string;
  allocationRef: string;
  participant: string;
  planRef: PlanRevisionRef;
  steps: string[];
  status: 'active' | 'fulfilled' | 'withdrawn' | 'reallocated';
  bounds?: { deadline?: string };
}

export interface DecisionRow {
  decisionId: string;
  endeavorId?: string;
  endeavorTitle?: string;
  decisionKind?: string;
  title?: string;
  approver: string;
  status: 'pending' | 'recorded';
  outcome?: string;
  requestedAt?: string;
  dueAt?: string;
}

/** One coordination event row for the Provenance trail (spec 332 §6 events, in order). */
export interface EndeavorEventRow {
  type: string;
  at: string;
  actor?: string;
  summary?: string;
}

export interface WorkListResponse {
  ok?: boolean;
  error?: string;
  /** The interactions grant predates the vault:coordination.* scopes — a steward re-enables (re-signs) it. */
  needsReEnable?: boolean;
  steward?: boolean;
  member?: boolean;
  you?: string;
  requests?: EndeavorRequestRow[];
  endeavors?: EndeavorRow[];
  /** The CALLER's own coordination facts (§12 visibility — participants see their own). */
  mine?: {
    allocations?: AllocationRow[];
    commitments?: CommitmentRow[];
    decisions?: DecisionRow[];
  };
}

/** One contribution proposal row (spec 332 §9.1 — an OFFER, allocated by the steward). */
export interface ProposalRow {
  proposalId: string;
  proposer: string;
  planRef: PlanRevisionRef;
  steps: string[];
  note?: string;
  proposedAt: string;
  status: 'open' | 'allocated' | 'declined';
}

/** One plan revision (proposed/adopted/superseded/rejected) with its content hash. */
export interface PlanRevisionRow {
  planId: string;
  revision: number;
  contentHash: string;
  status: 'proposed' | 'adopted' | 'superseded' | 'rejected';
  /** Who proposed this revision — the ORG address itself means the org agent's suggested draft. */
  proposedBy?: string;
  steps: Array<{ stepId: string; kind: string; description: string }>;
}

export interface WorkDetailResponse {
  ok?: boolean;
  error?: string;
  steward?: boolean;
  endeavor?: EndeavorRow & { outcome?: { description?: string; criteria?: string[] } };
  /** The agent/coordinator's outcome summary recorded when the endeavor was satisfied. */
  outcomeSummary?: string;
  plan?: PlanRow | null;
  /** EVERY plan revision — proposed ones await the steward's adoption. */
  plans?: PlanRevisionRow[];
  participations?: ParticipationRow[];
  proposals?: ProposalRow[];
  allocations?: AllocationRow[];
  commitments?: CommitmentRow[];
  decisions?: DecisionRow[];
  /** Spec 382 W3 — milestone achievements recorded in the endeavor's log. */
  milestones?: Array<{ milestoneId: string; evidenceRefs?: unknown[]; recordedBy?: string; occurredAt?: string }>;
  events?: EndeavorEventRow[];
}

// ─── Fetch helpers ───

const authed = (token: string): Record<string, string> => ({
  'content-type': 'application/json',
  authorization: `Bearer ${token}`,
});

export async function fetchWorkList(token: string, org: string): Promise<WorkListResponse> {
  const res = await fetch(`/connect/work?org=${encodeURIComponent(org.toLowerCase())}`, {
    headers: authed(token),
  });
  const body = (await res.json().catch(() => ({}))) as WorkListResponse;
  if (res.status === 403) return { ok: false, member: false, error: body.error };
  return body;
}

export async function fetchWorkDetail(
  token: string,
  org: string,
  endeavorId: string,
): Promise<WorkDetailResponse> {
  const res = await fetch(
    `/connect/work?org=${encodeURIComponent(org.toLowerCase())}&endeavorId=${encodeURIComponent(endeavorId)}`,
    { headers: authed(token) },
  );
  return (await res.json().catch(() => ({}))) as WorkDetailResponse;
}

async function postWork(
  token: string,
  payload: Record<string, unknown>,
): Promise<{ ok?: boolean; error?: string; requestId?: string; endeavorId?: string }> {
  const res = await fetch('/connect/work', {
    method: 'POST',
    headers: authed(token),
    body: JSON.stringify(payload),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; needsReEnable?: boolean; requestId?: string; endeavorId?: string };
  if (!res.ok || body.ok === false) {
    // Carry the serving plane's stale-grant signal so the UI can offer the steward re-enable ceremony.
    const err = new Error(body.error ?? `work op failed (${res.status})`) as Error & { needsReEnable?: boolean };
    if (body.needsReEnable === true) err.needsReEnable = true;
    throw err;
  }
  return body;
}

/** True when a thrown work-op error carries the serving plane's stale-grant re-enable signal. */
export function isReEnableError(e: unknown): boolean {
  return e instanceof Error && (e as Error & { needsReEnable?: boolean }).needsReEnable === true;
}

/** Home Request (spec 334 §5): a free-text GOAL posted to the target principal's
 *  serving plane — an EndeavorRequest, never a tool call. */
export async function submitEndeavorRequest(
  token: string,
  target: string,
  goal: string,
): Promise<{ requestId?: string }> {
  return postWork(token, { action: 'request', target: target.toLowerCase(), goal });
}

/** Steward triage: adopt a pending request as an Endeavor (endeavor.create). */
export async function adoptEndeavorRequest(
  token: string,
  org: string,
  requestId: string,
  title?: string,
): Promise<{ endeavorId?: string }> {
  return postWork(token, { action: 'adopt', org: org.toLowerCase(), requestId, ...(title ? { title } : {}) });
}

/** Steward triage: decline a pending request — recorded, never silent. */
export async function declineEndeavorRequest(
  token: string,
  org: string,
  requestId: string,
  reason?: string,
): Promise<void> {
  await postWork(token, { action: 'decline', org: org.toLowerCase(), requestId, ...(reason ? { reason } : {}) });
}

/** Propose a plan revision (endeavor.proposePlan) — participant-or-member gated.
 *  Returns the proposed revision's binding triple for immediate adoption. */
export async function proposePlan(
  token: string,
  org: string,
  endeavorId: string,
  steps: Array<{ stepId: string; kind: string; description: string }>,
  milestones?: Array<{ milestoneId: string; title: string; criteria?: Array<{ criterionId: string }> }>,
): Promise<{ planId?: string; revision?: number; contentHash?: string }> {
  return postWork(token, { action: 'proposePlan', org: org.toLowerCase(), endeavorId, planSteps: steps, ...(milestones?.length ? { milestones } : {}) }) as Promise<{
    planId?: string; revision?: number; contentHash?: string;
  }>;
}

/** Adopt a proposed plan revision (endeavor.adoptPlan) — steward-only; binds the exact hash. */
export async function adoptPlan(
  token: string,
  org: string,
  endeavorId: string,
  planRef: PlanRevisionRef,
): Promise<void> {
  await postWork(token, { action: 'adoptPlan', org: org.toLowerCase(), endeavorId, planRef });
}

/** Offer a contribution against adopted plan steps (endeavor.propose). */
export async function offerContribution(
  token: string,
  org: string,
  endeavorId: string,
  planRef: PlanRevisionRef,
  steps: string[],
  note?: string,
): Promise<{ proposalId?: string }> {
  return postWork(token, { action: 'offer', org: org.toLowerCase(), endeavorId, planRef, steps, ...(note ? { note } : {}) }) as Promise<{ proposalId?: string }>;
}

/** Steward selection of a proposal (endeavor.allocate) — records the decision, grants nothing. */
export async function allocateContribution(
  token: string,
  org: string,
  endeavorId: string,
  proposalRef: string,
  participant: string,
  steps: string[],
): Promise<void> {
  await postWork(token, { action: 'allocate', org: org.toLowerCase(), endeavorId, proposalRef, participant, steps });
}

/** The commitment payload the PARTICIPANT signs — binds the exact adopted plan
 *  revision hash (spec 332 §5/§9.2). The DO re-derives this digest server-side
 *  and verifies fail-closed; a stale plan hash is rejected, never coerced. */
export interface CommitmentDraft {
  endeavorId: string;
  allocationRef: string;
  participant: Address;
  planRef: PlanRevisionRef;
  steps: string[];
}

/** MUST mirror the serving plane's `commitmentPayloadDigest` preimage exactly
 *  (demo-a2a endeavors.ts): { endeavorId, allocationRef, planRef, steps } —
 *  the participant is bound by the SIGNATURE (signer = session SA), not the
 *  preimage. A divergent preimage is a 409 server-side, never coerced. */
export async function commitmentDigest(draft: CommitmentDraft): Promise<Hex> {
  return sha256Hex32(canonicalizeMessage({
    endeavorId: draft.endeavorId,
    allocationRef: draft.allocationRef,
    planRef: { planId: draft.planRef.planId, revision: draft.planRef.revision, hash: draft.planRef.hash },
    steps: draft.steps,
  }));
}

/** Commit to an allocation: the participant signs the commitment digest, then
 *  posts endeavor.commit. Commitment grants nothing — authority remains with
 *  the authority packages (ADR-0054 §4). */
export async function commitContribution(
  token: string,
  org: string,
  draft: CommitmentDraft,
  signHash: (hash: Hex) => Promise<Hex>,
): Promise<void> {
  const digest = await commitmentDigest(draft);
  const signature = await signHash(digest);
  await postWork(token, {
    action: 'commit',
    org: org.toLowerCase(),
    ...draft,
    signature: { payloadHash: digest, signer: draft.participant, scheme: 'erc1271', signature },
  });
}

/** Mark ONE plan step done (endeavor.satisfyStep) — evidence note required; recorded by the
 *  managing principal or an active participant (re-gated by the reducer). */
/** Spec 382 W2 — take back a commitment (only the committed participant may). The step returns to the pool. */
export async function withdrawCommitment(token: string, org: string, endeavorId: string, commitmentId: string, reason?: string): Promise<void> {
  await postWork(token, { action: 'withdraw', org: org.toLowerCase(), endeavorId, commitmentId, ...(reason ? { reason } : {}) });
}

/** Spec 382 W2 — a steward moves a commitment to another participant: a new allocation for them to commit to. */
export async function reallocateContribution(token: string, org: string, endeavorId: string, commitmentId: string, participant: string): Promise<{ allocationId?: string }> {
  return postWork(token, { action: 'reallocate', org: org.toLowerCase(), endeavorId, commitmentId, participant }) as Promise<{ allocationId?: string }>;
}

export async function markStepDone(
  token: string,
  org: string,
  endeavorId: string,
  stepId: string,
  evidence: string,
): Promise<void> {
  await postWork(token, { action: 'satisfyStep', org: org.toLowerCase(), endeavorId, stepId, evidence });
}

/** Spec 382 W3 — record a milestone of the adopted plan as achieved (endeavor.milestone.achieve), with evidence. */
export async function achieveMilestone(token: string, org: string, endeavorId: string, milestoneId: string, evidence: string): Promise<void> {
  await postWork(token, { action: 'achieveMilestone', org: org.toLowerCase(), endeavorId, milestoneId, evidence });
}

/** Mark the whole endeavor complete (endeavor.satisfy) — coordinator/steward act. */
export async function completeEndeavor(
  token: string,
  org: string,
  endeavorId: string,
  note?: string,
): Promise<void> {
  await postWork(token, { action: 'satisfy', org: org.toLowerCase(), endeavorId, ...(note ? { note } : {}) });
}

/** Close the endeavor without completing it (endeavor.abandon) — recorded with a reason. */
export async function closeEndeavor(
  token: string,
  org: string,
  endeavorId: string,
  reason?: string,
): Promise<void> {
  await postWork(token, { action: 'abandon', org: org.toLowerCase(), endeavorId, ...(reason ? { reason } : {}) });
}

/** Record a decision (endeavor.decide) — only the declared approver's session passes the DO gate. */
export async function recordDecision(
  token: string,
  org: string,
  endeavorId: string,
  decisionId: string,
  outcome: 'approved' | 'rejected',
  reason?: string,
): Promise<void> {
  await postWork(token, {
    action: 'decide',
    org: org.toLowerCase(),
    endeavorId,
    decisionId,
    outcome,
    ...(reason ? { reason } : {}),
  });
}

// ─── Projections into the portable @agenticprimitives/home contracts (spec 334 §8) ───

const nowIso = (): string => new Date().toISOString();
/** Display-projection cast only (same convention as home/manifest.ts homeCaip10). */
const caip10 = (sa: string): CanonicalAgentId =>
  (sa.includes(':') ? sa : `eip155:${CHAIN_ID}:${sa.toLowerCase()}`) as CanonicalAgentId;

export function projectEndeavorSummary(org: string, row: EndeavorRow): HomeEndeavorSummaryV1 {
  return {
    type: 'ap.home.endeavor-summary.v1',
    endeavorId: row.endeavorId,
    managingPrincipal: caip10(org),
    title: row.title,
    lifecycle: row.lifecycle,
    stepsTotal: row.stepsTotal ?? 0,
    stepsSatisfied: row.stepsSatisfied ?? 0,
    ...(row.deadline ? { deadline: row.deadline } : {}),
    updatedAt: row.updatedAt ?? nowIso(),
  };
}

/** Project an allocation awaiting commitment into the My Work contract. */
export function projectAllocationEntry(
  org: string,
  participant: string,
  a: AllocationRow,
): HomeContributionEntryV1 {
  return {
    type: 'ap.home.contribution-entry.v1',
    endeavorId: a.endeavorId ?? '',
    endeavorTitle: a.endeavorTitle ?? a.endeavorId ?? 'Endeavor',
    managingPrincipal: caip10(org),
    participant: caip10(participant),
    stepIds: a.steps,
    planRef: a.planRef ?? { planId: '', revision: 0, hash: '' },
    status: 'allocated',
    allocationId: a.allocationId,
    ...(a.deadline ? { deadline: a.deadline } : {}),
    updatedAt: nowIso(),
  };
}

/** Project an active commitment into the My Work contract. */
export function projectCommitmentEntry(
  org: string,
  participant: string,
  c: CommitmentRow,
): HomeContributionEntryV1 {
  return {
    type: 'ap.home.contribution-entry.v1',
    endeavorId: c.endeavorId ?? '',
    endeavorTitle: c.endeavorTitle ?? c.endeavorId ?? 'Endeavor',
    managingPrincipal: caip10(org),
    participant: caip10(participant),
    stepIds: c.steps,
    planRef: c.planRef,
    status: c.status === 'fulfilled' ? 'satisfied' : 'committed',
    allocationId: c.allocationRef,
    commitmentId: c.commitmentId,
    ...(c.bounds?.deadline ? { deadline: c.bounds.deadline } : {}),
    updatedAt: nowIso(),
  };
}

/** Project a pending decision request into the render-half decision card. */
export function projectDecisionCard(org: string, d: DecisionRow): HomeDecisionCardV1 {
  return {
    type: 'ap.home.decision-card.v1',
    decisionId: d.decisionId,
    endeavorId: d.endeavorId ?? '',
    managingPrincipal: caip10(org),
    approver: caip10(d.approver),
    decisionKind: d.decisionKind ?? 'decision',
    title: d.title ?? 'Decision requested',
    requestedAt: d.requestedAt ?? nowIso(),
    ...(d.dueAt ? { dueAt: d.dueAt } : {}),
    allowedActions: [
      { actionId: 'approve', label: 'Approve', transition: 'approve', style: 'primary' },
      { actionId: 'deny', label: 'Reject', transition: 'deny', style: 'destructive' },
    ],
  };
}
