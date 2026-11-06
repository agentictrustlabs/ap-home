// Spec 445 §5 — may this sign-in skip the sheet? Each row of §5.2 returns its reason; a yes signs nothing, carries the
// stored wires, and its code exchanges at /token under PKCE and no other verifier. The chain and the signer are stubbed;
// the rules, the row, the KV writes and the token exchange are the real code.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeTimestampTerms } from '@agenticprimitives/delegation';

const ISS = 'https://www.faithnet.me';
const PERSON = '0xeef5ed02e052ee221afcbbd2708919473c4e2b28';
const SITE = '0x89d13c596c45e4ee80af5ae06c727fe9a820ffd0';
const ASK = '0xb77a627a4ad23af518f9626186f7be4d2cc4bff1';
const REDIRECT = 'https://reader.test/';
const SUB = `eip155:34348:${PERSON}`;

const h = vi.hoisted(() => ({
  verify: vi.fn(),
  recognition: { value: null as null | Record<string, unknown> },
  directoryName: { value: 'ruth.impact' as string | Error },
  auditFails: { value: false },
  client: { value: null as unknown },
}));

vi.mock('../_lib/server-broker', () => ({
  getServer: async () => ({ signer: {}, directory: { agent: async () => { if (h.directoryName.value instanceof Error) throw h.directoryName.value; return { facets: { name: h.directoryName.value } }; } } }),
  resolveOrigin: () => 'https://www.faithnet.me',
  ownIssuer: () => 'https://www.faithnet.me',
  json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  jsonCors: (body: unknown, _r: Request, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  corsHeaders: () => ({}),
}));
vi.mock('../_lib/recognition', () => ({ readRecognition: async () => h.recognition.value }));
vi.mock('../_lib/verify-delegation', () => ({ verifyDelegation: h.verify }));
vi.mock('../_lib/session-ttl', () => ({ idTokenTtl: () => 7 * 86_400 }));
vi.mock('../_lib/oidc-registry', () => ({ resolveClient: async () => h.client.value, isAllowedRelyingOriginAsync: async () => true }));
vi.mock('../../src/lib/oidc-clients', () => ({
  clientAllowsRedirect: (c: { redirect_uris: string[] }, u: string) => c.redirect_uris.includes(u),
  clientAllowsTemplate: (c: { allowed_delegation_templates: string[] }, t: string) => c.allowed_delegation_templates.includes(t),
  getClientDelegateFor: () => SITE,
  getClient: () => null,
  isAllowedClientOrigin: () => false,
}));
vi.mock('../../src/lib/chain', async (orig) => { const real = await orig<{ CONTRACTS: object }>(); return { ...real, CONTRACTS: { ...real.CONTRACTS, timestampEnforcer: '0x00000000000000000000000000000000000000aa' } }; });
vi.mock('../../src/home/inbox-data', () => ({ homeAuditSink: () => ({ write: async () => { if (h.auditFails.value) throw new Error('audit down'); } }) }));
vi.mock('@agenticprimitives/connect', async (orig) => ({ ...(await orig<object>()), mintIdToken: vi.fn(async () => 'id-token'), newAuthCode: () => 'code-1' }));
vi.mock('./app-grant-row', async (orig) => ({ ...(await orig<object>()), wireRef: () => '0xdigest' }));

import { onRequestPost } from './remembered';
import { onRequestPost as tokenPost } from '../token';
import { termsDigest, termsFor } from '../../src/lib/consent-terms';
import { askAsMeCaveats, siteCaveats } from '../../src/lib/delegation';
import type { RelyingApp } from '../../src/whitelabel/schema';

const inDays = (d: number) => Math.floor(Date.now() / 1000) + d * 86_400;
// Fixed once: compared across calls, a time read at each call differs when two calls straddle a second.
const FAR = inDays(300);
const wire = (delegate: string, until = FAR) => ({
  delegator: PERSON, delegate, authority: '0x00', salt: '1', signature: '0x03',
  caveats: (delegate === ASK ? askAsMeCaveats(until) : siteCaveats(until)).map((c) => ({ enforcer: c.enforcer, terms: c.terms })),
});
const reader = (over: Partial<RelyingApp> = {}) => ({
  client_id: 'reader', name: 'Reader', redirect_uris: [REDIRECT], allowed_scopes: ['openid', 'profile'],
  allowed_delegation_templates: ['site-login', 'ask-as-me', 'x402-pay'], delegate: SITE, ask_delegate: ASK, ask_with_login: true,
  remembered_consent: 'on', ...over,
}) as RelyingApp;
const rowFor = (over: Record<string, unknown> = {}) => {
  const terms = termsFor(reader(), 'site-login');
  return { v: 2, clientId: 'reader', template: 'site-login', delegate: SITE, delegation: wire(SITE), askDelegation: wire(ASK, inDays(25)), issuedAt: 1, terms, termsDigest: termsDigest(terms), origins: ['https://reader.test'], ...over };
};

let store: Map<string, string>;
const env = () => ({
  AUTH_CODES: {
    async get(k: string) { return store.get(k) ?? null; },
    async put(k: string, v: string) { store.set(k, v); },
    async delete(k: string) { store.delete(k); },
  },
}) as never;
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'; // RFC 7636 appendix B
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const ask = (over: Record<string, unknown> = {}, headers: Record<string, string> = { origin: ISS }) =>
  onRequestPost({
    request: new Request(`${ISS}/oidc/remembered`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ client_id: 'reader', redirect_uri: REDIRECT, code_challenge: CHALLENGE, code_challenge_method: 'S256', delegation_template: 'site-login', nonce: 'n', person: PERSON, agent_name: '', profile_name: 'Ruth', ...over }),
    }),
    env: env(),
  });
