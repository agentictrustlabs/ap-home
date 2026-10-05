/**
 * `/oidc/grant` — the organization's common name on the `org` payload `/token` returns.
 *
 * WHAT THESE PIN: an org-create ceremony that asked for a common name hands it to the relying app on the
 * FIRST token, beside `orgName`, and projects it onto the steward's link; the raw `orgProfile` the SPA sent
 * is not echoed; a common name that only repeats the `.org` name is omitted; an existing organization's
 * saved name reaches the token the same way.
 *
 * The proofs are stubbed (delegation verification, token minting, the broker); the KV writes are the real code.
 */
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

const redeem = async (org: Record<string, unknown>) => {
  store.set('oidc-grant:g1', JSON.stringify({ client_id: 'gc-engage', delegate: DELEGATE, nonce: '', agent_name: '', code_challenge: 'c', redirect_uri: 'https://app.test/cb', delegation_template: 'org-create' }));
  const r = await onRequestPost(ctx(new Request(`${ISS}/oidc/grant`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ISS },
    body: JSON.stringify({ grant_id: 'g1', delegation: { delegator: PERSON, delegate: DELEGATE }, org }),
  })));
  expect(r.status).toBe(200);
  return (JSON.parse(store.get('oidc:code-1')!) as { org: Record<string, unknown> }).org;
};

describe('/oidc/grant — the organization common name', () => {
  beforeEach(() => { store = new Map(); });

  it('returns the ceremony\'s common name beside orgName on the first token, and projects it onto the link', async () => {
    const org = await redeem({ orgAgent: ORG, orgName: 'global-church.org', person: PERSON, purpose: 'related-org', orgProfile: { displayName: 'Global.Church' } });
    expect(org).toMatchObject({ orgAgent: ORG, orgName: 'global-church.org', displayName: 'Global.Church' });
    expect(org).not.toHaveProperty('orgProfile');
    expect(JSON.parse(store.get(`related:${PERSON}:${ORG}`)!).orgProfile).toEqual({ displayName: 'Global.Church' });
  });

  it('omits a common name that only repeats the .org name', async () => {
    const org = await redeem({ orgAgent: ORG, orgName: 'global-church.org', person: PERSON, orgProfile: { displayName: 'global-church' } });
    expect(org).not.toHaveProperty('displayName');
  });

  it('returns an existing organization\'s saved name when the ceremony connects it', async () => {
    store.set(`related:${PERSON}:${ORG}`, JSON.stringify({ orgAgent: ORG, orgName: 'global-church.org', orgProfile: { displayName: 'Global.Church', website: 'https://global.church' } }));
    const org = await redeem({ orgAgent: ORG, orgName: 'global-church.org', person: PERSON });
    expect(org).toMatchObject({ displayName: 'Global.Church', website: 'https://global.church' });
  });
});
