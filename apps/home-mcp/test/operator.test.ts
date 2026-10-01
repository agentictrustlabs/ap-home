// Spec 397 §11.1 / §11.4 — the operator surface: a registration gets scope act only by the operator's flag; the
// connection-key client is curated; the key pages carry the PKCE state in a cookie and never the key.
import { describe, it, expect } from 'vitest';
import { Store, type ClientRow } from '../src/store.js';
import { clientMayAct } from '../src/act.js';
import { KEY_CLIENT_ID, clientView, ensureKeyClient, keyCookie, keyDonePage, keyStartPage, listClients, operatorAllowed, readKeyCookie, setClientAct } from '../src/operator.js';

function memStore(): Store {
  const clients = new Map<string, ClientRow>();
  const stub = { fetch: async (req: Request) => {
    const { op, key, row } = (await req.json()) as { op: string; key?: string; row?: ClientRow };
    switch (op) {
      case 'client.put': clients.set(key!, row!); return Response.json({ ok: true });
      case 'client.get': return Response.json({ ok: true, row: clients.get(key!) ?? null });
      case 'client.list': return Response.json({ ok: true, rows: [...clients.values()] });
      default: return Response.json({ ok: true, row: null });
    }
  } } as unknown as DurableObjectStub;
  return new Store(stub);
}

describe('operator surface', () => {
  it('the secret gates it; no secret configured ⇒ nothing is allowed', () => {
    expect(operatorAllowed({}, 'x')).toBe(false);
    expect(operatorAllowed({ ACT_REGISTRATION_SECRET: 's3' }, undefined)).toBe(false);
    expect(operatorAllowed({ ACT_REGISTRATION_SECRET: 's3' }, 's3')).toBe(true);
  });
  it('lists registrations without secrets and flips act on ONE of them; the flag is what clientMayAct reads', async () => {
    const s = memStore();
    await s.putClient({ client_id: 'muse-1', client_name: 'Muse custom connector', client_secret_hash: 'HASH', redirect_uris: ['https://muse.example/cb'], token_endpoint_auth_method: 'none', created_at: 1 });
    await s.putClient({ client_id: 'claude-1', client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none', created_at: 2 });
    const before = await listClients(s);
    expect(before.map((c) => c.client_id)).toEqual(['claude-1', 'muse-1']);
    expect(JSON.stringify(before)).not.toContain('HASH');
    expect(before.every((c) => c.act === false)).toBe(true);
    expect(await setClientAct(s, 'nope', true)).toMatchObject({ ok: false });
    const r = await setClientAct(s, 'muse-1', true);
    expect(r).toMatchObject({ ok: true, client: { client_id: 'muse-1', act: true } });
    expect(clientMayAct({}, 'muse-1', (await s.getClient('muse-1'))!.act)).toBe(true);
    expect(clientMayAct({}, 'claude-1', (await s.getClient('claude-1'))!.act)).toBe(false);
    await setClientAct(s, 'muse-1', false);
    expect((await s.getClient('muse-1'))!.act).toBe(false);
  });
  it('the key client is curated: public, act-allowed, redirecting to its own done page; idempotent', async () => {
    const s = memStore();
    const a = await ensureKeyClient(s, 'https://home-mcp.example');
    expect(a).toMatchObject({ client_id: KEY_CLIENT_ID, act: true, token_endpoint_auth_method: 'none', redirect_uris: ['https://home-mcp.example/connect/key/done'] });
    const b = await ensureKeyClient(s, 'https://home-mcp.example');
    expect(b.created_at).toBe(a.created_at);
    expect(clientView(b).act).toBe(true);
  });
  it('the cookie carries state and verifier, HttpOnly on the key path; the pages never embed the verifier', () => {
    const c = keyCookie('st.verif', 600);
    expect(c).toMatch(/^hm_key=st\.verif; Path=\/connect\/key; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/);
    expect(readKeyCookie(`a=b; ${c.split(';')[0]}`)).toEqual({ state: 'st', verifier: 'verif' });
    expect(readKeyCookie('a=b')).toBeNull();
    const start = keyStartPage('https://home-mcp.example', 'https://home.example');
    expect(start).toContain('/connect/key/start');
    expect(start).toContain('value="ask act"');
    const done = keyDonePage('https://home-mcp.example', 'KEY123', 'ask act', 30 * 86_400);
    expect(done).toContain('KEY123');
    expect(done).toContain('30 days');
    expect(done).toContain('https://home-mcp.example/mcp');
    expect(done).not.toContain('verif');
  });
});
