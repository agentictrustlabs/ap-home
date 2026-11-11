// Spec 445, in a real browser against the real build: every way through the sheet, and every way back to it.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

process.env.NEXT_PUBLIC_CHAIN_ID ??= '34348';
const { askAsMeCaveats, siteCaveats } = await import('../../apps/home/src/lib/delegation');
const { termsDigest, termsFor } = await import('../../apps/home/src/lib/consent-terms');
const { getClient } = await import('../../apps/home/src/lib/oidc-clients');
const { signerFromPrivateJwk } = await import('../../apps/home/src/lib/broker-core');
const { mintAgentSession } = await import('../../apps/home/node_modules/@agenticprimitives/connect/dist/index.js');
const { DEPLOYMENT_EPOCH } = await import('../../apps/home/src/lib/chain');
const { ROOT_AUTHORITY } = await import('../../apps/home/node_modules/@agenticprimitives/delegation/dist/index.js');

const HOME = 'http://localhost:5373';
const BACK = 'http://127.0.0.1:8799';
const READER = 'seed-bible-reader';
const READER_URL = 'https://seed-reader.faithnet.io/';
const SITE = '0x89D13c596c45E4eE80Af5ae06C727FE9A820ffD0';
const ASK = '0xb77a627a4ad23af518f9626186F7bE4D2cC4BFf1';
const SHEET = /This app can/i;

const inDays = (d: number) => Math.floor(Date.now() / 1000) + d * 86_400;
const pkce = () => { const verifier = randomBytes(32).toString('base64url'); return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }; };
const wireOf = (delegator: string, delegate: string, caveats: Array<{ enforcer: string; terms: string }>) => ({
  delegator, delegate, authority: ROOT_AUTHORITY, salt: BigInt(`0x${randomBytes(16).toString('hex')}`).toString(), signature: '0x03',
  caveats: caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms })),
});

const kvGet = async (r: APIRequestContext, key: string) => (await (await r.get(`${BACK}/__kv/get?key=${encodeURIComponent(key)}`)).json()).value as string | null;
const kvPut = (r: APIRequestContext, key: string, value: string) => r.post(`${BACK}/__kv/put`, { data: { key, value } });
const chain = (r: APIRequestContext, data: object) => r.post(`${BACK}/__chain`, { data });

/** Nothing leaves localhost but the reader's return, which is answered with a blank page. */
async function offline(context: BrowserContext) {
  await context.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return route.continue();
    if (route.request().resourceType() === 'document') return route.fulfill({ contentType: 'text/html', body: '<html><title>returned</title>returned</html>' });
    return route.abort();
  });
}

