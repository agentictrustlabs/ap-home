import { describe, it, expect, beforeAll } from 'vitest';
import { generateBrokerKeypair, importJwks, mintAgentSession, verifyAgentSession } from '@agenticprimitives/connect';
import { resolveOrigin } from '../_lib/origin';
import { onRequestPost } from './session-token';

// Spec 426 §5 — the production session seam. A Home session (the same JWT /connect/demo-signin and the
// portal mint) becomes an id_token for the session's OWN agent at ONE registered client. Self-contained:
// getServer(env)'s own signer, no custody URL, a KV stub.
const SA = '0x1111111111111111111111111111111111111111';
const url = 'https://home.test/connect/session-token';

function makeKV() {
  const m = new Map<string, string>();
  return {
    async get(k: string) { return m.get(k) ?? null; },
    async put(k: string, v: string) { m.set(k, v); },
    async delete(k: string) { m.delete(k); },
    async list() { return { keys: [...m.keys()].map((name) => ({ name })), list_complete: true }; },
  };
}

let env: any;
let token: string;
let iss: string;

async function mint(aud: string, sa: string = SA): Promise<string> {
  const { getServer } = await import('../_lib/server-broker');
  const { signer } = await getServer(env);
  return mintAgentSession(
    {
      sub: `eip155:84532:${sa}` as any,
      principal: { kind: 'siwe-eoa', id: sa, assurance: 'onchain-confirmed', role: 'custody-grade' } as any,
      assurance: 'onchain-confirmed',
      aud,
      iss,
      ttlSeconds: 3600,
    },
    signer,
  );
}

beforeAll(async () => {
  const kp = await generateBrokerKeypair('ES256');
  const privateJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  env = {
    AUTH_CODES: makeKV(),
    BROKER_PRIVATE_JWK: JSON.stringify(privateJwk),
    BROKER_KID: 'test-broker',
    DEMO_SSO_AUD: 'demo-sso',
    RPC_URL: 'http://localhost:0',
  };
  iss = resolveOrigin(new Request(url), env);
  token = await mint('demo-sso');
});

const post = (body: unknown, bearer: string | null = token) =>
  onRequestPost({
    request: new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
    }),
    env,
  } as any);

describe('/connect/session-token — spec 426 §5 production seam', () => {
  it('refuses without a session', async () => {
    const res = await post({ client_id: 'gc-engage' }, null);
    expect(res.status).toBe(401);
  });

  it('refuses an unregistered client and a missing client_id', async () => {
    expect((await post({ client_id: 'not-a-client' })).status).toBe(400);
    expect((await post({})).status).toBe(400);
  });

  it('refuses a session it cannot verify', async () => {
    const res = await post({ client_id: 'gc-engage' }, token.slice(0, -4) + 'xxxx');
    expect(res.status).toBe(401);
  });

  it('mints an id_token for the session’s own agent at the named client, verifiable against the broker JWKS', async () => {
    const res = await post({ client_id: 'gc-engage', as: SA });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id_token: string; sub: string; aud: string; expires_in: number };
    expect(body.aud).toBe('gc-engage');
    expect(body.sub.toLowerCase()).toBe(`eip155:84532:${SA}`);
    expect(body.expires_in).toBe(3600);
    const { getServer } = await import('../_lib/server-broker');
    const { jwks } = await getServer(env);
    const v = await verifyAgentSession(body.id_token, { keys: await importJwks(jwks), expectedAud: 'gc-engage', expectedIss: iss });
    expect(v.ok).toBe(true);
  });

  it('refuses to mint AS another agent — self-acting only', async () => {
    const res = await post({ client_id: 'gc-engage', as: '0x2222222222222222222222222222222222222222' });
    expect(res.status).toBe(403);
  });

  it('accepts a registered relying app’s id_token as the session too (the runtime may hold one)', async () => {
    const appToken = await mint('skills-app');
    const res = await post({ client_id: 'gc-platform' }, appToken);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { aud: string }).aud).toBe('gc-platform');
  });
});
