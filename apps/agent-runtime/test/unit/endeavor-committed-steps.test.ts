// Spec 382 — which committed steps are handed to which participant: the new commitments' intents, for
// actors other than the organization, on steps not yet satisfied; nothing for the organization's own promise.
import { describe, expect, it } from 'vitest';
import type { Address } from '@agenticprimitives/types';
import { applyCoordinationEvent, initialCoordinationState, validateCoordinationCommand, type CoordinationCommandV1, type CoordinationStateV1, type CoordinationEventV1 } from '@agenticprimitives/coordination';
import { planContentHash } from '@agenticprimitives/coordination';
import { parkableCommittedSteps } from '../../src/endeavor-committed-steps.js';

const ORG = '0x3b99f2b452766de5df0dbcdfc676f27257151333' as Address;
const ALICE = '0xb0d11ce19b756a682e78b4904cd8d832303b3d11' as Address;
const BOB = '0x8c5cddca27c088a65e58e94403acdc9bc3eb7fe3' as Address;
const AT = '2026-09-08T12:00:00Z';
const STEPS = [
  { stepId: 'step_deposit', kind: 'contribution', description: 'Pay the venue deposit', capabilityRequirements: [{ capabilityIri: 'urn:ap:cap:treasury.payment.execute', minAssertionStrength: 'declared' as const }] },
  { stepId: 'step_notes', kind: 'contribution', description: 'Write the kickoff notes' },
];
const HASH = planContentHash({ steps: STEPS as never, edges: [], milestones: [] });
const REF = { planId: 'plan_1', revision: 1, hash: HASH };
const SIG = (signer: Address) => ({ payloadHash: ('0x' + '11'.repeat(32)) as `0x${string}`, signer, scheme: 'erc1271' as const, signature: '0x1212' as `0x${string}` });

function run(cmds: CoordinationCommandV1[]): { state: CoordinationStateV1; events: CoordinationEventV1[] } {
  let state = initialCoordinationState(); const events: CoordinationEventV1[] = [];
  for (const c of cmds) { const r = validateCoordinationCommand(state, c); if (!r.ok) throw new Error(`${c.kind}: ${r.reason}`); for (const e of r.events) { state = applyCoordinationEvent(state, e); events.push(e); } }
  return { state, events };
}
const base = (): CoordinationCommandV1[] => [
  { kind: 'SubmitEndeavorRequest', actor: ALICE, issuedAt: AT, requestId: 'ereq_1', targetPrincipal: ORG, goal: 'Corridor kickoff', entryPoint: 'home-request' },
  { kind: 'AdoptEndeavor', actor: ORG, issuedAt: AT, requestId: 'ereq_1', endeavorId: 'end_1', situationId: 'sit_1', title: 'Corridor kickoff', outcome: { outcomeId: 'out_1', criteria: [{ criterionId: 'c1', kind: 'attestable', statement: 'kicked off' }] }, initialParticipations: [{ participationId: 'part_a', participant: ALICE, role: 'coordinator' }] },
  { kind: 'ProposePlan', actor: ALICE, issuedAt: AT, endeavorId: 'end_1', planId: 'plan_1', revision: 1, steps: STEPS as never, edges: [], milestones: [] },
  { kind: 'AdoptPlan', actor: ALICE, issuedAt: AT, endeavorId: 'end_1', planRef: REF },
  { kind: 'InviteParticipant', actor: ORG, issuedAt: AT, endeavorId: 'end_1', participationId: 'part_b', participant: BOB, role: 'contributor' },
  { kind: 'AcceptParticipation', actor: BOB, issuedAt: AT, endeavorId: 'end_1', participationId: 'part_b' },
  { kind: 'ProposeContribution', actor: BOB, issuedAt: AT, endeavorId: 'end_1', proposalId: 'prop_b', planRef: REF, steps: ['step_deposit'] },
  { kind: 'AllocateContribution', actor: ORG, issuedAt: AT, endeavorId: 'end_1', allocationId: 'alloc_b', proposalRef: 'prop_b', participant: BOB, steps: ['step_deposit'] },
];

describe('parkableCommittedSteps', () => {
  it('hands the step bob committed to, to bob — with the commitment, the adopted hash and the goal', () => {
    const { state, events } = run([...base(), { kind: 'CommitContribution', actor: BOB, issuedAt: AT, endeavorId: 'end_1', commitmentId: 'commit_b', allocationRef: 'alloc_b', planRef: REF, steps: ['step_deposit'], signature: SIG(BOB) }]);
    const out = parkableCommittedSteps(state, events.slice(-1), ORG);
    expect(out.reason).toBeUndefined();
    expect(out.steps).toHaveLength(1);
    expect(out.steps[0]).toMatchObject({ participant: BOB, commitmentRef: 'commit_b', planHash: HASH, goal: 'Corridor kickoff', step: { stepId: 'step_deposit', capabilityRequirements: [{ capabilityIri: 'urn:ap:cap:treasury.payment.execute' }] } });
  });
  it('parks nothing when the events carry no commitment, and nothing for a commitment the organization made to itself', () => {
    const { state, events } = run(base());
    expect(parkableCommittedSteps(state, events, ORG).steps).toEqual([]);
    const own = run([...base(),
      { kind: 'ProposeContribution', actor: ALICE, issuedAt: AT, endeavorId: 'end_1', proposalId: 'prop_o', planRef: REF, steps: ['step_notes'] },
      { kind: 'AllocateContribution', actor: ORG, issuedAt: AT, endeavorId: 'end_1', allocationId: 'alloc_o', proposalRef: 'prop_o', participant: ALICE, steps: ['step_notes'] },
      { kind: 'CommitContribution', actor: ALICE, issuedAt: AT, endeavorId: 'end_1', commitmentId: 'commit_o', allocationRef: 'alloc_o', planRef: REF, steps: ['step_notes'], signature: SIG(ALICE) },
    ]);
    // alice is not the organization: her commitment IS parked at her. The organization's own would not be.
    expect(parkableCommittedSteps(own.state, own.events.slice(-1), ORG).steps.map((s) => s.participant)).toEqual([ALICE]);
    expect(parkableCommittedSteps(own.state, own.events.slice(-1), ALICE).steps).toEqual([]);
  });
});
