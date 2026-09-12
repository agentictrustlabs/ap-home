import { describe, it, expect } from 'vitest';
import { assembleRoutines, sourceWords } from './routines';
describe('a routine as a product (398 G3)', () => {
  it('versioned skill + trigger + fresh authority + history + budget + pause', () => {
    const [r] = assembleRoutines({
      assignment: { archetypeId: 'org-steward', archetypeVersion: '3', definitionDigest: '0xabc' },
      triggers: [{ triggerId: 'digest', kind: 'schedule', ask: 'send the weekly digest', every: 'P7D', nextAt: 5, lastAt: 4, lastRunRef: 'r2', lastOutcome: 'answered', budget: { vaultCalls: 20 }, lastBill: { vaultCalls: 6, doRequests: 2 } }],
      records: [
        { runRef: 'r1', at: 1, outcome: 'completed', steps: 1, receipts: 1, intent: { goal: 'send the weekly digest', context: { trigger: 'digest' } } },
        { runRef: 'r2', at: 4, outcome: 'completed', steps: 1, receipts: 1, intent: { goal: 'send the weekly digest', context: { trigger: 'digest' } } },
        { runRef: 'rx', at: 3, outcome: 'completed', steps: 1, receipts: 1, intent: { goal: 'someone asked', context: {} } },
      ],
    });
    expect(r!.playbook).toEqual({ archetypeId: 'org-steward', version: '3', digest: '0xabc', current: true });
    expect(r!.source).toBe('every 7d'); expect(r!.state.state).toBe('completed');
    expect(r!.history.map((h) => h.runRef)).toEqual(['r2', 'r1']);
    expect(r!.budget).toBe(20); expect(r!.budgetBy).toBe('steward'); expect(r!.lastBill?.vaultCalls).toBe(6);
    expect(r!.authority).toMatch(/never one carried/);
  });
  it('paused reads as blocked and says by whom; a never-fired routine is queued', () => {
    const [p, q] = assembleRoutines({ assignment: null, records: [], triggers: [
      { triggerId: 'a', kind: 'schedule', ask: 'x', lastOutcome: 'answered', paused: { at: 1, by: 'budget', note: 'over' } },
      { triggerId: 'b', kind: 'webhook', ask: 'y' },
    ] });
    expect(p!.state.state).toBe('blocked'); expect(p!.native).toBe('paused by budget'); expect(p!.playbook).toBeNull();
    expect(q!.state.state).toBe('queued'); expect(sourceWords({ triggerId: 'b', kind: 'webhook', ask: 'y' })).toMatch(/grants nothing/);
  });
});
