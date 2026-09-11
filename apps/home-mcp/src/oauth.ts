// THE AUTHORIZATION SERVER TOWARD MCP CLIENTS — OAuth 2.1 exactly as the MCP authorization specification requires:
// RFC 8414 metadata, RFC 7591 dynamic client registration, PKCE S256 required, RFC 8707 resource indicators (the
// token's audience is THIS MCP endpoint and nothing else), opaque rotating tokens, refresh, revocation. A bearer
// minted here is a CLIENT credential — it says which client of which person is calling — and it never leaves
// this Worker (the MCP passthrough rule, which is ADR-0041's rule). Toward the person, this Worker is a registered
// relying app of the Home (`oauth-callback.ts`): identity and the ask-as-me wire come from there, never from here.
import { Store, randomToken, sha256b64, type ClientRow, type TokenRow } from './store.js';

export const ACCESS_TTL_S = 3600;
export const REFRESH_TTL_S = 30 * 86_400;
export const CODE_TTL_MS = 300_000;
export const PENDING_TTL_MS = 600_000;

export interface OAuthEnv { TOKEN_SECRET?: string }

export function authorizationServerMetadata(origin: string, scopes: readonly string[]): Record<string, unknown> {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: [...scopes],
    // RFC 8707 — a client MUST say which resource it wants a token for; the token is bound to it.
    resource_indicators_supported: true,
    service_documentation: `${origin}/`,
  };
}

/** The token's lookup key: an HMAC-ish hash under the Worker secret, so a dumped store yields no usable token. */
export async function tokenHash(env: OAuthEnv, token: string): Promise<string> { return sha256b64(`${env.TOKEN_SECRET ?? 'unset'}:${token}`); }

