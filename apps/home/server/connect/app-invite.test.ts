import { describe, it, expect, beforeAll } from 'vitest';
import { generateBrokerKeypair, mintIdToken } from '@agenticprimitives/connect';
import { resolveOrigin } from '../_lib/origin';
import { getServer } from '../_lib/server-broker';
import { onRequestPost } from './app-invite';
import { callerFromInviteAuth } from './org-invite';

// The app-invite MAILER and the login token a registered app holds after its people sign in with their own Home
// (social or passkey). That token carries its flow's nonce. Spec 445 D5 refuses a nonce-bearing id_token as an API
// bearer; the mailer opts in to a FRESH login token, because it only mails a link on an origin registered for that
// same client. Every other caller of callerFromInviteAuth (org membership) keeps D5.
const PERSON = '0x3a7bc77ef3d65f2c520cd56cd76c2e1423f20753';
const base = 'https://home.test/connect/app-invite/email';
const WORKBENCH = 'https://isl-workbench.faithnet.io/#/invite/abc';

function makeKV() {
  const m = new Map<string, string>();
  return {
    m,
    async get(k: string) { return m.get(k) ?? null; },
    async put(k: string, v: string) { m.set(k, v); },
    async delete(k: string) { m.delete(k); },
    async list() { return { keys: [...m.keys()].map((name) => ({ name })), list_complete: true }; },
  };
}

let env: any;
let iss: string;

async function idToken(opts: { nonce?: string; ageSec?: number; aud?: string } = {}): Promise<string> {
  const { signer } = await getServer(env);
  const now = Date.now() - (opts.ageSec ?? 0) * 1000;
  return mintIdToken(
    { iss, sub: `eip155:34348:${PERSON}` as any, aud: opts.aud ?? 'skills-app', ttlSeconds: 7200, ...(opts.nonce ? { nonce: opts.nonce } : {}), now: () => now },
    signer,
  );
}

const post = (body: unknown, bearer: string | null) =>
  onRequestPost({
    request: new Request(base, { method: 'POST', headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) }),
    env,
  } as any);
const caller = (bearer: string, opts?: Parameters<typeof callerFromInviteAuth>[2]) =>
  callerFromInviteAuth(env, new Request(base, { method: 'POST', headers: { authorization: `Bearer ${bearer}` } }), opts);

beforeAll(async () => {
  const kp = await generateBrokerKeypair('ES256');
  env = {
    AUTH_CODES: makeKV(),
    BROKER_PRIVATE_JWK: JSON.stringify(await crypto.subtle.exportKey('jwk', kp.privateKey)),
    BROKER_KID: 'test-broker',
    DEMO_SSO_AUD: 'demo-sso',
    RPC_URL: 'http://localhost:0',
  };
  iss = resolveOrigin(new Request(base), env);
});

describe('/connect/app-invite/email and the login token', () => {
  it('a token with no nonce is accepted, as before', async () => {
    const r = await post({ email: 'reader@example.org', returnUrl: WORKBENCH, name: 'ISL evaluation workbench' }, await idToken());
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true });
  });

  it("a fresh LOGIN token (the app's sign-in, with its nonce) is accepted by the mailer", async () => {
    const r = await post({ email: 'reader@example.org', returnUrl: WORKBENCH, name: 'ISL evaluation workbench' }, await idToken({ nonce: 'n-123', ageSec: 120 }));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, appName: 'Skills' });
  });

  it('a STALE login token is refused (older than an hour)', async () => {
    const r = await post({ email: 'reader@example.org', returnUrl: WORKBENCH }, await idToken({ nonce: 'n-123', ageSec: 2 * 3600 }));
    expect(r.status).toBe(401);
  });

  it("the link must still be on an origin registered for the token's own client", async () => {
    const r = await post({ email: 'reader@example.org', returnUrl: 'https://elsewhere.example/x' }, await idToken({ nonce: 'n-123', ageSec: 60 }));
    expect(r.status).toBe(400);
  });

  it('a token for an unknown client is refused', async () => {
    const r = await post({ email: 'reader@example.org', returnUrl: WORKBENCH }, await idToken({ nonce: 'n-123', aud: 'no-such-client' }));
    expect(r.status).toBe(401);
  });

  it('D5 still holds for every other caller: org membership refuses a login token, takes a nonce-less one', async () => {
    expect(await caller(await idToken({ nonce: 'n-123', ageSec: 60 }))).toBeNull();
    expect(await caller(await idToken())).toMatchObject({ person: PERSON, clientId: 'skills-app' });
    expect(await caller(await idToken({ nonce: 'n-123', ageSec: 60 }), { acceptLoginToken: true })).toMatchObject({ person: PERSON, clientId: 'skills-app' });
  });
});
