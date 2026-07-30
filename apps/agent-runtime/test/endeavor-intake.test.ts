// spec 334 §4 (W4) — one engine, four doors + the execution binding.
// Part 1: each door adapter's body drives the SAME `endeavor.request` op (entryPoint +
// intakeContext land on the pending request row verbatim).
// Part 2: a committed PlanStep compiles to an ExecutionIntent descriptor, rides a task input as
// the adapter-contract binding, survives the JSON wire, and round-trips through
// `projectEndeavorProvenance` into a `p-plan:correspondsToStep`-bound run trace.
import { describe, expect, it } from 'vitest';
import type { Address } from '@agenticprimitives/types';
import {
  applyCoordinationEvent,
  compilePlanToExecutionIntents,
  initialCoordinationState,
  planKey,
  validateCoordinationCommand,
  type CoordinationCommandV1,
  type CoordinationStateV1,
  type PlanRevisionRef,
  type PlanStepV1,
  type SignedPayloadRef,
} from '@agenticprimitives/coordination';
import { planContentHash } from '@agenticprimitives/coordination/planning';
import { projectEndeavorProvenance } from '@agenticprimitives/provenance';
import {
  COORDINATION_REQUESTS_RESOURCE,
  handleEndeavorOp,
  type CoordinationRequestsDocV1,
  type EndeavorOpDeps,
} from '../src/endeavors.js';
import {
  buildEndeavorTaskInput,
  endeavorRequestFromA2aTask,
  endeavorRequestFromDiscussionAsk,
  endeavorRequestFromInboxAsk,
  executionInputFromTask,
  parseEndeavorRequestInput,
  parseEndeavorTaskBinding,
  parseEndeavorStateInput,
  ENDEAVOR_REQUEST_SKILL_ID,
  ENDEAVOR_STATE_SKILL_ID,
} from '../src/endeavor-intake.js';
import { skillSelector } from '@agenticprimitives/a2a';

const ORG = `0x${'a'.repeat(40)}`;
const REQUESTER = `0x${'c'.repeat(40)}`;
const CAROL = `0x${'d'.repeat(40)}` as Address;
const AT = '2026-07-19T12:00:00Z';

function makeDeps(docs: Map<string, unknown>, session: string): EndeavorOpDeps {
  return {
    principal: ORG,
    principalCaip: `eip155:84532:${ORG}`,
    sessionSa: session,
    sessionCaip: `eip155:84532:${session}`,
    readDoc: async <T,>(resource: string, empty: T): Promise<T> =>
      docs.has(resource) ? (JSON.parse(JSON.stringify(docs.get(resource))) as T) : empty,
    writeDoc: async (resource: string, data: unknown): Promise<void> => {
      docs.set(resource, JSON.parse(JSON.stringify(data)));
    },
    serialize: <T,>(fn: () => Promise<T>): Promise<T> => fn(),
    memberName: async () => null,
    isSteward: async () => false,
    verifySignature: async () => true,
    writeAudit: async () => undefined,
    putTopicBody: async () => undefined,
  };
}

