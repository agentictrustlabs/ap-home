// Spec 445 §4 — /oidc/grant checks `Origin`, which only a browser cannot fake, and a wire, which an app already holds. So
// replaying a held wire must not be able to write "they allowed this": terms are stored only beside the recognition
// cookie of the person whose wire it is.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const PERSON = '0xeef5ed02e052ee221afcbbd2708919473c4e2b28';
const DELEGATE = '0x89d1000000000000000000000000000000000000';
const ISS = 'https://home.test';
const h = vi.hoisted(() => ({ recognition: { value: null as null | { sub: string } } }));

vi.mock('../_lib/server-broker', () => ({
  getServer: async () => ({ signer: {} }),
  resolveOrigin: () => 'https://home.test',
  json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
}));
vi.mock('../_lib/verify-delegation', () => ({ verifyDelegation: async () => ({ ok: true, digest: '0xdigest' }) }));
vi.mock('../_lib/session-ttl', () => ({ idTokenTtl: () => 300 }));
vi.mock('../_lib/recognition', () => ({ readRecognition: async () => h.recognition.value }));
vi.mock('../_lib/oidc-registry', () => ({ resolveClient: async () => ({ client_id: 'reader', redirect_uris: [], allowed_scopes: ['profile'], allowed_delegation_templates: ['site-login'], delegate: '0x89d1000000000000000000000000000000000000' }) }));
vi.mock('@agenticprimitives/connect', () => ({ mintIdToken: async () => 'id-token', newAuthCode: () => 'code-1' }));

import { onRequestPost } from './grant';

let store: Map<string, string>;
const env = { AUTH_CODES: { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => { store.set(k, v); }, delete: async (k: string) => { store.delete(k); } } } as never;
const redeem = async (grantExtra: Record<string, unknown> = {}, bodyExtra: Record<string, unknown> = {}) => {
  store.set('oidc-grant:g1', JSON.stringify({ ...grantExtra, client_id: 'reader', delegate: DELEGATE, nonce: '', agent_name: '', code_challenge: 'c', redirect_uri: 'https://reader.test/', delegation_template: 'site-login' }));
  const r = await onRequestPost({ request: new Request(`${ISS}/oidc/grant`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ISS }, body: JSON.stringify({ grant_id: 'g1', delegation: { delegator: PERSON, delegate: DELEGATE }, ...bodyExtra }) }), env });
  expect(r.status).toBe(200);
  return (JSON.parse(store.get(`app-grants:${PERSON}`)!) as Array<{ terms?: { clientId: string }; delegation: unknown }>)[0]!;
};

beforeEach(() => { store = new Map(); h.recognition.value = null; });

describe('/oidc/grant', () => {
  it('stores what was agreed beside this person\'s cookie', async () => {
    h.recognition.value = { sub: `eip155:34348:${PERSON}` };
    expect((await redeem()).terms?.clientId).toBe('reader');
  });
  it('remembers nothing with no cookie, and still lists the wire', async () => {
    const row = await redeem();
    expect(row.terms).toBeUndefined();
    expect(row.delegation).toBeDefined();
  });
  it('remembers nothing beside someone else\'s cookie', async () => {
    h.recognition.value = { sub: 'eip155:34348:0x1111111111111111111111111111111111111111' };
    expect((await redeem()).terms).toBeUndefined();
  });
  // The skip rule always shows the sheet for a request through a host or with a session key. An Allow given on such a
  // sheet is not a record of allowing the app asking by itself.
  it('remembers nothing for an Allow given through a host', async () => {
    h.recognition.value = { sub: `eip155:34348:${PERSON}` };
    const row = await redeem({ via_host: true });
    expect(row.terms).toBeUndefined();
    expect(row.delegation).toBeDefined();
  });
  it('remembers nothing for an Allow that had a session-key leaf signed', async () => {
    h.recognition.value = { sub: `eip155:34348:${PERSON}` };
    expect((await redeem({}, { sessionDelegation: { delegate: '0x2' } })).terms).toBeUndefined();
  });
});
