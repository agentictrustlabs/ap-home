// Spec 376 W2 — a playbook's specialist rule sets a step's executor by name; the person's own words outrank it.
import { describe, expect, it } from 'vitest';
import { withSpecialists } from '../../src/harness-run.js';
import type { ToolSpec } from '@agenticprimitives/orchestration';

const tools: ToolSpec[] = [
  { id: 'treasury.payment.execute', description: 'pay', capability: { id: 'treasury.payment.execute', action: 'execute', resourceArg: 'payer', authorityArg: 'payer' } },
  { id: 'org.members', description: 'roster' },
];
describe('withSpecialists', () => {
  it('hands a capability the playbook names to its specialist, by name, and leaves the rest alone', () => {
    const plan = { steps: [{ toolId: 'treasury.payment.execute', args: { payee: 'bob.me', usdc: '1' } }, { toolId: 'org.members', args: {} }] };
    const out = withSpecialists(plan, [{ capability: 'treasury.payment.execute', executor: 'runtime-c3s0.svc' }], tools);
    expect(out.steps[0]?.executor).toBe('runtime-c3s0.svc');
    expect(out.steps[1]?.executor).toBeUndefined();
  });
  it('keeps an executor the plan already names — the person outranks the rule', () => {
    const plan = { steps: [{ toolId: 'treasury.payment.execute', args: {}, executor: 'other.svc' }] };
    expect(withSpecialists(plan, [{ capability: 'treasury.payment.execute', executor: 'runtime-c3s0.svc' }], tools).steps[0]?.executor).toBe('other.svc');
  });
  it('a supplied (screen) plan is handed the same way — the rule is the agent’s behaviour, not the screen’s interpretation', () => {
    const supplied = { steps: [{ toolId: 'treasury.payment.execute', args: { payee: 'nathan.treasury', usdc: '1' }, id: 's0' }] };
    const out = withSpecialists(supplied, [{ capability: 'treasury.payment.execute', executor: 'runtime-c3s0.svc' }], tools);
    expect(out.steps[0]).toEqual({ ...supplied.steps[0], executor: 'runtime-c3s0.svc' });
  });
  it('no specialists ⇒ the plan is returned as is', () => {
    const plan = { steps: [{ toolId: 'org.members', args: {} }] };
    expect(withSpecialists(plan, undefined, tools)).toBe(plan);
  });
});

describe('executorPrefixOf — "have X do it"', () => {
  it('peels a typed name off the front and leaves the ask', async () => {
    const { executorPrefixOf, withExecutor } = await import('../../src/harness-run.js');
    expect(executorPrefixOf('have runtime-c3s0.svc pay nathan.treasury 1 usdc')).toEqual({ executor: 'runtime-c3s0.svc', rest: 'pay nathan.treasury 1 usdc' });
    expect(executorPrefixOf('Ask alice2.treasury to fund bob.treasury with 2 usdc')).toEqual({ executor: 'alice2.treasury', rest: 'fund bob.treasury with 2 usdc' });
    expect(executorPrefixOf('have a look at the roster')).toEqual({ rest: 'have a look at the roster' });
    expect(executorPrefixOf('pay nathan.treasury 1 usdc')).toEqual({ rest: 'pay nathan.treasury 1 usdc' });
    const plan = { steps: [{ toolId: 'treasury.payment.execute', args: {} }, { toolId: 'x', args: {}, executor: 'kept.svc' }] };
    expect(withExecutor(plan, 'runtime-c3s0.svc').steps.map((s) => s.executor)).toEqual(['runtime-c3s0.svc', 'kept.svc']);
  });
});
