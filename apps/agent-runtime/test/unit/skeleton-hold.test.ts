// `skill-selection/hold` — a plan with a required input missing answers with a question (`ask`, today) or with the
// skill's full structure, placeholders and the questions first (`skeleton`). The decision and the prompt are pure, so
// they are pinned here without a model: what "would hold" means, which step the instruction lands on, and that the
// `ask` note is gone when the skeleton instruction is in.
import { describe, expect, it } from 'vitest';
import { outcomeSteps, type OutcomePlanV1 } from '@agenticprimitives/orchestration';
import { HOLD_MODES, SKELETON_INSTRUCTION, holdDecision, holdModeOf, skeletonInstruction, stepsUnderHold } from '../../src/skeleton-hold.js';

const DEADLINE = 'https://x/#FunderDeadline';
const BRIEF = 'https://x/#DecisionBrief';
const labelOf = (iri: string) => ({ [DEADLINE]: 'funder deadline', [BRIEF]: 'decision brief' })[iri] ?? iri.split('#').pop()!;
const held: OutcomePlanV1 = { kind: 'plan', steps: [{ tool: 'cic.grants.draft' }], satisfied: {}, missing: [DEADLINE], ambiguous: [] };
const whole: OutcomePlanV1 = { kind: 'plan', steps: [{ tool: 'cic.grants.draft' }], satisfied: { [DEADLINE]: 'request' }, missing: [], ambiguous: [] };
const chain: OutcomePlanV1 = { kind: 'plan', steps: [{ tool: 'cic.decide', for: BRIEF }, { tool: 'cic.grants.draft', from: [{ tool: 'cic.decide', class: BRIEF }] }], satisfied: { [BRIEF]: { step: 'cic.decide' } }, missing: [DEADLINE], ambiguous: [] };
const build = (p: OutcomePlanV1) => outcomeSteps(p, 'draft the LOI', labelOf);

describe('the hold mode', () => {
  it('a comparison\'s toggle first, then the deployment knob, then ask — and anything unknown is ask', () => {
    expect(holdModeOf('skeleton', undefined)).toBe('skeleton');
    expect(holdModeOf(undefined, 'skeleton')).toBe('skeleton');
    expect(holdModeOf('ask', 'skeleton')).toBe('ask');
    expect(holdModeOf(undefined, undefined)).toBe('ask');
    expect(holdModeOf(undefined, 'skelton')).toBe('ask');
    expect(HOLD_MODES).toEqual(['ask', 'skeleton']);
  });
  it('"would hold" is a required input the plan found missing; the skeleton only under that mode', () => {
    expect(holdDecision(held, 'ask')).toEqual({ wouldHold: true, skeleton: false });
    expect(holdDecision(held, 'skeleton')).toEqual({ wouldHold: true, skeleton: true });
    expect(holdDecision(whole, 'skeleton')).toEqual({ wouldHold: false, skeleton: false });
  });
});

describe('the skeleton instruction', () => {
  it('is the measured text, verbatim, with the missing facts named by label', () => {
    expect(SKELETON_INSTRUCTION).toContain('[MISSING: the funder\'s deadline]');
    expect(SKELETON_INSTRUCTION).toContain('open with three to five one-line questions');
    expect(SKELETON_INSTRUCTION.endsWith('Never invent a figure.')).toBe(true);
    expect(skeletonInstruction(['funder deadline', 'budget total'])).toBe(`${SKELETON_INSTRUCTION}\n\n(Not given and not produced here: funder deadline, budget total.)`);
    expect(skeletonInstruction([])).toBe(SKELETON_INSTRUCTION);
  });
});

describe('the steps under the hold', () => {
  it('ask: the steps as built — the ask note on the terminal question, nothing added', () => {
    const r = stepsUnderHold(held, 'ask', labelOf, build);
    expect(r.skeleton).toBe(false);
    expect(r.steps).toEqual(build(held));
    expect(String(r.steps[0]!.args.question)).toContain('ask for it rather than invent it');
    expect(r.steps[0]!.args.skeleton).toBeUndefined();
  });
  it('skeleton: the instruction in front of the terminal question, the ask note gone, the step marked', () => {
    const r = stepsUnderHold(held, 'skeleton', labelOf, build);
    expect(r.skeleton).toBe(true);
    const q = String(r.steps[0]!.args.question);
    expect(q.startsWith(SKELETON_INSTRUCTION)).toBe(true);
    expect(q).toContain('(Not given and not produced here: funder deadline.)');
    expect(q.endsWith('draft the LOI')).toBe(true);
    expect(q).not.toContain('ask for it rather than invent it');
    expect(r.steps[0]!.args.skeleton).toBe(true);
  });
  it('a chain: the producer\'s step is untouched; only the terminal step is instructed', () => {
    const r = stepsUnderHold(chain, 'skeleton', labelOf, build);
    expect(r.skeleton).toBe(true);
    expect(r.steps[0]).toEqual(build(chain)[0]);
    expect(String(r.steps[1]!.args.question).startsWith(SKELETON_INSTRUCTION)).toBe(true);
    expect(r.steps[1]!.args.material).toEqual({ $ref: 'o0.answer' });
  });
  it('nothing missing: skeleton mode changes nothing', () => {
    const r = stepsUnderHold(whole, 'skeleton', labelOf, build);
    expect(r).toEqual({ steps: build(whole), skeleton: false });
  });
});
