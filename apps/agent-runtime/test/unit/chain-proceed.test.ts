// `plan/chain-proceed` — a chain's terminal step takes its skill's proceed-anyway path (the grant chain paused at the
// drafter's Stage 1 soft gate, 2026-10-01/02, 0.35–0.46 in every arm). The decision and the rewrite are pure, so they are
// pinned here without a model: what a chain is, which step the instruction lands on, and that the skeleton wins.
import { describe, expect, it } from 'vitest';
import { outcomeSteps, type OutcomePlanV1 } from '@agenticprimitives/orchestration';
import { CHAIN_PROCEED_INSTRUCTION, CHAIN_PROCEED_MODES, chainProceedDecision, chainProceedModeOf, isChain, stepsUnderChainProceed } from '../../src/chain-proceed.js';
import { SKELETON_INSTRUCTION, stepsUnderHold } from '../../src/skeleton-hold.js';

const DEADLINE = 'https://x/#FunderDeadline';
const INTAKE = 'https://x/#PipelineIntake';
const labelOf = (iri: string) => ({ [DEADLINE]: 'funder deadline', [INTAKE]: 'pipeline intake' })[iri] ?? iri.split('#').pop()!;
const ASK = 'Figure out which of our funder deadlines is next and get a first draft of that application going.';
const single: OutcomePlanV1 = { kind: 'plan', steps: [{ tool: 'cic.grants.draft' }], satisfied: {}, missing: [], ambiguous: [] };
const chain: OutcomePlanV1 = { kind: 'plan', steps: [{ tool: 'cic.grants.pipeline', for: INTAKE }, { tool: 'cic.grants.draft', from: [{ tool: 'cic.grants.pipeline', class: INTAKE }] }], satisfied: { [INTAKE]: { step: 'cic.grants.pipeline' } }, missing: [], ambiguous: [] };
const heldChain: OutcomePlanV1 = { ...chain, missing: [DEADLINE] };
const sideBySide: OutcomePlanV1 = { kind: 'plan', steps: [{ tool: 'cic.grants.pipeline' }, { tool: 'cic.grants.draft' }], satisfied: {}, missing: [], ambiguous: [] };
const build = (p: OutcomePlanV1) => outcomeSteps(p, ASK, labelOf);

describe('the mode', () => {
  it('a comparison\'s toggle first, then the deployment knob, then off — and anything unknown is off', () => {
    expect(chainProceedModeOf('on', undefined)).toBe('on');
    expect(chainProceedModeOf(undefined, 'on')).toBe('on');
    expect(chainProceedModeOf('off', 'on')).toBe('off');
    expect(chainProceedModeOf(undefined, undefined)).toBe('off');
    expect(chainProceedModeOf(undefined, 'yes')).toBe('off');
    expect(CHAIN_PROCEED_MODES).toEqual(['off', 'on']);
  });
  it('the instruction is the measured text: proceed-anyway, named placeholders, never invent, the facts last', () => {
    expect(CHAIN_PROCEED_INSTRUCTION.startsWith('The person asked for this output in the same request as the step before it')).toBe(true);
    expect(CHAIN_PROCEED_INSTRUCTION).toContain('[VERIFY: the funder\'s eligibility]');
    expect(CHAIN_PROCEED_INSTRUCTION).toContain('[MISSING: the deadline and its source]');
    expect(CHAIN_PROCEED_INSTRUCTION).toContain('Never invent a figure, a funder name, a deadline or a quote.');
    expect(CHAIN_PROCEED_INSTRUCTION.endsWith('End with the three to five facts that would complete it.')).toBe(true);
  });
});

describe('what a chain is', () => {
  it('a producer whose output the terminal step consumes; one step or two side by side are not', () => {
    expect(isChain(build(chain))).toBe(true);
    expect(isChain(build(single))).toBe(false);
    expect(isChain(build(sideBySide))).toBe(false);
    expect(isChain([])).toBe(false);
  });
});

describe('the steps under the mode', () => {
  it('a single-step plan is untouched', () => {
    const steps = build(single);
    expect(stepsUnderChainProceed(steps, 'on', false)).toEqual({ steps: build(single), chainProceed: false });
  });
  it('off leaves a chain unchanged', () => {
    expect(stepsUnderChainProceed(build(chain), 'off', false)).toEqual({ steps: build(chain), chainProceed: false });
  });
  it('a two-step chain: the instruction on the terminal step only, marked; the producer never rewritten', () => {
    const r = stepsUnderChainProceed(build(chain), 'on', false);
    expect(r.chainProceed).toBe(true);
    expect(r.steps[0]).toEqual(build(chain)[0]);
    const q = String(r.steps[1]!.args.question);
    expect(q.startsWith(CHAIN_PROCEED_INSTRUCTION)).toBe(true);
    expect(q).toContain(ASK);
    expect(r.steps[1]!.args.chainProceed).toBe(true);
    expect(r.steps[1]!.args.material).toEqual({ $ref: 'o0.answer' });
    expect(String(r.steps[0]!.args.question)).not.toContain(CHAIN_PROCEED_INSTRUCTION);
  });
  it('with the skeleton: one instruction, the skeleton\'s — it wins when a required input is missing', () => {
    const held = stepsUnderHold(heldChain, 'skeleton', labelOf, build);
    expect(held.skeleton).toBe(true);
    expect(chainProceedDecision(held.steps, 'on', heldChain.missing.length > 0)).toBe(false);
    const r = stepsUnderChainProceed(held.steps, 'on', heldChain.missing.length > 0);
    expect(r.chainProceed).toBe(false);
    const q = String(r.steps[1]!.args.question);
    expect(q.startsWith(SKELETON_INSTRUCTION)).toBe(true);
    expect(q).not.toContain(CHAIN_PROCEED_INSTRUCTION);
    expect(r.steps[0]).toEqual(build(heldChain)[0]);
  });
  it('a held chain under ask: the ask note stands alone — "proceed" is never put in front of "ask for it"', () => {
    const held = stepsUnderHold(heldChain, 'ask', labelOf, build);
    const r = stepsUnderChainProceed(held.steps, 'on', heldChain.missing.length > 0);
    expect(r).toEqual({ steps: held.steps, chainProceed: false });
    expect(String(r.steps[1]!.args.question)).toContain('ask for it rather than invent it');
  });
});
