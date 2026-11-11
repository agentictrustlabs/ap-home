// Spec 445 §8 — an app's id_token is not a Home session. Real keys and real tokens: an id_token passes the signature,
// issuer, audience and time checks, so these pin the one thing that tells them apart.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { generateBrokerKeypair, mintAgentSession, mintIdToken, publishJwks, type BrokerSigner } from '@agenticprimitives/connect';

const ISS = 'https://www.faithnet.me';
const SUB = 'eip155:34348:0xeef5ed02e052ee221afcbbd2708919473c4e2b28';
const h = vi.hoisted(() => ({ jwks: null as unknown }));
vi.mock('./_lib/server-broker', () => ({
  getServer: async () => ({ jwks: h.jwks, directory: { agent: async () => ({ facets: { name: 'ruth.me' } }) } }),
  resolveOrigin: () => 'https://www.faithnet.me',
  json: (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } }),
}));

import { fedcmConsentFailure, onAccounts } from './fedcm';
import { termsFor } from '../src/lib/consent-terms';
import type { RelyingApp } from '../src/whitelabel/schema';
import type { AppGrantRow } from './oidc/app-grant-row';

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
    expect(await r.json()).toMatchObject({ reason: expect.stringContaining('typ must be "agent-session+jwt"') });
  });
});

describe('fedcmConsentFailure — when the FedCM lane may hand back a stored wire', () => {
  const client = { client_id: 'app', redirect_uris: [], allowed_scopes: ['openid'], allowed_delegation_templates: ['site-login'], delegate: '0x89d13c596c45e4ee80af5ae06c727fe9a820ffd0' } as unknown as RelyingApp;
  const row = (over: Partial<AppGrantRow> = {}): AppGrantRow => ({ clientId: 'app', template: 'site-login', delegate: client.delegate, delegation: {} as never, issuedAt: 1, terms: termsFor(client, 'site-login'), origins: ['https://app.test'], ...over });
  const ask = (r: AppGrantRow | undefined, c = client, origin = 'https://app.test', curated = true) => fedcmConsentFailure(c, r, origin, curated);
  it('hands it back for an app this person allowed, that asks for nothing more', () => expect(ask(row())).toBeNull());
  it('a member-registered app always asks', () => expect(ask(row(), client, 'https://app.test', false)).toBe('member_registered'));
  it('an app that mints money authority at sign-in is never handed one', () => expect(ask(row(), { ...client, paymentConfig: {} } as never)).toBe('template_ineligible'));
  it('never allowed', () => expect(ask(undefined)).toBe('no_record'));
  it('a row with no terms', () => expect(ask(row({ terms: undefined }))).toBe('no_record'));
  it('ask me every time', () => expect(ask(row({ askEveryTime: true }))).toBe('ask_every_time'));
  it('another origin', () => expect(ask(row(), client, 'https://other.test')).toBe('new_origin'));
  it('an app asking for more', () => expect(ask(row(), { ...client, allowed_scopes: ['openid', 'profile'] } as never)).toBe('terms_widened'));
});
