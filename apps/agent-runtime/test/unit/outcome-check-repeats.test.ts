// `quality/judge-repeats` — the outcome check judged N times on one answer: score and classes averaged, the spread kept.
// Pure over the judge's results, so the arithmetic is pinned without a model: one result is itself (spread 0), two that
// disagree average and show the gap, a class one repeat did not score counts 0 for it, errors are all kept.
import { describe, expect, it } from 'vitest';
import { OUTCOME_CHECK_JUDGE } from '@agenticprimitives/orchestration';
import { averageOutcomeChecks, judgeRepeatsOf } from '../../src/outcome-check-repeats.js';

const A = 'https://x/#LetterOfInquiry';
const B = 'https://x/#Proposal';
const one = { judge: OUTCOME_CHECK_JUDGE, classes: { [A]: 0.9, [B]: 0.1 }, requested: { [A]: 0.95, [B]: 0.2 }, score: 0.9, ms: 1200 };
const two = { judge: OUTCOME_CHECK_JUDGE, classes: { [A]: 0.7, [B]: 0.3 }, requested: { [A]: 0.85, [B]: 0.4 }, score: 0.7, ms: 800 };

describe('how many repeats', () => {
  it('the toggle first, then the deployment knob, then 1; bounded; anything unreadable is 1', () => {
    expect(judgeRepeatsOf('2', undefined)).toBe(2);
    expect(judgeRepeatsOf(undefined, '2')).toBe(2);
    expect(judgeRepeatsOf('1', '2')).toBe(1);
    expect(judgeRepeatsOf(undefined, undefined)).toBe(1);
    expect(judgeRepeatsOf(undefined, 'two')).toBe(1);
    expect(judgeRepeatsOf(undefined, '0')).toBe(1);
    expect(judgeRepeatsOf(undefined, '20')).toBe(4);
  });
});

describe('the average with its spread', () => {
  it('one result is itself: repeats 1, spread 0', () => {
    expect(averageOutcomeChecks([one])).toEqual({ judge: OUTCOME_CHECK_JUDGE, classes: one.classes, requested: one.requested, score: 0.9, ms: 1200, repeats: 1, spread: 0, scores: [0.9] });
  });
  it('two results: score and every class averaged, the spread is max − min, the ms summed, each score kept', () => {
    const r = averageOutcomeChecks([one, two]);
    expect(r.repeats).toBe(2);
    expect(r.score).toBe(0.8);
    expect(r.spread).toBe(0.2);
    expect(r.scores).toEqual([0.9, 0.7]);
    expect(r.classes).toEqual({ [A]: 0.8, [B]: 0.2 });
    expect(r.requested).toEqual({ [A]: 0.9, [B]: 0.3 });
    expect(r.ms).toBe(2000);
    expect(r.error).toBeUndefined();
  });
  it('a class one repeat did not score counts 0 for that repeat; an error on any repeat is on the average', () => {
    const r = averageOutcomeChecks([one, { judge: OUTCOME_CHECK_JUDGE, classes: { [A]: 0.5 }, score: 0.5, ms: 10, error: 'timeout' }]);
    expect(r.classes).toEqual({ [A]: 0.7, [B]: 0.05 });
    expect(r.requested).toEqual(one.requested);
    expect(r.score).toBe(0.7);
    expect(r.spread).toBe(0.4);
    expect(r.error).toBe('timeout');
  });
  it('agreeing repeats show a spread of 0 — the number that says the judge held still', () => {
    expect(averageOutcomeChecks([one, one]).spread).toBe(0);
  });
  it('no results is a programming error, not a score', () => {
    expect(() => averageOutcomeChecks([])).toThrow();
  });
});
