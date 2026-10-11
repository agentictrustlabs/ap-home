import { describe, it, expect } from 'vitest';
import { answerFromDays, publicPulseAsk, subjectOf, windowOf, type PulseDayRecord } from '../src/pulse-public';

const NOW = Date.parse('2026-10-11T12:00:00Z');
const day = (d: string, rec: Partial<PulseDayRecord> = {}): { day: string; rec: PulseDayRecord } => ({ day: d, rec: { type: 'ap.town-pulse.v1', day: d, ...rec } });

describe('the pulse a context agent keeps, answered to a stranger (spec 436 §5.5 T3)', () => {
  it('reads the window out of the words, and says which window it used', () => {
    expect(windowOf('what did inference cost yesterday', NOW).words).toBe('yesterday');
    expect(windowOf('what did inference cost yesterday', NOW).days).toEqual(['2026-10-10']);
    expect(windowOf('how is the town doing this week', NOW).days).toHaveLength(7);
    expect(windowOf('which services were down in the last 7 days', NOW).to).toBe('2026-10-11');
    expect(windowOf('anything over the last 3 days', NOW).days).toHaveLength(3);
    // No window named is not an error: it is seven days, and the answer says so.
    expect(windowOf('how are things', NOW).words).toBe('the last 7 days');
  });

  it('matches the subject on words and never pretends to understand more', () => {
    expect(subjectOf('what did we spend on tokens')).toBe('cost');
    expect(subjectOf('which services were down')).toBe('status');
    expect(subjectOf('how many runs completed')).toBe('runs');
    expect(subjectOf('how is the town doing')).toBe('overall');
  });

  it('an absent record is an absence, never a zero — and the answer cites nothing because it read nothing', () => {
    const a = answerFromDays('what did we spend this week', windowOf('this week', NOW), []);
    expect(a.read).toBe(false);
    expect(a.cited).toEqual([]);
    expect(a.answer).toContain('I have none');
    expect(a.answer).not.toContain('$0.00');
  });

  it('names every record it answered from', () => {
    const w = windowOf('yesterday', NOW);
    const a = answerFromDays('what did it cost yesterday', w, [day('2026-10-10', { pulse: { cost: [{ basis: 'effective', days: [{ day: '2026-10-10', amountMicroUsd: 2_000_000 }] }] } })]);
    expect(a.cited).toEqual([{ key: 'pulse.day:2026-10-10', day: '2026-10-10' }]);
    expect(a.answer).toContain('$2.00 effective');
  });

  it('keeps the bases apart: billed and effective are reported separately and never summed (I1)', () => {
    const w = windowOf('yesterday', NOW);
    const a = answerFromDays('cost yesterday', w, [day('2026-10-10', { pulse: { cost: [
      { basis: 'billed', days: [{ day: '2026-10-10', amountMicroUsd: 0 }] },
      { basis: 'effective', days: [{ day: '2026-10-10', amountMicroUsd: 3_250_000 }] },
    ] } })]);
    expect(a.answer).toContain('$0.00 billed');
    expect(a.answer).toContain('$3.25 effective');
    expect(a.answer).toContain('never added together');
    expect(a.answer).not.toContain('$3.25 billed');
  });

  it('a day with no cost recorded says so rather than reporting nothing spent', () => {
    const a = answerFromDays('what did we spend yesterday', windowOf('yesterday', NOW), [day('2026-10-10')]);
    expect(a.answer).toContain('No infrastructure cost is recorded');
    expect(a.answer).not.toMatch(/\$0\.00\b.*spent/);
  });

  it('answers which services were down from the probe counts, and distinguishes never from sometimes', () => {
    const w = windowOf('last 7 days', NOW);
    const a = answerFromDays('which services were down in the last 7 days', w, [
      day('2026-10-10', { services: { naming: { samples: 10, up: 10 }, skills: { samples: 10, up: 4 }, ghost: { samples: 10, up: 0 } } }),
    ]);
    expect(a.answer).toContain('Never answered');
    expect(a.answer).toContain('ghost');
    expect(a.answer).toContain('skills (4 of 10 probes)');
    expect(a.answer).not.toContain('naming');
  });

  it('says the window is partial when a day in it has no record', () => {
    const w = windowOf('this week', NOW);
    const a = answerFromDays('how is the town doing this week', w, [day(w.days[0]!, { services: { naming: { samples: 2, up: 2 } } })]);
    expect(a.answer).toContain('6 days');
    expect(a.answer).toContain('partial');
    expect(a.cited).toHaveLength(1);
  });

  it('reports runs and cost per completed run only when the record carries them', () => {
    const w = windowOf('yesterday', NOW);
    const withRuns = answerFromDays('how many runs', w, [day('2026-10-10', { heartbeat: { runs: { completed: 50, failed: 2 } }, pulse: { costPerCompletedRun: { microUsd: 12_000, completedRuns: 50, infraBasis: 'effective' } } })]);
    expect(withRuns.answer).toContain('50 completed runs');
    expect(withRuns.answer).toContain('2 failures');
    expect(withRuns.answer).toContain('$0.01');
    expect(withRuns.answer).toContain('effective');
    const without = answerFromDays('how many runs', w, [day('2026-10-10')]);
    expect(without.answer).toContain('No run counts are recorded');
  });

  it('reads the agent\'s own records for the window and answers from them, end to end', async () => {
    const vault: Record<string, PulseDayRecord> = {
      'pulse.day:2026-10-10': { day: '2026-10-10', heartbeat: { runs: { completed: 7 } }, services: { naming: { samples: 5, up: 5 } } },
    };
    const read = async (_subject: string, key: string) => vault[key] ?? null;
    const out = await publicPulseAsk({ readSubjectRecord: read }, '0xabc', { question: 'how did it go yesterday' }, NOW);
    expect(out.read).toBe(true);
    expect(out.cited).toEqual([{ key: 'pulse.day:2026-10-10', day: '2026-10-10' }]);
    expect(String(out.answer)).toContain('7 completed runs');
    // a record the vault refuses is simply not read — never a thrown ask
    const refused = await publicPulseAsk({ readSubjectRecord: async () => { throw new Error('vault_key_unauthorized'); } }, '0xabc', { question: 'yesterday' }, NOW);
    expect(refused.read).toBe(false);
    expect(refused.cited).toEqual([]);
  });
});
