// Spec 445 §7 — the person's controls over a remembered Allow: forget, ask every time, and revoking one wire.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeTimestampTerms } from '@agenticprimitives/delegation';

const PERSON = '0xeef5ed02e052ee221afcbbd2708919473c4e2b28';
vi.mock('../_lib/server-broker', () => ({ getServer: async () => ({ jwks: {} }), ownIssuer: () => 'https://home.test' }));
vi.mock('@agenticprimitives/connect', () => ({ importJwks: async () => [], verifyAgentSession: async (t: string) => (t === 'good' ? { ok: true, session: { sub: `eip155:1:${PERSON}`, principal: { kind: 'passkey' } } } : t === 'id-token' ? { ok: true, session: { sub: `eip155:1:${PERSON}` } } : { ok: false, reason: 'no' }) }));
const h = vi.hoisted(() => ({ recognition: { value: null as null | { sub: string } } }));
vi.mock('../_lib/recognition', () => ({ readRecognition: async () => h.recognition.value }));
vi.mock('../../src/lib/chain', async (orig) => { const real = await orig<{ CONTRACTS: object }>(); return { ...real, CONTRACTS: { ...real.CONTRACTS, timestampEnforcer: '0x00000000000000000000000000000000000000aa' } }; });

import { onRequestGet, onRequestPost } from './app-grants';
import { wireRef } from '../oidc/app-grant-row';

let store: Map<string, string>;
const env = { AUTH_CODES: { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => { store.set(k, v); }, delete: async (k: string) => { store.delete(k); } } } as never;
const KEY = `app-grants:${PERSON}`;
const wire = (until: number) => ({ delegator: PERSON, delegate: '0x89d13c596c45e4ee80af5ae06c727fe9a820ffd0', authority: `0x${'00'.repeat(32)}`, salt: '1', signature: '0x03', caveats: [{ enforcer: '0x00000000000000000000000000000000000000aa', terms: encodeTimestampTerms(1_000, until) }] });
const row = () => ({ v: 2, clientId: 'reader', template: 'site-login', delegate: '0x89d1', delegation: wire(2_000_000_000), askDelegation: wire(1_900_000_000), issuedAt: 1, terms: { v: 1, clientId: 'reader' }, termsDigest: '0xd', origins: ['https://r.test'], superseded: [{ ref: '0xAA', kind: 'site', validUntil: null, wire: wire(2_000_000_000) }] });
const post = async (body: unknown, token = 'good') => onRequestPost({ request: new Request('https://home.test/connect/app-grants', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), env });
const saved = () => (JSON.parse(store.get(KEY) ?? '[]') as Array<Record<string, unknown>>)[0]!;

beforeEach(() => { store = new Map([[KEY, JSON.stringify([row()])]]); h.recognition.value = { sub: `eip155:1:${PERSON}` }; });

describe('the listing', () => {
  it('reads each wire\'s real end, from the encoder\'s bytes (validAfter was being read as the end)', async () => {
    const b = await (await onRequestGet({ request: new Request('https://home.test/x', { headers: { authorization: 'Bearer good' } }), env })).json() as { grants: Array<{ validUntil: number; ask: { validUntil: number } }> };
    expect(b.grants[0]!.validUntil).toBe(2_000_000_000_000);
    expect(b.grants[0]!.ask.validUntil).toBe(1_900_000_000_000);
  });
});

describe('the controls', () => {
  it('forget drops what was agreed and keeps the wires listed, so they can still be revoked', async () => {
    expect((await post({ clientId: 'reader', forget: true })).status).toBe(200);
    expect(saved().terms).toBeUndefined();
    expect(saved().origins).toBeUndefined();
    expect(saved().delegation).toBeDefined();
    expect(saved().superseded).toHaveLength(1);
  });
  it('ask every time turns on and off', async () => {
    await post({ clientId: 'reader', askEveryTime: true });
    expect(saved().askEveryTime).toBe(true);
    await post({ clientId: 'reader', askEveryTime: false });
    expect(saved().askEveryTime).toBeUndefined();
  });
  it('turning ask every time OFF needs this person\'s recognition cookie; turning it on, and forget, do not', async () => {
    await post({ clientId: 'reader', askEveryTime: true });
    h.recognition.value = null;
    expect((await post({ clientId: 'reader', askEveryTime: false })).status).toBe(403);
    h.recognition.value = { sub: 'eip155:1:0x1111111111111111111111111111111111111111' };
    expect((await post({ clientId: 'reader', askEveryTime: false })).status).toBe(403);
    expect(saved().askEveryTime).toBe(true);
    h.recognition.value = null;
    expect((await post({ clientId: 'reader', askEveryTime: true })).status).toBe(200);
    expect((await post({ clientId: 'reader', forget: true })).status).toBe(200);
  });
  // Spec 445 §16 — as signing out everywhere does: the app's next renewal fails and it has to send the person to the Home.
  const bind = () => { const refs = [wire(2_000_000_000), wire(1_900_000_000)].map((w) => `oidc-deleg:${wireRef(w as never).toLowerCase()}`); for (const k of refs) store.set(k, 'reader'); return refs; };
  it('forget ends the app\'s silent renewal on every wire of the row, and leaves the wires listed', async () => {
    const refs = bind();
    await post({ clientId: 'reader', forget: true });
    for (const k of refs) expect(store.has(k)).toBe(false);
    expect(saved().delegation).toBeDefined();
  });
  it('ask every time, turned on, ends it too; turned off, it touches nothing', async () => {
    let refs = bind();
    await post({ clientId: 'reader', askEveryTime: true });
    for (const k of refs) expect(store.has(k)).toBe(false);
    refs = bind();
    await post({ clientId: 'reader', askEveryTime: false });
    for (const k of refs) expect(store.has(k)).toBe(true);
  });
  it('ends nothing for a caller with no session', async () => {
    const refs = bind();
    await post({ clientId: 'reader', forget: true }, 'bad');
    for (const k of refs) expect(store.has(k)).toBe(true);
  });
  it('an id_token under the Home\'s audience is not a session here', async () => {
    expect((await post({ clientId: 'reader', forget: true }, 'id-token')).status).toBe(401);
    expect(saved().terms).toBeDefined();
  });
  it('a revoked ask wire leaves the row, and the site wire stays', async () => {
    await post({ clientId: 'reader', part: 'ask', revoked: true });
    expect(saved().askDelegation).toBeUndefined();
    expect(saved().delegation).toBeDefined();
  });
  it('a revoked older wire leaves the list, whatever the case of its ref', async () => {
    await post({ clientId: 'reader', supersededRef: '0xaa', revoked: true });
    expect(saved().superseded).toEqual([]);
  });
  it('needs the person\'s own session, and a row to act on', async () => {
    expect((await post({ clientId: 'reader', forget: true }, 'bad')).status).toBe(401);
    expect((await post({ clientId: 'nobody', forget: true })).status).toBe(404);
    expect(saved().terms).toBeDefined();
  });
  it('revoking the whole app still drops the row, as it did', async () => {
    await post({ clientId: 'reader', revoked: true });
    expect(store.get(KEY)).toBe('[]');
  });
});
