// Spec 415 A5 — the Lab's submission is checked the way the CLI checks a comparison before it registers a plan: a valid
// replay set, a criterion that is gold for THAT set, named variants the runtime knows, a split, bounded repeats; and
// the plan it builds carries the set's and the criterion's digests. Progress counts runs by their verdict and never
// carries words.
import { describe, expect, it } from 'vitest';
import { replaySetDigest, criterionDigest, type ReplaySetV1, type SelectionCriterionV1, type ExperimentRunV1 } from '@agenticprimitives/evaluation';
import { parseExperimentRequest, progressOf } from '../../src/experiment-job.js';

const set: ReplaySetV1 = { type: 'ap.replay-set.v1', id: 'lab-set', version: '1', intents: [
  { id: 'i1', message: 'score our AI governance maturity across the org', split: 'held-out', bucket: 'explicit', provenance: 'authored', seedId: 'i1' },
  { id: 'i2', message: 'write up the minutes from last night', split: 'held-out', bucket: 'negative-near', provenance: 'authored', seedId: 'i2' },
] };

async function criterionFor(s: ReplaySetV1): Promise<SelectionCriterionV1> {
  return { type: 'ap.selection-criterion.v1', replaySetDigest: await replaySetDigest(s), collisionPairs: [], cases: { i1: { expected: 'skill:cil-commons/ai-governance-assessor', adjudication: 'author' }, i2: { expected: null, adjudication: 'author' } } } as unknown as SelectionCriterionV1;
}
const now = new Date('2026-10-01T12:00:00Z');

describe('parseExperimentRequest', () => {
  it('builds the plan from the set, the gold and the variants, with the digests the runner will check', async () => {
    const criterion = await criterionFor(set);
    const r = await parseExperimentRequest({ set, criterion, variants: { control: {}, judged: { judgeProvider: 'anthropic', toggles: { 'quality/judge': 'outcome' } } }, split: 'held-out', repeats: 2, planId: 'lab-1' }, now);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.id).toBe('lab-1');
    expect(r.plan.replaySetDigest).toBe(await replaySetDigest(set));
    expect(r.plan.criterionDigest).toBe(await criterionDigest(criterion));
    expect(r.plan.repeats).toBe(2);
    expect(Object.keys(r.plan.variants)).toEqual(['control', 'judged']);
    expect(r.plan.registeredAt).toBe(now.toISOString());
  });
  it('refuses gold for another set, an unnamed variant, a bad split and too many repeats — each by name', async () => {
    const criterion = await criterionFor(set);
    const other = { ...criterion, replaySetDigest: `sha256:${'0'.repeat(64)}` };
    expect(await parseExperimentRequest({ set, criterion: other, variants: { a: {} } }, now)).toMatchObject({ ok: false, error: expect.stringContaining('criterion: gold for') });
    expect(await parseExperimentRequest({ set, criterion, variants: {} }, now)).toMatchObject({ ok: false, error: expect.stringContaining('variants') });
    expect(await parseExperimentRequest({ set, criterion, variants: { a: {} }, split: 'everything' }, now)).toMatchObject({ ok: false, error: expect.stringContaining('split') });
    expect(await parseExperimentRequest({ set, criterion, variants: { a: {} }, repeats: 50 }, now)).toMatchObject({ ok: false, error: expect.stringContaining('repeats') });
    expect(await parseExperimentRequest({ set, criterion, variants: { a: { notAKnob: 1 } } }, now)).toMatchObject({ ok: false, error: expect.stringContaining('not a variant component') });
  });
  it('names the plan after the set, the variants, the split and the repeats when none is given', async () => {
    const criterion = await criterionFor(set);
    const r = await parseExperimentRequest({ set, criterion, variants: { model: {} } }, now);
    expect(r.ok && r.plan.id).toBe('lab-set@1-model-held-out-r1');
  });
});

describe('progressOf', () => {
  it('counts runs by verdict, keeps the newest few, and carries no words', () => {
    const runs = [
      { intentId: 'i1', variant: 'control', repeat: 0, runRef: 'r1', status: 'ok', selected: ['skill:cil-commons/ai-governance-assessor'], evidence: 'stamped', captureLevel: null, ms: 1200, verdict: { outcome: 'tp', earl: 'passed' } },
      { intentId: 'i2', variant: 'control', repeat: 0, runRef: null, status: 'failed', selected: [], evidence: 'none', captureLevel: null, ms: 0, error: 'the ask threw' },
    ] as unknown as ExperimentRunV1[];
    const p = progressOf({ planId: 'lab-1' }, 'running', runs, 4, { startedAt: now.toISOString() });
    expect(p).toMatchObject({ planId: 'lab-1', status: 'running', total: 4, done: 2, failed: 1, byOutcome: { tp: 1, failed: 1 } });
    expect(p.recent[0]).toMatchObject({ intentId: 'i2', status: 'failed' });
    expect(JSON.stringify(p)).not.toContain('score our AI governance');
  });
});
