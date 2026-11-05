// Spec 445 §8 — an app's id_token is not a Home session. Real keys and real tokens: an id_token passes the signature,
// issuer, audience and time checks, so these pin the one thing that tells them apart.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { generateBrokerKeypair, mintAgentSession, mintIdToken, publishJwks, type BrokerSigner } from '@agenticprimitives/connect';

const ISS = 'https://www.faithnet.me';
const SUB = 'eip155:34348:0xeef5ed02e052ee221afcbbd2708919473c4e2b28';
const h = vi.hoisted(() => ({ jwks: null as unknown }));
vi.mock('./_lib/server-broker', () => ({
  getServer: async () => ({ jwks: h.jwks, directory: { agent: async () => ({ facets: { name: 'ruth.impact' } }) } }),
  resolveOrigin: () => 'https://www.faithnet.me',
  json: (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } }),
}));

import { onAccounts } from './fedcm';

let signer: BrokerSigner;
const accounts = (token: string) => onAccounts({
  request: new Request(`${ISS}/fedcm/accounts`, { headers: { 'sec-fetch-dest': 'webidentity', cookie: `ap_sso=${encodeURIComponent(JSON.stringify({ t: token, v: 'passkey' }))}` } }),
  env: {} as never,
});

beforeAll(async () => {
  signer = await generateBrokerKeypair('ES256');
  h.jwks = await publishJwks([signer as never]);
});

describe('what /fedcm takes as a Home session', () => {
  it('takes a real session', async () => {
    const t = await mintAgentSession({ sub: SUB as never, principal: { kind: 'passkey', id: 'x', assurance: 'onchain-confirmed', role: 'custody-grade' } as never, assurance: 'onchain-confirmed', aud: 'demo-sso', iss: ISS, ttlSeconds: 3600 }, signer);
    expect((await accounts(t)).status).toBe(200);
  });
  it('refuses an id_token issued to an app, though it is signed by the same key', async () => {
    const t = await mintIdToken({ iss: ISS, sub: SUB as never, aud: 'some-app', ttlSeconds: 3600 }, signer);
    const r = await accounts(t);
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ reason: 'session_verify_failed:not_a_home_session' });
  });
});
