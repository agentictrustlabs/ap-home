// Spec 415 A5 — the Run tab's calls: the submission carries the session in the body and the CSRF header, the read puts
// the session in the query, a form row becomes exactly the variant request the runtime accepts, and nothing here
// carries a case's words back.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../csrf', () => ({ ensureCsrfToken: async () => 't', csrfHeaders: () => ({ 'x-csrf-token': 't' }), invalidateCsrfCache: () => undefined }));

import { startExperiment, readExperiment, variantFromForm, readComparisonKnobs, prefillFromQuery, decodeBase64Url } from './experiments';

function stubFetch(answer: (url: string, init?: RequestInit) => unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => { calls.push({ url, init }); const body = answer(url, init); return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }); });
  return calls;
}

describe('variantFromForm', () => {
  it('turns a row into the runtime\'s variant request, leaving blanks out, so an empty row is the live arm', () => {
    expect(variantFromForm({ name: 'live' } as never)).toEqual({});
    expect(variantFromForm({ provider: 'gemini', judgeProvider: 'anthropic', judge: 'outcome', judgeProfile: 'fast' })).toEqual({ provider: 'gemini', judgeProvider: 'anthropic', judgeProfile: 'fast', toggles: { 'quality/judge': 'outcome' } });
    expect(variantFromForm({ judge: 'off', judgeProfile: 'nonsense' })).toEqual({});
  });
  it('carries a row\'s other toggles alongside the judge mode', () => {
    expect(variantFromForm({ provider: 'gemini', judge: 'outcome', toggles: { 'plan/chain-proceed': 'on' } })).toEqual({ provider: 'gemini', toggles: { 'plan/chain-proceed': 'on', 'quality/judge': 'outcome' } });
    expect(variantFromForm({ judge: 'off', toggles: { 'quality/judge': 'pairwise' } })).toEqual({});
  });
});

describe('startExperiment / readExperiment', () => {
  it('posts the session in the body with the CSRF header, and reads with the session in the query', async () => {
    const calls = stubFetch((url) => (url.includes('/experiments/') ? { ok: true, progress: { planId: 'p1', status: 'running', total: 4, done: 1, failed: 0, byOutcome: { tp: 1 }, recent: [] } } : { ok: true, progress: { planId: 'p1', status: 'queued', total: 4, done: 0, failed: 0, byOutcome: {}, recent: [] } }));
    const r = await startExperiment('tok', { addressee: '0xABC', set: { id: 's' }, criterion: { type: 'ap.selection-criterion.v1' }, variants: { a: {}, b: { judgeProvider: 'anthropic' } }, split: 'held-out', repeats: 2, planId: 'p1' });
    expect(r.ok && r.progress.status).toBe('queued');
    const post = calls[0]!;
    expect(post.url).toBe('/a2a/harness/experiments');
    expect((post.init?.headers as Record<string, string>)['x-csrf-token']).toBe('t');
    const body = JSON.parse(String(post.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ session: 'tok', addressee: '0xabc', split: 'held-out', repeats: 2, planId: 'p1', variants: { a: {}, b: { judgeProvider: 'anthropic' } } });
    const p = await readExperiment('tok', '0xABC', 'p1');
    expect(p?.status).toBe('running');
    expect(calls[1]!.url).toBe('/a2a/harness/experiments/p1?session=tok&addressee=0xabc');
    expect(JSON.stringify(p)).not.toContain('message');
    vi.unstubAllGlobals();
  });
  it('reports a refusal by name instead of throwing', async () => {
    stubFetch(() => ({ ok: false, error: 'only the agent itself or its steward may run a comparison on it', refused: 'variant.not-steward' }));
    const r = await startExperiment('tok', { addressee: '0xabc', set: {}, criterion: {}, variants: { a: {} }, split: 'all', repeats: 1 });
    expect(r).toMatchObject({ ok: false, refused: 'variant.not-steward' });
    vi.unstubAllGlobals();
  });
  it('reads the deployment\'s knobs without a session', async () => {
    const calls = stubFetch(() => ({ ok: true, evalCapture: 'on', providers: ['gemini', 'anthropic'], providerRoles: ['provider', 'selectionProvider', 'answerProvider', 'judgeProvider'], selections: ['model'], plannerKinds: ['model'], toggles: { 'quality/judge': ['off', 'on', 'pairwise', 'outcome'] } }));
    const k = await readComparisonKnobs();
    expect(k?.providers).toEqual(['gemini', 'anthropic']);
    expect(calls[0]!.url).toBe('/a2a/harness/comparison');
    vi.unstubAllGlobals();
  });
});