const reason = async (r: Response) => (await r.json() as { consent_required?: string }).consent_required;

beforeEach(() => {
  store = new Map([[`app-grants:${PERSON}`, JSON.stringify([rowFor()])]]);
  h.verify.mockReset().mockResolvedValue({ ok: true, digest: '0xdigest' });
  h.recognition.value = { sub: SUB, cred: 'passkey', auth_time: 1 };
  h.directoryName.value = 'ruth.impact';
  h.auditFails.value = false;
  h.client.value = reader();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

describe('who may ask', () => {
  it('refuses another origin, a missing one, and a cross-site fetch', async () => {
    expect((await ask({}, { origin: 'https://evil.test' })).status).toBe(403);
    expect((await ask({}, {})).status).toBe(403);
    expect((await ask({}, { origin: ISS, 'sec-fetch-site': 'cross-site' })).status).toBe(403);
  });
  it('is login_required with no recognition, whatever else the request holds', async () => {
    h.recognition.value = null;
    const r = await ask({}, { origin: ISS, authorization: 'Bearer stolen-session-token' });
    expect(r.status).toBe(401);
    expect(store.has('oidc:code-1')).toBe(false);
  });
  it('judges the request as authorize-grant does', async () => {
    expect((await ask({ redirect_uri: 'https://evil.test/' })).status).toBe(400);
    expect((await ask({ delegation_template: 'not-allowed' })).status).toBe(400);
    expect((await ask({ code_challenge_method: 'plain' })).status).toBe(400);
  });
});

describe('when every line holds', () => {
  it('answers a code, carrying the stored wires, and signs nothing', async () => {
    const r = await ask();
    expect(await r.json()).toEqual({ code: 'code-1' });
    const code = JSON.parse(store.get('oidc:code-1')!) as Record<string, unknown>;
    expect(code.delegation).toEqual(wire(SITE));
    expect((code.askDelegation as { delegate: string }).delegate).toBe(ASK);
    expect(code).toMatchObject({ id_token: 'id-token', paymentDelegation: null, sessionDelegation: null, delegations: null, org: null, client_id: 'reader', redirect_uri: REDIRECT, code_challenge: CHALLENGE, profile_name: 'Ruth' });
  });
  it('checks every wire on chain, now', async () => {
    await ask();
    expect(h.verify).toHaveBeenCalledTimes(2);
  });
  it('renews the binding the app\'s silent re-auth runs on, and records the visit', async () => {
    await ask();
    expect(JSON.parse(store.get('oidc-deleg:0xdigest')!)).toMatchObject({ client_id: 'reader', agent_name: 'ruth.impact', profile_name: 'Ruth' });
    const [row] = JSON.parse(store.get(`app-grants:${PERSON}`)!) as Array<{ lastUsedAt?: number; delegation: unknown }>;
    expect(row!.lastUsedAt).toBeGreaterThan(0);
    expect(row!.delegation).toEqual(wire(SITE)); // the same wire: nothing new
    expect(JSON.parse(store.get(`remembered-log:${PERSON}`)!)[0]).toMatchObject({ clientId: 'reader' });
  });
  it('its code exchanges at /token under PKCE, and under no other verifier', async () => {
    await ask();
    const exchange = (verifier: string) => tokenPost({
      request: new Request(`${ISS}/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'authorization_code', code: 'code-1', code_verifier: verifier, client_id: 'reader', redirect_uri: REDIRECT }) }),
      env: env(),
    });
    const saved = store.get('oidc:code-1')!;
    const wrong = await exchange('wrong-verifier-wrong-verifier-wrong-verifier-xxx');
    expect(wrong.status).toBe(400);
    expect(store.has('oidc:code-1')).toBe(false); // single use, whatever the outcome
    store.set('oidc:code-1', saved);
    const good = await exchange(VERIFIER);
    expect(good.status).toBe(200);
    const b = await good.json() as { id_token: string; delegation: unknown; askDelegation: { delegate: string } };
    expect(b.id_token).toBe('id-token');
    expect(b.delegation).toEqual(wire(SITE));
    expect(b.askDelegation.delegate).toBe(ASK);
  });
});

describe('each line of §5.2 says why it failed', () => {
  const put = (row: Record<string, unknown>) => store.set(`app-grants:${PERSON}`, JSON.stringify([row]));
  const cases: Array<[string, string, () => Promise<Response>]> = [
    ['client_not_enabled', 'an app not switched on', async () => { h.client.value = reader({ remembered_consent: undefined }); return ask(); }],
    ['template_ineligible', 'a template that is never remembered', async () => ask({ delegation_template: 'x402-pay' })],
    ['template_ineligible', 'an app that mints money authority at sign-in', async () => { h.client.value = reader({ paymentConfig: {} as never }); return ask(); }],
    ['prompt_consent', 'prompt=consent', async () => ask({ prompt: 'consent' })],
    ['prompt_login', 'prompt=login', async () => ask({ prompt: 'login' })],
    ['prompt_login', 'prompt=select_account', async () => ask({ prompt: 'select_account' })],
    ['session_key_requested', 'a session key', async () => ask({ session_key: '0xabc' })],
    ['via_host_requested', 'a request through a host', async () => ask({ via_host: 'Claude' })],
    ['session_mismatch', 'a page showing someone else', async () => ask({ person: '0x1111111111111111111111111111111111111111' })],
    ['no_record', 'no row', async () => { store.delete(`app-grants:${PERSON}`); return ask(); }],
    ['no_record', 'a row from before spec 445', async () => { put({ clientId: 'reader', template: 'site-login', delegate: SITE, delegation: wire(SITE), issuedAt: 1 }); return ask(); }],
    ['ask_every_time', 'the person\'s own switch', async () => { put(rowFor({ askEveryTime: true })); return ask(); }],
    ['new_origin', 'a redirect origin never allowed', async () => { put(rowFor({ origins: ['https://other.test'] })); return ask(); }],
    ['terms_widened', 'a registry asking for more', async () => { h.client.value = reader({ idTokenClaims: ['email'] } as Partial<RelyingApp>); return ask({ profile_email: '' }); }],
    ['claims_need_session', 'a name the page could not read', async () => ask({ profile_name: undefined })],
    ['pinned_name_mismatch', 'a pin for another person', async () => ask({ agent_name: 'naomi.impact' })],
    ['directory_unavailable', 'a directory that cannot answer', async () => { h.directoryName.value = new Error('down'); return ask(); }],
    ['wire_revoked', 'a wire revoked on chain', async () => { h.verify.mockResolvedValueOnce({ ok: false, reason: 'delegation is revoked' }); return ask(); }],
    ['wire_revoked', 'a wire revoked and forgotten', async () => { const { askDelegation: _a, ...row } = rowFor(); put(row); return ask(); }],
    ['wire_invalid', 'a signature that no longer verifies', async () => { h.verify.mockResolvedValue({ ok: false, reason: 'ERC-1271 verification failed against the delegator' }); return ask(); }],
    ['wire_invalid', 'a wire that is someone else\'s', async () => { put(rowFor({ delegation: { ...wire(SITE), delegator: '0x1111111111111111111111111111111111111111' } })); return ask(); }],
    ['wire_invalid', 'a wire naming an old key', async () => { put(rowFor({ delegation: wire('0x2222222222222222222222222222222222222222') })); return ask(); }],
    ['caveats_changed', 'a wire that is not what the template builds today', async () => { put(rowFor({ delegation: { ...wire(SITE), caveats: wire(SITE).caveats.slice(0, 1) } })); return ask(); }],
    ['caveats_changed', 'an ask wire carrying extra authority', async () => { put(rowFor({ askDelegation: { ...wire(ASK, inDays(25)), caveats: [...wire(ASK, inDays(25)).caveats, { enforcer: '0x00000000000000000000000000000000000000cc', terms: '0x01' }] } })); return ask(); }],
    ['wire_expiring', 'a wire that ends before the id_token', async () => { put(rowFor({ askDelegation: wire(ASK, inDays(3)) })); return ask(); }],
    ['chain_unavailable', 'a chain that cannot be read: not called a revocation', async () => { h.verify.mockResolvedValue({ ok: false, reason: 'revocation check unavailable (chain read failed) — please retry' }); return ask(); }],
    ['audit_unavailable', 'a sign-in that cannot be recorded', async () => { h.auditFails.value = true; vi.spyOn(console, 'warn').mockImplementationOnce(() => undefined); return ask(); }],
  ];
  for (const [want, what, run] of cases) {
    it(`${want}: ${what}`, async () => {
      const r = await run();
      expect(await reason(r)).toBe(want);
      expect(store.has('oidc:code-1')).toBe(false);
    });
  }
  it('terms_widened hands back what was agreed, so the sheet can mark what is new', async () => {
    h.client.value = reader({ idTokenClaims: ['email'] } as Partial<RelyingApp>);
    const b = await (await ask({ profile_email: '' })).json() as { stored_terms?: { clientId: string } };
    expect(b.stored_terms?.clientId).toBe('reader');
  });
  it('an app that no longer asks for the ask wire is not held back by it, and does not receive it', async () => {
    h.client.value = reader({ ask_with_login: false });
    const { askDelegation: _a, ...row } = rowFor();
    put(row);
    expect(await (await ask()).json()).toEqual({ code: 'code-1' });
    expect(JSON.parse(store.get('oidc:code-1')!).askDelegation).toBeNull();
  });
});

describe('a silent sign-in', () => {
  it('needs the app to name the person it expects', async () => {
    expect(await reason(await ask({ prompt: 'none' }))).toBe('silent_person_unconfirmed');
    expect(await reason(await ask({ prompt: 'none', login_hint: '0x1111111111111111111111111111111111111111' }))).toBe('silent_person_unconfirmed');
    expect(h.verify).not.toHaveBeenCalled();
  });
  it('passes for that person, by address or CAIP-10, in any case', async () => {
    expect(await (await ask({ prompt: 'none', login_hint: PERSON.toUpperCase().replace('0X', '0x') })).json()).toEqual({ code: 'code-1' });
    store.delete('oidc:code-1');
    expect(await (await ask({ prompt: 'none', login_hint: SUB })).json()).toEqual({ code: 'code-1' });
  });
  it('still gets nothing for an app the person never allowed', async () => {
    store.delete(`app-grants:${PERSON}`);
    expect(await reason(await ask({ prompt: 'none', login_hint: PERSON }))).toBe('no_record');
  });
});

describe('shadow', () => {
  beforeEach(() => { h.client.value = reader({ remembered_consent: 'shadow' }); });
  it('decides, counts, and still shows the sheet', async () => {
    const b = await (await ask()).json() as { consent_required?: string; would?: string; code?: string };
    expect(b).toEqual({ consent_required: 'shadow', would: 'allow' });
    expect(store.has('oidc:code-1')).toBe(false);
    expect(h.verify).toHaveBeenCalled();
    expect([...store.keys()].some((k) => k.startsWith('remembered-stat:') && k.endsWith(':reader:shadow:allow'))).toBe(true);
  });
  it('names the reason for a no', async () => {
    h.verify.mockResolvedValueOnce({ ok: false, reason: 'revoked' });
    expect(await reason(await ask())).toBe('wire_revoked');
  });
});

describe('an app not switched on', () => {
  it('reads no chain, and is still counted for W0', async () => {
    h.client.value = reader({ remembered_consent: undefined });
    expect(await reason(await ask())).toBe('client_not_enabled');
    expect(h.verify).not.toHaveBeenCalled();
    expect([...store.keys()].some((k) => k.startsWith('remembered-stat:') && k.endsWith(':reader:off:would_check_chain'))).toBe(true);
  });
});
