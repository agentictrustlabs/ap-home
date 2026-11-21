// /connect/session-token: an app's token mints for that app only; a Home session still mints for any registered client.
import { describe, expect, it, vi } from 'vitest';
import { generateBrokerKeypair, mintAgentSession, mintIdToken, publishJwks } from '@agenticprimitives/connect';

const ISS = 'https://home.test';
const SA = '0x0569d24a04cddbd3d530f6d7f7513f99c52e65c2';
const SUB = `eip155:34348:${SA}` as Parameters<typeof mintIdToken>[0]['sub'];
const signer = await generateBrokerKeypair();
const jwks = await publishJwks([signer]);

vi.mock('../_lib/server-broker', () => ({
  getServer: async () => ({ jwks, signer, directory: { agent: async () => null } }),
  ownIssuer: () => (iss: string) => iss === ISS,
  resolveOrigin: () => ISS,
}));
vi.mock('../_lib/oidc-registry', async (orig) => ({
  ...(await orig<typeof import('../_lib/oidc-registry')>()),
  resolveClient: async (_e: unknown, id: string) => (['gather-app', 'other-app'].includes(id) ? { clientId: id } : null),
}));

import { onRequestPost } from './session-token';

const post = (token: string, client_id: string) =>
  onRequestPost({ request: new Request(`${ISS}/connect/session-token`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ client_id }) }), env: { DEMO_SSO_AUD: 'demo-sso' } } as never);
const audOf = (jwt: string) => JSON.parse(atob(jwt.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))).aud;

describe('/connect/session-token', () => {
  it('REFUSES to turn one app’s token into another app’s', async () => {
    const appToken = await mintIdToken({ iss: ISS, sub: SUB, aud: 'other-app', ttlSeconds: 600, nonce: 'n' }, signer);
    const r = await post(appToken, 'gather-app');
    expect(r.status).toBe(403);
    expect(await r.json()).not.toHaveProperty('id_token');
  });
  it('renews an app’s token for the same app', async () => {
    const appToken = await mintIdToken({ iss: ISS, sub: SUB, aud: 'gather-app', ttlSeconds: 600, nonce: 'n' }, signer);
    const r = await post(appToken, 'gather-app');
    expect(r.status).toBe(200);
    expect(audOf(((await r.json()) as { id_token: string }).id_token)).toBe('gather-app');
  });
  it('mints for any registered client from the person’s Home session', async () => {
    const session = await mintAgentSession({ sub: SUB, principal: { kind: 'email', id: 'h', assurance: 'asserted', role: 'login-grade' }, assurance: 'asserted', aud: 'demo-sso', iss: ISS, ttlSeconds: 120 } as Parameters<typeof mintAgentSession>[0], signer);
    const r = await post(session, 'other-app');
    expect(r.status).toBe(200);
    expect(audOf(((await r.json()) as { id_token: string }).id_token)).toBe('other-app');
  });
  it('refuses an unregistered client and a junk token', async () => {
    const appToken = await mintIdToken({ iss: ISS, sub: SUB, aud: 'gather-app', ttlSeconds: 600 }, signer);
    expect((await post(appToken, 'nobody')).status).toBe(400);
    expect((await post('not-a-jwt', 'gather-app')).status).toBe(401);
  });
});
