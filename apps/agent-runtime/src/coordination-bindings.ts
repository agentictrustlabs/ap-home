// WORK & PLANNING AS A COMPILED PLAYBOOK — spec 370 P4 (spec 359 §2's proving domain), the THIN BINDINGS.
//
// The Endeavor substrate (specs 332–334) already exists: the reducer, the commands, the gates and the
// records live in `endeavors.ts` and run inside the organization's InteractionsDO. What the Ask lacked
// was any tool that reached them. These bindings are that and nothing more: each one names a capability
// the Coordinator archetype's contracts compile onto, reads through the SAME vault record the Home reads
// (`readSubjectRecord`), and writes through the SAME DO op the Home's `/connect/work` route forwards to,
// under the asker's own session and — for a steward act — the stewardship wire the asker's own links hold.
//
// No coordination logic is re-implemented here. Visibility is the substrate's `visibleEndeavorRows`,
// state is `reduceEventLog`, standing is `deriveStanding`; a write is validated by the reducer in the DO
// exactly as a click is. A playbook grants nothing: the acts below still run under the mandate their
// contracts declare, and the DO still derives the caller's standing from its own records (ADR-0054).
import type { Address } from 'viem';
import type { ToolInvoker, ToolSpec } from '@agenticprimitives/orchestration';
import { deriveStanding, relationshipRows, subjectOfRead, type StandingDeps } from '@agenticprimitives/context';
import type { CoordinationEventV1 } from '@agenticprimitives/coordination';
import { ADAPTER, CARRIES } from './adapter-declarations.js';
import {
  COORDINATION_INDEX_RESOURCE, coordinationEventsResource, reduceEventLog, visibleEndeavorRows, endeavorViewFor,
  type CoordinationIndexDocV1,
} from './endeavors.js';

export const ENDEAVOR_LIST_CAPABILITY = 'coordination.endeavor.list' as const;
export const ENDEAVOR_GET_CAPABILITY = 'coordination.endeavor.get' as const;
export const ENDEAVOR_REQUEST_CAPABILITY = 'coordination.endeavor.request' as const;
export const CONTRIBUTION_PROPOSE_CAPABILITY = 'coordination.contribution.propose' as const;
export const CONTRIBUTION_ALLOCATE_CAPABILITY = 'coordination.contribution.allocate' as const;
export const ENDEAVOR_SATISFY_CAPABILITY = 'coordination.endeavor.satisfy' as const;
/** Spec 382 W2 as Ask capabilities (the Work family's execution parity, 361 I4 / 398 G1): a participant takes a
 *  commitment back; a steward moves a contribution to someone else as a NEW allocation they must commit to. */
export const COMMITMENT_WITHDRAW_CAPABILITY = 'coordination.commitment.withdraw' as const;
export const COMMITMENT_REALLOCATE_CAPABILITY = 'coordination.commitment.reallocate' as const;
/** Spec 332 §6 as an Ask capability: one plan STEP recorded satisfied with completion evidence — by the people doing the work. */
export const STEP_SATISFY_CAPABILITY = 'coordination.step.satisfy' as const;
/** Spec 382 W3 (M6 milestones) — a milestone the adopted plan defines, recorded achieved with criteria evidence. */
export const MILESTONE_ACHIEVE_CAPABILITY = 'coordination.milestone.achieve' as const;
/** Spec 393 — a decision raised for DECLARED approvers, and recorded by one of them (immutable). */
export const DECISION_REQUEST_CAPABILITY = 'coordination.decision.request' as const;
export const DECISION_RECORD_CAPABILITY = 'coordination.decision.record' as const;

const ORG_ARG = { org: { type: 'string', description: 'The organization, team, circle or church whose work this is — its address or its name. Defaults to the agent being asked when it is one.' } };

