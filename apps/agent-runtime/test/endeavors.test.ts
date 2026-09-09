// endeavor.* op-family tests (spec 334 §3 W2) — the handler over injected in-memory deps (the
// DO seams), NOT a Durable Object harness. Covers a happy path per op plus one rejection per
// server-side authority invariant (rules 2a–2d).
import { describe, expect, it } from 'vitest';

import {
  COORDINATION_INDEX_RESOURCE,
  COORDINATION_REQUESTS_RESOURCE,
  commitmentPayloadDigest,
  coordinationEventsResource,
  coordinationStateResource,
  endeavorTopicResource,
  endeavorViewFor,
  handleEndeavorOp,
  parsePlanSteps,
  reduceEventLog,
  visibleEndeavorRows,
  type CoordinationRequestsDocV1,
  type EndeavorIndexEntryV1,
  type EndeavorOpDeps,
} from '../src/endeavors.js';
import type { CoordinationEventV1, PlanRevisionRef } from '@agenticprimitives/coordination';

const ORG = `0x${'a'.repeat(40)}`;
const STEWARD = `0x${'b'.repeat(40)}`;
const REQUESTER = `0x${'c'.repeat(40)}`;
const STRANGER = `0x${'e'.repeat(40)}`;
const caip = (sa: string): string => `eip155:84532:${sa}`;

interface Harness {
  docs: Map<string, unknown>;
  audits: string[];
  bodies: string[];
  as(session: string, opts?: { steward?: boolean; member?: string | null; verify?: boolean }): EndeavorOpDeps;
}

function makeHarness(): Harness {
  const docs = new Map<string, unknown>();
  const audits: string[] = [];
  const bodies: string[] = [];
  return {
    docs,
    audits,
    bodies,
    as(session, opts = {}) {
      return {
        principal: ORG,
        principalCaip: caip(ORG),
        sessionSa: session,
        sessionCaip: caip(session),
        readDoc: async <T,>(resource: string, empty: T): Promise<T> =>
          docs.has(resource) ? (JSON.parse(JSON.stringify(docs.get(resource))) as T) : empty,
        writeDoc: async (resource: string, data: unknown): Promise<void> => {
          docs.set(resource, JSON.parse(JSON.stringify(data)));
        },
        serialize: <T,>(fn: () => Promise<T>): Promise<T> => fn(),
        memberName: async () => opts.member ?? null,
        isSteward: async () => opts.steward ?? false,
        verifySignature: async () => opts.verify ?? true,
        writeAudit: async (action) => {
          audits.push(action);
        },
        putTopicBody: async (_envelope, bodyText) => {
          bodies.push(bodyText);
        },
      };
    },
  };
}

async function out(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/** Drives request → adopt → proposePlan → adoptPlan → propose → allocate; returns the ids. */
async function driveToAllocation(h: Harness): Promise<{
  endeavorId: string;
  planRef: PlanRevisionRef;
  proposalId: string;
  allocationId: string;
}> {
  const req = await out(await handleEndeavorOp(h.as(REQUESTER), 'endeavor.request', { goal: 'Publish the quarterly impact report' }));
  expect(req.ok).toBe(true);

  const created = await out(await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.create', {
    requestId: req.requestId,
    decision: 'adopt',
    title: 'Quarterly impact report',
  }));
  expect(created.ok).toBe(true);
  const endeavorId = String(created.endeavorId);

  const proposed = await out(await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.proposePlan', {
    endeavorId,
    steps: [
      { stepId: 'step_draft', kind: 'contribution', description: 'Draft the report' },
      { stepId: 'step_review', kind: 'validation', description: 'Review the draft' },
    ],
    edges: [{ from: 'step_draft', to: 'step_review', kind: 'precedes' }],
  }));
  expect(proposed.ok).toBe(true);
  const planRef: PlanRevisionRef = {
    planId: proposed.planId as PlanRevisionRef['planId'],
    revision: Number(proposed.revision),
    hash: proposed.contentHash as PlanRevisionRef['hash'],
  };

  const adopted = await out(await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.adoptPlan', { endeavorId, planRef }));
  expect(adopted.ok).toBe(true);

  const proposal = await out(await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.propose', {
    endeavorId,
    planRef,
    steps: ['step_draft'],
    note: 'I will draft it',
  }));
  expect(proposal.ok).toBe(true);

  const alloc = await out(await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.allocate', {
    endeavorId,
    proposalRef: proposal.proposalId,
    participant: STEWARD,
    steps: ['step_draft'],
  }));
  expect(alloc.ok).toBe(true);

  return {
    endeavorId,
    planRef,
    proposalId: String(proposal.proposalId),
    allocationId: String(alloc.allocationId),
  };
}

