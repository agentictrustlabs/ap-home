import { describe, it, expect } from 'vitest';

describe('declared rows rebuilt from the record (spec 323 W6)', () => {
  it('a schedule row gets a fresh clock from the sentence in her zone; a connector row primes; `advanced` drops the prime', async () => {
    const { rowOfDeclared, advanced } = await import('../src/triggers.js');
    const { parseRoutineSentence } = await import('../src/routine-sentence.js');
    const compile = (s: string, tz: string) => { const p = parseRoutineSentence(s, { tz, now: Date.parse('2026-09-15T12:00:00Z') }); return 'error' in p ? null : { firstAt: p.firstAt }; };
    const A = ('0x' + 'a'.repeat(40)) as `0x${string}`;
    const clock = rowOfDeclared(A, { triggerId: 'r1', kind: 'schedule', ask: "what's on my calendar", every: '7d', everyMs: 7 * 86_400_000, declared: { by: A, at: 1, saidAs: "every Monday at 8, tell me what's on my calendar", when: 'every Monday at 8', tz: 'America/Denver' } }, compile, Date.parse('2026-09-15T12:00:00Z'));
    expect(clock.playbookDigest).toBe('declared'); expect(clock.declared?.saidAs).toContain('every Monday');
    expect(new Date(clock.nextAt!).toISOString()).toBe('2026-09-21T14:00:00.000Z'); // next Monday 08:00 Denver (UTC-6)
    const poll = rowOfDeclared(A, { triggerId: 'r2', kind: 'connector', on: { connector: 'google-gmail', query: 'from:pastor newer_than:2d' }, ask: 'summarize it', every: '15m', everyMs: 900_000, declared: { by: A, at: 1, saidAs: 'when mail arrives from the pastor, summarize it', when: 'when mail arrives from the pastor', tz: 'UTC' } }, compile, 1000);
    expect(poll.primeSeen).toBe(true); expect(poll.seen).toEqual([]); expect(poll.nextAt).toBe(1000 + 900_000);
    const after = advanced({ ...poll, seen: ['t1'] }, 'answered', 'run-1', 'primed', 2000);
    expect((after as { primeSeen?: true }).primeSeen).toBeUndefined(); expect(after.seen).toEqual(['t1']);
    // a sentence the grammar no longer reads falls back to one interval from now — never a row with no clock
    const odd = rowOfDeclared(A, { triggerId: 'r3', kind: 'schedule', ask: 'x', every: '1d', everyMs: 86_400_000, declared: { by: A, at: 1, saidAs: 'sometimes, x', when: '?', tz: 'UTC' } }, compile, 5000);
    expect(odd.nextAt).toBe(5000 + 86_400_000);
  });
});