/** "What are we working on?" — the organization's endeavors this person may see, and their own part. */
export const ENDEAVOR_LIST_TOOL: ToolSpec = {
  id: ENDEAVOR_LIST_CAPABILITY,
  description: 'List the endeavors (work in progress, plans, requests) of an organization the person has standing in — what is being worked on, by whom, and where each stands. A READ: no authority is spent.',
  inputSchema: { type: 'object', properties: { ...ORG_ARG } },
  subject: 'org',
  establishes: 'lookup',
};

/** One endeavor in full: its plan, who took what, what was decided, what happened. */
export const ENDEAVOR_GET_TOOL: ToolSpec = {
  id: ENDEAVOR_GET_CAPABILITY,
  description: 'Read one endeavor of an organization in full: the adopted plan and its steps, proposals, allocations, commitments, decisions and the event trail. A READ: no authority is spent.',
  inputSchema: { type: 'object', properties: { ...ORG_ARG, endeavorId: { type: 'string', description: 'The endeavor id (end_…), from the list.' } }, required: ['endeavorId'] },
  subject: 'org',
  establishes: 'lookup',
};

/** Ask an organization to take on a goal. Any member may; the organization's stewards triage it. */
export const ENDEAVOR_REQUEST_TOOL: ToolSpec = {
  id: ENDEAVOR_REQUEST_CAPABILITY,
  verbs: ['plan', 'request', 'organize', 'take on', 'get us to', 'ask the organization to'],
  description: 'Ask an organization to take on a goal as an endeavor — a request its stewards adopt or decline. Args: org (the organization asked), goal (the outcome wanted, in the person\'s words).',
  inputSchema: { type: 'object', properties: { ...ORG_ARG, goal: { type: 'string', description: 'The goal, as the person said it.' }, requester: { type: 'string', description: 'Who asks — the person asking, always; never set to the organization.' } }, required: ['org', 'goal'] },
  // A REQUEST IS THE REQUESTER'S ACT (spec 393 W2 tail, the same rule as the offer): asked AT the organization,
  // the harness's default would spend the ORGANIZATION's mandate to ask the organization something. The acting
  // party is declared — the requester, resolved to the asker (an ontology party role, never the room they stand in).
  capability: { id: ENDEAVOR_REQUEST_CAPABILITY, action: 'request', resourceArg: 'org', authorityArg: 'requester' },
  risk: 'medium', adapter: ADAPTER.sync, carries: CARRIES.coordination,
  establishes: 'submission',
};

/** Offer to do steps of an adopted plan. A proposal — the steward allocates. */
export const CONTRIBUTION_PROPOSE_TOOL: ToolSpec = {
  id: CONTRIBUTION_PROPOSE_CAPABILITY,
  verbs: ['volunteer', 'offer', 'take', 'i will do', "i'll do", 'sign me up'],
  description: 'Offer to carry out steps of an endeavor\'s adopted plan. Args: org, endeavorId, steps (the step ids offered, from the plan), note (optional). A PROPOSAL: the steward decides who is allocated.',
  inputSchema: { type: 'object', properties: { ...ORG_ARG, endeavorId: { type: 'string' }, steps: { type: 'array', items: { type: 'string' }, description: 'Plan step ids (step_…).' }, note: { type: 'string' }, proposer: { type: 'string', description: 'Who offers — the person asking, always; never set to the organization.' } }, required: ['org', 'endeavorId', 'steps'] },
  // AN OFFER IS THE OFFERER'S ACT (spec 393 W2). Asked AT the organization, the harness's default — "whose
  // authority: the declared one, else the resource acted on" — asked for the ORGANIZATION's mandate to make a
  // member's offer, which a member cannot grant and a steward should not. The acting party is declared: the
  // proposer, resolved to the asker (ontology party role, never the room they stand in).
  capability: { id: CONTRIBUTION_PROPOSE_CAPABILITY, action: 'propose', resourceArg: 'org', authorityArg: 'proposer' },
  risk: 'medium', adapter: ADAPTER.sync,
  establishes: 'submission',
};