describe('entry-point adapters (one engine, four doors)', () => {
  const DOORS = [
    {
      body: endeavorRequestFromDiscussionAsk({ channelId: 'conv_board', messageId: 'msg_1', question: 'Plan the retreat?' }),
      entryPoint: 'discussion-ask',
      context: [{ kind: 'channel-message', id: 'msg_1' }, { kind: 'channel', id: 'conv_board' }],
    },
    {
      body: endeavorRequestFromInboxAsk({ conversationId: 'conv_dm1', messageId: 'env_7', ask: 'Can you book travel?' }),
      entryPoint: 'inbox-ask',
      context: [{ kind: 'inbox-message', id: 'env_7' }, { kind: 'conversation', id: 'conv_dm1' }],
    },
    {
      body: endeavorRequestFromA2aTask({ taskId: '0xbeef', goal: 'Rebalance the treasury' }),
      entryPoint: 'a2a-intent',
      context: [{ kind: 'a2a-task', id: '0xbeef' }],
    },
  ] as const;

  it('every door body drives the SAME endeavor.request op and persists entryPoint + intakeContext', async () => {
    for (const door of DOORS) {
      const docs = new Map<string, unknown>();
      const res = await handleEndeavorOp(makeDeps(docs, REQUESTER), 'endeavor.request', { ...door.body });
      const out = (await res.json()) as { ok?: boolean; requestId?: string };
      expect(out.ok, door.entryPoint).toBe(true);
      const doc = docs.get(COORDINATION_REQUESTS_RESOURCE) as CoordinationRequestsDocV1;
      expect(doc.rows).toHaveLength(1);
      expect(doc.rows[0]!.request.entryPoint).toBe(door.entryPoint);
      expect(doc.rows[0]!.request.intakeContext).toEqual(door.context);
      expect(doc.rows[0]!.request.requester.toLowerCase()).toBe(REQUESTER);
    }
  });

  it('an adapter with a blank goal is rejected by the op (never a junk request row)', async () => {
    const docs = new Map<string, unknown>();
    const res = await handleEndeavorOp(makeDeps(docs, REQUESTER), 'endeavor.request', {
      ...endeavorRequestFromA2aTask({ taskId: '0xbeef', goal: '   ' }),
    });
    expect(res.status).toBe(400);
    expect(docs.has(COORDINATION_REQUESTS_RESOURCE)).toBe(false);
  });
});

// ── Execution binding round-trip (spec 332 §10 / spec 334 §4 door 4) ─────────────────────────────

const STEPS: PlanStepV1[] = [{ stepId: 'step_a', kind: 'contribution', description: 'draft the report' }];
const PLAN_HASH = planContentHash({ steps: STEPS, edges: [], milestones: [] });
const PLAN_REF: PlanRevisionRef = { planId: 'plan_x', revision: 1, hash: PLAN_HASH };
const SIG: SignedPayloadRef = {
  payloadHash: `0x${'1'.repeat(64)}`,
  signer: CAROL,
  scheme: 'ecdsa',
  signature: `0x${'2'.repeat(64)}`,
};

function exec(state: CoordinationStateV1, command: CoordinationCommandV1): CoordinationStateV1 {
  const r = validateCoordinationCommand(state, command);
  if (!r.ok) throw new Error(`unexpected rejection of ${command.kind}: ${r.reason}`);
  let next = state;
  for (const e of r.events) next = applyCoordinationEvent(next, e);
  return next;
}

function committedState(): CoordinationStateV1 {
  const org = ORG as Address;
  let s = initialCoordinationState();
  s = exec(s, { kind: 'SubmitEndeavorRequest', actor: REQUESTER as Address, issuedAt: AT, requestId: 'ereq_1', targetPrincipal: org, goal: 'ship it', entryPoint: 'a2a-intent' });
  s = exec(s, {
    kind: 'AdoptEndeavor', actor: org, issuedAt: AT, requestId: 'ereq_1', endeavorId: 'end_1', situationId: 'sit_1', title: 'ship it',
    outcome: { outcomeId: 'out_1', criteria: [{ criterionId: 'c1', kind: 'attestable', statement: 'shipped' }] },
    initialParticipations: [{ participationId: 'part_coord', participant: org, role: 'coordinator' }],
  });
  s = exec(s, { kind: 'ProposePlan', actor: org, issuedAt: AT, endeavorId: 'end_1', planId: 'plan_x', revision: 1, steps: STEPS, edges: [], milestones: [] });
  s = exec(s, { kind: 'AdoptPlan', actor: org, issuedAt: AT, endeavorId: 'end_1', planRef: PLAN_REF });
  s = exec(s, { kind: 'InviteParticipant', actor: org, issuedAt: AT, endeavorId: 'end_1', participationId: 'part_c', participant: CAROL, role: 'contributor' });
  s = exec(s, { kind: 'AcceptParticipation', actor: CAROL, issuedAt: AT, endeavorId: 'end_1', participationId: 'part_c' });
  s = exec(s, { kind: 'ProposeContribution', actor: CAROL, issuedAt: AT, endeavorId: 'end_1', proposalId: 'prop_1', planRef: PLAN_REF, steps: ['step_a'] });
  s = exec(s, { kind: 'AllocateContribution', actor: org, issuedAt: AT, endeavorId: 'end_1', allocationId: 'alloc_1', proposalRef: 'prop_1', participant: CAROL, steps: ['step_a'] });
  s = exec(s, { kind: 'CommitContribution', actor: CAROL, issuedAt: AT, endeavorId: 'end_1', commitmentId: 'commit_1', allocationRef: 'alloc_1', planRef: PLAN_REF, steps: ['step_a'], signature: SIG });
  return s;
}

