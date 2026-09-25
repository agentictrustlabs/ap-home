// A routed step is named by the stepRef the record gives it, never by its index — the spec-413 retrieval step at the
// head of a run shifted every index by one, and the reply named `s1` for the step the provenance graph calls `s0`.
import { describe, expect, it } from 'vitest';
import { routedStepsOf } from '../../src/harness-run.js';

describe('routedStepsOf', () => {
  it('uses the observation\'s own stepRef when a retrieval step precedes it', () => {
    const out = routedStepsOf([
      { stepRef: 'retrieve', step: { id: 'retrieve', toolId: 'kb.retrieve' }, result: { count: 3 } },
      { stepRef: 's0', step: { toolId: 'organization.membership.list' }, result: { via: { agent: '0xabc', observedVia: 'serving-handler', runRef: 'routed-run-x-s0' } } },
    ]);
    expect(out.map((r) => r.stepRef)).toEqual(['s0']);
  });
  it('falls back to the plan step id, then the index, when the observation carries no stepRef', () => {
    expect(routedStepsOf([{ step: { id: 'a', toolId: 't' }, result: { via: { agent: '0x1' } } }])[0]!.stepRef).toBe('a');
    expect(routedStepsOf([{ step: { toolId: 't' }, result: { via: { agent: '0x1' } } }])[0]!.stepRef).toBe('s0');
  });
});
