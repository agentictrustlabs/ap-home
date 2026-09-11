// Spec 397 W1 — the authorization server, exactly: DCR, PKCE S256 required, the resource bound, rotation, revocation.
import { describe, it, expect } from 'vitest';
import { registerClient, parseAuthorize, tokenEndpoint, bearerOf, revokeEndpoint, authorizationServerMetadata } from '../src/oauth.js';
import { Store, sha256b64, type ClientRow, type CodeRow, type PendingRow, type TokenRow, type PersonRow } from '../src/store.js';

/** An in-memory stand-in for the object, same ops. */
function memStore(): Store {
  const m = { clients: new Map<string, ClientRow>(), pending: new Map<string, PendingRow>(), codes: new Map<string, CodeRow>(), tokens: new Map<string, TokenRow>(), persons: new Map<string, PersonRow>() };
  const stub = { fetch: async (req: Request) => {
    const { op, key, row } = (await req.json()) as { op: string; key?: string; row?: never };
    const now = Date.now();
    const out = (r: unknown) => Response.json({ ok: true, row: r ?? null });
    switch (op) {
      case 'client.put': m.clients.set(key!, row); return out(null);
      case 'client.get': return out(m.clients.get(key!));
      case 'pending.put': m.pending.set(key!, row); return out(null);
      case 'pending.take': { const r = m.pending.get(key!); m.pending.delete(key!); return out(r); }
      case 'code.put': m.codes.set(key!, row); return out(null);
      case 'code.take': { const r = m.codes.get(key!); m.codes.delete(key!); return out(r); }
      case 'token.put': m.tokens.set(key!, row); return out(null);
      case 'token.get': { const r = m.tokens.get(key!); return out(r && r.exp > now ? r : null); }
      case 'token.delete': m.tokens.delete(key!); return out(null);
      case 'person.put': m.persons.set(key!, row); return out(null);
      case 'person.get': return out(m.persons.get(key!));
      default: return out(null);
    }
  } } as unknown as DurableObjectStub;
  return new Store(stub);
}
const RESOURCE = 'https://home-mcp.example/mcp';
const env = { TOKEN_SECRET: 's' };
const verifier = 'v'.repeat(48);

describe('the authorization server toward MCP clients', () => {
  it('advertises RFC 8414 metadata with PKCE S256 and resource indicators', () => {
    const m = authorizationServerMetadata('https://home-mcp.example', ['ask']);
    expect(m).toMatchObject({ issuer: 'https://home-mcp.example', code_challenge_methods_supported: ['S256'], registration_endpoint: 'https://home-mcp.example/oauth/register', resource_indicators_supported: true });
  });
  it('registers a public client (RFC 7591); refuses a non-https redirect', async () => {
    const s = memStore();
    const bad = await registerClient(s, { redirect_uris: ['http://evil.example/cb'] });
    expect(bad.status).toBe(400);
    const res = await registerClient(s, { redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'Claude' });
    expect(res.status).toBe(201);
    const reg = (await res.json()) as { client_id: string; client_secret?: string };
    expect(reg.client_id.startsWith('mcp_')).toBe(true);
    expect(reg.client_secret).toBeUndefined();
  });
  it('authorize requires PKCE S256 and the exact resource; the code exchanges once, with the verifier, for a token bound to the resource; refresh rotates; revoke kills', async () => {
    const s = memStore();
    const reg = (await (await registerClient(s, { redirect_uris: ['https://claude.ai/cb'] })).json()) as { client_id: string };
    const challenge = await sha256b64(verifier);
    const q = (over: Record<string, string> = {}) => new URLSearchParams({ client_id: reg.client_id, redirect_uri: 'https://claude.ai/cb', response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', resource: RESOURCE, scope: 'ask', ...over });
    expect((await parseAuthorize(s, q({ code_challenge_method: 'plain' }), RESOURCE, ['ask'])).ok).toBe(false);
    expect((await parseAuthorize(s, q({ resource: 'https://other.example/mcp' }), RESOURCE, ['ask'])).ok).toBe(false);
    expect((await parseAuthorize(s, q({ redirect_uri: 'https://claude.ai/other' }), RESOURCE, ['ask'])).ok).toBe(false);
    const ok = await parseAuthorize(s, q(), RESOURCE, ['ask']);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    await s.putCode({ code: 'c1', ...ok.req, sub: 'eip155:34348:0xabc', created_at: Date.now() });
    const form = (o: Record<string, string>) => new URLSearchParams({ grant_type: 'authorization_code', client_id: reg.client_id, redirect_uri: 'https://claude.ai/cb', code: 'c1', code_verifier: verifier, ...o });
    // wrong verifier: refused and the code is spent
    expect((await tokenEndpoint(env, s, form({ code_verifier: 'x'.repeat(48) }), null, RESOURCE)).status).toBe(400);
    expect((await tokenEndpoint(env, s, form({}), null, RESOURCE)).status).toBe(400);
    await s.putCode({ code: 'c2', ...ok.req, sub: 'eip155:34348:0xabc', created_at: Date.now() });
    const tok = (await (await tokenEndpoint(env, s, form({ code: 'c2' }), null, RESOURCE)).json()) as { access_token: string; refresh_token: string; token_type: string };
    expect(tok.token_type).toBe('Bearer');
    const row = await bearerOf(env, s, `Bearer ${tok.access_token}`, RESOURCE);
    expect(row).toMatchObject({ sub: 'eip155:34348:0xabc', scope: ['ask'], resource: RESOURCE });
    expect(await bearerOf(env, s, `Bearer ${tok.access_token}`, 'https://other.example/mcp')).toBeNull();
    const rotated = (await (await tokenEndpoint(env, s, new URLSearchParams({ grant_type: 'refresh_token', client_id: reg.client_id, refresh_token: tok.refresh_token }), null, RESOURCE)).json()) as { access_token: string; refresh_token: string };
    expect(await bearerOf(env, s, `Bearer ${tok.access_token}`, RESOURCE)).toBeNull();
    expect(await bearerOf(env, s, `Bearer ${rotated.access_token}`, RESOURCE)).not.toBeNull();
    expect((await tokenEndpoint(env, s, new URLSearchParams({ grant_type: 'refresh_token', client_id: reg.client_id, refresh_token: tok.refresh_token }), null, RESOURCE)).status).toBe(400);
    await revokeEndpoint(env, s, new URLSearchParams({ client_id: reg.client_id, token: rotated.access_token }), null);
    expect(await bearerOf(env, s, `Bearer ${rotated.access_token}`, RESOURCE)).toBeNull();
  });
});
