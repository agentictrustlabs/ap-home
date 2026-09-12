import { describe, it, expect } from 'vitest';
import { workItemOf, workItemRow } from './work-item';

const ORG = '0x1111111111111111111111111111111111111111';
const P1 = '0x2222222222222222222222222222222222222222', P2 = '0x3333333333333333333333333333333333333333';

describe('the accountable work item (398 §4.3)', () => {
  it('projects goal · owner · executors · state · acceptance from the detail, and says what is absent', () => {
    const w = workItemOf(ORG, 'e1', {
      endeavor: { endeavorId: 'e1', title: 'Prepare the retreat', lifecycle: 'active', outcome: { description: 'A retreat everyone can attend', criteria: ['venue booked', 'invitations sent'] } },
      participations: [{ participant: P1, participantName: 'Mara', role: 'contributor' } as never],
      allocations: [{ allocationId: 'a1', endeavorId: 'e1', participant: P1, planRef: { planId: 'p', revision: 1 }, steps: ['s1', 's2'] } as never],
      commitments: [{ commitmentId: 'c1', endeavorId: 'e1', participant: P1, planRef: { planId: 'p', revision: 1 }, steps: ['s1', 's2'], status: 'active' } as never, { commitmentId: 'c2', endeavorId: 'e1', participant: P2, planRef: { planId: 'p', revision: 1 }, steps: ['s3'], status: 'withdrawn' } as never],
      decisions: [{ decisionId: 'd1', approver: P2, status: 'pending', decisionKind: 'plan-adoption' }],
    })!;
    expect(w.goal).toBe('A retreat everyone can attend');
    expect(w.owner).toEqual({ agent: ORG, kind: 'org' });
    expect(w.executors).toEqual([{ agent: P1, name: 'Mara', via: 'commitment', steps: 2 }]);   // the withdrawn commitment is not an executor
    expect(w.state.state).toBe('running'); expect(w.native).toBe('active');
    expect(w.acceptance).toEqual({ criteria: ['venue booked', 'invitations sent'], approvers: [{ agent: P2, decisionKind: 'plan-adoption', pending: true }] });
    expect(w.artifacts).toEqual([]); expect(w.cost).toBeNull();
  });
  it('no endeavor, no item', () => { expect(workItemOf(ORG, 'x', {})).toBeNull(); });
  it('the list row carries the same contract: goal · owner · state · progress, and names what only the item answers', () => {
    const r = workItemRow(ORG, { title: 'Retreat', lifecycle: 'active', stepsTotal: 4, stepsSatisfied: 1 });
    expect(r.goal).toBe('Retreat'); expect(r.owner).toEqual({ agent: ORG.toLowerCase(), kind: 'org' });
    expect(r.state.state).toBe('running'); expect(r.progress).toEqual({ satisfied: 1, total: 4 });
    expect(r.onItem).toEqual(['executors', 'artifacts', 'acceptance', 'cost']);
    expect(workItemRow(ORG, { title: 'x', lifecycle: 'proposed' }).progress).toBeNull();
  });
});