describe('prefillFromQuery', () => {
  const orgs = [{ agent: '0xABC', name: 'cil-commons-1e07.org' }, { agent: '0xdef', name: 'faith.org' }];
  const sets = [{ id: 'cil-commons-fresh-heldout-8' }, { id: 'long-answer-panel-1' }];
  it('selects the agent by address or name and the set by id, case-insensitively for the agent', () => {
    expect(prefillFromQuery('?agent=0xabc&set=long-answer-panel-1', orgs, sets)).toEqual({ addressee: '0xABC', setId: 'long-answer-panel-1' });
    expect(prefillFromQuery('agent=CIL-commons-1e07.org', orgs, sets)).toEqual({ addressee: '0xABC' });
  });
  it('ignores what the lists do not hold, and never types a value into the form', () => {
    expect(prefillFromQuery('?agent=0x999&set=nope', orgs, sets)).toEqual({});
    expect(prefillFromQuery('', orgs, sets)).toEqual({});
  });
});

describe('prefillFromQuery — the whole run (repeats + arms)', () => {
  const orgs = [{ agent: '0xABC', name: 'cil-commons-1e07.org' }];
  const sets = [{ id: 'cil-commons-chain-panel-1' }];
  const knobs = { providers: ['gemini', 'anthropic'], selections: ['model', 'outcome'], toggles: { 'quality/judge': ['off', 'on', 'pairwise', 'outcome'], 'plan/chain-proceed': ['off', 'on'], 'skill-selection/hold': ['ask', 'skeleton'], 'quality/judge-repeats': ['1', '2'] } };
  const b64u = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
  const base = { provider: 'gemini', judgeProvider: 'anthropic', toggles: { 'quality/judge': 'outcome' } };
  const arms = { off: { ...base, toggles: { ...base.toggles, 'plan/chain-proceed': 'off' } }, on: { ...base, toggles: { ...base.toggles, 'plan/chain-proceed': 'on' } } };

  it('turns arms into the form\'s rows and reads repeats 1..5; the rows submit as exactly the arms that came in', () => {
    const p = prefillFromQuery(`?agent=0xabc&set=cil-commons-chain-panel-1&repeats=3&arms=${b64u(arms)}`, orgs, sets, knobs);
    expect(p).toMatchObject({ addressee: '0xABC', setId: 'cil-commons-chain-panel-1', repeats: 3 });
    expect(p.notice).toBeUndefined();
    expect(p.rows?.map((r) => [r.name, r.provider, r.judgeProvider, r.judge, r.toggles])).toEqual([['off', 'gemini', 'anthropic', 'outcome', { 'plan/chain-proceed': 'off' }], ['on', 'gemini', 'anthropic', 'outcome', { 'plan/chain-proceed': 'on' }]]);
    expect(Object.fromEntries(p.rows!.map((r) => [r.name, variantFromForm(r)]))).toEqual(arms);
  });
  it('accepts padded base64url too, and a single arm with no judge as judge off', () => {
    const raw = Buffer.from(JSON.stringify({ base: { provider: 'anthropic' } })).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
    expect(prefillFromQuery(`arms=${raw}`, orgs, sets, knobs).rows).toEqual([{ name: 'base', provider: 'anthropic', selectionProvider: '', answerProvider: '', judgeProvider: '', judgeProfile: '', judge: 'off', selection: '' }]);
    expect(decodeBase64Url('!!')).toBeNull();
  });
  it('ignores repeats out of range or not a whole number', () => {
    for (const r of ['0', '6', '2.5', 'three', '-1']) expect(prefillFromQuery(`?repeats=${r}`, orgs, sets, knobs).repeats).toBeUndefined();
  });
  it('refuses the whole arms parameter, with one line, for anything the form could not hold — never types it in', () => {
    const bad: Array<[string, RegExp]> = [
      ['%%%', /not base64url/],
      [Buffer.from('not json').toString('base64url'), /not JSON/],
      [b64u([1, 2]), /not an object/],
      [b64u({}), /no arms/],
      [b64u({ 'bad name!': {} }), /not a name/],
      [b64u({ a: { provider: 'groq' } }), /provider "groq" is not offered/],
      [b64u({ a: { toggles: { 'plan/chain-proceed': 'maybe' } } }), /plan\/chain-proceed=maybe/],
      [b64u({ a: { toggles: { 'secret/knob': 'on' } } }), /secret\/knob/],
      [b64u({ a: { plannerKind: 'model' } }), /plannerKind/],
      [b64u({ a: { judgeProfile: 'lenient' } }), /judge profile/],
      [b64u(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`a${i}`, {}]))), /9 arms/],
      [b64u({ ok: base, bad: { provider: 'groq' } }), /arm bad/],
    ];
    for (const [arms, why] of bad) { const p = prefillFromQuery(`?arms=${arms}`, orgs, sets, knobs); expect(p.rows).toBeUndefined(); expect(p.notice).toMatch(why); }
  });
  it('leaves arms alone until the deployment\'s knobs are known', () => {
    expect(prefillFromQuery(`?arms=${b64u(arms)}`, orgs, sets, null)).toEqual({});
  });
});
