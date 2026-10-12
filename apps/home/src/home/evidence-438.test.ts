// Spec 438 W5 — the acceptance twins, run against the REAL Ring 0 projections the Home renders.
//
// A twin is a pair: the honest behaviour, and the plausible wrong one it must not collapse into. These are
// here rather than in Ring 0 because W5 is the wave where a person can see any of it, and the thing being
// accepted is what the surface SHOWS — the packages are already tested on their own.
import { describe, expect, it } from 'vitest';
import { evidenceStatusOf, type RunRecordV1 } from '@agenticprimitives/orchestration';
import { findingsOf } from '@agenticprimitives/harness';
import { validateAssessment, verifyAssessment, signAssessment, type AssessmentV1 } from '@agenticprimitives/evaluation';

const step = (stepRef: string, over: Record<string, unknown> = {}) => ({ stepRef, toolId: 't.a', args: {}, ok: true, ...over });
const record = (over: Partial<RunRecordV1> = {}): RunRecordV1 =>
  ({
    type: 'ap.run-record.v1', runRef: 'run_1', at: 1,
    intent: { goal: 'do it' },
    plan: { steps: [{ toolId: 't.a', id: 's0' }] },
    steps: [step('s0')], receipts: [], events: [], outcome: 'completed',
    export: { at: 1, provenance: { written: true, recordType: 'x' }, spans: { count: 0, sent: true } },
    ...over,
  }) as RunRecordV1;

describe('TWIN 1 — a retry does not join its predecessor\u2019s work until somebody attaches it', () => {
  // The surface half of the twin: the Home shows `work` from the record and NOTHING ELSE. Everything a
  // heuristic would use to guess is right here — same agent, same goal, the next run along — and the second
  // run still carries no work, because attaching is an act with an author (coordination.run.attach).
  const attached = record({ runRef: 'run_a', work: { endeavorId: 'end_1' } } as Partial<RunRecordV1>);
  const retry = record({ runRef: 'run_a_retry' });

  it('the attached run names its work; the retry names none', () => {
    expect((attached as { work?: { endeavorId: string } }).work?.endeavorId).toBe('end_1');
    expect((retry as { work?: unknown }).work).toBeUndefined();
  });

  it('the label renders the work only when the record says so \u2014 absence is not "none"', () => {
    const label = (r: RunRecordV1): string => {
      const w = (r as { work?: { endeavorId?: string } }).work;
      return w?.endeavorId ? ` \u00b7 work ${w.endeavorId}` : '';
    };
    expect(label(attached)).toBe(' \u00b7 work end_1');
    expect(label(retry)).toBe('');
  });

  it('evidence status is read the same for both \u2014 work is a reference, never an input to a reading', () => {
    const a = evidenceStatusOf(attached);
    const b = evidenceStatusOf(retry);
    expect(a.coverage).toEqual(b.coverage);
    expect(a.consistency).toEqual(b.consistency);
  });
});

describe('TWIN 2 — a run with unreported usage shows unavailable, not 0', () => {
  it('reports unavailable and invents no token totals', () => {
    const ev = evidenceStatusOf(record({ modelCalls: [{ role: 'plan' }, { role: 'compose' }] }));
    expect(ev.cost.state).toBe('unavailable');
    expect(ev.cost.tokensIn).toBeUndefined();
    expect(ev.cost.tokensOut).toBeUndefined();
  });

  it('says `partial` rather than a total when only some calls reported', () => {
    const ev = evidenceStatusOf(record({ modelCalls: [{ role: 'plan', tokensIn: 7, tokensOut: 3 }, { role: 'compose' }] }));
    expect(ev.cost.state).toBe('partial');
    expect(ev.cost.callsMissingUsage).toBe(1);
  });
});

describe('TWIN 3 — a failed-looking timed-out step reads unknown — reconciling', () => {
  it('is effect-uncertain, and is NOT also reported as a tool failure', () => {
    const r = record({ steps: [step('s0', { ok: false, error: 'timeout' })] });
    const ev = evidenceStatusOf(r, { effectUncertainSteps: ['s0'] });
    expect(ev.effectUncertain).toBe(true);

    const kinds = findingsOf([r], { evidenceOpts: { run_1: { effectUncertainSteps: ['s0'] } } }).map((f) => f.kind);
    expect(kinds).toContain('effect-uncertain');
    expect(kinds).not.toContain('tool-failure');
  });

  it('the same step WITHOUT the uncertainty is an ordinary failure', () => {
    const r = record({ outcome: 'failed', steps: [step('s0', { ok: false, error: 'refused' })] });
    const kinds = findingsOf([r]).map((f) => f.kind);
    expect(kinds).toContain('tool-failure');
    expect(kinds).not.toContain('effect-uncertain');
  });
});

describe('TWIN 4 — an assessment from a non-delegate is refused, and the record is untouched', () => {
  const EVALUATOR = '0xeva1uator000000000000000000000000000000a';
  const assessment: AssessmentV1 = {
    schema: 'apeval/AssessmentV1',
    subject: { runRef: 'run_1', recordDigest: 'sha256:aaa', at: '2026-02-01T00:00:00Z' },
    criteria: { outcomeId: 'out_1', revision: 1, digest: 'sha256:ccc', statedAt: '2026-01-01T00:00:00Z' },
    evaluator: { sa: EVALUATOR, kind: 'mechanical' },
    results: [{ criterionId: 'c1', outcome: 'passed', evidenceRefs: ['urn:ap:receipt:1'] }],
    at: '2026-02-02T00:00:00Z',
  };

  it('refuses a signer whose wire delegator is somebody else', async () => {
    const signed = await signAssessment(assessment, async () => '0x51sig');
    const v = await verifyAssessment(signed, async () => ({ ok: true, signer: '0xkey', delegator: '0xnotthem000000000000000000000000000000000', selector: 'assessment.issue' }));
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toMatch(/not the evaluator's delegate/);
  });

  it('accepts the evaluator’s own delegate', async () => {
    const signed = await signAssessment(assessment, async () => '0x51sig');
    const v = await verifyAssessment(signed, async () => ({ ok: true, signer: '0xkey', delegator: EVALUATOR, selector: 'assessment.issue' }));
    expect(v.ok).toBe(true);
  });

  it('THE RECORD IS BYTE-IDENTICAL before and after an assessment lands', () => {
    // The structural guarantee behind the twin: an assessment is a SEPARATE record. Nothing in validating or
    // signing one can reach the run, and this is the test that would fail if that ever changed.
    const r = record();
    const before = JSON.stringify(r);
    expect(validateAssessment(assessment).ok).toBe(true);
    const ev = evidenceStatusOf(r, { assessmentCount: 1 });
    expect(ev.assessment).toEqual({ state: 'assessed', count: 1 });
    expect(JSON.stringify(r)).toBe(before);
  });

  it('an unassessed run is not a failing one', () => {
    expect(evidenceStatusOf(record()).assessment).toEqual({ state: 'unassessed', count: 0 });
  });
});

describe('the feed states observations, never advice', () => {
  it('no finding reads as an instruction', () => {
    const fs = findingsOf([
      record({ outcome: 'failed', steps: [step('s0', { ok: false })] }),
      record({ runRef: 'run_2', outcome: 'authority-required', presented: [] }),
    ]);
    expect(fs.length).toBeGreaterThan(0);
    for (const f of fs) expect(f.detail, `"${f.detail}" reads as advice`).not.toMatch(/\b(retry|re-run|you should|please|click|fix it)\b/i);
  });
});
