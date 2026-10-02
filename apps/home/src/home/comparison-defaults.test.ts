// Run a comparison — the defaults a person can run as-is, and the deterministic reading of "tell me what to compare".
import { describe, it, expect } from 'vitest';
import { applyWords, defaultArms, defaultDraft, readyWords, armWords, type EvalSetSummary } from './comparison-defaults';

const knobs = { providers: ['gemini', 'groq'], selections: ['model', 'rule-based'], toggles: { 'quality/judge': ['off', 'on', 'pairwise', 'outcome'] } };
const sets: EvalSetSummary[] = [
  { id: 'cil-commons-chain-panel-1', domain: 'cil-commons', title: 'Chain panel 1', cases: 12, fixtures: true, recommended: false },
  { id: 'cil-commons-fresh-heldout', domain: 'cil-commons', title: 'Fresh held-out', cases: 40, fixtures: false, recommended: true },
];

describe('the defaults', () => {
  it('two arms: the live default and the next provider; one provider ⇒ the rule-based selector', () => {
    expect(defaultArms(knobs).map((r) => [r.name, r.provider, r.selection])).toEqual([['control', '', ''], ['treatment', 'groq', '']]);
    expect(defaultArms({ providers: ['gemini'], selections: ['model', 'rule-based'] })[1]).toMatchObject({ selection: 'rule-based' });
  });
  it('the recommended set, held-out, one repeat; the ready line says it all', () => {
    const d = defaultDraft(knobs, sets);
    expect(d).toMatchObject({ setId: 'cil-commons-fresh-heldout', split: 'held-out', repeats: 1 });
    expect(readyWords(d, 'Missio Nexus', sets)).toBe('Missio Nexus · Fresh held-out (40 cases) · control vs treatment (provider groq) · held-out · 1 repeat');
  });
});

describe('tell me what to compare', () => {
  const base = defaultDraft(knobs, sets);
  it('"compare gemini and groq, judge outcome, 3 repeats, all cases" is read fully and said back', () => {
    const r = applyWords('compare gemini and groq with an outcome judge, 3 repeats, all cases', knobs, sets, base);
    expect(r.draft.rows[0]).toMatchObject({ provider: 'gemini' });
    expect(r.draft.rows[1]).toMatchObject({ provider: 'groq', judge: 'outcome' });
    expect(r.draft).toMatchObject({ repeats: 3, split: 'all' });
    expect(r.understood).toEqual(['control uses gemini, treatment uses groq', 'treatment judge mode outcome', '3 repeats', 'split: all cases']);
    expect(r.ignored).toEqual([]);
  });
  it('a lone provider goes to the treatment; "both" applies to both; rules name the selector; a set by its title', () => {
    const r = applyWords('groq on both arms, rules, chain panel', knobs, sets, base);
    expect(r.draft.rows.map((x) => x.provider)).toEqual(['groq', 'groq']);
    expect(r.draft.rows[1]).toMatchObject({ selection: 'rule-based' });
    expect(r.draft.setId).toBe('cil-commons-chain-panel-1');
  });
  it('a provider this deployment does not offer is named as ignored, and nothing else moves', () => {
    const r = applyWords('use claude', knobs, sets, base);
    expect(r.understood).toEqual([]);
    expect(r.ignored).toEqual(['claude']);
    expect(r.draft).toEqual(base);
  });
  it('armWords names only what differs from the control', () => {
    expect(armWords({ ...base.rows[1]!, judgeProfile: 'fast' }, base.rows[0]!)).toBe('provider groq, judge profile fast');
    expect(armWords(base.rows[0]!, base.rows[0]!)).toBe('');
  });
});

describe('an arm\'s other toggles', () => {
  it('say how a treatment differs when only a toggle does', () => {
    const c = { ...defaultArms(knobs)[0]!, toggles: { 'plan/chain-proceed': 'off' } };
    expect(armWords({ ...c, name: 'on', toggles: { 'plan/chain-proceed': 'on' } }, c)).toBe('plan/chain-proceed on');
    expect(armWords({ ...c, toggles: undefined }, c)).toBe('plan/chain-proceed default');
  });
});
