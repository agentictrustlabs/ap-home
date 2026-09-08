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
  inputSchema: { type: 'object', properties: { ...ORG_ARG, goal: { type: 'string', description: 'The goal, as the person said it.' } }, required: ['org', 'goal'] },
  capability: { id: ENDEAVOR_REQUEST_CAPABILITY, action: 'request', resourceArg: 'org' },
  risk: 'medium',
  establishes: 'submission',
};

/** Offer to do steps of an adopted plan. A proposal — the steward allocates. */
export const CONTRIBUTION_PROPOSE_TOOL: ToolSpec = {
  id: CONTRIBUTION_PROPOSE_CAPABILITY,
  verbs: ['volunteer', 'offer', 'take', 'i will do', "i'll do", 'sign me up'],
  description: 'Offer to carry out steps of an endeavor\'s adopted plan. Args: org, endeavorId, steps (the step ids offered, from the plan), note (optional). A PROPOSAL: the steward decides who is allocated.',
  inputSchema: { type: 'object', properties: { ...ORG_ARG, endeavorId: { type: 'string' }, steps: { type: 'array', items: { type: 'string' }, description: 'Plan step ids (step_…).' }, note: { type: 'string' } }, required: ['org', 'endeavorId', 'steps'] },
  capability: { id: CONTRIBUTION_PROPOSE_CAPABILITY, action: 'propose', resourceArg: 'org' },
  risk: 'medium',
  establishes: 'submission',
};

/** The steward's selection: this participant does these steps. Records the decision; grants nothing. */
export const CONTRIBUTION_ALLOCATE_TOOL: ToolSpec = {
  id: CONTRIBUTION_ALLOCATE_CAPABILITY,
  verbs: ['allocate', 'assign', 'give the step to', 'put on'],
  description: 'Allocate an endeavor\'s plan steps to a participant who proposed for them — the organization\'s decision, made by a steward. Args: org, endeavorId, proposalRef (prop_…), participant (the person), steps.',
  inputSchema: { type: 'object', properties: { ...ORG_ARG, endeavorId: { type: 'string' }, proposalRef: { type: 'string', description: 'The proposal being allocated (prop_…).' }, participant: { type: 'string', description: 'The person allocated — address or name.' }, steps: { type: 'array', items: { type: 'string' } } }, required: ['org', 'endeavorId', 'proposalRef', 'participant', 'steps'] },
  capability: { id: CONTRIBUTION_ALLOCATE_CAPABILITY, action: 'allocate', resourceArg: 'org', authorityArg: 'org' },
  risk: 'medium',
  establishes: 'authoritative',
};

/** Close an endeavor as satisfied — the outcome confirmed by the coordinator. */
export const ENDEAVOR_SATISFY_TOOL: ToolSpec = {
  id: ENDEAVOR_SATISFY_CAPABILITY,
  verbs: ['close', 'complete', 'finish', 'mark done', 'mark complete', 'wrap up', 'satisfy'],
  description: 'Mark an endeavor satisfied — its outcome confirmed and the work closed. Args: org, endeavorId, note (what was achieved). The organization\'s act, by a steward or the endeavor\'s coordinator.',
  inputSchema: { type: 'object', properties: { ...ORG_ARG, endeavorId: { type: 'string' }, note: { type: 'string', description: 'What came of it, in a sentence.' } }, required: ['org', 'endeavorId'] },
  capability: { id: ENDEAVOR_SATISFY_CAPABILITY, action: 'satisfy', resourceArg: 'org', authorityArg: 'org' },
  risk: 'medium',
  establishes: 'authoritative',
};

export const COORDINATION_READ_TOOLS: ToolSpec[] = [ENDEAVOR_LIST_TOOL, ENDEAVOR_GET_TOOL];
export const COORDINATION_ACTION_TOOLS: ToolSpec[] = [ENDEAVOR_REQUEST_TOOL, CONTRIBUTION_PROPOSE_TOOL, CONTRIBUTION_ALLOCATE_TOOL, ENDEAVOR_SATISFY_TOOL];
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
function orgOf(args: Record<string, unknown>, addressee: Address, principal: Address | undefined, toolId: string, stepRef?: string): { org: Address } | { refused: string } {
  const sub = subjectOfRead(args, addressee, principal, { toolId, arg: 'org', noun: 'organization or team', stepRef });
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
    const o = orgOf(args, addressee, person, toolId, ctx?.step?.id);
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
    const o = orgOf(args, addressee, person, toolId, ctx?.step?.id);
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
      default: throw new Error(`${toolId} is not a coordination act`);
    }
  };
}
