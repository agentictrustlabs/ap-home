import { describe, it, expect, beforeAll, vi } from 'vitest';
import { generateBrokerKeypair, importJwks, mintIdToken } from '@agenticprimitives/connect';

// The registry is not under test: one registered relying client, `field-app`.
vi.mock('./oidc-registry', () => ({
  resolveClient: async (_env: unknown, id: string) => (id === 'field-app' ? { clientId: id } : null),
}));

import { bearerNonce, verifyIdTokenForRelyingClient } from './person-bearer';

const SA = '0x2222222222222222222222222222222222222222';
const ISS = 'https://www.home.test';
let signer: Parameters<typeof mintIdToken>[1];
let keys: Awaited<ReturnType<typeof importJwks>>;

beforeAll(async () => {
  const kp = await generateBrokerKeypair('ES256');
  signer = { kid: 'k1', alg: 'ES256', privateKey: kp.privateKey } as unknown as typeof signer;
  const pub = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
  keys = await importJwks({ keys: [pub] } as never);
});

const mint = (aud: string, nonce?: string) =>
  mintIdToken({ iss: ISS, sub: `eip155:34348:${SA}` as never, aud, ttlSeconds: 600, ...(nonce ? { nonce } : {}) }, signer);
const own = (iss: string) => iss === ISS;

describe('verifyIdTokenForRelyingClient — an id_token presented as an API bearer', () => {
  it('accepts a REAL sign-in token, which carries the nonce of the flow that requested it (field.faithnet.io, 2026-11-15)', async () => {
    expect(await verifyIdTokenForRelyingClient({} as never, await mint('field-app', 'n-123'), keys, own)).toBe(SA);
  });

  it('accepts a token with no nonce (demo-signin)', async () => {
    expect(await verifyIdTokenForRelyingClient({} as never, await mint('field-app'), keys, own)).toBe(SA);
  });

  it('still refuses an unregistered audience and a foreign issuer', async () => {
    expect(await verifyIdTokenForRelyingClient({} as never, await mint('nobody', 'n'), keys, own)).toBeNull();
    expect(await verifyIdTokenForRelyingClient({} as never, await mint('field-app', 'n'), keys, () => false)).toBeNull();
  });

  it('still refuses a token whose signature is not ours', async () => {
    const t = await mint('field-app', 'n');
    const [h, p] = t.split('.');
    const other = await generateBrokerKeypair('ES256');
    const forged = await mintIdToken({ iss: ISS, sub: `eip155:34348:${SA}` as never, aud: 'field-app', ttlSeconds: 600, nonce: 'n' }, { ...(signer as object), privateKey: other.privateKey } as never);
    expect(await verifyIdTokenForRelyingClient({} as never, `${h}.${p}.${forged.split('.')[2]}`, keys, own)).toBeNull();
  });
});

describe('bearerNonce', () => {
  it('states the token\'s own nonce, or null when it carries none', () => {
    expect(bearerNonce({ nonce: 'abc' })).toBe('abc');
    expect(bearerNonce({})).toBeNull();
    expect(bearerNonce({ nonce: '' })).toBeNull();
    expect(bearerNonce({ nonce: 7 })).toBeNull();
  });
});