/** The steward's selection: this participant does these steps. Records the decision; grants nothing. */
export const CONTRIBUTION_ALLOCATE_TOOL: ToolSpec = {
  id: CONTRIBUTION_ALLOCATE_CAPABILITY,
  verbs: ['allocate', 'assign', 'give the step to', 'put on'],
  description: 'Allocate an endeavor\'s plan steps to a participant who proposed for them — the organization\'s decision, made by a steward. Args: org, endeavorId, proposalRef (prop_…), participant (the person), steps.',
  inputSchema: { type: 'object', properties: { ...ORG_ARG, endeavorId: { type: 'string' }, proposalRef: { type: 'string', description: 'The proposal being allocated (prop_…).' }, participant: { type: 'string', description: 'The person allocated — address or name.' }, steps: { type: 'array', items: { type: 'string' } } }, required: ['org', 'endeavorId', 'proposalRef', 'participant', 'steps'] },
  capability: { id: CONTRIBUTION_ALLOCATE_CAPABILITY, action: 'allocate', resourceArg: 'org', authorityArg: 'org' },
  risk: 'medium', adapter: ADAPTER.sync,
  establishes: 'authoritative',
};

/** Close an endeavor as satisfied — the outcome confirmed by the coordinator. */
export const ENDEAVOR_SATISFY_TOOL: ToolSpec = {
  id: ENDEAVOR_SATISFY_CAPABILITY,
  verbs: ['close', 'complete', 'finish', 'mark done', 'mark complete', 'wrap up', 'satisfy'],
  description: 'Mark an endeavor satisfied — its outcome confirmed and the work closed. Args: org, endeavorId, note (what was achieved). The organization\'s act, by a steward or the endeavor\'s coordinator.',
  inputSchema: { type: 'object', properties: { ...ORG_ARG, endeavorId: { type: 'string' }, note: { type: 'string', description: 'What came of it, in a sentence.' } }, required: ['org', 'endeavorId'] },
  capability: { id: ENDEAVOR_SATISFY_CAPABILITY, action: 'satisfy', resourceArg: 'org', authorityArg: 'org' },
  risk: 'medium', adapter: ADAPTER.sync,
  establishes: 'authoritative',
};

/** A milestone reached — the adopted plan names it; the evidence says how its criteria were met. */
export const MILESTONE_ACHIEVE_TOOL: ToolSpec = {
  id: MILESTONE_ACHIEVE_CAPABILITY,
  verbs: ['milestone reached', 'reached the milestone', 'mark milestone', 'milestone achieved', 'hit the milestone', 'record the milestone'],
  description: 'Record a milestone of an endeavor\'s adopted plan as ACHIEVED, with a note of how its criteria were met. Args: org, endeavorId, milestoneId (from the plan), note. The organization\'s act by a steward, or the participant\'s own; the record refuses a milestone the plan does not define or one already achieved.',
  inputSchema: { type: 'object', properties: { ...ORG_ARG, endeavorId: { type: 'string' }, milestoneId: { type: 'string', description: 'The milestone id from the adopted plan.' }, note: { type: 'string', description: 'How the criteria were met, in a sentence — the achievement evidence.' } }, required: ['org', 'endeavorId', 'milestoneId'] },
  capability: { id: MILESTONE_ACHIEVE_CAPABILITY, action: 'achieve', resourceArg: 'org', authorityArg: 'org' },
  risk: 'medium', adapter: ADAPTER.sync,
  establishes: 'authoritative',
};

/** A plan step done — the execution record, by the managing principal or an active participant, with evidence. */
export const STEP_SATISFY_TOOL: ToolSpec = {
  id: STEP_SATISFY_CAPABILITY,
  verbs: ['step done', 'mark the step done', 'finished the step', 'completed the step', 'did the step', 'record the step as done'],
  description: 'Record ONE plan step of an endeavor as SATISFIED, with a note of what was done — the completion evidence. Args: org, endeavorId, stepId (from the adopted plan), note. By the organization\'s steward or an active participant (the one doing the work); the record refuses a step the plan does not name. Not the endeavor itself — coordination.endeavor.satisfy closes the whole endeavor.',
  inputSchema: { type: 'object', properties: { ...ORG_ARG, endeavorId: { type: 'string' }, stepId: { type: 'string', description: 'The step_* id from the adopted plan.' }, note: { type: 'string', description: 'What was done, in a sentence — the completion evidence.' } }, required: ['org', 'endeavorId', 'stepId', 'note'] },
  capability: { id: STEP_SATISFY_CAPABILITY, action: 'satisfy', resourceArg: 'org', authorityArg: 'org' },
  risk: 'medium', adapter: ADAPTER.sync,
  establishes: 'authoritative',
};

