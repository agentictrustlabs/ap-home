/**
 * THE PER-CASE RUBRIC JUDGE (2026-10-15): the author's instructions and scored criteria, applied to one answer.
 * The arithmetic is held here — awarded minus deducted over awardable, "cannot tell" out of the denominator, a required
 * criterion failing the case alone — and the words the judge sees, and the Lab's check of a submitted rubrics file.
 */
import { describe, it, expect } from 'vitest';
import { scoreRubric, rubricJudgeInput, judgeRubric, validateRubricV1, type RubricV1 } from '../src/rubric-judge.js';
import { validateRubrics } from '../src/experiment-job.js';

const rubric: RubricV1 = {
  instructions: 'Judge the playbook, not the tone.',
  criteria: [
    { id: 'lead', text: 'Names an incident lead and a backup by role', points: 3, required: true },
    { id: 'tiers', text: 'Gives a severity scale anchored on harm to people', points: 2 },
    { id: 'drill', text: 'Names what to test in a tabletop drill', points: 1 },
    { id: 'invents', text: 'Invents a dollar figure the request did not give', points: 2, kind: 'deduct' },
  ],
  passAt: 0.7,
};

describe('scoreRubric', () => {
  it('awards met criteria, deducts a present fault, and passes at the fraction', () => {
    const r = scoreRubric(rubric, { lead: { verdict: 'met' }, tiers: { verdict: 'met' }, drill: { verdict: 'not-met' }, invents: { verdict: 'not-met' } });
    expect(r).toMatchObject({ awardable: 6, awarded: 5, deducted: 0, cannotTell: 0, requiredFailed: [], pass: true });
    expect(r.score).toBeCloseTo(5 / 6, 5);
  });
  it('a present fault costs its points; a required criterion not met fails the case whatever the score', () => {
    const faulted = scoreRubric(rubric, { lead: { verdict: 'met' }, tiers: { verdict: 'met' }, drill: { verdict: 'met' }, invents: { verdict: 'met' } });
    expect(faulted.score).toBeCloseTo(4 / 6, 5); expect(faulted.pass).toBe(false);
    const noLead = scoreRubric(rubric, { lead: { verdict: 'not-met' }, tiers: { verdict: 'met' }, drill: { verdict: 'met' }, invents: { verdict: 'not-met' } });
    expect(noLead.score).toBeCloseTo(3 / 6, 5); expect(noLead.requiredFailed).toEqual(['lead']); expect(noLead.pass).toBe(false);
  });
  it('"cannot tell" leaves the denominator; a verdict the judge did not give is cannot-tell; all cannot-tell is no score', () => {
    const r = scoreRubric(rubric, { lead: { verdict: 'met' }, tiers: { verdict: 'cannot-tell' } });
    expect(r).toMatchObject({ awardable: 3, awarded: 3, cannotTell: 3, pass: true }); expect(r.score).toBe(1);
    const none = scoreRubric(rubric, {});
    expect(none.score).toBeNull(); expect(none.pass).toBeNull();
  });
  it('clamps to 0 when deductions exceed awards', () => {
    expect(scoreRubric(rubric, { lead: { verdict: 'met' }, tiers: { verdict: 'not-met' }, drill: { verdict: 'not-met' }, invents: { verdict: 'met' } }).score).toBeCloseTo(1 / 6, 5);
    expect(scoreRubric({ criteria: [{ id: 'a', text: 'a', points: 1 }, { id: 'f', text: 'f', points: 5, kind: 'deduct' }] }, { a: { verdict: 'met' }, f: { verdict: 'met' } }).score).toBe(0);
  });
});

describe('rubricJudgeInput', () => {
  it('shows the judge the instructions, every criterion by id with faults marked, and the three-way answer', () => {
    const q = rubricJudgeInput({ request: 'build the playbook', answer: 'the playbook', rubric });
    expect(q.system).toContain("THE AUTHOR'S INSTRUCTIONS:\nJudge the playbook, not the tone.");
    expect(q.system).toContain('[lead] Names an incident lead and a backup by role (required)');
    expect(q.system).toContain('[invents] FAULT (deduct if present): Invents a dollar figure');
    expect(q.system).toContain('cannot-tell');
    expect(q.messages[0]!.content).toBe('THE REQUEST:\nbuild the playbook\n\nTHE ANSWER:\nthe playbook');
    expect(q.tool.name).toBe('rubric_verdicts');
  });
  it('judgeRubric scores the call\'s verdicts, ignores an id the rubric lacks, and names the judge', async () => {
    const call = async () => ({ criteria: [{ id: 'lead', verdict: 'met', because: 'Jo leads, Sam backs up' }, { id: 'tiers', verdict: 'met' }, { id: 'drill', verdict: 'not-met' }, { id: 'invents', verdict: 'not-met' }, { id: 'ghost', verdict: 'met' }] });
    const r = await judgeRubric({ request: 'q', answer: 'a', rubric }, call as never, () => 'anthropic/claude-sonnet-5-5');
    expect(r.score).toBeCloseTo(5 / 6, 5); expect(r.pass).toBe(true); expect(r.judge).toBe('ap.rubric-judge.v1'); expect(r.judgeModel).toBe('anthropic/claude-sonnet-5-5');
    expect(r.criteria['lead']).toMatchObject({ verdict: 'met', because: 'Jo leads, Sam backs up', points: 3, required: true });
    expect(r.criteria['ghost']).toBeUndefined();
  });
});

describe('validateRubricV1 / validateRubrics', () => {
  it('refuses an empty rubric, a duplicate id, bad points, a deduct-only rubric and a pass-at out of range; fills the defaults', () => {
    expect(validateRubricV1({ criteria: [] }).ok).toBe(false);
    expect(validateRubricV1({ criteria: [{ id: 'a', text: 'x', points: 1 }, { id: 'a', text: 'y', points: 1 }] }).ok).toBe(false);
    expect(validateRubricV1({ criteria: [{ id: 'a', text: 'x', points: 0 }] }).ok).toBe(false);
    expect(validateRubricV1({ criteria: [{ id: 'f', text: 'x', points: 1, kind: 'deduct' }] }).ok).toBe(false);
    expect(validateRubricV1({ criteria: [{ id: 'a', text: 'x', points: 1 }], passAt: 1.5 }).ok).toBe(false);
    const ok = validateRubricV1({ instructions: ' be fair ', criteria: [{ id: 'a', text: ' x ', points: 2 }] });
    expect(ok.ok && ok.rubric).toEqual({ instructions: 'be fair', criteria: [{ id: 'a', text: 'x', points: 2, kind: 'award' }], passAt: 0.7 });
  });
  it('a rubrics file must be for THIS set and name only its cases', () => {
    const ids = new Set(['c1']);
    expect(validateRubrics({ type: 'ap.rubrics.v1', replaySetDigest: 'sha256:x', cases: { c1: rubric } }, 'sha256:x', ids).ok).toBe(true);
    expect(validateRubrics({ type: 'ap.rubrics.v1', replaySetDigest: 'sha256:y', cases: { c1: rubric } }, 'sha256:x', ids).ok).toBe(false);
    expect(validateRubrics({ type: 'ap.rubrics.v1', replaySetDigest: 'sha256:x', cases: { c9: rubric } }, 'sha256:x', ids).ok).toBe(false);
  });
});
