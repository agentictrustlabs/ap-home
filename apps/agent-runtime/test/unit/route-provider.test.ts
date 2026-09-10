// Spec 388 — budget-routed model selection: a ROUTE decided before the call from measured facts, never a fallback.
import { describe, it, expect, beforeEach } from 'vitest';
import { routeProvider, routePolicy, resetSpend, spentThisMinute, selectComposerRouted, GROQ_FREE_PLAN_PROMPT_BUDGET, GROQ_FREE_PLAN_TPM } from '../../src/orchestration.js';

const both = { ORCHESTRATION_LLM: 'groq,anthropic', GROQ_API_KEY: 'g', ANTHROPIC_API_KEY: 'a', ORCHESTRATION_ROUTE: 'budget' } as never;

describe('spec 388 — routeProvider', () => {
  beforeEach(() => resetSpend());
  it('the policy is a deployment setting; a typo is refused, never read as "first"', async () => {
    expect(routePolicy({} as never)).toBe('first');
    expect(routePolicy({ ORCHESTRATION_ROUTE: 'budget' } as never)).toBe('budget');
    expect(() => routePolicy({ ORCHESTRATION_ROUTE: 'cheapest' } as never)).toThrow(/first.*budget/);
  });
  it('"first" keeps spec 377: the first offered provider, whatever the call needs', async () => {
    const r = await routeProvider({ ...(both as object), ORCHESTRATION_ROUTE: 'first' } as never, undefined, { call: 'planner', estimatedTokens: 50_000 });
    expect(r).toMatchObject({ provider: 'groq', because: expect.stringContaining('first offered') });
  });
  it('a provider the turn NAMED is the turn\'s choice — no routing over a person\'s pick', async () => {
    expect(await routeProvider(both, 'anthropic', { call: 'planner', estimatedTokens: 10 })).toMatchObject({ provider: 'anthropic', because: 'anthropic: named by the turn' });
  });
  it('under "budget" the first offered provider whose budget carries the estimate wins, and the reason carries the numbers', async () => {
    const small = await routeProvider(both, undefined, { call: 'planner', estimatedTokens: 5_700 });
    expect(small.provider).toBe('groq');
    expect(small.because).toContain(`5700 ≤ budget ${GROQ_FREE_PLAN_PROMPT_BUDGET}`);
    expect(small.considered).toEqual([{ provider: 'groq', budget: GROQ_FREE_PLAN_PROMPT_BUDGET, spentThisMinute: 0, fits: true }]);
    resetSpend();
    const big = await routeProvider(both, undefined, { call: 'planner', estimatedTokens: 9_900 });
    expect(big.provider).toBe('anthropic');
    expect(big.because).toContain('groq would not: estimate 9900 > 6500');
    expect(big.considered.map((c) => [c.provider, c.fits])).toEqual([['groq', false], ['anthropic', true]]);
  });
  it('the minute\'s spend on the metered provider counts: planner + composer in one turn route apart, not into a 429', async () => {
    const planner = await routeProvider(both, undefined, { call: 'planner', estimatedTokens: 5_500 });
    expect(planner.provider).toBe('groq');
    expect(spentThisMinute('groq')).toBe(5_500);
    const composer = await routeProvider(both, undefined, { call: 'composer', estimatedTokens: 4_000 });
    expect(composer.provider).toBe('anthropic');
    expect(composer.because).toContain(`4000+5500 > ${GROQ_FREE_PLAN_TPM}/min`);
    // a minute later the window has cleared
    const later = await routeProvider(both, undefined, { call: 'composer', estimatedTokens: 4_000 }, { now: Date.now() + 61_000 });
    expect(later.provider).toBe('groq');
  });
  it('a paid tier raises the meter and the budget by configuration, not by guessing', async () => {
    const paid = { ...(both as object), ORCHESTRATION_GROQ_TPM: '300000', ORCHESTRATION_GROQ_PROMPT_BUDGET: '120000' } as never;
    expect((await routeProvider(paid, undefined, { call: 'planner', estimatedTokens: 50_000 })).provider).toBe('groq');
  });
  it('when no offered provider carries the call, the first takes it FITTED — said so, never silently', async () => {
    const groqOnly = { ORCHESTRATION_LLM: 'groq', GROQ_API_KEY: 'g', ORCHESTRATION_ROUTE: 'budget' } as never;
    const r = await routeProvider(groqOnly, undefined, { call: 'planner', estimatedTokens: 9_000 });
    expect(r).toMatchObject({ provider: 'groq', because: expect.stringContaining('no offered provider carries 9000 tokens') });
    expect(r.because).toContain('prompt fitted');
  });
  it('a listed-but-keyless provider THROWS on the route too — a route may not quietly skip a misconfiguration', async () => {
    await expect(routeProvider({ ORCHESTRATION_LLM: 'groq,anthropic', GROQ_API_KEY: 'g', ORCHESTRATION_ROUTE: 'budget' } as never, undefined, { call: 'planner', estimatedTokens: 9_000 })).rejects.toThrow(/ANTHROPIC_API_KEY is not set/);
  });
  it('the routed composer names its provider and returns the route beside it', async () => {
    const r = await selectComposerRouted(both, { need: { call: 'composer', estimatedTokens: 3_000 } });
    expect(r.route.provider).toBe('groq');
    expect(r.composer).not.toBeNull();
    expect(await selectComposerRouted({} as never, { need: { call: 'composer', estimatedTokens: 3_000 } })).toMatchObject({ composer: null, route: { provider: null, because: 'no model offered' } });
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

describe('spec 388 W3 — where the minute is counted', () => {
  beforeEach(() => resetSpend());

  it('the window admits and charges IN ONE STEP, so two callers cannot both read an empty minute', async () => {
    const { SpendWindow } = await import('../../src/spend-window.js');
    const w = new SpendWindow();
    const now = Date.now();
    const cand = [{ provider: 'groq', tpm: 8_000, tokens: 5_000, eligible: true }];
    expect(w.admit(cand, now)).toEqual({ picked: 'groq', spent: { groq: 0 } });
    // the second caller sees the first one's charge and is turned away — this is the whole point of W3
    expect(w.admit(cand, now)).toEqual({ picked: null, spent: { groq: 5_000 } });
    expect(w.admit(cand, now + 61_000)).toEqual({ picked: 'groq', spent: { groq: 0 } });
  });

  it('a candidate the per-request budget already rules out is REPORTED but cannot win', async () => {
    const { SpendWindow } = await import('../../src/spend-window.js');
    const w = new SpendWindow();
    const now = Date.now();
    expect(w.admit([{ provider: 'groq', tpm: 8_000, tokens: 9_900, eligible: false }], now)).toEqual({ picked: null, spent: { groq: 0 } });
    expect(w.spent('groq', now)).toBe(0);
  });

  it('two isolates sharing one meter route apart; two isolates with their own windows both see zero', async () => {
    const { SpendWindow } = await import('../../src/spend-window.js');
    const shared = new SpendWindow();
    const meter = { kind: 'shared' as const, async admit(c: never[], n: number) { return shared.admit(c, n); }, async charge(p: string, t: number, n: number) { shared.charge(p, t, n); } };
    const need = { call: 'planner' as const, estimatedTokens: 5_500 };
    const a = await routeProvider(both, undefined, need, { meter: meter as never });
    const b = await routeProvider(both, undefined, need, { meter: meter as never });
    expect([a.provider, b.provider]).toEqual(['groq', 'anthropic']);
    expect(b.because).toContain('5500+5500 > 8000/min');
    // the same two asks against per-isolate windows: both read an empty minute and both send to groq
    const one = new SpendWindow(), two = new SpendWindow();
    const iso = (w: InstanceType<typeof SpendWindow>) => ({ kind: 'isolate' as const, async admit(c: never[], n: number) { return w.admit(c, n); }, async charge(p: string, t: number, n: number) { w.charge(p, t, n); } });
    expect((await routeProvider(both, undefined, need, { meter: iso(one) as never })).provider).toBe('groq');
    expect((await routeProvider(both, undefined, need, { meter: iso(two) as never })).provider).toBe('groq');
  });

  it('which meter serves is chosen from the bindings, once — never reached by a failure', async () => {
    const { meterFor } = await import('../../src/orchestration.js');
    expect(meterFor(both).kind).toBe('isolate');
    const ns = { idFromName: () => 'id', get: () => ({ fetch: async () => new Response('{}') }) };
    expect(meterFor({ ...(both as object), PROVIDER_METER: ns, A2A_INTERNAL_MARKER: 'm' } as never).kind).toBe('shared');
    // bound but unprovisioned: the isolate's window, said so on the trace — not a silent shared meter that throws
    expect(meterFor({ ...(both as object), PROVIDER_METER: ns } as never).kind).toBe('isolate');
  });

  it('the shared meter retries the SAME call once and then surfaces the refusal (ADR-0013)', async () => {
    const { sharedMeter } = await import('../../src/orchestration.js');
    let calls = 0;
    const ns = (bodies: Array<() => Response>) => ({ idFromName: () => 'id', get: () => ({ fetch: async () => bodies[calls++]!() }) });
    const flaky = sharedMeter(ns([() => new Response('nope', { status: 500 }), () => Response.json({ ok: true, picked: 'groq', spent: { groq: 10 } })]) as never, { A2A_INTERNAL_MARKER: 'm' });
    expect(await flaky.admit([{ provider: 'groq', tpm: 8_000, tokens: 10, eligible: true }], Date.now())).toEqual({ picked: 'groq', spent: { groq: 10 } });
    expect(calls).toBe(2);
    calls = 0;
    const dead = sharedMeter(ns([() => new Response('nope', { status: 500 }), () => new Response('nope', { status: 500 })]) as never, { A2A_INTERNAL_MARKER: 'm' });
    await expect(dead.admit([{ provider: 'groq', tpm: 8_000, tokens: 10, eligible: true }], Date.now())).rejects.toThrow(/provider meter refused/);
  });
});

describe('spec 388 — the third provider: OpenAI between the free tier and Haiku', () => {
  beforeEach(() => resetSpend());
  const three = { ORCHESTRATION_LLM: 'groq,openai,anthropic', GROQ_API_KEY: 'g', OPENAI_API_KEY: 'o', ANTHROPIC_API_KEY: 'a', ORCHESTRATION_ROUTE: 'budget' } as never;

  it('the offer is walked cheapest-first: groq while it fits, then openai, and anthropic only when named', async () => {
    expect((await routeProvider(three, undefined, { call: 'planner', estimatedTokens: 5_000 })).provider).toBe('groq');
    // groq is now spent for the minute, so the NEXT offered provider takes it — openai, not the dearest one
    const next = await routeProvider(three, undefined, { call: 'composer', estimatedTokens: 5_000 });
    expect(next.provider).toBe('openai');
    expect(next.because).toContain('groq would not');
    // anthropic is never reached by the walk while openai carries the call: it is offered, not cheaper
    expect(next.considered.map((c) => c.provider)).toEqual(['groq', 'openai']);
  });

  it('a prompt past groq\'s per-request budget goes to openai untrimmed — the fitter is the last resort, not the second', async () => {
    const r = await routeProvider(three, undefined, { call: 'planner', estimatedTokens: 30_000 });
    expect(r.provider).toBe('openai');
    expect(r.because).toContain('no budget');
    expect(r.because).toContain('groq would not: estimate 30000 > 6500');
  });

  it('openai\'s model, label and budget are configuration; the default is the cheap tool-calling one', async () => {
    const { modelFor, availableModels, plannerPromptBudget, providerTpm, OPENAI_DEFAULTS } = await import('../../src/orchestration.js');
    expect(modelFor(three, 'openai')).toBe(OPENAI_DEFAULTS.model);
    expect(modelFor({ ...(three as object), ORCHESTRATION_OPENAI_MODEL: 'gpt-5-nano' } as never, 'openai')).toBe('gpt-5-nano');
    expect(plannerPromptBudget(three, 'openai')).toBeNull();
    expect(providerTpm(three, 'openai')).toBeNull();
    expect(plannerPromptBudget({ ...(three as object), ORCHESTRATION_OPENAI_PROMPT_BUDGET: '90000' } as never, 'openai')).toBe(90_000);
    expect(providerTpm({ ...(three as object), ORCHESTRATION_OPENAI_TPM: '200000' } as never, 'openai')).toBe(200_000);
    expect(availableModels(three).map((m) => m.id)).toEqual(['groq', 'openai', 'anthropic']);
  });

  it('a listed-but-keyless openai THROWS like any other — a third provider is not a softer promise', async () => {
    await expect(routeProvider({ ORCHESTRATION_LLM: 'groq,openai', GROQ_API_KEY: 'g', ORCHESTRATION_ROUTE: 'budget' } as never, undefined, { call: 'planner', estimatedTokens: 9_000 })).rejects.toThrow(/OPENAI_API_KEY is not set/);
  });
});