/** A commitment taken back — the participant's own act; the step returns to the pool. */
export const COMMITMENT_WITHDRAW_TOOL: ToolSpec = {
  id: COMMITMENT_WITHDRAW_CAPABILITY,
  verbs: ['withdraw', 'withdraw my commitment', 'pull out', 'step back from', 'take back my commitment', 'i can\'t do', 'drop my step'],
  description: 'WITHDRAW a commitment the person made on an endeavor — their promise taken back, the step returned to the pool for someone else. Args: org, endeavorId, commitmentId (the commit_* id of their own commitment), note (why, in a sentence — kept as the reason). Only the committed participant; the record refuses anyone else.',
  inputSchema: { type: 'object', properties: { ...ORG_ARG, endeavorId: { type: 'string' }, commitmentId: { type: 'string', description: 'The commit_* id of the commitment being withdrawn.' }, note: { type: 'string', description: 'Why, in a sentence.' } }, required: ['org', 'endeavorId', 'commitmentId'] },
  capability: { id: COMMITMENT_WITHDRAW_CAPABILITY, action: 'withdraw', resourceArg: 'org', authorityArg: 'org' },
  risk: 'medium', adapter: ADAPTER.sync,
  establishes: 'authoritative',
};

/** A contribution moved to another participant — a steward's act; the new participant's commitment is theirs to sign. */
export const COMMITMENT_REALLOCATE_TOOL: ToolSpec = {
  id: COMMITMENT_REALLOCATE_CAPABILITY,
  verbs: ['reallocate', 'reassign', 'move the step to', 'hand the step to', 'give the step to', 'reallocate to'],
  description: 'REALLOCATE a committed (or withdrawn) contribution on an endeavor to another participant — a NEW allocation they must commit to themselves; nothing is granted. Args: org, endeavorId, commitmentId (the commit_* id being moved), participant (the resolved agent address it moves to). A steward\'s act as the organization.',
  inputSchema: { type: 'object', properties: { ...ORG_ARG, endeavorId: { type: 'string' }, commitmentId: { type: 'string', description: 'The commit_* id of the contribution being moved.' }, participant: { type: 'string', description: 'The agent it moves to (resolve the person first).' } }, required: ['org', 'endeavorId', 'commitmentId', 'participant'] },
  capability: { id: COMMITMENT_REALLOCATE_CAPABILITY, action: 'reallocate', resourceArg: 'org', authorityArg: 'org' },
  risk: 'medium', adapter: ADAPTER.sync,
  establishes: 'authoritative',
};

/** Raise a decision for the people who may make it — the approvers are named up front; the record is theirs alone. */
export const DECISION_REQUEST_TOOL: ToolSpec = {
  id: DECISION_REQUEST_CAPABILITY,
  verbs: ['ask for a decision', 'request a decision', 'needs approval', 'ask to approve', 'raise a decision', 'get sign-off', 'put to'],
  description: 'Raise a DECISION on an endeavor for named approvers — who may decide is declared now, and only they can record it. Args: org, endeavorId, title (what is being decided), approvers (the resolved agent addresses who may decide — the organization\'s own address names the organization, decided by a steward as it), decisionKind (plan-change, spend, go-no-go …), summary, stepIds (the plan steps it concerns), dueAt. The organization\'s act by a steward, or an active participant\'s own.',
  inputSchema: { type: 'object', properties: { ...ORG_ARG, endeavorId: { type: 'string' }, title: { type: 'string', description: 'What is being decided, as a question or a short statement.' }, approvers: { type: 'array', items: { type: 'string' }, description: 'The agent addresses that may decide (resolve people first; the organization\'s address names the organization).' }, decisionKind: { type: 'string' }, summary: { type: 'string' }, stepIds: { type: 'array', items: { type: 'string' } }, dueAt: { type: 'string', description: 'ISO timestamp; a record after it is refused as expired.' } }, required: ['org', 'endeavorId', 'title', 'approvers'] },
  capability: { id: DECISION_REQUEST_CAPABILITY, action: 'request', resourceArg: 'org', authorityArg: 'org' },
  risk: 'medium', adapter: ADAPTER.sync,
  establishes: 'authoritative',
};

