// Spec 388 — budget-routed model selection: a ROUTE decided before the call from measured facts, never a fallback.
import { describe, it, expect, beforeEach } from 'vitest';
import { routeProvider, routePolicy, resetSpend, spentThisMinute, selectComposerRouted, GROQ_FREE_PLAN_PROMPT_BUDGET, GROQ_FREE_PLAN_TPM } from '../../src/orchestration.js';

const both = { ORCHESTRATION_LLM: 'groq,anthropic', GROQ_API_KEY: 'g', ANTHROPIC_API_KEY: 'a', ORCHESTRATION_ROUTE: 'budget' } as never;

describe('spec 388 — routeProvider', () => {
  beforeEach(() => resetSpend());
  it('the policy is a deployment setting; a typo is refused, never read as "first"', () => {
    expect(routePolicy({} as never)).toBe('first');
    expect(routePolicy({ ORCHESTRATION_ROUTE: 'budget' } as never)).toBe('budget');
    expect(() => routePolicy({ ORCHESTRATION_ROUTE: 'cheapest' } as never)).toThrow(/first.*budget/);
  });
  it('"first" keeps spec 377: the first offered provider, whatever the call needs', () => {
    const r = routeProvider({ ...(both as object), ORCHESTRATION_ROUTE: 'first' } as never, undefined, { call: 'planner', estimatedTokens: 50_000 });
    expect(r).toMatchObject({ provider: 'groq', because: expect.stringContaining('first offered') });
  });
  it('a provider the turn NAMED is the turn\'s choice — no routing over a person\'s pick', () => {
    expect(routeProvider(both, 'anthropic', { call: 'planner', estimatedTokens: 10 })).toMatchObject({ provider: 'anthropic', because: 'anthropic: named by the turn' });
  });
  it('under "budget" the first offered provider whose budget carries the estimate wins, and the reason carries the numbers', () => {
    const small = routeProvider(both, undefined, { call: 'planner', estimatedTokens: 5_700 });
    expect(small.provider).toBe('groq');
    expect(small.because).toContain(`5700 ≤ budget ${GROQ_FREE_PLAN_PROMPT_BUDGET}`);
    expect(small.considered).toEqual([{ provider: 'groq', budget: GROQ_FREE_PLAN_PROMPT_BUDGET, spentThisMinute: 0, fits: true }]);
    resetSpend();
    const big = routeProvider(both, undefined, { call: 'planner', estimatedTokens: 9_900 });
    expect(big.provider).toBe('anthropic');
    expect(big.because).toContain('groq would not: estimate 9900 > 6500');
    expect(big.considered.map((c) => [c.provider, c.fits])).toEqual([['groq', false], ['anthropic', true]]);
  });
  it('the minute\'s spend on the metered provider counts: planner + composer in one turn route apart, not into a 429', () => {
    const planner = routeProvider(both, undefined, { call: 'planner', estimatedTokens: 5_500 });
    expect(planner.provider).toBe('groq');
    expect(spentThisMinute('groq')).toBe(5_500);
    const composer = routeProvider(both, undefined, { call: 'composer', estimatedTokens: 4_000 });
    expect(composer.provider).toBe('anthropic');
    expect(composer.because).toContain(`4000+5500 > ${GROQ_FREE_PLAN_TPM}/min`);
    // a minute later the window has cleared
    const later = routeProvider(both, undefined, { call: 'composer', estimatedTokens: 4_000 }, Date.now() + 61_000);
    expect(later.provider).toBe('groq');
  });
  it('a paid tier raises the meter and the budget by configuration, not by guessing', () => {
    const paid = { ...(both as object), ORCHESTRATION_GROQ_TPM: '300000', ORCHESTRATION_GROQ_PROMPT_BUDGET: '120000' } as never;
    expect(routeProvider(paid, undefined, { call: 'planner', estimatedTokens: 50_000 }).provider).toBe('groq');
  });
  it('when no offered provider carries the call, the first takes it FITTED — said so, never silently', () => {
    const groqOnly = { ORCHESTRATION_LLM: 'groq', GROQ_API_KEY: 'g', ORCHESTRATION_ROUTE: 'budget' } as never;
    const r = routeProvider(groqOnly, undefined, { call: 'planner', estimatedTokens: 9_000 });
    expect(r).toMatchObject({ provider: 'groq', because: expect.stringContaining('no offered provider carries 9000 tokens') });
    expect(r.because).toContain('prompt fitted');
  });
  it('a listed-but-keyless provider THROWS on the route too — a route may not quietly skip a misconfiguration', () => {
    expect(() => routeProvider({ ORCHESTRATION_LLM: 'groq,anthropic', GROQ_API_KEY: 'g', ORCHESTRATION_ROUTE: 'budget' } as never, undefined, { call: 'planner', estimatedTokens: 9_000 })).toThrow(/ANTHROPIC_API_KEY is not set/);
  });
  it('the routed composer names its provider and returns the route beside it', () => {
    const r = selectComposerRouted(both, { need: { call: 'composer', estimatedTokens: 3_000 } });
    expect(r.route.provider).toBe('groq');
    expect(r.composer).not.toBeNull();
    expect(selectComposerRouted({} as never, { need: { call: 'composer', estimatedTokens: 3_000 } })).toMatchObject({ composer: null, route: { provider: null, because: 'no model offered' } });
  });
});

