// THE OPERATOR'S DOOR TO THE PAGED LIBRARY SWITCH (`/custody/library/paged`): bridge-HMAC under its own audience, and
// it forwards ONLY to the named owner's own object, as an in-Worker call.
import { describe, expect, it } from 'vitest';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import app from '../src/index.js';

const SECRET = 'test-bridge-secret';
const OWNER = '0x' + 'ab'.repeat(20);
const signed = (body: string, audience = 'custody.library.paged', secret = SECRET) => {
  const ts = String(Date.now());
  const nonce = randomBytes(12).toString('base64url');
  const sig = createHmac('sha256', secret).update(`${ts}.${nonce}.0x${createHash('sha256').update(body).digest('hex')}.${audience}`).digest('hex');
  return { 'content-type': 'application/json', 'x-bridge-timestamp': ts, 'x-bridge-nonce': nonce, 'x-bridge-audience': audience, 'x-bridge-signature': sig };
};
function env(over: Record<string, unknown> = {}) {
  const seen: Array<{ name: string; url: string; body: unknown; internal: boolean }> = [];
  const kv = new Map<string, string>();
  return {
    seen,
    env: {
      CHAIN_ID: '84532', RPC_URL: 'https://rpc.example.test', A2A_CUSTODY_BRIDGE_SECRET: SECRET, A2A_INTERNAL_MARKER: 'marker',
      AUTH_CODES: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => { kv.set(k, v); }, delete: async (k: string) => { kv.delete(k); } },
      SUBJECT_SA_MAP: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => { kv.set(k, v); } },
      INTERACTIONS: {
        idFromName: (name: string) => name,
        get: (name: string) => ({ fetch: async (r: Request) => { seen.push({ name, url: r.url, body: await r.json(), internal: r.headers.get('x-ap-internal') === 'marker' }); return new Response(JSON.stringify({ ok: true, action: 'status', paged: false }), { status: 200 }); } }),
      },
      ...over,
    } as never,
  };
}
const post = (body: string, headers: Record<string, string>, e: never) => app.fetch(new Request('https://a2a.example.test/custody/library/paged', { method: 'POST', headers, body }), e);

describe('/custody/library/paged', () => {
  it('is closed when the bridge secret is not configured', async () => {
    const { env: e } = env({ A2A_CUSTODY_BRIDGE_SECRET: undefined });
    const body = JSON.stringify({ owner: OWNER, action: 'status' });
    expect((await post(body, signed(body), e)).status).toBe(503);
  });

  it('refuses a call without the envelope, under another audience, or signed with another secret', async () => {
    const body = JSON.stringify({ owner: OWNER, action: 'activate' });
    for (const headers of [{ 'content-type': 'application/json' }, signed(body, 'custody.oidc.sign'), signed(body, 'custody.library.paged', 'wrong')]) {
      const { env: e, seen } = env();
      expect((await post(body, headers, e)).status).toBe(401);
      expect(seen).toHaveLength(0);
    }
  });

  it("forwards to the owner's own object as an in-Worker call, and answers with its report", async () => {
    const { env: e, seen } = env();
    const body = JSON.stringify({ owner: OWNER.toUpperCase().replace('0X', '0x'), action: 'status' });
    const r = await post(body, signed(body), e);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, paged: false });
    expect(seen).toEqual([{ name: OWNER, url: `https://do/interactions/${OWNER}/internal.library.paged`, body: { owner: OWNER, action: 'status' }, internal: true }]);
  });

  it('needs an owner address', async () => {
    const { env: e } = env();
    const body = JSON.stringify({ owner: 'someone', action: 'status' });
    expect((await post(body, signed(body), e)).status).toBe(400);
  });
});
