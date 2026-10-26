import { describe, it, expect, beforeAll } from 'vitest';
import { generateBrokerKeypair, mintAgentSession } from '@agenticprimitives/connect';
import { resolveOrigin } from '../_lib/origin';
import { onRequestPost, onRequestGet, proposalFields } from './profile-proposal';
import { onRequestPost as sessionToken } from './session-token';

// A profile change an app proposes (an app may read the profile, never write it): the reader leaves the change under
// the person's id_token; only that person's Home session reads it back, for the Home to save on their yes.
const RUTH = '0x1111111111111111111111111111111111111111';
const BOAZ = '0x2222222222222222222222222222222222222222';
const NAOMI = '0x3333333333333333333333333333333333333333';
const base = 'https://home.test/connect/profile-proposal';
const READER = 'https://seed-reader.faithnet.io';

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
const sessions: Record<string, string> = {};

async function homeSession(sa: string): Promise<string> {
  const { getServer } = await import('../_lib/server-broker');
  const { signer } = await getServer(env);
  return mintAgentSession(
    {
      sub: `eip155:84532:${sa}` as any,
      principal: { kind: 'siwe-eoa', id: sa, assurance: 'onchain-confirmed', role: 'custody-grade' } as any,
      assurance: 'onchain-confirmed',
      aud: 'demo-sso',
      iss,
      ttlSeconds: 3600,
    },
    signer,
  );
}

/** The id_token the reader holds after its sign-in — minted through the Home's own session-token seam. */
async function readerIdToken(sa: string): Promise<string> {
  const res = await sessionToken({
    request: new Request('https://home.test/connect/session-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${sessions[sa]}` },
      body: JSON.stringify({ client_id: 'seed-bible-reader', as: sa }),
    }),
    env,
  } as any);
  return ((await res.json()) as { id_token: string }).id_token;
}

const post = (body: unknown, bearer: string | null, origin?: string) =>
  onRequestPost({
    request: new Request(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
    }),
    env,
  } as any);
const get = (query: string, bearer: string | null) =>
  onRequestGet({ request: new Request(`${base}${query}`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} }), env } as any);

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
  for (const sa of [RUTH, BOAZ, NAOMI]) sessions[sa] = await homeSession(sa);
});

const PHOTO = 'data:image/jpeg;base64,' + 'A'.repeat(64);

describe('/connect/profile-proposal', () => {
  it('refuses without a sign-in, and a proposal with nothing in it', async () => {
    expect((await post({ firstName: 'Ruth' }, null)).status).toBe(401);
    expect((await post({}, await readerIdToken(RUTH))).status).toBe(400);
  });

  it('the reader proposes; only the same person, at their Home, reads it back', async () => {
    const res = await post({ firstName: ' Ruth ', lastName: 'Miller', photo: PHOTO, email: 'not@taken.org' }, await readerIdToken(RUTH), READER);
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    // the app cannot read it back — only the Home's own session
    expect((await get(`?token=${token}`, await readerIdToken(RUTH))).status).toBe(401);
    // someone else's Home session cannot read it
    expect((await get(`?token=${token}`, sessions[BOAZ]!)).status).toBe(403);
    const back = await get(`?token=${token}`, sessions[RUTH]!);
    expect(back.status).toBe(200);
    expect(await back.json()).toMatchObject({
      ok: true,
      client: 'seed-bible-reader',
      fields: { firstName: 'Ruth', lastName: 'Miller', photo: PHOTO },
    });
  });

  it('takes only names and a photo in the form the profile holds', () => {
    expect(proposalFields({ photo: 'https://evil.example/x.png' })).toEqual({ error: expect.stringMatching(/JPEG, PNG or WebP/) });
    expect(proposalFields({ firstName: 3 })).toEqual({ error: 'firstName must be text' });
    expect(proposalFields({ photo: null })).toEqual({ photo: null });
    expect(proposalFields({ firstName: 'x'.repeat(200) })).toEqual({ firstName: 'x'.repeat(80) });
  });

  it('an unknown or expired token is said so', async () => {
    expect((await get(`?token=${'a'.repeat(40)}`, sessions[RUTH]!)).status).toBe(404);
    expect((await get('?token=nope', sessions[RUTH]!)).status).toBe(400);
  });
});
