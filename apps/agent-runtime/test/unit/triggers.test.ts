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