describe('spec 388 W2 — the structured calls and the widest budget', () => {
  beforeEach(() => resetSpend());
  it('widestPromptBudget: the named provider\'s; the default\'s under first; unbounded under budget when any offered provider is', async () => {
    const { widestPromptBudget } = await import('../../src/orchestration.js');
    expect(widestPromptBudget(both, 'groq')).toBe(GROQ_FREE_PLAN_PROMPT_BUDGET);
    expect(widestPromptBudget({ ...(both as object), ORCHESTRATION_ROUTE: 'first' } as never)).toBe(GROQ_FREE_PLAN_PROMPT_BUDGET);
    expect(widestPromptBudget(both)).toBeNull();
    expect(widestPromptBudget({ ORCHESTRATION_LLM: 'groq', GROQ_API_KEY: 'g', ORCHESTRATION_ROUTE: 'budget', ORCHESTRATION_GROQ_PROMPT_BUDGET: '9000' } as never)).toBe(9000);
  });
  it('a structured call is routed per request by what it carries, and each decision is reported', async () => {
    const { structuredCallFor } = await import('../../src/context-wiring.js');
    const routes: Array<{ provider: string | null; because: string }> = [];
    const made: string[] = [];
    const call = structuredCallFor(both, undefined, { onRoute: (d) => routes.push(d), make: (p) => { made.push(p); return async () => ({ on: p }); } })!;
    const tool = { name: 't', description: 'd', input_schema: { type: 'object' } };
    expect(await call({ system: 'x'.repeat(4_000), messages: [{ role: 'user', content: 'q' }], tool })).toEqual({ on: 'groq' });
    expect(await call({ system: 'x'.repeat(40_000), messages: [{ role: 'user', content: 'q' }], tool })).toEqual({ on: 'anthropic' });
    expect(routes.map((r) => r.provider)).toEqual(['groq', 'anthropic']);
    expect(routes[1]!.because).toContain('groq would not');
    expect(made).toEqual(['groq', 'anthropic']);
    // a named provider is not routed; `first` is not routed
    const named = structuredCallFor(both, 'anthropic', { make: (p) => async () => ({ on: p }) })!;
    expect(await named({ system: 's', messages: [], tool })).toEqual({ on: 'anthropic' });
    const first = structuredCallFor({ ...(both as object), ORCHESTRATION_ROUTE: 'first' } as never, undefined, { make: (p) => async () => ({ on: p }) })!;
    expect(await first({ system: 'x'.repeat(40_000), messages: [], tool })).toEqual({ on: 'groq' });
  });
});
