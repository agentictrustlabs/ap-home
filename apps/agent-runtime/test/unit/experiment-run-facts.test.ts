// 2026-10-14 (W1/W2/W3/W4) — what the runtime adds to a run record beside the pinned runner: the cause of a missing
// verdict, the isolation refusal, the gold-plan outcome with its per-class verdicts, the agent-plan number, the state check.
import { describe, expect, it } from 'vitest';
import type { ExperimentRunV1 } from '@agenticprimitives/evaluation';
import { enrichRun, failureCauseOf, isolationOf, traceFactsOf } from '../../src/experiment-run-facts.js';

const ok = (over: Partial<ExperimentRunV1> = {}): ExperimentRunV1 => ({ intentId: 'i1', variant: 'v', repeat: 0, runRef: 'r', status: 'ok', selected: ['skill:x/a'], evidence: 'stamped', captureLevel: null, ms: 5, verdict: { outcome: 'tp', earl: 'passed', overSelected: false, evidence: 'stamped', primary: 'skill:x/a' } as never, ...over });

describe('failureCauseOf', () => {
  it.each([
    ['the ask threw: fetch failed', 'environment'], ['provider: planner_failed: HTTP 529', 'environment'], ['/harness/ask answered 503', 'environment'],
    ['outcome judge: the model did not call the tool', 'grader'], ['the plan was refused', 'agent'], [undefined, 'agent'],
  ])('%s → %s', (e, c) => { expect(failureCauseOf(e as string | undefined)).toBe(c); });
});

describe('enrichRun', () => {
  it('a failed run gets its cause from its words; an unreadable one is the environment\'s', () => {
    expect(enrichRun(ok({ status: 'failed', error: 'the ask threw: fetch failed', verdict: undefined }), {}, []).failureCause).toBe('environment');
    expect(enrichRun(ok({ status: 'failed', error: 'refused', verdict: undefined }), {}, []).failureCause).toBe('agent');
    expect(enrichRun(ok({ status: 'unreadable', verdict: undefined }), {}, []).failureCause).toBe('environment');
  });
  it('W4 — refuses a repeat that recalled turns or reuses a context id: unreadable, environment, the verdict dropped, the reason kept', () => {
    const seen: string[] = [];
    const first = enrichRun(ok(), { recalledTurns: 0, contextId: 'ctx-1' }, seen);
    expect(first.status).toBe('ok'); expect(seen).toEqual(['ctx-1']);
    const second = enrichRun(ok({ repeat: 1 }), { recalledTurns: 0, contextId: 'ctx-1' }, seen);
    expect(second).toMatchObject({ status: 'unreadable', failureCause: 'environment', isolation: { refused: true, contextId: 'ctx-1' }, selected: [] });
    expect(second.verdict).toBeUndefined();
    const recalled = enrichRun(ok({ repeat: 2 }), { recalledTurns: 3 }, seen);
    expect(recalled.isolation?.because).toContain('3 earlier turns');
    expect(isolationOf({}, [])).toBeNull();
  });
  it('W2/W4 — the gold-plan outcome with verdicts and cantTell, the agent-plan number, the state check; a grader error is the grader\'s', () => {
    const facts = traceFactsOf({ outcomeCheck: { score: 0.8, classes: { 'https://x#A': 0.8 }, basis: 'gold-plan', judge: 'ap.outcome-per-class-judge.v4', verdicts: { 'https://x#A': 'delivered', 'https://x#B': 'unknown', 'https://x#C': 'nope' }, cantTell: 1, counted: 1 }, outcomeCheckAgentPlan: { score: 0.3, classes: { 'https://x#C': 0.3 } }, stateCheck: { pass: false, classes: { 'https://x#A': { exists: true, valid: false, errors: ['missing "supportedBy"'] } } } });
    const r = enrichRun(ok({ outcome: { score: 0.8, classes: { 'https://x#A': 0.8 } } }), facts, []);
    expect(r.outcome).toEqual({ score: 0.8, classes: { 'https://x#A': 0.8 }, basis: 'gold-plan', judge: 'ap.outcome-per-class-judge.v4', verdicts: { 'https://x#A': 'delivered', 'https://x#B': 'unknown' }, cantTell: 1, counted: 1 });
    expect(r.outcomeAgentPlan).toEqual({ score: 0.3, classes: { 'https://x#C': 0.3 } });
    expect(r.stateCheck).toEqual({ pass: false, classes: { 'https://x#A': { exists: true, valid: false, errors: ['missing "supportedBy"'] } } });
    const g = enrichRun(ok(), traceFactsOf({ outcomeCheck: { score: 0, classes: {}, error: 'timeout' } }), []);
    expect(g).toMatchObject({ status: 'ok', failureCause: 'grader', graderError: 'outcome judge: timeout' });
    expect(g.outcome).toBeUndefined();
  });
});