describe('A2A task execution binding', () => {
  const state = committedState();
  const compiled = compilePlanToExecutionIntents({
    endeavor: state.endeavor!,
    plan: state.plans[planKey('plan_x', 1)]!,
    commitments: Object.values(state.commitments),
  });

  it('the compiled descriptor rides the task input and survives the JSON wire fail-closed', () => {
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const input = buildEndeavorTaskInput(compiled.intents[0]!);
    expect(input.goal).toBe('draft the report');
    const wire = JSON.parse(JSON.stringify(input)) as unknown;
    const binding = parseEndeavorTaskBinding(wire);
    expect(binding).toEqual(compiled.intents[0]!.provenance);
  });

  it('rejects a partial binding (a run that cannot bind exactly is unbound, never approximate)', () => {
    if (!compiled.ok) return;
    const input = JSON.parse(JSON.stringify(buildEndeavorTaskInput(compiled.intents[0]!))) as { endeavorBinding: Record<string, unknown> };
    delete input.endeavorBinding.commitmentRef;
    expect(parseEndeavorTaskBinding(input)).toBeNull();
    expect(parseEndeavorTaskBinding({})).toBeNull();
    expect(parseEndeavorTaskBinding(null)).toBeNull();
  });

  it('round-trips through projectEndeavorProvenance: the task run binds p-plan:correspondsToStep', () => {
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const intent = compiled.intents[0]!;
    const binding = parseEndeavorTaskBinding(JSON.parse(JSON.stringify(buildEndeavorTaskInput(intent))))!;
    const execution = executionInputFromTask({
      taskId: '0xtask1',
      binding,
      startedAt: AT,
      endedAt: AT,
      artifactRefs: ['vault:artifact:report-draft'],
      actorClass: 'person',
    });
    const rec = projectEndeavorProvenance({
      endeavorId: binding.endeavorId,
      managingPrincipal: binding.principal,
      managingPrincipalClass: 'org',
      planRevisions: [{
        planId: PLAN_REF.planId,
        revision: PLAN_REF.revision,
        contentHash: PLAN_REF.hash,
        proposedBy: ORG,
        proposedAt: AT,
        status: 'adopted',
        adoptedBy: ORG,
        adoptedAt: AT,
        steps: STEPS.map((st) => ({ stepId: st.stepId, kind: st.kind })),
      }],
      executions: [execution],
    });
    const activity = rec.activities.find((a) => a.id === 'act:a2a-task:0xtask1')!;
    expect(activity.correspondsToStep).toBe('step_a');
    expect(activity.hadPlan).toBe(`ent:end_1:plan:plan_x:rev:1`);
    expect(activity.wasAssociatedWith.toLowerCase()).toBe(CAROL.toLowerCase());
    expect(activity.hadRole).toBe('committed-contributor');
    expect(activity.used).toContain('commitment:commit_1');
    const artifact = rec.entities.find((e) => e.wasGeneratedBy === activity.id)!;
    expect(artifact.ref).toBe('vault:artifact:report-draft');
    // The plan projection carries the step the run corresponds to.
    expect(rec.plans[0]!.steps.map((st) => st.id)).toEqual(['step_a']);
  });
});

// ── The narrow `endeavor.request` skill — the door the Operational Intent grant names ────────────
// The gate authorizes a message by the SKILL IT NAMES, so this skill's id IS an authority boundary:
// change the string and every already-minted grant stops matching, silently. These are the guards.

