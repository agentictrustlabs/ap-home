import { describe, it, expect, vi, beforeEach } from 'vitest';

const PERSON = '0xeef5ed02e052ee221afcbbd2708919473c4e2b28';
const ORG = '0xe26157068af46629691e2ab19726bf61476e6b6c';
const DELEGATE = '0x89d1000000000000000000000000000000000000';
const ISS = 'https://home.test';

vi.mock('../_lib/server-broker', () => ({
  getServer: async () => ({ signer: {} }),
  resolveOrigin: () => ISS,
  json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
}));
vi.mock('../_lib/verify-delegation', () => ({ verifyDelegation: async () => ({ ok: true, digest: '0xdigest' }) }));
vi.mock('../_lib/session-ttl', () => ({ idTokenTtl: () => 300 }));
vi.mock('@agenticprimitives/connect', () => ({ mintIdToken: async () => 'id-token', newAuthCode: () => 'code-1' }));
vi.mock('../../src/lib/oidc-clients', () => ({ getClient: () => null }));

import { onRequestPost } from './grant';

let store: Map<string, string>;
const ctx = (request: Request) =>
  ({
    request,
    env: {
      AUTH_CODES: {
        async get(k: string) { return store.get(k) ?? null; },
        async put(k: string, v: string) { store.set(k, v); },
        async delete(k: string) { store.delete(k); },
      },
    },
  }) as never;


const VICTIM = '0x7777777777777777777777777777777777777777';
const post = (org: Record<string, unknown>) => {
  store.set('oidc-grant:g1', JSON.stringify({ client_id: 'gc-engage', delegate: DELEGATE, nonce: '', agent_name: '', code_challenge: 'c', redirect_uri: 'https://app.test/cb', delegation_template: 'org-create' }));
  return onRequestPost(ctx(new Request(`${ISS}/oidc/grant`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ISS },
    body: JSON.stringify({ grant_id: 'g1', delegation: { delegator: PERSON, delegate: DELEGATE }, org }),
  })));
};

describe('/oidc/grant — the org link belongs to the person who signed', () => {
  beforeEach(() => { store = new Map(); });

  it('REFUSES an org link for anyone but the delegation’s delegator, and leaves theirs untouched', async () => {
    const theirs = JSON.stringify({ orgAgent: ORG, orgName: 'their.org', stewardshipDelegation: { delegator: ORG, delegate: VICTIM, signature: '0xreal' } });
    store.set(`related:${VICTIM}:${ORG}`, theirs);
    const r = await post({ orgAgent: ORG, orgName: 'their.org', person: VICTIM, stewardshipDelegation: { junk: true } });
    expect(r.status).toBe(403);
    expect(store.get(`related:${VICTIM}:${ORG}`)).toBe(theirs);
    expect(store.has('oidc:code-1')).toBe(false);
  });

  it('writes the link for the delegator, whatever the case of the address', async () => {
    const r = await post({ orgAgent: ORG, orgName: 'mine.org', person: PERSON.toUpperCase().replace('0X', '0x') });
    expect(r.status).toBe(200);
    expect(JSON.parse(store.get(`related:${PERSON}:${ORG}`)!)).toMatchObject({ orgAgent: ORG, orgName: 'mine.org' });
  });
});
