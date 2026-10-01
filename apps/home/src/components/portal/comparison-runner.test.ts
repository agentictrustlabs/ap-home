// Spec 415 A5 — the Run tab's progress renders the experiment's state in the ONE state vocabulary (never the object's
// `running` as a state word), its counts by verdict, the newest runs by id, and — when done — each arm's numbers and
// the pairwise comparisons with their confounds; nothing in it is a case's words.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExperimentProgress } from './ComparisonRunner';
import type { ExperimentProgressV1 } from '../../home/experiments';

const running: ExperimentProgressV1 = { planId: 'ol-fh8-r1', status: 'running', total: 154, done: 40, failed: 1, byOutcome: { tp: 30, tn: 8, miss: 1, failed: 1 }, startedAt: '2026-10-01T13:00:00Z', recent: [{ intentId: 'f8-assess-maturity', variant: 'control', repeat: 0, status: 'ok', outcome: 'tp', selected: ['skill:cil-commons/ai-governance-assessor'], ms: 14000 }] };

describe('ExperimentProgress', () => {
  it('renders a running experiment with its counts and newest runs, in the projected state vocabulary', () => {
    const html = renderToStaticMarkup(createElement(ExperimentProgress, { progress: running }));
    expect(html).toContain('data-testid="comparison-runner-progress"');
    expect(html).toContain('40 of 154');
    expect(html).toContain('f8-assess-maturity');
    expect(html).toContain('ai-governance-assessor');
    expect(html).toContain('data-state="running"');
    expect(html).not.toContain('data-state="working"');
  });
  it('renders the scores and the comparisons when done, naming a confound', () => {
    const done: ExperimentProgressV1 = { ...running, status: 'done', done: 154, finishedAt: '2026-10-01T13:40:00Z',
      scores: { control: { micro_ta: { value: 0.857, num: 66, den: 77 }, macro_ta: { value: 0.84 }, hold_rate: { value: 0.923, num: 24, den: 26 }, routing_purity: { value: 0.9 } }, treatment: { micro_ta: { value: 0.922, num: 71, den: 77 }, macro_ta: { value: 0.91 }, hold_rate: { value: 0.96, num: 25, den: 26 }, routing_purity: { value: 0.94 } } },
      verdicts: { control: { status: 'FAIL', reason: 'per-skill floor' }, treatment: { status: 'FAIL', reason: 'per-skill floor' } },
      comparisons: [{ a: 'control', b: 'treatment', confounds: ['judgeProvider', 'answerProvider'], confounded: true, delta_macro: 0.07, fixed: 7, broken: 1, p_value: 0.07 }], refused: ['capture.refused.roster.asker=154'] };
    const html = renderToStaticMarkup(createElement(ExperimentProgress, { progress: done }));
    expect(html).toContain('data-testid="comparison-runner-scores"');
    expect(html).toContain('0.922 (71/77)');
    expect(html).toContain('confounded: judgeProvider, answerProvider');
    expect(html).toContain('7 / 1');
    expect(html).toContain('capture.refused.roster.asker=154');
    expect(html).toMatch(/data-state="completed"/);
  });
});