/** Record a decision — admitted only for a declared approver; approved/rejected close it, deferred keeps it open. */
export const DECISION_RECORD_TOOL: ToolSpec = {
  id: DECISION_RECORD_CAPABILITY,
  verbs: ['approve', 'reject the decision', 'decide', 'sign off', 'defer the decision', 'record my decision', 'i approve', 'i reject'],
  description: 'Record a decision on a pending decision request of an endeavor — approved, rejected or deferred, with the reason. Only a DECLARED approver may record it (a steward records as the organization only when the organization was named); approved and rejected close the request for good, deferred leaves it pending. Args: org, endeavorId, decisionId, outcome, reason.',
  inputSchema: { type: 'object', properties: { ...ORG_ARG, endeavorId: { type: 'string' }, decisionId: { type: 'string', description: 'The dec_* id from the endeavor\'s decisions.' }, outcome: { type: 'string', enum: ['approved', 'rejected', 'deferred'] }, reason: { type: 'string', description: 'Why — kept as the record\'s rationale.' } }, required: ['org', 'endeavorId', 'decisionId', 'outcome', 'reason'] },
  capability: { id: DECISION_RECORD_CAPABILITY, action: 'record', resourceArg: 'org', authorityArg: 'org' },
  risk: 'medium', adapter: ADAPTER.sync,
  establishes: 'authoritative',
};

export const COORDINATION_READ_TOOLS: ToolSpec[] = [ENDEAVOR_LIST_TOOL, ENDEAVOR_GET_TOOL];
export const COORDINATION_ACTION_TOOLS: ToolSpec[] = [ENDEAVOR_REQUEST_TOOL, CONTRIBUTION_PROPOSE_TOOL, CONTRIBUTION_ALLOCATE_TOOL, ENDEAVOR_SATISFY_TOOL, MILESTONE_ACHIEVE_TOOL, STEP_SATISFY_TOOL, COMMITMENT_WITHDRAW_TOOL, COMMITMENT_REALLOCATE_TOOL, DECISION_REQUEST_TOOL, DECISION_RECORD_TOOL];
export const COORDINATION_CAPABILITY_IDS = new Set<string>([...COORDINATION_READ_TOOLS, ...COORDINATION_ACTION_TOOLS].map((t) => t.id));

