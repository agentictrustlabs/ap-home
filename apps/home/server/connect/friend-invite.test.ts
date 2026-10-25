import { describe, it, expect, beforeAll } from 'vitest';
import { generateBrokerKeypair, mintAgentSession } from '@agenticprimitives/connect';
import { resolveOrigin } from '../_lib/origin';
import { onRequestPost, onRequestGet, keptSent } from './friend-invite';
import { onRequestPost as sessionToken } from './session-token';

// A friend invitation by email, from the Home or from inside an app (the reader's id_token): the inviter sees what
// they sent, the same address is not invited twice, and accepting marks who accepted rather than erasing it.
const RUTH = '0x1111111111111111111111111111111111111111';
const BOAZ = '0x2222222222222222222222222222222222222222';
const NAOMI = '0x3333333333333333333333333333333333333333';
const base = 'https://home.test/connect/friend-invite/email';
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

describe('/connect/friend-invite', () => {
  it('refuses without a sign-in', async () => {
    expect((await post({ email: 'boaz@example.org' }, null)).status).toBe(401);
  });

  it('from the reader: sent, listed for the inviter, and the same address again is the same invitation', async () => {
    const ruth = await readerIdToken(RUTH);
    const first = (await (await post({ email: 'Boaz@Example.org', fromName: 'Ruth' }, ruth, READER)).json()) as { ok: boolean; token: string };
    expect(first.ok).toBe(true);
    const again = (await (await post({ email: 'boaz@example.org' }, ruth, READER)).json()) as { token: string; again: boolean };
    expect(again).toMatchObject({ token: first.token, again: true });

    const list = (await (await get('', ruth)).json()) as { sent: Array<{ token: string; email: string; acceptedBy?: string }> };
    expect(list.sent).toEqual([expect.objectContaining({ token: first.token, email: 'boaz@example.org' })]);

    const looked = (await (await get(`?token=${first.token}`, null)).json()) as { from: string; fromName: string; accepted: boolean };
    expect(looked).toMatchObject({ from: RUTH, fromName: 'Ruth', accepted: false });
    // The stash keeps the address's hash, never the address.
    expect(env.AUTH_CODES.m.get(`friend-invite:${first.token}`)).not.toContain('boaz@');
  });

  it('accepting marks who accepted; nobody else can take it after; the inviter cannot accept their own', async () => {
    const res = (await (await post({ email: 'naomi@example.org' }, sessions[RUTH]!)).json()) as { token: string };
    expect((await post({ token: res.token, claim: true }, sessions[RUTH]!)).status).toBe(400);

    const claimed = (await (await post({ token: res.token, claim: true }, await readerIdToken(NAOMI))).json()) as { claimed: boolean; from: string };
    expect(claimed).toMatchObject({ claimed: true, from: RUTH });
    const taken = (await (await post({ token: res.token, claim: true }, sessions[BOAZ]!)).json()) as { claimed: boolean };
    expect(taken.claimed).toBe(false);

    const list = (await (await get('', sessions[RUTH]!)).json()) as { sent: Array<{ token: string; acceptedBy?: string }> };
    expect(list.sent.find((s) => s.token === res.token)?.acceptedBy).toBe(NAOMI);
    expect(((await (await get(`?token=${res.token}`, null)).json()) as { accepted: boolean }).accepted).toBe(true);
  });

  it('only the inviter can cancel or resend; a cancelled invitation is gone', async () => {
    const res = (await (await post({ email: 'orpah@example.org' }, sessions[BOAZ]!)).json()) as { token: string };
    expect((await post({ token: res.token, cancel: true }, sessions[RUTH]!)).status).toBe(404);
    expect((await post({ token: res.token, resend: true }, sessions[BOAZ]!)).status).toBe(200);
    expect((await post({ token: res.token, cancel: true }, sessions[BOAZ]!)).status).toBe(200);
    expect((await get(`?token=${res.token}`, null)).status).toBe(404);
    const list = (await (await get('', sessions[BOAZ]!)).json()) as { sent: unknown[] };
    expect(list.sent).toEqual([]);
  });
});

describe('keptSent', () => {
  it('drops expired open invitations and keeps accepted ones a while', () => {
    const now = Date.now();
    const day = 24 * 3600 * 1000;
    const kept = keptSent([
      { token: 'a', email: 'a@x.org', createdAt: now - 20 * day, expiresAt: now - 6 * day },
      { token: 'b', email: 'b@x.org', createdAt: now - 20 * day, expiresAt: now - 6 * day, acceptedBy: BOAZ, acceptedAt: now - 10 * day },
      { token: 'c', email: 'c@x.org', createdAt: now, expiresAt: now + 14 * day },
    ], now);
    expect(kept.map((s) => s.token)).toEqual(['b', 'c']);
  });
});
