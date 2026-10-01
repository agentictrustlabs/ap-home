// Spec 415 A5 — the Run tab's calls: the submission carries the session in the body and the CSRF header, the read puts
// the session in the query, a form row becomes exactly the variant request the runtime accepts, and nothing here
// carries a case's words back.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../csrf', () => ({ ensureCsrfToken: async () => 't', csrfHeaders: () => ({ 'x-csrf-token': 't' }), invalidateCsrfCache: () => undefined }));

import { startExperiment, readExperiment, variantFromForm, readComparisonKnobs } from './experiments';

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