const OAUTH_ERR = (error: string, description: string, status = 400): Response =>
  new Response(JSON.stringify({ error, error_description: description }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/** RFC 7591 — an unprivileged registration: it decides who may ASK, never what is granted (the Home's own rule). */
export async function registerClient(store: Store, body: Record<string, unknown>): Promise<Response> {
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
  if (uris.length === 0 || uris.length > 8) return OAUTH_ERR('invalid_redirect_uri', 'one to eight redirect_uris are required');
  for (const u of uris) { try { const x = new URL(u); if (x.protocol !== 'https:' && x.hostname !== 'localhost' && x.hostname !== '127.0.0.1') return OAUTH_ERR('invalid_redirect_uri', `${u} is not https`); } catch { return OAUTH_ERR('invalid_redirect_uri', `${u} is not a URL`); } }
  const method = typeof body.token_endpoint_auth_method === 'string' ? body.token_endpoint_auth_method : 'none';
  if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) return OAUTH_ERR('invalid_client_metadata', 'token_endpoint_auth_method unsupported');
  const grants = Array.isArray(body.grant_types) ? body.grant_types : ['authorization_code'];
  if (grants.some((g) => g !== 'authorization_code' && g !== 'refresh_token')) return OAUTH_ERR('invalid_client_metadata', 'only authorization_code and refresh_token are supported');
  const client_id = `mcp_${randomToken(16)}`;
  const secret = method === 'none' ? undefined : randomToken(32);
  const row: ClientRow = { client_id, redirect_uris: uris, ...(typeof body.client_name === 'string' ? { client_name: body.client_name.slice(0, 120) } : {}), token_endpoint_auth_method: method as ClientRow['token_endpoint_auth_method'], ...(secret ? { client_secret_hash: await sha256b64(secret) } : {}), created_at: Date.now() };
  await store.putClient(row);
  return new Response(JSON.stringify({ client_id, ...(secret ? { client_secret: secret } : {}), client_id_issued_at: Math.floor(row.created_at / 1000), redirect_uris: uris, token_endpoint_auth_method: method, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], ...(row.client_name ? { client_name: row.client_name } : {}) }), { status: 201, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

export interface AuthorizeRequest { client_id: string; redirect_uri: string; state?: string; code_challenge: string; scope: string[]; resource: string }
/** Validate a /authorize request against the registration and the MCP rules (PKCE S256, resource). */
export async function parseAuthorize(store: Store, q: URLSearchParams, resourceUrl: string, scopesSupported: readonly string[]): Promise<{ ok: true; req: AuthorizeRequest; client: ClientRow } | { ok: false; res: Response }> {
  const client_id = q.get('client_id') ?? '';
  const client = client_id ? await store.getClient(client_id) : null;
  if (!client) return { ok: false, res: OAUTH_ERR('invalid_client', 'unknown client_id — register first (RFC 7591)', 401) };
  const redirect_uri = q.get('redirect_uri') ?? '';
  if (!client.redirect_uris.includes(redirect_uri)) return { ok: false, res: OAUTH_ERR('invalid_request', 'redirect_uri is not one the client registered') };
  if (q.get('response_type') !== 'code') return { ok: false, res: OAUTH_ERR('unsupported_response_type', 'response_type must be code') };
  if (q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(q.get('code_challenge') ?? '')) return { ok: false, res: OAUTH_ERR('invalid_request', 'PKCE S256 code_challenge is required') };
  const resource = (q.get('resource') ?? '').replace(/\/$/, '');
  if (!resource) return { ok: false, res: OAUTH_ERR('invalid_target', 'resource is required (RFC 8707) — the MCP endpoint URL') };
  if (resource !== resourceUrl.replace(/\/$/, '')) return { ok: false, res: OAUTH_ERR('invalid_target', `this server issues tokens for ${resourceUrl} only`) };
  const scope = (q.get('scope') ?? scopesSupported.join(' ')).split(/\s+/).filter(Boolean);
  const unknown = scope.filter((s) => !scopesSupported.includes(s));
  if (unknown.length) return { ok: false, res: OAUTH_ERR('invalid_scope', `unknown scope ${unknown.join(' ')}`) };
  return { ok: true, req: { client_id, redirect_uri, ...(q.get('state') ? { state: q.get('state')! } : {}), code_challenge: q.get('code_challenge')!, scope, resource }, client };
}

async function pkceOk(verifier: string, challenge: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_.~-]{43,128}$/.test(verifier)) return false;
  return (await sha256b64(verifier)) === challenge;
}

async function clientAuth(store: Store, body: URLSearchParams, header: string | null): Promise<ClientRow | null> {
  let id = body.get('client_id') ?? ''; let secret = body.get('client_secret') ?? '';
  const basic = /^Basic\s+(.+)$/i.exec(header ?? '')?.[1];
  if (basic) { try { const [i, s] = atob(basic).split(':'); id = decodeURIComponent(i ?? ''); secret = decodeURIComponent(s ?? ''); } catch { return null; } }
  const client = id ? await store.getClient(id) : null;
  if (!client) return null;
  if (client.token_endpoint_auth_method !== 'none') { if (!secret || (await sha256b64(secret)) !== client.client_secret_hash) return null; }
  return client;
}

/** /token — authorization_code (PKCE, resource re-checked) and refresh_token (rotating). Opaque tokens. */
export async function tokenEndpoint(env: OAuthEnv, store: Store, body: URLSearchParams, authHeader: string | null, resourceUrl: string): Promise<Response> {
  const client = await clientAuth(store, body, authHeader);
  if (!client) return OAUTH_ERR('invalid_client', 'client authentication failed', 401);
  const grant = body.get('grant_type');
  const issue = async (sub: string, scope: string[], resource: string): Promise<Response> => {
    const access = randomToken(32); const refresh = randomToken(32);
    const now = Math.floor(Date.now() / 1000);
    const ah = await tokenHash(env, access); const rh = await tokenHash(env, refresh);
    const base = { client_id: client.client_id, sub, scope, resource, created_at: now };
    await store.putToken(ah, { ...base, token_hash: ah, kind: 'access', exp: (now + ACCESS_TTL_S) * 1000 } satisfies TokenRow);
    await store.putToken(rh, { ...base, token_hash: rh, kind: 'refresh', exp: (now + REFRESH_TTL_S) * 1000, refresh_of: ah } satisfies TokenRow);
    return new Response(JSON.stringify({ access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: scope.join(' ') }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store', pragma: 'no-cache' } });
  };
  if (grant === 'authorization_code') {
    const code = body.get('code') ?? ''; const verifier = body.get('code_verifier') ?? ''; const redirect = body.get('redirect_uri') ?? '';
    const row = code ? await store.takeCode(code) : null; // single use, whatever happens next
    if (!row) return OAUTH_ERR('invalid_grant', 'invalid or already-used code');
    if (row.client_id !== client.client_id) return OAUTH_ERR('invalid_grant', 'code was issued to another client');
    if (row.redirect_uri !== redirect) return OAUTH_ERR('invalid_grant', 'redirect_uri mismatch');
    if (!(await pkceOk(verifier, row.code_challenge))) return OAUTH_ERR('invalid_grant', 'PKCE verification failed');
    const resource = (body.get('resource') ?? row.resource).replace(/\/$/, '');
    if (resource !== row.resource || resource !== resourceUrl.replace(/\/$/, '')) return OAUTH_ERR('invalid_target', 'resource does not match the authorization');
    return issue(row.sub, row.scope, row.resource);
  }
  if (grant === 'refresh_token') {
    const rt = body.get('refresh_token') ?? '';
    const rh = rt ? await tokenHash(env, rt) : '';
    const row = rh ? await store.getToken(rh) : null;
    if (!row || row.kind !== 'refresh' || row.client_id !== client.client_id) return OAUTH_ERR('invalid_grant', 'invalid refresh token');
    // ROTATION: the presented refresh token and the access token it was issued with are spent together.
    await store.deleteToken(rh); if (row.refresh_of) await store.deleteToken(row.refresh_of);
    const scope = (body.get('scope') ?? row.scope.join(' ')).split(/\s+/).filter(Boolean);
    if (scope.some((s) => !row.scope.includes(s))) return OAUTH_ERR('invalid_scope', 'a refresh may not widen scope');
    // RFC 8707 on refresh too: a token is for the resource it was authorized for, and a refresh may name only that one.
    const wanted = body.get('resource');
    if (wanted && wanted.replace(/\/$/, '') !== row.resource) return OAUTH_ERR('invalid_target', 'a refresh may not change the resource');
    return issue(row.sub, scope, row.resource);
  }
  return OAUTH_ERR('unsupported_grant_type', 'authorization_code or refresh_token');
}

/** /revoke (RFC 7009) — an access or refresh token; always 200 (a revoked or unknown token is the same fact). */
export async function revokeEndpoint(env: OAuthEnv, store: Store, body: URLSearchParams, authHeader: string | null): Promise<Response> {
  const client = await clientAuth(store, body, authHeader);
  if (!client) return OAUTH_ERR('invalid_client', 'client authentication failed', 401);
  const t = body.get('token') ?? '';
  if (t) { const h = await tokenHash(env, t); const row = await store.getToken(h); if (row && row.client_id === client.client_id) { await store.deleteToken(h); if (row.refresh_of) await store.deleteToken(row.refresh_of); } }
  return new Response(null, { status: 200 });
}

/** The bearer on an MCP request → the token row, or null. The audience is THIS resource; anything else is refused. */
export async function bearerOf(env: OAuthEnv, store: Store, authHeader: string | null, resourceUrl: string): Promise<TokenRow | null> {
  const t = /^Bearer\s+(.+)$/i.exec(authHeader ?? '')?.[1]?.trim();
  if (!t) return null;
  const row = await store.getToken(await tokenHash(env, t));
  if (!row || row.kind !== 'access') return null;
  if (row.resource.replace(/\/$/, '') !== resourceUrl.replace(/\/$/, '')) return null;
  return row;
}
