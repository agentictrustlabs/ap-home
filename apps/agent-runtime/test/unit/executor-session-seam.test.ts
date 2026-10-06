import { describe, it, expect } from 'vitest';
import { homeSessionSeam } from '../../src/executor-invoke.js';

// Spec 426 §5 — the Home-backed session seam: the run's own session first (production), demo-signin second.
const PRINCIPAL = '0x8482b1963f8435c111ffc57aa3b4754addb1a2a5' as const;
const HOME = 'https://www.home.test';

type Call = { url: string; auth?: string; body: Record<string, unknown> };
const fetchAnswering = (calls: Call[], answers: Record<string, { status: number; body: unknown }>) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, auth: (init?.headers as Record<string, string>)?.authorization, body: JSON.parse(String(init?.body)) });
    const a = answers[new URL(u).pathname] ?? { status: 404, body: { error: 'nope' } };
    return { ok: a.status < 400, status: a.status, json: async () => a.body } as unknown as Response;
  }) as typeof fetch;

describe('spec 426 §5 — homeSessionSeam', () => {
  it('mints from the run’s own session at /connect/session-token, as the principal, for the client', async () => {
    const calls: Call[] = [];
    const seam = homeSessionSeam({ homeOrigin: HOME, fetch: fetchAnswering(calls, { '/connect/session-token': { status: 200, body: { id_token: 'idtok' } } }) });
    expect(await seam(PRINCIPAL, 'gc-engage', 'home-session-jwt')).toBe('idtok');
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(`${HOME}/connect/session-token`);
    expect(calls[0].auth).toBe('Bearer home-session-jwt');
    expect(calls[0].body).toEqual({ client_id: 'gc-engage', as: PRINCIPAL });
  });

  it('falls back to demo-signin when the session route refuses (a persona in an unattended run)', async () => {
    const calls: Call[] = [];
    const seam = homeSessionSeam({ homeOrigin: HOME, fetch: fetchAnswering(calls, { '/connect/session-token': { status: 403, body: { error: 'not yours' } }, '/connect/demo-signin': { status: 200, body: { homeSession: 'demo-tok' } } }) });
    expect(await seam(PRINCIPAL, 'gc-engage', 'home-session-jwt')).toBe('demo-tok');
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/connect/session-token', '/connect/demo-signin']);
    expect(calls[1].body).toEqual({ as: PRINCIPAL, client_id: 'gc-engage' });
  });

  it('skips the session route when the run has no session, and refuses (null) when neither binds', async () => {
    const calls: Call[] = [];
    const seam = homeSessionSeam({ homeOrigin: HOME, fetch: fetchAnswering(calls, {}) });
    expect(await seam(PRINCIPAL, 'gc-engage')).toBeNull();
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/connect/demo-signin']);
  });

  it('refuses outright with no Home origin and survives a network failure', async () => {
    expect(await homeSessionSeam({ homeOrigin: null })(PRINCIPAL, 'gc-engage', 's')).toBeNull();
    const failing = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
    expect(await homeSessionSeam({ homeOrigin: HOME, fetch: failing })(PRINCIPAL, 'gc-engage', 's')).toBeNull();
  });
});
