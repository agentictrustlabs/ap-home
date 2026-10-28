import { describe, expect, it, vi } from 'vitest';
import worker, { readHeartbeat, relay, type Env } from '../src/index.js';

const env = { ASSETS: { fetch: async () => new Response('asset') }, ESTATE_ID: 'faithnet', ESTATE_NAME: 'faithnet.estate', HOME_ORIGIN: 'https://www.faithnet.me', A2A_ORIGIN: 'https://a2a.test', PUBLIC_ORIGIN: 'https://faithnet.estate' } as unknown as Env;
const post = (path: string, origin: string | null, body = '{}') => new Request(`https://faithnet.estate${path}`, { method: 'POST', headers: origin ? { origin } : {}, body });

describe('heartbeat', () => {
  it('says so when no token is held, rather than reading zeros', async () => {
    const r = await readHeartbeat(env);
    expect(r).toMatchObject({ ok: false, status: 503 });
  });
  it('refuses an answer that is not a heartbeat', async () => {
    const r = await readHeartbeat({ ...env, ESTATE_HEARTBEAT_TOKEN: 't' }, (async () => new Response(JSON.stringify({ hello: 1 }))) as typeof fetch);
    expect(r).toMatchObject({ ok: false, status: 502 });
  });
});

describe('relay', () => {
  it('mints a CSRF token as this site and sends it as header and cookie', async () => {
    const f = vi.fn(async (u: RequestInfo | URL) => String(u).endsWith('/auth/csrf') ? new Response(JSON.stringify({ ok: true, token: 'tok' })) : new Response('{"ok":true}'));
    const res = await relay(env, 'runs', '{"a":1}', f as unknown as typeof fetch);
    expect(res.status).toBe(200);
    const [, init] = f.mock.calls[1]! as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({ 'x-csrf-token': 'tok', cookie: 'agentic-csrf=tok', origin: 'https://faithnet.estate' });
  });
  it('names the allowlist when the runtime will not issue a token', async () => {
    const res = await relay(env, 'runs', '{}', (async () => new Response('{}', { status: 400 })) as typeof fetch);
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('ALLOWED_ORIGINS');
  });
});

describe('the manage door', () => {
  it('relays only the three harness calls', async () => {
    expect((await worker.fetch(post('/api/manage/grant', 'https://faithnet.estate'), env)).status).toBe(404);
  });
  it('answers its own page only', async () => {
    expect((await worker.fetch(post('/api/manage/runs', 'https://evil.example'), env)).status).toBe(403);
    expect((await worker.fetch(post('/api/manage/runs', null), env)).status).toBe(403);
  });
});
