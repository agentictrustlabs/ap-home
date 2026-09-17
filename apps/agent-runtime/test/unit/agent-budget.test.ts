import { describe, it, expect } from 'vitest';
import { budgetOf, overBudget } from '../../src/agent-budget.js';

describe("an agent's budget (P1.4)", () => {
  it('normalises a record: whole non-negative numbers, else unbounded', () => {
    expect(budgetOf({ asksPerDay: 5.9, vaultCallsPerDay: -1, note: 'x' })).toMatchObject({ type: 'ap.agent-budget.v1', asksPerDay: 5, vaultCallsPerDay: null, note: 'x' });
    expect(budgetOf(null)).toEqual({ type: 'ap.agent-budget.v1', asksPerDay: null, vaultCallsPerDay: null });
  });
  it('says what stands in the way, and nothing when within budget or unbounded', () => {
    const b = budgetOf({ asksPerDay: 3, vaultCallsPerDay: 100 });
    expect(overBudget(b, { day: 'd', asks: 2, vaultCalls: 10, doRequests: 0 })).toBeNull();
    expect(overBudget(b, { day: 'd', asks: 3, vaultCalls: 10, doRequests: 0 })).toMatch(/3 of 3 asks/);
    expect(overBudget(b, { day: 'd', asks: 0, vaultCalls: 100, doRequests: 0 })).toMatch(/100 of 100 vault calls/);
    expect(overBudget(budgetOf(null), { day: 'd', asks: 999, vaultCalls: 999, doRequests: 0 })).toBeNull();
  });
});