describe('endeavor.request — the skill id is the authority boundary', () => {
  it('is exactly the string demo-sso-next mints the grant against', () => {
    // OPERATIONAL_INTENT_SKILLS in demo-sso-next/src/lib/delegation.ts carries this literal. Both
    // sides keep their own copy (the CONSULT_SKILL precedent — neither app depends on the other),
    // so this assertion is the thing standing between them and a silent drift.
    expect(ENDEAVOR_REQUEST_SKILL_ID).toBe('endeavor.request');
  });

  it('derives the 4-byte selector the grant encodes in allowedMethods', () => {
    const selector = skillSelector(ENDEAVOR_REQUEST_SKILL_ID);
    expect(selector).toMatch(/^0x[0-9a-f]{8}$/);
    // Pinned: a grant minted before this test existed carries THIS value — keccak256(utf8(
    // 'endeavor.request'))[:4]. If the derivation or the skill name changes, the gate rejects
    // credentials that were correct when they were signed.
    expect(selector).toBe('0x9db527f0');
  });
});

describe('parseEndeavorRequestInput — fail-closed body rules', () => {
  it('accepts a bare goal string or { goal }, trimmed', () => {
    expect(parseEndeavorRequestInput('  Rebalance the treasury  ')).toEqual({ ok: true, goal: 'Rebalance the treasury' });
    expect(parseEndeavorRequestInput({ goal: 'Draft the Q3 letter' })).toEqual({ ok: true, goal: 'Draft the Q3 letter' });
  });

  it('refuses an empty or absent goal', () => {
    for (const bad of ['', '   ', {}, { goal: '' }, { goal: 42 }, null, undefined]) {
      const out = parseEndeavorRequestInput(bad);
      expect(out.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('REFUSES caller-supplied provenance rather than sanitizing it', () => {
    // A sender that names its own entryPoint is asserting which door raised the work. Dropping the
    // field would leave the caller believing it took effect — refuse instead (ADR-0013).
    const forged = parseEndeavorRequestInput({ goal: 'x', entryPoint: 'home-request' });
    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(forged.error).toMatch(/entryPoint\/intakeContext/);
    expect(parseEndeavorRequestInput({ goal: 'x', intakeContext: [{ kind: 'channel', id: 'c1' }] }).ok).toBe(false);
  });

  it('the accepted goal files as an a2a-intent with the TASK as its only context', async () => {
    const parsed = parseEndeavorRequestInput({ goal: 'Rebalance the treasury' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const docs = new Map<string, unknown>();
    const body = endeavorRequestFromA2aTask({ taskId: '0xfeed', goal: parsed.goal });
    const res = await handleEndeavorOp(makeDeps(docs, REQUESTER), 'endeavor.request', { ...body });
    expect(((await res.json()) as { ok?: boolean }).ok).toBe(true);
    const row = (docs.get(COORDINATION_REQUESTS_RESOURCE) as CoordinationRequestsDocV1).rows[0]!;
    expect(row.request.entryPoint).toBe('a2a-intent');
    expect(row.request.intakeContext).toEqual([{ kind: 'a2a-task', id: '0xfeed' }]);
    expect(row.request.requester.toLowerCase()).toBe(REQUESTER);
  });
});

describe('endeavor.state — the read half of the same grant', () => {
  it('is the string the grant was minted against, and derives its selector', () => {
    expect(ENDEAVOR_STATE_SKILL_ID).toBe('endeavor.state');
    // Already in OPERATIONAL_INTENT_SKILLS, so grants minted before the handler existed reach it.
    expect(skillSelector(ENDEAVOR_STATE_SKILL_ID)).toBe('0x4ddc81aa');
  });

  it('accepts an endeavor id, as a string or { endeavorId }', () => {
    expect(parseEndeavorStateInput('  end_7  ')).toEqual({ ok: true, endeavorId: 'end_7' });
    expect(parseEndeavorStateInput({ endeavorId: 'end_7' })).toEqual({ ok: true, endeavorId: 'end_7' });
  });

  it('accepts the ereq_ id the SUBMITTER was handed, not just the adopted end_ id', () => {
    // endeavor.request returns a requestId; the end_ id only exists after the org adopts. Refusing
    // ereq_ would mean a dispatcher can name what it raised and never follow it.
    expect(parseEndeavorStateInput({ endeavorId: 'ereq_32ed2ad2' })).toEqual({ ok: true, endeavorId: 'ereq_32ed2ad2' });
  });

  it('REFUSES anything that is neither an end_ nor an ereq_ id', () => {
    for (const bad of ['', 'plan_1', 'end', 'ereq', {}, { endeavorId: 42 }, null, undefined]) {
      expect(parseEndeavorStateInput(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});