export interface CoordinationDeps extends StandingDeps {
  /** A PUBLIC op on a principal's InteractionsDO, as the session — the same door `/connect/work` uses. */
  interactionsOp?: (principal: Address, op: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

const isAddr = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);

/**
 * The org an argument names, resolved already by the party resolver — and ONLY the agent being asked
 * (spec 366 R3, `subjectOfRead`): another agent's endeavors are read at that agent; a person's own agent
 * asked about no organization asks which one.
 */
function orgOf(args: Record<string, unknown>, addressee: Address, principal: Address | undefined, toolId: string, stepRef?: string, selfKind?: string | null): { org: Address } | { refused: string } {
  const sub = subjectOfRead(args, addressee, principal, { toolId, arg: 'org', noun: 'organization or team', stepRef, selfKind });
  return 'refused' in sub ? sub : { org: sub.subject };
}

/** The stewardship wire the asker's OWN links hold for this org — what the DO's steward gate verifies. */
async function stewardshipWireFor(deps: StandingDeps, person: Address, org: Address): Promise<unknown> {
  if (!deps.readSubjectRecord) return undefined;
  const doc = await deps.readSubjectRecord(person, 'relationships.data').catch(() => null);
  return relationshipRows(doc).find((r) => r.agent.toLowerCase() === org.toLowerCase() && r.relationship === 'steward')?.stewardshipDelegation;
}

/**
 * The reads: the SAME records the Home's Work surface shows, filtered by the SAME visibility rule
 * (`visibleEndeavorRows`), with standing derived from the asker's own tier. Nothing is computed that
 * the substrate does not already compute for a click.
 */
export function endeavorReadInvoker(deps: CoordinationDeps, addressee: Address, person?: Address): ToolInvoker {
  return async (toolId, args, ctx) => {
    const o = orgOf(args, addressee, person, toolId, ctx?.step?.id, deps.addresseeKind);
    if ('refused' in o) return { endeavors: [], count: 0, refused: o.refused };
    if (!person) return { endeavors: [], count: 0, refused: 'this agent does not know who is asking' };
    // `deps` is StandingDeps-shaped: the harness maps the routed context (what the asker presented, that
    // their tree is not ours to read) onto `context`, and the verifier rides along (spec 366 R2/R3).
    const standing = await deriveStanding(deps, { principal: person, subject: o.org }).catch(() => null);
    if (!standing || standing.relation === 'none') {
      const reason = `an organization's work is its own record, and ${standing?.because ?? 'this agent cannot read your links'} — only someone who belongs there can see it`;
      return { endeavors: [], count: 0, refused: reason, reason };
    }
    if (!deps.readSubjectRecord) return { endeavors: [], count: 0, refused: 'this agent cannot read the organization\'s records' };
    const flags = { steward: standing.relation === 'steward' || standing.relation === 'self', member: true };
    if (toolId === ENDEAVOR_LIST_CAPABILITY) {
      const index = (await deps.readSubjectRecord(o.org, COORDINATION_INDEX_RESOURCE).catch(() => null)) as CoordinationIndexDocV1 | null;
      const interpretation = `the organization's own work record (${COORDINATION_INDEX_RESOURCE}), filtered by your standing (${standing.relation})`;
      if (!index) return { endeavors: [], count: 0, interpretation, reason: 'this organization keeps no work records yet — nothing has been requested or planned there', tier: 'the organization\'s own records' };
      const rows = visibleEndeavorRows(Object.values(index.endeavors ?? {}), person, flags);
      return {
        org: o.org, count: rows.length, interpretation, tier: 'the organization\'s own records', standing: standing.relation,
        ...(rows.length === 0 ? { reason: 'the work record is empty — nothing has been requested or planned' } : {}),
        endeavors: rows.map((e) => ({ endeavorId: e.endeavorId, title: e.title, lifecycle: e.lifecycle, participants: e.participants, requester: e.requester, updatedAt: e.updatedAt, ...(e.stepsTotal !== undefined ? { steps: `${e.stepsSatisfied ?? 0}/${e.stepsTotal}` } : {}) })),
      };
    }
    const endeavorId = String(args.endeavorId ?? '').trim();
    if (!endeavorId) return { refused: 'which endeavor? — give its id from the list' };
    const log = (await deps.readSubjectRecord(o.org, coordinationEventsResource(endeavorId)).catch(() => null)) as CoordinationEventV1[] | null;
    if (!Array.isArray(log) || log.length === 0) return { refused: `no endeavor ${endeavorId} is recorded by this organization` };
    const state = reduceEventLog(log);
    const view = endeavorViewFor(state, person, flags);
    if (view === 'none') return { refused: 'this endeavor is not visible to you' };
    return { org: o.org, endeavorId, interpretation: `the endeavor's own event log (${coordinationEventsResource(endeavorId)}), reduced to its current state`, tier: 'the organization\'s own records', view, state };
  };
}

/**
 * The writes: the SAME DO ops the Home's `/connect/work` route forwards to, under the asker's session and
 * the stewardship wire their own links hold. The reducer validates the command; this passes it on.
 */
export function endeavorActInvoker(deps: CoordinationDeps, addressee: Address, person: Address | undefined, session: string | undefined): ToolInvoker {
  return async (toolId, args, ctx) => {
    const o = orgOf(args, addressee, person, toolId, ctx?.step?.id, deps.addresseeKind);
    if ('refused' in o) throw new Error(o.refused);
    if (!person || !session) throw new Error('this act needs the person\'s own session');
    if (!deps.interactionsOp) throw new Error('coordination acts are not wired on this agent');
    const stewardship = await stewardshipWireFor(deps, person, o.org);
    const common = { session, ...(stewardship ? { stewardship } : {}) };
    const steps = Array.isArray(args.steps) ? args.steps.map(String) : [];
    switch (toolId) {
      case ENDEAVOR_REQUEST_CAPABILITY: {
        const r = await deps.interactionsOp(o.org, 'endeavor.request', { ...common, goal: String(args.goal ?? '').trim(), entryPoint: 'home-request' });
        return { org: o.org, requestId: r.requestId, status: r.status ?? 'submitted', note: 'The request is with the organization\'s stewards, who adopt or decline it.' };
      }
      case CONTRIBUTION_PROPOSE_CAPABILITY: {
        const endeavorId = String(args.endeavorId ?? '').trim();
        // The adopted plan's reference is the substrate's, read from the endeavor's own state — a person
        // names steps, never a plan hash.
        const log = (await deps.readSubjectRecord?.(o.org, coordinationEventsResource(endeavorId)).catch(() => null)) as CoordinationEventV1[] | null;
        const state = Array.isArray(log) && log.length ? reduceEventLog(log) : null;
        const adopted = state?.endeavor?.adoptedPlanRef;
        if (!adopted) throw new Error('this endeavor has no adopted plan to propose against yet');
        const r = await deps.interactionsOp(o.org, 'endeavor.propose', { ...common, endeavorId, planRef: adopted, steps, ...(args.note ? { note: String(args.note) } : {}) });
        return { org: o.org, endeavorId, proposalId: r.proposalId, steps, note: 'Offered. A steward allocates the steps to whoever does them.' };
      }
      case CONTRIBUTION_ALLOCATE_CAPABILITY: {
        const participant = String(args.participant ?? '').trim();
        if (!isAddr(participant)) throw new Error(`the participant must be a resolved agent, not “${participant}”`);
        const r = await deps.interactionsOp(o.org, 'endeavor.allocate', { ...common, endeavorId: String(args.endeavorId ?? ''), proposalRef: String(args.proposalRef ?? ''), participant: participant.toLowerCase(), steps });
        return { org: o.org, endeavorId: String(args.endeavorId ?? ''), allocationId: r.allocationId, participant: participant.toLowerCase(), steps };
      }
      case ENDEAVOR_SATISFY_CAPABILITY: {
        const r = await deps.interactionsOp(o.org, 'endeavor.satisfy', { ...common, endeavorId: String(args.endeavorId ?? ''), ...(args.note ? { note: String(args.note) } : {}) });
        return { org: o.org, endeavorId: r.endeavorId, lifecycle: r.lifecycle };
      }
      case MILESTONE_ACHIEVE_CAPABILITY: {
        const milestoneId = String(args.milestoneId ?? '').trim();
        const r = await deps.interactionsOp(o.org, 'endeavor.milestone.achieve', { ...common, endeavorId: String(args.endeavorId ?? ''), milestoneId, ...(args.note ? { evidence: String(args.note) } : {}) });
        return { org: o.org, endeavorId: String(args.endeavorId ?? ''), milestoneId: r.milestoneId ?? milestoneId, note: 'Recorded as achieved in the endeavor\'s log, with the evidence given.' };
      }
      case STEP_SATISFY_CAPABILITY: {
        const stepId = String(args.stepId ?? '').trim();
        const r = await deps.interactionsOp(o.org, 'endeavor.satisfyStep', { ...common, endeavorId: String(args.endeavorId ?? ''), stepId, evidence: String(args.note ?? '') });
        return { org: o.org, endeavorId: String(args.endeavorId ?? ''), stepId: r.stepId ?? stepId, note: 'Recorded as done in the endeavor\'s log, with the evidence given.' };
      }
      case COMMITMENT_WITHDRAW_CAPABILITY: {
        const commitmentId = String(args.commitmentId ?? '').trim();
        const r = await deps.interactionsOp(o.org, 'endeavor.withdrawCommitment', { ...common, endeavorId: String(args.endeavorId ?? ''), commitmentId, ...(args.note ? { reason: String(args.note) } : {}) });
        return { org: o.org, endeavorId: String(args.endeavorId ?? ''), commitmentId: r.commitmentId ?? commitmentId, note: 'Withdrawn. The step is back in the pool; a steward may allocate it again.' };
      }
      case COMMITMENT_REALLOCATE_CAPABILITY: {
        const participant = String(args.participant ?? '').trim();
        if (!isAddr(participant)) throw new Error(`the participant must be a resolved agent, not “${participant}”`);
        const commitmentId = String(args.commitmentId ?? '').trim();
        const r = await deps.interactionsOp(o.org, 'endeavor.reallocate', { ...common, endeavorId: String(args.endeavorId ?? ''), commitmentId, participant: participant.toLowerCase() });
        return { org: o.org, endeavorId: String(args.endeavorId ?? ''), commitmentId, allocationId: r.allocationId, participant: participant.toLowerCase(), note: 'Reallocated as a new allocation. It waits on the new participant\'s own commitment; nothing was granted.' };
      }
      case DECISION_REQUEST_CAPABILITY: {
        const approvers = (Array.isArray(args.approvers) ? args.approvers : typeof args.approvers === 'string' ? args.approvers.split(/[,\s]+/) : []).map((a) => String(a).trim()).filter(Boolean);
        const unresolved = approvers.find((a) => !isAddr(a));
        if (unresolved) throw new Error(`an approver must be a resolved agent, not “${unresolved}”`);
        const stepIds = Array.isArray(args.stepIds) ? args.stepIds.map(String) : [];
        const r = await deps.interactionsOp(o.org, 'endeavor.decision.request', { ...common, endeavorId: String(args.endeavorId ?? ''), title: String(args.title ?? '').trim(), approvers: approvers.map((a) => a.toLowerCase()), ...(args.decisionKind ? { decisionKind: String(args.decisionKind) } : {}), ...(args.summary ? { summary: String(args.summary) } : {}), ...(stepIds.length ? { stepIds } : {}), ...(args.dueAt ? { dueAt: String(args.dueAt) } : {}) });
        return { org: o.org, endeavorId: String(args.endeavorId ?? ''), decisionId: r.decisionId, approvers: r.approvers ?? approvers, status: r.status ?? 'pending', note: 'Raised. It waits on the named approvers; nobody else can record it.' };
      }
      case DECISION_RECORD_CAPABILITY: {
        const decisionId = String(args.decisionId ?? '').trim();
        const r = await deps.interactionsOp(o.org, 'endeavor.decide', { ...common, endeavorId: String(args.endeavorId ?? ''), decisionId, outcome: String(args.outcome ?? ''), reason: String(args.reason ?? '') });
        return { org: o.org, endeavorId: String(args.endeavorId ?? ''), decisionId: r.decisionId ?? decisionId, outcome: r.outcome, decidedBy: r.decidedBy, status: r.status, note: r.status === 'pending' ? 'Deferred — the request stays open.' : 'Recorded. The request is closed; a reversal would be a new request.' };
      }
      default: throw new Error(`${toolId} is not a coordination act`);
    }
  };
}
