import { describe, expect, it } from 'vitest';
import { schedulesFor, dueNow, nextDue, advanced } from '../../src/triggers.js';

// Spec 370 P5 — a playbook's schedule rows: first due one interval on (assigning is not asking), fired
// once when overdue however long the object slept, and advanced from now.
const AGENT = '0x0000000000000000000000000000000000000a11' as const;
describe('trigger schedules', () => {
  it('rows from a playbook, first due one interval from now', () => {
    const rows = schedulesFor(AGENT, '0xdigest', [{ id: 'daily', kind: 'schedule', every: 'PT24H', ask: 'what are we working on' }], 1000);
    expect(rows).toEqual([{ agent: AGENT, triggerId: 'daily', kind: 'schedule', ask: 'what are we working on', every: 'PT24H', everyMs: 86_400_000, nextAt: 1000 + 86_400_000, playbookDigest: '0xdigest' }]);
    expect(dueNow(rows, 1000)).toEqual([]);
    expect(dueNow(rows, 1000 + 86_400_000)).toHaveLength(1);
    expect(nextDue(rows)).toBe(1000 + 86_400_000);
    expect(nextDue([])).toBeNull();
  });
  it('an overdue row fires once and is advanced from NOW, with what it reached', () => {
    const [row] = schedulesFor(AGENT, '0xd', [{ id: 'weekly', kind: 'schedule', every: 'P7D', ask: 'plan a weekly review' }], 0);
    const later = 30 * 24 * 3600_000; // slept a month
    const after = advanced(row!, 'parked', 'run-1', 'This needs your authority…', later);
    expect(after.nextAt).toBe(later + 7 * 24 * 3600_000);
    expect(after.lastOutcome).toBe('parked');
    expect(after.lastRunRef).toBe('run-1');
    expect(dueNow([after], later)).toEqual([]);
  });
});

// ── spec 398 §5.3 / §5.4 — PAUSE is a routine's own control; BUDGET exhaustion pauses, never widens ─────────────
import { withPause, withBudget, matchingTriggers as matching } from '../../src/triggers.js';
describe('pause and budget (398 §5.3 / §5.4)', () => {
  const agent = '0xee11dfb02e4a02630be512886305df5c68fd682c' as const;
  const row = { agent, triggerId: 't1', kind: 'schedule' as const, ask: 'send the digest', every: '1h', everyMs: 3_600_000, nextAt: 1000, playbookDigest: '0xd' };
  it('a paused schedule is never due; resumed, it is', () => {
    const paused = withPause(row, true, 'holiday', 5);
    expect(paused.paused).toEqual({ at: 5, by: 'steward', note: 'holiday' });
    expect(dueNow([paused], 2000)).toEqual([]);
    expect(dueNow([withPause(paused, false, undefined)], 2000)).toHaveLength(1);
  });
  it('a paused event or webhook row matches no source', () => {
    const hook = withPause({ agent, triggerId: 'w', kind: 'webhook' as const, token: 'tok', ask: 'x', playbookDigest: '0xd' }, true, undefined);
    expect(matching([hook], { kind: 'webhook', triggerId: 'w', token: 'tok', payload: {} })).toEqual([]);
  });
  it('a firing over budget pauses the routine BY BUDGET with the numbers on the row; under budget it does not', () => {
    const budgeted = withBudget(row, 10);
    const over = advanced(budgeted, 'answered', 'r1', 'ok', 9000, { vaultCalls: 14, doRequests: 3 });
    expect(over.paused?.by).toBe('budget'); expect(over.paused?.note).toMatch(/14 vault calls against a budget of 10/);
    expect(over.lastBill).toEqual({ vaultCalls: 14, doRequests: 3 });
    expect(over.nextAt).toBe(9000 + 3_600_000);   // the clock still advanced — the firing happened; only the next is held
    const under = advanced(budgeted, 'answered', 'r2', 'ok', 9000, { vaultCalls: 4, doRequests: 1 });
    expect(under.paused).toBeUndefined();
    expect(withBudget(over, null).budget).toBeUndefined();
  });
  // Spec 398 §5.4 — the budget the SKILL.md trigger declares is the row's initial one, told apart from a steward's.
  it('a budget declared on the contract lands on the row as declared; a steward setting one is not declared', () => {
    const [declared] = schedulesFor(agent, '0xd', [{ id: 'digest', kind: 'schedule', every: 'PT24H', ask: 'what are we working on', budget: { vaultCalls: 40 } }], 0);
    expect(declared!.budget).toEqual({ vaultCalls: 40, declared: true });
    const [hook] = schedulesFor(agent, '0xd', [{ id: 'h', kind: 'webhook', ask: 'status', budget: { vaultCalls: 3 } }], 0);
    expect(hook!.budget).toEqual({ vaultCalls: 3, declared: true });
    expect(withBudget(declared!, 12).budget).toEqual({ vaultCalls: 12 });
    // clearing the steward's returns to the declared one when the playbook still declares it; to none otherwise
    expect(withBudget(withBudget(declared!, 12), null, { vaultCalls: 40 }).budget).toEqual({ vaultCalls: 40, declared: true });
    expect(withBudget(withBudget(declared!, 12), null, null).budget).toBeUndefined();
    const over = advanced(declared!, 'answered', 'r1', 'ok', 9000, { vaultCalls: 41, doRequests: 1 });
    expect(over.paused?.by).toBe('budget');
  });
});
