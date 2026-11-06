// Spec 445 §16 — a sign-out ends every app's silent renewal, and only a real session can ask for it.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const PERSON = '0xeef5ed02e052ee221afcbbd2708919473c4e2b28';
const ISS = 'https://home.test';
const h = vi.hoisted(() => ({ rec: { value: null as null | { sub: string } } }));
vi.mock('../_lib/server-broker', () => ({ getServer: async () => ({ jwks: {} }), ownIssuer: () => 'https://home.test', resolveOrigin: () => 'https://home.test', json: (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s }) }));
vi.mock('../_lib/recognition', () => ({ readRecognition: async () => h.rec.value, clearRecognition: async (r: Response) => r }));
vi.mock('@agenticprimitives/connect', () => ({ importJwks: async () => [], verifyAgentSession: async (t: string) => (t === 'session' ? { ok: true, session: { sub: `eip155:1:${PERSON}`, principal: { kind: 'passkey' } } } : t === 'id-token' ? { ok: true, session: { sub: `eip155:1:${PERSON}` } } : { ok: false }) }));
vi.mock('../oidc/app-grant-row', () => ({
  readRows: async (kv: { get(k: string): Promise<string | null> }, p: string) => JSON.parse((await kv.get(`app-grants:${p}`)) ?? '[]'),
  wireRef: (w: { id: string }) => { if (!w.id) throw new Error('unhashable'); return w.id; },
}));
import { onRequestPost } from './logout';

let store: Map<string, string>;
const env = { AUTH_CODES: { get: async (k: string) => store.get(k) ?? null, delete: async (k: string) => { store.delete(k); } } } as never;
const post = (body: object, headers: Record<string, string> = { origin: ISS }) => onRequestPost({ request: new Request(`${ISS}/connect/logout`, { method: 'POST', headers, body: JSON.stringify(body) }), env });
const bindings = () => [...store.keys()].filter((k) => k.startsWith('oidc-deleg:')).sort();

beforeEach(() => {
  h.rec.value = null;
  store = new Map([
    [`app-grants:${PERSON}`, JSON.stringify([
      { clientId: 'a', delegation: { id: '0xA1' }, askDelegation: { id: '0xA2' }, superseded: [{ wire: { id: '0xA0' } }] },
      { clientId: 'b', delegation: { id: '0xB1' } },
      { clientId: 'old', delegation: {} },
    ])],
    ['oidc-deleg:0xa1', '1'], ['oidc-deleg:0xa2', '1'], ['oidc-deleg:0xa0', '1'], ['oidc-deleg:0xb1', '1'], ['oidc-deleg:0xother', '1'],
  ]);
});

describe('/connect/logout', () => {
  it('ends the renewal of every wire of every app, from the cookie, and leaves anyone else\'s alone', async () => {
    h.rec.value = { sub: `eip155:1:${PERSON}` };
    expect(await (await post({ everywhere: true })).json()).toEqual({ ok: true, renewalsEnded: 4 });
    expect(bindings()).toEqual(['oidc-deleg:0xother']);
  });
  it('does the same from a real session, when there is no cookie', async () => {
    await post({ everywhere: true }, { origin: ISS, authorization: 'Bearer session' });
    expect(bindings()).toEqual(['oidc-deleg:0xother']);
  });
  it('refuses an id_token: an app cannot sign a person out of the others', async () => {
    await post({ everywhere: true }, { origin: ISS, authorization: 'Bearer id-token' });
    expect(bindings()).toHaveLength(5);
  });
  it('"Not you?" ends the cookie and leaves the apps alone', async () => {
    h.rec.value = { sub: `eip155:1:${PERSON}` };
    await post({});
    expect(bindings()).toHaveLength(5);
  });
  it('refuses another origin', async () => {
    h.rec.value = { sub: `eip155:1:${PERSON}` };
    expect((await post({ everywhere: true }, { origin: 'https://evil.test' })).status).toBe(403);
    expect(bindings()).toHaveLength(5);
  });
  it('a store that cannot answer does not stop the sign-out', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broken = { AUTH_CODES: { get: async () => { throw new Error('down'); } } } as never;
    h.rec.value = { sub: `eip155:1:${PERSON}` };
    const r = await onRequestPost({ request: new Request(`${ISS}/connect/logout`, { method: 'POST', headers: { origin: ISS }, body: '{"everywhere":true}' }), env: broken });
    expect(r.status).toBe(200);
    warn.mockRestore();
  });
});