describe('endeavor.* serving plane', () => {
  it('runs request → adopt → plan → allocate → commit, event-sourced end to end', async () => {
    const h = makeHarness();
    const { endeavorId, planRef, allocationId } = await driveToAllocation(h);

    const digest = await commitmentPayloadDigest({ endeavorId, allocationRef: allocationId, planRef, steps: ['step_draft'] });
    const committed = await out(await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.commit', {
      endeavorId,
      allocationRef: allocationId,
      planRef,
      steps: ['step_draft'],
      signature: { payloadHash: digest, signer: STEWARD, scheme: 'erc1271', signature: '0xdeadbeef' },
    }));
    expect(committed.ok).toBe(true);

    const log = h.docs.get(coordinationEventsResource(endeavorId)) as CoordinationEventV1[];
    const state = reduceEventLog(log);
    expect(state.endeavor?.lifecycle).toBe('active');
    expect(Object.values(state.commitments)).toHaveLength(1);
    expect(Object.values(state.allocations)[0]?.status).toBe('committed');
    // Audit rows for every mutation.
    expect(h.audits).toEqual([
      'interactions.endeavor.request',
      'interactions.endeavor.create',
      'interactions.endeavor.proposePlan',
      'interactions.endeavor.adoptPlan',
      'interactions.endeavor.propose',
      'interactions.endeavor.allocate',
      'interactions.endeavor.commit',
    ]);
  });

  it('declines a pending request explicitly (never silent)', async () => {
    const h = makeHarness();
    const req = await out(await handleEndeavorOp(h.as(REQUESTER), 'endeavor.request', { goal: 'Do a thing' }));
    const res = await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.create', {
      requestId: req.requestId,
      decision: 'decline',
      reason: 'out of scope',
    });
    expect(res.status).toBe(200);
    const doc = h.docs.get(COORDINATION_REQUESTS_RESOURCE) as CoordinationRequestsDocV1;
    expect(doc.rows[0]?.status).toBe('declined');
    expect(doc.rows[0]?.reason).toBe('out of scope');
  });

  it('rejects endeavor.create from a non-steward session (403)', async () => {
    const h = makeHarness();
    const req = await out(await handleEndeavorOp(h.as(REQUESTER), 'endeavor.request', { goal: 'Do a thing' }));
    const res = await handleEndeavorOp(h.as(REQUESTER), 'endeavor.create', { requestId: req.requestId, decision: 'adopt' });
    expect(res.status).toBe(403);
  });

  // Rule 2a — allocation records selection only: no doc outside the coordination catalog changes.
  it('allocation grants nothing: only coordination docs are written', async () => {
    const h = makeHarness();
    const { endeavorId } = await driveToAllocation(h);
    const keys = [...h.docs.keys()].sort();
    expect(keys).toEqual([
      coordinationEventsResource(endeavorId),
      coordinationStateResource(endeavorId),
      COORDINATION_INDEX_RESOURCE,
      COORDINATION_REQUESTS_RESOURCE,
    ].sort());
  });

  // Rule 2b — stale/mismatched plan revision hash is 409, never coerced.
  it('rejects a commit whose planRef hash is stale with 409', async () => {
    const h = makeHarness();
    const { endeavorId, planRef, allocationId } = await driveToAllocation(h);
    const stale: PlanRevisionRef = { ...planRef, hash: `0x${'1'.repeat(64)}` as PlanRevisionRef['hash'] };
    const digest = await commitmentPayloadDigest({ endeavorId, allocationRef: allocationId, planRef: stale, steps: ['step_draft'] });
    const res = await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.commit', {
      endeavorId,
      allocationRef: allocationId,
      planRef: stale,
      steps: ['step_draft'],
      signature: { payloadHash: digest, signer: STEWARD, scheme: 'erc1271', signature: '0xdeadbeef' },
    });
    expect(res.status).toBe(409);
  });

  it('rejects a commit whose signed payload does not bind the adopted revision hash (409)', async () => {
    const h = makeHarness();
    const { endeavorId, planRef, allocationId } = await driveToAllocation(h);
    const res = await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.commit', {
      endeavorId,
      allocationRef: allocationId,
      planRef,
      steps: ['step_draft'],
      signature: { payloadHash: `0x${'2'.repeat(64)}`, signer: STEWARD, scheme: 'erc1271', signature: '0xdeadbeef' },
    });
    expect(res.status).toBe(409);
  });

  it('rejects a commit from a session that is not the allocated participant (403)', async () => {
    const h = makeHarness();
    const { endeavorId, planRef, allocationId } = await driveToAllocation(h);
    const digest = await commitmentPayloadDigest({ endeavorId, allocationRef: allocationId, planRef, steps: ['step_draft'] });
    const res = await handleEndeavorOp(h.as(STRANGER, { member: 'Stranger' }), 'endeavor.commit', {
      endeavorId,
      allocationRef: allocationId,
      planRef,
      steps: ['step_draft'],
      signature: { payloadHash: digest, signer: STRANGER, scheme: 'erc1271', signature: '0xdeadbeef' },
    });
    expect(res.status).toBe(403);
  });

  it('rejects a commit whose signature fails verification (403, fail-closed)', async () => {
    const h = makeHarness();
    const { endeavorId, planRef, allocationId } = await driveToAllocation(h);
    const digest = await commitmentPayloadDigest({ endeavorId, allocationRef: allocationId, planRef, steps: ['step_draft'] });
    const res = await handleEndeavorOp(h.as(STEWARD, { steward: true, verify: false }), 'endeavor.commit', {
      endeavorId,
      allocationRef: allocationId,
      planRef,
      steps: ['step_draft'],
      signature: { payloadHash: digest, signer: STEWARD, scheme: 'erc1271', signature: '0xdeadbeef' },
    });
    expect(res.status).toBe(403);
  });

  // Rule 2c — no RecordDecision command ships yet: honest 501, never a faked record.
  it('endeavor.decide returns 501 until the spec 333 wave', async () => {
    const h = makeHarness();
    const res = await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.decide', {});
    expect(res.status).toBe(501);
  });

  // Rule 2d — conversation never mutates state: post writes fabric only, endeavor-ref-linked.
  it('endeavor.post appends a fabric message with the endeavor contextRef and NO coordination event', async () => {
    const h = makeHarness();
    const { endeavorId } = await driveToAllocation(h);
    const logBefore = (h.docs.get(coordinationEventsResource(endeavorId)) as CoordinationEventV1[]).length;
    const res = await out(await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.post', {
      endeavorId,
      bodyText: 'Status update: draft underway',
    }));
    expect(res.ok).toBe(true);
    const logAfter = (h.docs.get(coordinationEventsResource(endeavorId)) as CoordinationEventV1[]).length;
    expect(logAfter).toBe(logBefore);
    const messages = h.docs.get(endeavorTopicResource(endeavorId)) as Array<{ envelope: { contextRefs?: Array<{ kind: string; id: string }> } }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.envelope.contextRefs).toEqual([{ kind: 'endeavor', id: endeavorId }]);
    expect(h.bodies).toEqual(['Status update: draft underway']);
  });

  it('rejects a proposePlan from a session with no membership, stewardship, or participation (403)', async () => {
    const h = makeHarness();
    const { endeavorId } = await driveToAllocation(h);
    const res = await handleEndeavorOp(h.as(STRANGER), 'endeavor.proposePlan', {
      endeavorId,
      steps: [{ stepId: 'step_x', kind: 'contribution', description: 'x' }],
    });
    expect(res.status).toBe(403);
  });

  // The Work-UX wire contract (demo-sso-next work-client.ts): list carries `mine`, get carries
  // the adopted `plan` projection + the ordered `events` trail + the endeavor's outcome strings.
  it('projects mine/plan/events for the Work surfaces', async () => {
    const h = makeHarness();
    const { endeavorId, planRef, allocationId } = await driveToAllocation(h);

    const list = await out(await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.list', {}));
    const mine = list.mine as { allocations: Array<Record<string, unknown>>; commitments: unknown[] };
    expect(mine.allocations).toHaveLength(1);
    expect(mine.allocations[0]).toMatchObject({
      allocationId,
      endeavorId,
      participant: STEWARD,
      planRef: { planId: planRef.planId, revision: planRef.revision, hash: planRef.hash },
    });

    const got = await out(await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.get', { endeavorId }));
    const plan = got.plan as { revision: number; status: string; contentHash: string; steps: Array<{ satisfied: boolean }> };
    expect(plan.status).toBe('adopted');
    expect(plan.contentHash).toBe(planRef.hash);
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps.every((s) => s.satisfied === false)).toBe(true);
    const events = got.events as Array<{ type: string; at: string }>;
    expect(events.map((e) => e.type)).toEqual([
      'EndeavorRequestSubmitted',
      'EndeavorAdopted',
      'ParticipationAsserted',
      'PlanProposed',
      'PlanAdopted',
      'ContributionProposed',
      'ContributionAllocated',
    ]);
    const endeavor = got.endeavor as { outcome?: { criteria: string[] } };
    expect(endeavor.outcome?.criteria?.length).toBeGreaterThan(0);
  });

  // ── Execution ops (spec 332 §6): satisfyStep / satisfy / abandon ──
  it('marks a step done with evidence, then completes the endeavor', async () => {
    const h = makeHarness();
    const { endeavorId, planRef, allocationId } = await driveToAllocation(h);
    const digest = await commitmentPayloadDigest({ endeavorId, allocationRef: allocationId, planRef, steps: ['step_draft'] });
    await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.commit', {
      endeavorId, allocationRef: allocationId, planRef, steps: ['step_draft'],
      signature: { payloadHash: digest, signer: STEWARD, scheme: 'erc1271', signature: '0xdeadbeef' },
    });

    // Evidence is REQUIRED.
    const noEvidence = await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.satisfyStep', { endeavorId, stepId: 'step_draft' });
    expect(noEvidence.status).toBe(400);

    const done1 = await out(await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.satisfyStep', {
      endeavorId, stepId: 'step_draft', evidence: 'Draft written and shared',
    }));
    expect(done1.ok).toBe(true);
    const done2 = await out(await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.satisfyStep', {
      endeavorId, stepId: 'step_review', evidence: 'Reviewed and approved',
    }));
    expect(done2.ok).toBe(true);

    const satisfied = await out(await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.satisfy', {
      endeavorId, note: 'Report published',
    }));
    expect(satisfied.ok).toBe(true);
    expect(satisfied.lifecycle).toBe('satisfied');

    // The evidence note round-trips into the event trail.
    const got = await out(await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.get', { endeavorId }));
    const events = got.events as Array<{ type: string; summary?: string }>;
    expect(events.find((e) => e.type === 'PlanStepSatisfied')?.summary).toBe('Draft written and shared');
    expect(events.find((e) => e.type === 'EndeavorSatisfied')?.summary).toBe('Report published');
  });

  // ── spec 382 W3 (M6 milestones): achieved only with evidence, only what the adopted plan defines, once ──
  it('records a milestone the adopted plan defines as achieved, with evidence, once', async () => {
    const h = makeHarness();
    const req = await out(await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.request', { goal: 'Run the spring retreat', entryPoint: 'home-request' }));
    const created = await out(await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.create', { requestId: req.requestId, decision: 'adopt', title: 'Spring retreat' }));
    const endeavorId = String(created.endeavorId);
    const proposed = await out(await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.proposePlan', {
      endeavorId,
      steps: [{ stepId: 'step_venue', kind: 'contribution', description: 'Book the venue' }],
      milestones: [{ milestoneId: 'ms_venue', title: 'Venue booked', criteria: [{ criterionId: 'crit_contract' }] }],
    }));
    expect(proposed.ok).toBe(true);
    const planRef = { planId: proposed.planId, revision: Number(proposed.revision), hash: proposed.contentHash };
    expect((await out(await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.adoptPlan', { endeavorId, planRef }))).ok).toBe(true);
    const detail = await out(await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.get', { endeavorId }));
    expect((detail.plan as { milestones?: Array<{ milestoneId: string }> }).milestones?.map((m) => m.milestoneId)).toEqual(['ms_venue']);

    const noEvidence = await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.milestone.achieve', { endeavorId, milestoneId: 'ms_venue' });
    expect(noEvidence.status).toBe(400);
    const unknown = await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.milestone.achieve', { endeavorId, milestoneId: 'ms_nope', evidence: 'signed' });
    expect(unknown.status).toBeGreaterThanOrEqual(400);
    const done = await out(await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.milestone.achieve', { endeavorId, milestoneId: 'ms_venue', evidence: 'Contract signed with the lodge' }));
    expect(done.ok).toBe(true);
    const again = await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.milestone.achieve', { endeavorId, milestoneId: 'ms_venue', evidence: 'twice' });
    expect(again.status).toBeGreaterThanOrEqual(400);
    const after = await out(await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.get', { endeavorId }));
    expect((after.milestones as Array<{ milestoneId: string }>).map((m) => m.milestoneId)).toEqual(['ms_venue']);
  });

  it('rejects satisfyStep from a non-participant session', async () => {
    const h = makeHarness();
    const { endeavorId } = await driveToAllocation(h);
    const res = await handleEndeavorOp(h.as(STRANGER, { member: 'Member' }), 'endeavor.satisfyStep', {
      endeavorId, stepId: 'step_draft', evidence: 'nope',
    });
    expect(res.status).toBe(403);
  });

  it('abandons an endeavor with a recorded reason', async () => {
    const h = makeHarness();
    const { endeavorId } = await driveToAllocation(h);
    const res = await out(await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.abandon', {
      endeavorId, reason: 'requester withdrew',
    }));
    expect(res.ok).toBe(true);
    expect(res.lifecycle).toBe('abandoned');
    const got = await out(await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.get', { endeavorId }));
    const events = got.events as Array<{ type: string; summary?: string }>;
    expect(events.find((e) => e.type === 'EndeavorAbandoned')?.summary).toBe('requester withdrew');
  });

  // spec 334 §6 — the org agent's plan-draft return path: the ORG ITSELF (actor = managing
  // principal) proposes a plan revision, which the reducer's ProposePlan gate admits.
  it('admits a plan proposed BY the org principal (the agent-drafted suggestion)', async () => {
    const h = makeHarness();
    const req = await out(await handleEndeavorOp(h.as(REQUESTER), 'endeavor.request', { goal: 'Plan the retreat' }));
    const created = await out(await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.create', {
      requestId: req.requestId, decision: 'adopt',
    }));
    const endeavorId = String(created.endeavorId);
    // The internal door: sessionSa = ORG, memberName = 'Organization agent'.
    const proposed = await out(await handleEndeavorOp(h.as(ORG, { member: 'Organization agent' }), 'endeavor.proposePlan', {
      endeavorId,
      steps: [
        { stepId: 'step_1', kind: 'interaction', description: 'Gather details from the requester' },
        { stepId: 'step_2', kind: 'contribution', description: 'Draft the retreat itinerary' },
        { stepId: 'step_3', kind: 'validation', description: 'Confirm the outcome with the requester' },
      ],
    }));
    expect(proposed.ok).toBe(true);
    const got = await out(await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.get', { endeavorId }));
    const plans = got.plans as Array<{ proposedBy: string; status: string }>;
    expect(plans[0]?.proposedBy).toBe(ORG);
    expect(plans[0]?.status).toBe('proposed');
    const plan = got.plan as { proposedBy: string; status: string };
    expect(plan.proposedBy).toBe(ORG);
  });

  it('applies §12 visibility on list/get', async () => {
    const h = makeHarness();
    const { endeavorId } = await driveToAllocation(h);

    // Steward sees the endeavor + all requests.
    const stewardList = await out(await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.list', {}));
    expect((stewardList.endeavors as unknown[]).length).toBe(1);
    expect((stewardList.requests as unknown[]).length).toBe(1);

    // A member sees the open endeavor but not the requester's request row.
    const memberList = await out(await handleEndeavorOp(h.as(STRANGER, { member: 'Member' }), 'endeavor.list', {}));
    expect((memberList.endeavors as unknown[]).length).toBe(1);
    expect((memberList.requests as unknown[]).length).toBe(0);

    // A non-member stranger sees nothing but can be a requester elsewhere.
    const strangerList = await out(await handleEndeavorOp(h.as(STRANGER), 'endeavor.list', {}));
    expect((strangerList.endeavors as unknown[]).length).toBe(0);

    // The requester sees their own request status via get (request-only view).
    const requesterGet = await out(await handleEndeavorOp(h.as(REQUESTER), 'endeavor.get', { endeavorId }));
    expect(requesterGet.view).toBe('request-only');

    // A stranger session gets 403 on get.
    const strangerGet = await handleEndeavorOp(h.as(STRANGER), 'endeavor.get', { endeavorId });
    expect(strangerGet.status).toBe(403);
  });
});

describe('pure visibility helpers', () => {
  const entry = (over: Partial<EndeavorIndexEntryV1>): EndeavorIndexEntryV1 => ({
    endeavorId: 'end_1',
    title: 't',
    lifecycle: 'active',
    revision: 3,
    participants: [],
    requester: REQUESTER,
    updatedAt: '2026-07-19T00:00:00Z',
    ...over,
  });

  it('visibleEndeavorRows: steward all, member open-only + participating, stranger participating-only', () => {
    const rows = [
      entry({ endeavorId: 'end_open', lifecycle: 'active' }),
      entry({ endeavorId: 'end_done', lifecycle: 'satisfied' }),
      entry({ endeavorId: 'end_mine', lifecycle: 'satisfied', participants: [STRANGER] }),
    ];
    expect(visibleEndeavorRows(rows, STEWARD, { steward: true, member: false })).toHaveLength(3);
    expect(visibleEndeavorRows(rows, STRANGER, { steward: false, member: true }).map((r) => r.endeavorId)).toEqual(['end_open', 'end_mine']);
    expect(visibleEndeavorRows(rows, STRANGER, { steward: false, member: false }).map((r) => r.endeavorId)).toEqual(['end_mine']);
  });

  it('endeavorViewFor: requester of an unadopted request gets request-only', () => {
    const state = reduceEventLog([]);
    expect(endeavorViewFor(state, STRANGER, { steward: false, member: false })).toBe('none');
  });
});

// CAPABILITY REQUIREMENTS SURVIVE THE WIRE.
//
// PlanStepV1 has carried `capabilityRequirements` all along and this parser silently dropped it, so
// a planner could name the capability a step needs and the STORED plan would not — which makes
// routing that step to the agent holding the capability impossible regardless of what was planned.
// The property under test is preservation, and that a malformed entry costs the entry rather than
// the plan (a capability is a reference, never authority — ADR-0053).
describe('parsePlanSteps — capability requirements', () => {
  const step = (extra: Record<string, unknown> = {}) => ({
    stepId: 'step_1_abcd1234', kind: 'contribution', description: 'Author the T-box', ...extra,
  });
  const CAP = 'urn:skills:cap:ontology-engineering:tbox-modeling';

  it('preserves a well-formed requirement', () => {
    const out = parsePlanSteps([step({ capabilityRequirements: [{ capabilityIri: CAP, minAssertionStrength: 'declared' }] })]);
    expect(out?.[0]?.capabilityRequirements).toEqual([{ capabilityIri: CAP, minAssertionStrength: 'declared' }]);
  });

  it('preserves several, and every allowed strength', () => {
    const reqs = [
      { capabilityIri: CAP, minAssertionStrength: 'declared' },
      { capabilityIri: `${CAP}-b`, minAssertionStrength: 'claimed' },
      { capabilityIri: `${CAP}-c`, minAssertionStrength: 'demonstrated' },
    ];
    expect(parsePlanSteps([step({ capabilityRequirements: reqs })])?.[0]?.capabilityRequirements).toEqual(reqs);
  });

  it('omits the field entirely when absent — no empty array on every step', () => {
    expect(parsePlanSteps([step()])?.[0]).not.toHaveProperty('capabilityRequirements');
  });

  it('drops a malformed entry WITHOUT failing the plan', () => {
    const out = parsePlanSteps([step({
      capabilityRequirements: [
        { capabilityIri: '', minAssertionStrength: 'declared' },
        { capabilityIri: CAP, minAssertionStrength: 'wishful' },
        { capabilityIri: 'x'.repeat(400), minAssertionStrength: 'declared' },
        { capabilityIri: CAP, minAssertionStrength: 'declared' },
      ],
    })]);
    expect(out).not.toBeNull();
    expect(out?.[0]?.capabilityRequirements).toEqual([{ capabilityIri: CAP, minAssertionStrength: 'declared' }]);
  });

  it('a non-array, or one that leaves nothing valid, yields a step with no requirements', () => {
    expect(parsePlanSteps([step({ capabilityRequirements: 'nope' })])?.[0]).not.toHaveProperty('capabilityRequirements');
    expect(parsePlanSteps([step({ capabilityRequirements: [{ capabilityIri: '' }] })])?.[0]).not.toHaveProperty('capabilityRequirements');
  });

  it('still enforces the rest of the step shape', () => {
    expect(parsePlanSteps([{ ...step(), kind: 'invented' }])).toBeNull();
  });
});

describe('spec 382 W2 — withdraw, reallocate, and typed receipt refs', () => {
  it('only the committed participant withdraws; a steward reallocates to a NEW allocation; satisfied steps carry typed refs', async () => {
    const { typedReceiptRefs } = await import('../src/endeavors.js');
    expect(typedReceiptRefs(['urn:ap:receipt:run:run-1', 'urn:ap:receipt:tx:0xabc', 'urn:ap:receipt:run:run-1', 'not-a-ref', 'urn:ap:evidence:note']).map((r) => (r as { iri: string }).iri))
      .toEqual(['urn:ap:receipt:run:run-1', 'urn:ap:receipt:tx:0xabc']);
    const h = makeHarness();
    const { endeavorId, planRef, allocationId } = await driveToAllocation(h);
    const digest = await commitmentPayloadDigest({ endeavorId, allocationRef: allocationId, planRef, steps: ['step_draft'] });
    await out(await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.commit', { endeavorId, allocationRef: allocationId, planRef, steps: ['step_draft'], signature: { payloadHash: digest, signer: STEWARD, scheme: 'erc1271', signature: '0xdeadbeef' } }));
    const commitmentId = Object.keys(reduceEventLog(h.docs.get(coordinationEventsResource(endeavorId)) as CoordinationEventV1[]).commitments)[0]!;
    // A stranger may not withdraw somebody else's commitment.
    const stranger = await handleEndeavorOp(h.as(REQUESTER), 'endeavor.withdrawCommitment', { endeavorId, commitmentId, reason: 'not mine' });
    expect(stranger.status).toBeGreaterThanOrEqual(400);
    // The participant withdraws, with a reason.
    const wr = await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.withdrawCommitment', { endeavorId, commitmentId, reason: 'travelling that week' });
    if (wr.status >= 400) console.log('WITHDRAW', wr.status, await wr.clone().text());
    const w = await out(wr);
    expect(w.ok).toBe(true);
    let state = reduceEventLog(h.docs.get(coordinationEventsResource(endeavorId)) as CoordinationEventV1[]);
    expect(state.commitments[commitmentId]?.status).toBe('withdrawn');
    // A steward reallocates the withdrawn contribution to another participant — a NEW allocation for them.
    // To a stranger: refused by the reducer (a reallocation names a participant or invitee, never anyone).
    const toStranger = await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.reallocate', { endeavorId, commitmentId, participant: REQUESTER });
    expect(toStranger.status).toBe(409);
    // To a participant: a NEW allocation for them to commit to (here the same participant, re-offered).
    const rr = await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.reallocate', { endeavorId, commitmentId, participant: STEWARD });
    if (rr.status >= 400) console.log('REALLOC', rr.status, await rr.clone().text());
    const re = await out(rr);
    expect(re.ok).toBe(true);
    state = reduceEventLog(h.docs.get(coordinationEventsResource(endeavorId)) as CoordinationEventV1[]);
    expect(Object.values(state.allocations).some((a) => a.allocationId === re.allocationId && a.participant.toLowerCase() === STEWARD.toLowerCase())).toBe(true);
    // A satisfied step carries the receipt refs typed, beside the note.
    const dr = await handleEndeavorOp(h.as(STEWARD, { steward: true }), 'endeavor.satisfyStep', { endeavorId, stepId: 'step_draft', evidence: 'drafted', evidenceRefs: ['urn:ap:receipt:run:run-9', 'urn:ap:receipt:tx:0x99'] });
    if (dr.status >= 400) console.log('SATISFY', dr.status, await dr.clone().text());
    const done = await out(dr);
    expect(done.ok).toBe(true);
    const ev = (h.docs.get(coordinationEventsResource(endeavorId)) as CoordinationEventV1[]).find((e) => e.kind === 'PlanStepSatisfied') as { evidenceRefs: Array<{ iri: string }> };
    expect(ev.evidenceRefs.map((r) => r.iri)).toEqual(['urn:ap:receipt:run:run-9', 'urn:ap:receipt:tx:0x99', expect.stringMatching(/^urn:ap:evidence:drafted$/)]);
  });
});