/** A real SIWE ceremony against the real endpoint, from the page, so the browser receives what it would. */
async function signIn(page: Page) {
  const account = privateKeyToAccount(generatePrivateKey());
  await page.goto('/jwks');
  const { nonce } = await page.evaluate(() => fetch('/connect/nonce').then((r) => r.json()));
  const message = createSiweMessage({ domain: 'localhost:5373', address: account.address, statement: 'Sign in', uri: HOME, version: '1', chainId: 34348, nonce });
  const signature = await account.signMessage({ message });
  const r = await page.evaluate((body) => fetch('/connect/siwe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (x) => ({ status: x.status, body: await x.json() })), { message, signature, aud: 'demo-sso' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.status).toBe('issued');
  const session = { token: r.body.token as string, agent: r.body.agent as string };
  await hold(page, session);
  return session;
}
/** What the Home's page keeps after a sign-in. */
async function hold(page: Page, s: { token: string }) {
  await page.evaluate(({ token, e }) => {
    localStorage.setItem('agenticprimitives:demo-sso:session', JSON.stringify({ token, via: 'wallet', deploymentEpoch: e }));
    document.cookie = `ap_sso=${encodeURIComponent(JSON.stringify({ t: token, v: 'wallet', e }))}; Path=/; SameSite=Lax`;
  }, { token: s.token, e: DEPLOYMENT_EPOCH });
}

/** A sheet's outcome, through the real authorize-grant and grant endpoints, from the page. The signing itself needs a
 *  bundler, so the wires are built here by the Home's own builders and the fake chain accepts their approval. */
async function allow(page: Page, s: { agent: string }, client = READER, redirect_uri = READER_URL, ask: string | null = ASK) {
  const { challenge } = pkce();
  const out = await page.evaluate(async ({ client, redirect_uri, challenge, delegation, askDelegation }) => {
    const j = (u: string, b: object) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const g = await j('/oidc/authorize-grant', { client_id: client, redirect_uri, code_challenge: challenge, code_challenge_method: 'S256', delegation_template: 'site-login', nonce: 'n', agent_name: '' });
    if (g.status !== 200) return g;
    return j('/oidc/grant', { grant_id: g.body.grant_id, delegation, ...(askDelegation ? { askDelegation } : {}) });
  }, { client, redirect_uri, challenge, delegation: wireOf(s.agent, SITE, siteCaveats(inDays(365))), askDelegation: ask ? wireOf(s.agent, ask, askAsMeCaveats(inDays(30))) : null });
  expect(out.status, JSON.stringify(out.body)).toBe(200);
}

const enrollUrl = (challenge: string, extra: Record<string, string> = {}, client = READER, redirect = READER_URL) => {
  const q = new URLSearchParams({ client_id: client, redirect_uri: redirect, state: 'st', nonce: 'nn', code_challenge: challenge, code_challenge_method: 'S256', delegation_template: 'site-login', delegate: SITE, ...extra });
  return `/?${q}`;
};
const returnedTo = (page: Page, base = READER_URL) => page.waitForURL((u) => u.href.startsWith(base), { timeout: 40_000 });
const cookieNamed = async (context: BrowserContext, name: string) => (await context.cookies()).find((c) => c.name === name);
const rowOf = async (r: APIRequestContext, agent: string, client = READER) => (JSON.parse((await kvGet(r, `app-grants:${agent.toLowerCase()}`)) ?? '[]') as Array<Record<string, any>>).find((x) => x.clientId === client);

test.beforeEach(async ({ context, request }) => { await offline(context); await chain(request, { reset: true }); });

test.describe('the recognition cookie', () => {
  test('a real sign-in sets it HttpOnly and Strict, and script cannot see it', async ({ page, context }) => {
    await signIn(page);
    const c = await cookieNamed(context, 'ap_sid');
    expect(c).toBeTruthy();
    expect(c!.httpOnly).toBe(true);
    expect(c!.sameSite).toBe('Strict');
    expect(c!.expires - Date.now() / 1000).toBeGreaterThan(3500);
    expect(c!.expires - Date.now() / 1000).toBeLessThan(3700);
    expect(await page.evaluate(() => document.cookie)).not.toContain('ap_sid');
    expect(c!.value.split('.').length).toBe(1);
  });

  test('sign-out removes it, and a saved copy is then worth nothing', async ({ page, context, request }) => {
    const s = await signIn(page);
    await allow(page, s);
    const copy = (await cookieNamed(context, 'ap_sid'))!.value;
    await page.goto(`/logout?return=${encodeURIComponent(`${HOME}/jwks`)}`);
    await expect.poll(async () => cookieNamed(context, 'ap_sid')).toBeUndefined();
    const { challenge } = pkce();
    const r = await request.post('/oidc/remembered', { headers: { origin: HOME, cookie: `ap_sid=${copy}` }, data: { client_id: READER, redirect_uri: READER_URL, code_challenge: challenge, delegation_template: 'site-login', person: s.agent } });
    expect(r.status()).toBe(401);
  });

  test('sign-out ends every app\'s silent renewal; "Not you?" does not', async ({ page, request }) => {
    const s = await signIn(page);
    await allow(page, s);
    const row = await rowOf(request, s.agent);
    const renew = () => request.post('/token', { data: { grant_type: 'delegation', delegation: row!.delegation, client_id: READER } });
    expect((await renew()).status()).toBe(200);
    await page.evaluate(() => fetch('/connect/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    expect((await renew()).status(), 'a cookie ended without "everywhere" leaves apps alone').toBe(200);
  });

  test('a real sign-out page ends the renewal of the apps this person allowed', async ({ page, request }) => {
    const s = await signIn(page);
    await allow(page, s);
    const row = await rowOf(request, s.agent);
    const renew = () => request.post('/token', { data: { grant_type: 'delegation', delegation: row!.delegation, client_id: READER } });
    expect((await renew()).status()).toBe(200);
    await page.goto(`/logout?return=${encodeURIComponent(`${HOME}/jwks`)}`);
    await expect.poll(async () => (await renew()).status()).not.toBe(200);
  });

  test('a session token alone proves nothing: replayed from elsewhere, 401', async ({ page, playwright }) => {
    const s = await signIn(page);
    await allow(page, s);
    const { challenge } = pkce();
    const elsewhere = await playwright.request.newContext({ baseURL: HOME });
    const r = await elsewhere.post('/oidc/remembered', { headers: { origin: HOME, authorization: `Bearer ${s.token}`, cookie: `ap_sso=${encodeURIComponent(JSON.stringify({ t: s.token, v: 'wallet' }))}` }, data: { client_id: READER, redirect_uri: READER_URL, code_challenge: challenge, delegation_template: 'site-login', person: s.agent, profile_name: '' } });
    expect(r.status()).toBe(401);
    await elsewhere.dispose();
  });

  test('no other origin may ask', async ({ request }) => {
    const r = await request.post('/oidc/remembered', { headers: { origin: 'https://evil.example' }, data: {} });
    expect(r.status()).toBe(403);
  });

  test('a social return link opened in another browser is refused, before anything is asked of the provider', async ({ page, context, playwright, request }) => {
    // A real start in this browser, and the state it stashed.
    const stashes = async () => (await (await request.post(`${BACK}/__kv/keys`, { data: { prefix: 'oidc:' } })).json()).keys as string[];
    const before = await stashes();
    await page.goto(`/oidc/google/start?aud=demo-sso&redirect_uri=${encodeURIComponent(`${HOME}/`)}`);
    const state = (await stashes()).find((k) => !before.includes(k))!.slice('oidc:'.length);
    const stash = (await kvGet(request, `oidc:${state}`))!;
    const other = await playwright.request.newContext({ baseURL: HOME });
    const elsewhere = await other.get(`/oidc/google/callback?code=x&state=${state}`);
    expect(elsewhere.status()).toBe(403);
    expect((await elsewhere.json()).error).toBe('sign_in_started_elsewhere');
    await other.dispose();
    // In the browser that started it, it gets past that refusal, to the provider (unreachable here).
    await kvPut(request, `oidc:${state}`, stash);
    const mark = (await cookieNamed(context, 'ap_login'))!;
    const here = await request.get(`/oidc/google/callback?code=x&state=${state}`, { headers: { cookie: `ap_login=${mark.value}` } }).catch(() => null);
    if (here) expect((await here.json().catch(() => ({}))).error).not.toBe('sign_in_started_elsewhere');
  });

  test('a social sign-in marks the browser that started it, Lax, before leaving for the provider', async ({ page, context }) => {
    await page.goto(`/oidc/google/start?aud=demo-sso&redirect_uri=${encodeURIComponent(`${HOME}/`)}`);
    const c = await cookieNamed(context, 'ap_login');
    expect(c?.httpOnly).toBe(true);
    expect(c?.sameSite).toBe('Lax');
    expect(page.url()).toContain('accounts.google.com');
  });
});

test.describe('a person who allowed the app', () => {
  test('passes with no sheet and no new delegation, and the code exchanges for the same wires', async ({ page, request }) => {
    const s = await signIn(page);
    await allow(page, s);
    const before = await rowOf(request, s.agent);
    const posted: string[] = [];
    page.on('request', (r) => { if (r.method() === 'POST') posted.push(new URL(r.url()).pathname); });
    const { verifier, challenge } = pkce();
    await page.goto(enrollUrl(challenge));
    await returnedTo(page);
    const u = new URL(page.url());
    expect(u.searchParams.get('state')).toBe('st');
    const code = u.searchParams.get('code')!;
    expect(code).toBeTruthy();
    expect(posted).toContain('/oidc/remembered');
    expect(posted).not.toContain('/oidc/grant');
    expect(posted).not.toContain('/oidc/authorize-grant');

    const t = await request.post('/token', { data: { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: READER, redirect_uri: READER_URL } });
    expect(t.status(), await t.text()).toBe(200);
    const b = await t.json();
    expect(b.delegation).toEqual(before!.delegation);
    expect(b.askDelegation).toEqual(before!.askDelegation);
    expect(b.id_token).toBeTruthy();
    const again = await request.post('/token', { data: { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: READER, redirect_uri: READER_URL } });
    expect(again.status()).toBe(400);

    const after = await rowOf(request, s.agent);
    expect(after!.lastUsedAt).toBeGreaterThanOrEqual(before!.lastUsedAt);
    expect(after!.delegation).toEqual(before!.delegation);
    expect(after!.superseded ?? []).toEqual([]);
    expect(JSON.parse((await kvGet(request, `remembered-log:${s.agent.toLowerCase()}`))!)[0].clientId).toBe(READER);
  });

  test('the code will not exchange under another verifier', async ({ page, request }) => {
    const s = await signIn(page);
    await allow(page, s);
    const { challenge } = pkce();
    await page.goto(enrollUrl(challenge));
    await returnedTo(page);
    const code = new URL(page.url()).searchParams.get('code')!;
    const t = await request.post('/token', { data: { grant_type: 'authorization_code', code, code_verifier: pkce().verifier, client_id: READER, redirect_uri: READER_URL } });
    expect(t.status()).toBe(400);
  });

  test('its id_token is not a Home session: refused at /me/profile and at FedCM', async ({ page, request, playwright }) => {
    const s = await signIn(page);
    await allow(page, s);
    const { verifier, challenge } = pkce();
    await page.goto(enrollUrl(challenge));
    await returnedTo(page);
    const code = new URL(page.url()).searchParams.get('code')!;
    const { id_token } = await (await request.post('/token', { data: { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: READER, redirect_uri: READER_URL } })).json();
    expect((await request.get('/me/profile', { headers: { authorization: `Bearer ${id_token}` } })).status()).toBe(401);
    const bare = await playwright.request.newContext({ baseURL: HOME });
    const f = await bare.get('/fedcm/accounts', { headers: { 'sec-fetch-dest': 'webidentity', cookie: `ap_sso=${encodeURIComponent(JSON.stringify({ t: id_token, v: 'x' }))}` } });
    expect(f.status()).toBe(401);
    expect((await f.json()).reason).toBe('session_verify_failed:not_a_home_session');
    const real = await bare.get('/fedcm/accounts', { headers: { 'sec-fetch-dest': 'webidentity', cookie: `ap_sso=${encodeURIComponent(JSON.stringify({ t: s.token, v: 'x' }))}` } });
    expect(real.status()).toBe(200);
    await bare.dispose();
  });
});

test.describe('the ways back to the sheet', () => {
  const sees = async (page: Page, url: string) => { await page.goto(url); await expect(page.getByText(SHEET).first()).toBeVisible(); expect(page.url()).toContain('localhost'); };

  test('never allowed: the sheet, saying everything the app may do', async ({ page }) => {
    await signIn(page);
    await sees(page, enrollUrl(pkce().challenge));
    await expect(page.getByText(/Ask your agent questions as you/)).toBeVisible();
    await expect(page.getByText(/Read your profile/)).toBeVisible();
    await expect(page.getByText(/name you go by/)).toBeVisible();
  });

  test('a wire revoked on chain', async ({ page, request }) => {
    const s = await signIn(page);
    await allow(page, s);
    const list = await (await request.get('/connect/app-grants', { headers: { authorization: `Bearer ${s.token}` } })).json();
    await chain(request, { revoke: list.grants[0].ask.ref });
    await sees(page, enrollUrl(pkce().challenge));
  });

  test('a signature that no longer verifies', async ({ page, request }) => {
    const s = await signIn(page);
    await allow(page, s);
    await chain(request, { invalidSignature: true });
    await sees(page, enrollUrl(pkce().challenge));
  });

  test('a chain that cannot be read', async ({ page, request }) => {
    const s = await signIn(page);
    await allow(page, s);
    await chain(request, { revocationDown: true });
    const answer = page.waitForResponse('**/oidc/remembered');
    await page.goto(enrollUrl(pkce().challenge));
    expect((await (await answer).json()).consent_required).toBe('chain_unavailable');
    await expect(page.getByText(SHEET).first()).toBeVisible();
  });

  test('a registry asking for more: the sheet says so, and marks what is new', async ({ page, request }) => {
    const s = await signIn(page);
    await allow(page, s);
    const key = `app-grants:${s.agent.toLowerCase()}`;
    const rows = JSON.parse((await kvGet(request, key))!);
    rows[0].terms.ask = false; delete rows[0].terms.delegates.ask;
    await kvPut(request, key, JSON.stringify(rows));
    await sees(page, enrollUrl(pkce().challenge));
    await expect(page.getByText(/is asking for more/)).toBeVisible();
    await expect(page.locator('.consent-list.can li', { hasText: 'Ask your agent' })).toContainText('(new)');
    await expect(page.locator('.consent-list.can li', { hasText: 'name you go by' })).not.toContainText('(new)');
  });

  test('a chain that is down altogether: nothing passes, and the person is asked for a credential', async ({ page, request }) => {
    const s = await signIn(page);
    await allow(page, s);
    await chain(request, { down: true });
    await page.goto(enrollUrl(pkce().challenge));
    await expect(page.getByText(/wallet|passkey|Google/i).first()).toBeVisible();
    expect(page.url()).toContain('localhost');
  });

  test('a pin for someone else', async ({ page, request }) => {
    const s = await signIn(page);
    await allow(page, s);
    await chain(request, { name: 'ruth.me' });
    const answer = page.waitForResponse('**/oidc/remembered', { timeout: 15_000 }).catch(() => null);
    await page.goto(enrollUrl(pkce().challenge, { agent_name: 'naomi.me' }));
    // The page itself catches a pin that is not the session's, and asks who: either way, nothing passes.
    await answer;
    await expect(page.getByText(SHEET).or(page.getByText(/wallet|passkey|Google/i)).first()).toBeVisible();
    expect(page.url()).toContain('localhost');
  });

  test('a pin for this person passes, and the token carries the name from the chain', async ({ page, request }) => {
    const s = await signIn(page);
    await allow(page, s);
    await chain(request, { name: 'ruth.me' });
    const { verifier, challenge } = pkce();
    await page.goto(enrollUrl(challenge, { agent_name: 'ruth.me' }));
    await page.waitForURL((u) => u.href.startsWith(READER_URL) || u.hostname.startsWith('ruth.'), { timeout: 40_000 });
    const code = new URL(page.url()).searchParams.get('code')!;
    const b = await (await request.post('/token', { data: { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: READER, redirect_uri: READER_URL } })).json();
    expect(JSON.parse(Buffer.from(b.id_token.split('.')[1], 'base64url').toString()).agent_name).toBe('ruth.me');
  });

  test('prompt=consent', async ({ page }) => {
    const s = await signIn(page);
    await allow(page, s);
    await sees(page, enrollUrl(pkce().challenge, { prompt: 'consent' }));
  });

  for (const prompt of ['login', 'select_account']) {
    test(`prompt=${prompt}, naming no Home: asks for a credential, then shows the sheet, and does not loop`, async ({ page, context }) => {
      const s = await signIn(page);
      await allow(page, s);
      const url = enrollUrl(pkce().challenge, { prompt });
      await page.goto(url);
      await expect(page.getByRole('button', { name: /Continue with Google/i })).toBeVisible();
      await expect.poll(async () => cookieNamed(context, 'ap_sid')).toBeUndefined();
      // And it stays: nothing pulls them back onto the sheet, or through to the app, without a credential.
      await page.waitForTimeout(4000);
      await expect(page.getByRole('button', { name: /Continue with Google/i })).toBeVisible();
      await expect(page.getByText(SHEET)).toHaveCount(0);
      expect(page.url()).toContain('localhost');
      // They prove a credential: a new session and a new cookie. The chooser has been answered, and the app still gets no code without the sheet.
      const again = await signIn(page);
      await allow(page, again);
      const answer = page.waitForResponse('**/oidc/remembered');
      await page.goto(url);
      expect((await (await answer).json()).consent_required).toBe('prompt_login');
      await expect(page.getByText(SHEET).first()).toBeVisible();
      expect(page.url()).toContain('localhost');
    });
  }

  test('prompt=login naming a Home: asks who, and ends the recognition', async ({ page, context, request }) => {
    const s = await signIn(page);
    await allow(page, s);
    await chain(request, { name: 'ruth.me' });
    await page.goto(enrollUrl(pkce().challenge, { prompt: 'login', agent_name: 'ruth.me' }));
    await expect.poll(async () => cookieNamed(context, 'ap_sid')).toBeUndefined();
    expect(page.url()).toContain('localhost');
  });

  test('a request through a host', async ({ page }) => {
    const s = await signIn(page);
    await allow(page, s);
    await sees(page, enrollUrl(pkce().challenge, { via_host: 'Claude' }));
  });

  test('a request with a session key', async ({ page }) => {
    const s = await signIn(page);
    await allow(page, s);
    await sees(page, enrollUrl(pkce().challenge, { session_key: '0x1111111111111111111111111111111111111111' }));
  });

  test('ask me every time', async ({ page, request }) => {
    const s = await signIn(page);
    await allow(page, s);
    const r = await request.post('/connect/app-grants', { headers: { authorization: `Bearer ${s.token}` }, data: { clientId: READER, askEveryTime: true } });
    expect(r.status()).toBe(200);
    await sees(page, enrollUrl(pkce().challenge));
  });

  test('forget this app: the sheet returns, and the wires stay listed', async ({ page, request }) => {
    const s = await signIn(page);
    await allow(page, s);
    await request.post('/connect/app-grants', { headers: { authorization: `Bearer ${s.token}` }, data: { clientId: READER, forget: true } });
    await sees(page, enrollUrl(pkce().challenge));
    const row = await rowOf(request, s.agent);
    expect(row!.terms).toBeUndefined();
    expect(row!.delegation).toBeTruthy();
  });

  test('a session that has come apart from the cookie: the page shows the sheet, for the person it names', async ({ page, browser }) => {
    const a = await signIn(page);
    await allow(page, a);
    const other = await browser.newContext();
    await offline(other);
    const b = await signIn(await other.newPage());
    await other.close();
    await hold(page, b); // this browser's cookie is still A's
    const answer = page.waitForResponse('**/oidc/remembered');
    await page.goto(enrollUrl(pkce().challenge));
    expect((await (await answer).json()).consent_required).toBe('session_mismatch');
    await expect(page.getByText(SHEET).first()).toBeVisible();
  });

  test('"Not you?" while the Home decides: no code is delivered, and the cookie is ended', async ({ page, context }) => {
    const s = await signIn(page);
    await allow(page, s);
    await page.route('**/oidc/remembered', async (route) => { await new Promise((r) => setTimeout(r, 4000)); await route.continue(); });
    await page.goto(enrollUrl(pkce().challenge));
    await expect(page.getByText(/Signing you in to/)).toBeVisible();
    await page.getByRole('button', { name: 'Not you?' }).click();
    await expect(page.getByText(/wallet|passkey|Google/i).first()).toBeVisible();
    await expect.poll(async () => cookieNamed(context, 'ap_sid')).toBeUndefined();
    await page.waitForTimeout(5000);
    expect(page.url()).toContain('localhost');
  });
});

test.describe('consent cannot be forged', () => {
  test('a held wire replayed at /oidc/grant with no cookie remembers nothing', async ({ page, playwright, request }) => {
    const s = await signIn(page);
    const { challenge } = pkce();
    const attacker = await playwright.request.newContext({ baseURL: HOME, extraHTTPHeaders: { origin: HOME } });
    const g = await (await attacker.post('/oidc/authorize-grant', { data: { client_id: READER, redirect_uri: READER_URL, code_challenge: challenge, code_challenge_method: 'S256', delegation_template: 'site-login', nonce: 'n', agent_name: '' } })).json();
    const r = await attacker.post('/oidc/grant', { data: { grant_id: g.grant_id, delegation: wireOf(s.agent, SITE, siteCaveats(inDays(365))) } });
    expect(r.status(), await r.text()).toBe(200);
    const row = await rowOf(request, s.agent);
    expect(row!.delegation).toBeTruthy();
    expect(row!.terms).toBeUndefined();
    await attacker.dispose();
    await page.goto(enrollUrl(pkce().challenge));
    await expect(page.getByText(SHEET).first()).toBeVisible();
  });

  test('an Allow that replaces another keeps the older wire listed, whole', async ({ page, request }) => {
    const s = await signIn(page);
    await allow(page, s);
    const first = await rowOf(request, s.agent);
    await allow(page, s);
    const second = await rowOf(request, s.agent);
    expect(second!.delegation).not.toEqual(first!.delegation);
    expect((second!.superseded as Array<{ kind: string; wire: unknown }>).map((x) => x.kind).sort()).toEqual(['ask', 'site']);
    expect((second!.superseded as Array<{ kind: string; wire: unknown }>).find((x) => x.kind === 'site')!.wire).toEqual(first!.delegation);
  });
});

test.describe('silent sign-in', () => {
  const errorOf = (page: Page) => new URL(page.url()).searchParams.get('error');

  test('with no session: login_required', async ({ page }) => {
    await page.goto(enrollUrl(pkce().challenge, { prompt: 'none' }));
    await returnedTo(page);
    expect(errorOf(page)).toBe('login_required');
  });

  test('allowed, but the app names nobody: the same answer', async ({ page }) => {
    const s = await signIn(page);
    await allow(page, s);
    await page.goto(enrollUrl(pkce().challenge, { prompt: 'none' }));
    await returnedTo(page);
    expect(errorOf(page)).toBe('login_required');
    expect(new URL(page.url()).searchParams.get('code')).toBeNull();
  });

  test('the app names someone else: the same answer', async ({ page }) => {
    const s = await signIn(page);
    await allow(page, s);
    await page.goto(enrollUrl(pkce().challenge, { prompt: 'none', login_hint: '0x1111111111111111111111111111111111111111' }));
    await returnedTo(page);
    expect(errorOf(page)).toBe('login_required');
  });

  test('never allowed, named correctly: the same answer', async ({ page }) => {
    const s = await signIn(page);
    await page.goto(enrollUrl(pkce().challenge, { prompt: 'none', login_hint: s.agent }));
    await returnedTo(page);
    expect(errorOf(page)).toBe('login_required');
  });

  test('allowed, and the app names this person: a code, and nothing on screen to click', async ({ page }) => {
    const s = await signIn(page);
    await allow(page, s);
    await page.goto(enrollUrl(pkce().challenge, { prompt: 'none', login_hint: s.agent }));
    await returnedTo(page);
    expect(new URL(page.url()).searchParams.get('code')).toBeTruthy();
    expect(errorOf(page)).toBeNull();
  });
});

test.describe('rollout', () => {
  const SHADOW = 'skills-app';
  const SHADOW_URL = 'https://skills.faithnet.io/';

  test('an app in shadow decides and counts, and still shows the sheet', async ({ page, request }) => {
    const s = await signIn(page);
    await allow(page, s, SHADOW, SHADOW_URL, null);
    const answer = page.waitForResponse('**/oidc/remembered');
    await page.goto(enrollUrl(pkce().challenge, {}, SHADOW, SHADOW_URL));
    expect(await (await answer).json()).toMatchObject({ consent_required: 'shadow', would: 'allow' });
    await expect(page.getByText(SHEET).first()).toBeVisible();
    await expect(page.getByText(/Signing you in to/)).toHaveCount(0);
    const keys = (await (await request.post(`${BACK}/__kv/keys`, { data: { prefix: 'remembered-stat:' } })).json()).keys as string[];
    expect(keys.some((k) => k.endsWith(`:${SHADOW}:shadow:allow`))).toBe(true);
  });

  test('an app left off shows the sheet, promises nothing, reads no chain, and is counted', async ({ page, request }) => {
    const s = await signIn(page);
    const OFF = 'town-app';
    const URL_OFF = 'https://town.faithnet.io/connected';
    await allow(page, s, OFF, URL_OFF, null);
    const answer = page.waitForResponse('**/oidc/remembered');
    await page.goto(enrollUrl(pkce().challenge, {}, OFF, URL_OFF));
    expect((await (await answer).json()).consent_required).toBe('client_not_enabled');
    await expect(page.getByText(SHEET).first()).toBeVisible();
    const keys = (await (await request.post(`${BACK}/__kv/keys`, { data: { prefix: 'remembered-stat:' } })).json()).keys as string[];
    expect(keys.some((k) => k.endsWith(`:${OFF}:off:would_check_chain`))).toBe(true);
  });
});

test.describe('FedCM, with real tokens', () => {
  const APP = 'skills-app';
  const APP_ORIGIN = 'https://skills.faithnet.io';
  const sub = (token: string) => (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as { sub: string }).sub;

  /** What the browser's FedCM asks for, as a relying app's page would, with a Home session in the cookie. */
  async function fedcmGrant(request: APIRequestContext, token: string, client = APP, origin = APP_ORIGIN) {
    const cookie = `ap_sso=${encodeURIComponent(JSON.stringify({ t: token, v: 'x' }))}`;
    const a = await request.post('/fedcm/assertion', { headers: { origin, 'sec-fetch-dest': 'webidentity', cookie }, form: { client_id: client, nonce: randomBytes(8).toString('hex'), account_id: sub(token), disclosure_text_shown: 'true' } });
    expect(a.status(), await a.text()).toBe(200);
    const { token: id_token } = await a.json();
    return request.post('/fedcm/grant', { headers: { origin, cookie }, data: { id_token, client_id: client } });
  }
  /** A session as a Google sign-in mints one for a person whose key the Home holds, signed by this build's real key. */
  async function custodial() {
    const person = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    const signer = await signerFromPrivateJwk(JSON.parse(readFileSync(join(import.meta.dirname, 'artifacts/broker.jwk'), 'utf8')), 'broker-1');
    const token = await mintAgentSession({ sub: `eip155:34348:${person}` as never, principal: { kind: 'oidc', id: 'oidc:x', assurance: 'onchain-confirmed', role: 'custody-grade' } as never, assurance: 'onchain-confirmed', aud: 'demo-sso', iss: HOME, ttlSeconds: 3600 }, signer);
    return { person, token };
  }
  const storeAllow = async (request: APIRequestContext, person: string, over: object = {}) => {
    const terms = termsFor(getClient(APP)!, 'site-login');
    const delegation = wireOf(person, SITE, siteCaveats(inDays(365)));
    await kvPut(request, `app-grants:${person}`, JSON.stringify([{ v: 2, clientId: APP, template: 'site-login', delegate: SITE, delegation, issuedAt: 1, terms, termsDigest: termsDigest(terms), origins: [APP_ORIGIN], ...over }]));
    return delegation;
  };

  test('a Home-held key, never allowed: no delegation, and the popup', async ({ request }) => {
    const { token } = await custodial();
    const b = await (await fedcmGrant(request, token)).json();
    expect(b).toMatchObject({ needs_device_credential: true, consent_required: 'no_record' });
    expect(b.delegation).toBeUndefined();
  });

  test('a Home-held key, allowed: the stored wire, and nothing new is signed', async ({ request }) => {
    const { person, token } = await custodial();
    const stored = await storeAllow(request, person);
    const b = await (await fedcmGrant(request, token)).json();
    expect(b.delegation).toEqual(stored);
  });

  test('a Home-held key, the wire revoked: the popup', async ({ request }) => {
    const { person, token } = await custodial();
    await storeAllow(request, person);
    const list = await (await request.get('/connect/app-grants', { headers: { authorization: `Bearer ${token}` } })).json();
    await chain(request, { revoke: list.grants[0].ref });
    expect((await (await fedcmGrant(request, token)).json()).consent_required).toBe('wire_revoked');
  });

  test('a Home-held key, ask me every time: the popup', async ({ request }) => {
    const { person, token } = await custodial();
    await storeAllow(request, person, { askEveryTime: true });
    expect((await (await fedcmGrant(request, token)).json()).consent_required).toBe('ask_every_time');
  });

  test('a wallet person is sent to the popup, whatever they allowed: a token alone never collects their wires', async ({ page, request }) => {
    const s = await signIn(page);
    await storeAllow(request, s.agent.toLowerCase());
    const b = await (await fedcmGrant(request, s.token)).json();
    expect(b.needs_device_credential).toBe(true);
    expect(b.consent_required).toBeUndefined();
    expect(b.delegation).toBeUndefined();
  });
});

test.describe('the person\'s own pages', () => {
  test('Connected Apps lists what was agreed and the older wires, and its controls work', async ({ page, request }) => {
    const s = await signIn(page);
    await allow(page, s);
    await allow(page, s);
    await page.goto('/apps/signed-in');
    const card = page.getByTestId(`app-grant-${READER}`);
    await expect(card).toBeVisible({ timeout: 40_000 });
    await expect(card.getByText(/Ask your agent questions as you/)).toBeVisible();
    await expect(page.getByTestId(`app-grant-others-${READER}`).getByText(/An older permission, still live/)).toHaveCount(2);
    await expect(card).toContainText(/until \w+ \d+, 20\d\d/);
    await page.getByTestId(`app-grant-ask-every-time-${READER}`).check();
    await expect.poll(async () => (await rowOf(request, s.agent))!.askEveryTime).toBe(true);
    await page.getByTestId(`app-grant-forget-${READER}`).click();
    await expect.poll(async () => (await rowOf(request, s.agent))!.terms).toBeUndefined();
    await expect(card).toBeVisible();
  });

  test('Activity lists a sign-in that passed: no new permission', async ({ page }) => {
    const s = await signIn(page);
    await allow(page, s);
    await page.goto(enrollUrl(pkce().challenge));
    await returnedTo(page);
    await page.goto('/activities');
    await expect(page.getByText(/No new permission/).first()).toBeVisible({ timeout: 40_000 });
    await page.goto('/apps/signed-in');
    await expect(page.getByText(/Seed Bible Reader/).first()).toBeVisible({ timeout: 40_000 });
  });
});

