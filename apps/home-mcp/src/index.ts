// home-mcp — spec 397. Claude.ai's entrance to a PERSON's own agent.
//
// Toward an MCP client this is an OAuth 2.1 authorization server + resource server (oauth.ts) and a Streamable HTTP
// MCP server. Toward the person it is a REGISTERED RELYING APP of the Home (spec 230/295): `/oauth/authorize` sends
// the person to the Home's own sign-in with `delegation_template=ask-as-me`; the callback exchanges the code at the
// Home's `/token` and receives the id_token AND the person's ask-as-me delegation to THIS Worker's key — sealed in
// the store, never a bearer of theirs. Every `ask` then speaks to the person's agent AS THEM under that wire
// (a2a.ts). The bearer a client holds says which client of which person is calling, and it never leaves here.
import { Hono } from 'hono';
import { MethodRegistry, RpcError, RPC_ERROR, SUPPORTED_PROTOCOL_VERSIONS, buildServerDiscover, negotiateProtocolVersion, parseJsonRpc, parseRequestMeta } from '@agenticprimitives/mcp-protocol';
import { createProtectedResourceMetadata, serveProtectedResourceMetadata, buildUnauthorizedResponse } from '@agenticprimitives/mcp-oauth';
import { importJwks, verifyIdToken } from '@agenticprimitives/connect';
import type { DelegationWireV1 } from '@agenticprimitives/a2a';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { HomeMcpStoreDO, Store, kekFrom, openWire, sealWire, randomToken, sha256b64, type PersonRow, type ElicitAnswer } from './store.js';
import { sseFrame, progressNotification, elicitationFor, isJsonRpcResponse } from './stream.js';
import { progressAsPerson, refreshWire } from './a2a.js';
import { ACT_TEMPLATE, ACT_SCOPE, requestsAct, clientMayAct, actKeyAddress, acceptStandingWires, type ActGrantV1 } from './act.js';
import { authorizationServerMetadata, parseAuthorize, registerClient, tokenEndpoint, revokeEndpoint, bearerOf, withDefaultResource, PENDING_TTL_MS } from './oauth.js';
import { KEY_CLIENT_ID, KEY_ACCESS_TTL_SECONDS, operatorAllowed, listClients, setClientAct, ensureKeyClient, keyStartPage, keyDonePage, keyErrorPage, keyCookie, readKeyCookie } from './operator.js';
import { TOOLS, askTool, grantLinkTool, discoverTool, engageTool, inspectTool, publicShelfTool, runTool, myRunsTool, needsReauthorization, type Person } from './tools.js';
import { SERVER, SCOPES } from './whitelabel.js';

export { HomeMcpStoreDO };

export interface Env {
  STORE: DurableObjectNamespace;
  HOME_ORIGIN: string;
  BROKER_JWKS_URL?: string;
  A2A_ORIGIN: string;
  CLIENT_ID: string;
  DEMO_CONNECT_ENABLED?: string;
  /** Where a person's agent is served, by its registry label (`https://{label}.faithnet.ai`), for its public card. */
  AGENT_HOST_PATTERN?: string;
  /** The ask-as-me DELEGATE key (spec 397): holds no authority of its own — every wire naming it is a person's
   *  revocable grant. A raw Worker secret today; audit home-mcp-raw-delegate-key (accepted-risk) schedules the
   *  KMS-backed signer + the client's delegate re-registration at the Home. */
  HOME_MCP_PRIVATE_KEY?: string;
  /** Spec 410 §1.2 — the estate the ask-as-me wire is hashed on, for the wire refresh (vars, never inferred). */
  CHAIN_ID?: string;
  DELEGATION_MANAGER?: string;
  TOKEN_SECRET?: string;
  /** Spec 397 §11 — the ACT-AS-ME delegate key: a SECOND secret; its address is the `delegate` on the Home's
   *  `home-mcp-act` client. A stolen ask key cannot derive a mandate — the act wires name this one. */
  HOME_MCP_ACT_KEY?: string;
  /** The Home's client id for the act template (`home-mcp-act`). */
  CLIENT_ID_ACT?: string;
  /** Operator allowlist: client ids that may request scope `act` (beside registrations that presented the act secret). */
  ACT_CLIENT_IDS?: string;
  /** A registration presenting this secret (`x-act-registration`) may request scope `act`. Unset ⇒ only the allowlist. */
  ACT_REGISTRATION_SECRET?: string;
}

/** R917-E-5 (spec 409 §7) — the secret that seals every connected person's wire. FAIL CLOSED: unset or empty is an
 *  error, never a literal (`'unset'` once stood in, so an unprovisioned Worker sealed wires anyone could open). */
function tokenSecret(env: Pick<Env, 'TOKEN_SECRET'>): string {
  const v = (env.TOKEN_SECRET ?? '').trim();
  if (!v) throw new Error('TOKEN_SECRET is not provisioned — the Home MCP seals no wire and serves no connection until it is (spec 409 §7)');
  return v;
}

const app = new Hono<{ Bindings: Env }>();
const SERVER_INFO = { name: SERVER.name, version: SERVER.version };
const CAPABILITIES = { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } };
const store = (env: Env) => new Store(env.STORE.get(env.STORE.idFromName('home-mcp')));
const originOf = (c: { req: { url: string } }) => new URL(c.req.url).origin;
const resourceOf = (c: { req: { url: string } }) => `${originOf(c)}/mcp`;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

function toolResult(value: Record<string, unknown>, isError = false): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value, ...(isError ? { isError: true } : {}) };
}

// CORS: MCP clients and their browsers; bearer auth, never cookies.
app.use('*', async (c, next) => {
  if (c.req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id', 'access-control-max-age': '600' } });
  await next();
  c.res.headers.set('access-control-allow-origin', '*');
  c.res.headers.set('access-control-expose-headers', 'www-authenticate, mcp-session-id');
});

// `keyAddress` is the delegate every ask-as-me wire names: it MUST equal the `delegate` on the Home's `home-mcp` client
// registration. Rotating the key = a new secret + that registration updated + deploy; every connection then ends itself
// (the assertion no longer recovers to the wire's delegate → 401 → the host re-authorizes; the Home mints a new wire).
app.get('/health', (c) => c.json({ ok: true, service: 'home-mcp', spec: 397, tools: TOOLS.map((t) => t.name), home: c.env.HOME_ORIGIN, actKeyAddress: actKeyAddress(c.env), keyAddress: c.env.HOME_MCP_PRIVATE_KEY ? privateKeyToAccount(c.env.HOME_MCP_PRIVATE_KEY as Hex).address : null }));
app.get('/', (c) => c.json({ service: SERVER.name, mcp: `POST ${resourceOf(c)} (Streamable HTTP; OAuth 2.1 — see /.well-known/oauth-protected-resource)`, tools: TOOLS.map((t) => t.name), connectionKey: `${originOf(c)}/connect/key`, doctrine: SERVER.instructions }));

// ── RFC 9728 / RFC 8414 ──
app.get('/.well-known/oauth-protected-resource', (c) => serveProtectedResourceMetadata(createProtectedResourceMetadata({ resource: resourceOf(c), authorizationServers: [originOf(c)], scopesSupported: [...SCOPES], resourceDocumentation: `${originOf(c)}/` })));
app.get('/.well-known/oauth-protected-resource/mcp', (c) => serveProtectedResourceMetadata(createProtectedResourceMetadata({ resource: resourceOf(c), authorizationServers: [originOf(c)], scopesSupported: [...SCOPES], resourceDocumentation: `${originOf(c)}/` })));
app.get('/.well-known/oauth-authorization-server', (c) => c.json(authorizationServerMetadata(originOf(c), SCOPES)));

// ── RFC 7591 ──
/** A caller's hour: registrations and demo connects are unprivileged, so they are bounded per caller and overall. */
async function tooMany(env: Env, what: string, caller: string, perCaller: number, overall: number): Promise<boolean> {
  const hour = 3_600_000;
  const [mine, all] = await Promise.all([store(env).rateHit(`${what}:${caller}`, hour), store(env).rateHit(`${what}:*`, hour)]);
  return mine > perCaller || all > overall;
}
const callerOf = (c: { req: { header(n: string): string | undefined } }) => c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
const tooManyResponse = () => new Response(JSON.stringify({ error: 'too_many_requests', error_description: 'this caller has registered or connected too often this hour' }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '3600' } });

app.post('/oauth/register', async (c) => {
  if (await tooMany(c.env, 'register', callerOf(c), 30, 600)) return tooManyResponse();
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const res = await registerClient(store(c.env), body);
  // Spec 397 §11 — a registration that presented the OPERATOR's act secret may request scope `act` later; the flag
  // lives on the client row, set here and nowhere else. A registration without it (Claude's) never gets the scope.
  const secret = (c.env.ACT_REGISTRATION_SECRET ?? '').trim();
  const presented = (c.req.header('x-act-registration') ?? '').trim();
  if (res.ok && secret && presented && presented === secret) {
    const reg = (await res.clone().json().catch(() => null)) as { client_id?: string } | null;
    const row = reg?.client_id ? await store(c.env).getClient(reg.client_id) : null;
    if (row) await store(c.env).putClient({ ...row, act: true });
  }
  return res;
});

// ── /oauth/authorize — validated here, COMPLETED at the Home (a relying app never runs a credential ceremony). ──
app.get('/oauth/authorize', async (c) => {
  // A host that names no resource (Meta Muse's connector) gets this Worker's one resource; a host that names another is refused.
  const parsed = await parseAuthorize(store(c.env), withDefaultResource(new URL(c.req.url).searchParams, resourceOf(c)), resourceOf(c), SCOPES);
  if (!parsed.ok) return parsed.res;
  // Spec 397 §11 — scope `act` is served only to a client the operator allowed, and only where this Worker holds an
  // act key. Refused by name, never quietly narrowed to `ask`.
  const act = requestsAct(parsed.req.scope);
  if (act && !clientMayAct(c.env, parsed.req.client_id, (parsed.client as { act?: boolean }).act)) return json({ error: 'invalid_scope', error_description: 'this registration may not request scope act' }, 400);
  if (act && (!c.env.CLIENT_ID_ACT || !actKeyAddress(c.env))) return json({ error: 'invalid_scope', error_description: 'scope act is not served by this Home MCP' }, 400);
  const id = randomToken(24);
  const homeVerifier = randomToken(48);
  const homeState = randomToken(16);
  await store(c.env).putPending({ id, ...parsed.req, home_verifier: homeVerifier, home_state: homeState, created_at: Date.now() });
  const home = new URL(c.env.HOME_ORIGIN);
  // Scope act redirects to the Home AS THE ACT CLIENT with the act template; any other connect stays ask-as-me.
  home.searchParams.set('client_id', act ? c.env.CLIENT_ID_ACT! : c.env.CLIENT_ID);
  home.searchParams.set('redirect_uri', `${originOf(c)}/oauth/callback`);
  home.searchParams.set('response_type', 'code');
  home.searchParams.set('scope', 'openid agent');
  home.searchParams.set('state', `${id}.${homeState}`);
  home.searchParams.set('nonce', randomToken(12));
  home.searchParams.set('code_challenge', await sha256b64(homeVerifier));
  home.searchParams.set('code_challenge_method', 'S256');
  home.searchParams.set('delegation_template', act ? ACT_TEMPLATE : 'ask-as-me');
  return c.redirect(home.toString(), 302);
});

/** The Home's token exchange → the id_token (who) and the ask-as-me delegation (how). Verified here against the Home's JWKS. */
async function connectFromHome(env: Env, exchange: { id_token?: string; delegation?: DelegationWireV1; delegations?: unknown; agent_name?: string }, clientId: string, template: 'ask-as-me' | typeof ACT_TEMPLATE = 'ask-as-me'): Promise<{ ok: true; sub: string; agent: string } | { ok: false; error: string }> {
  if (!exchange.id_token || !exchange.delegation) return { ok: false, error: 'the Home returned no id_token or no delegation' };
  const jwksUrl = env.BROKER_JWKS_URL ?? `${env.HOME_ORIGIN}/jwks`;
  const jwks = (await fetch(jwksUrl).then((r) => r.json()).catch(() => null)) as { keys: Array<JsonWebKey & { kid?: string; alg?: string }> } | null;
  if (!jwks) return { ok: false, error: 'the Home\'s JWKS could not be read' };
  const v = await verifyIdToken(exchange.id_token, { keys: await importJwks(jwks), expectedIss: env.HOME_ORIGIN, expectedAud: template === ACT_TEMPLATE ? (env.CLIENT_ID_ACT ?? env.CLIENT_ID) : env.CLIENT_ID });
  if (!v.ok) return { ok: false, error: `the Home's id_token did not verify: ${v.reason}` };
  const agent = String(v.claims.sub).match(/0x[0-9a-fA-F]{40}$/)?.[0]?.toLowerCase();
  if (!agent) return { ok: false, error: 'the id_token names no agent' };
  const wire = exchange.delegation;
  const key = env.HOME_MCP_PRIVATE_KEY ? privateKeyToAccount(env.HOME_MCP_PRIVATE_KEY as Hex).address.toLowerCase() : '';
  // The wire is OURS to hold only if it names this Worker's key as delegate and the person as delegator.
  if (wire.delegator.toLowerCase() !== agent) return { ok: false, error: 'the delegation is not the connecting person\'s' };
  if (!key || wire.delegate.toLowerCase() !== key) return { ok: false, error: 'the delegation does not name this Home MCP\'s key' };
  const kek = await kekFrom(tokenSecret(env));
  const sealed = await sealWire(kek, wire);
  const prior = await store(env).getPerson(v.claims.sub);
  // A person's clients are bounded: a registration is unprivileged, and a wire is worth guarding from being handed to
  // an unbounded number of them. Revoking at the Home ends every one; connecting again starts clean.
  // A client counts while it holds a live token: a registration whose tokens expired or were revoked is not a connection.
  const MAX_CLIENTS_PER_PERSON = 100;
  const live = new Set(prior ? await store(env).liveClientsFor(v.claims.sub) : []);
  if (prior && !live.has(clientId) && live.size >= MAX_CLIENTS_PER_PERSON) return { ok: false, error: `this person already has ${MAX_CLIENTS_PER_PERSON} connected clients — revoke the connection at their Home to start over` };
  // The person's REGISTRY NAME (alice.me) from the Home's reverse lookup — the id_token's agent_name is their display name.
  const rn = (await fetch(`${env.HOME_ORIGIN}/connect/reverse-name?address=${agent}`).then((r) => r.json()).catch(() => null)) as { name?: string | null } | null;
  const agentName = typeof rn?.name === 'string' && rn.name ? rn.name : (v.claims.agent_name ?? exchange.agent_name);
  // Spec 397 §11 — the ACT grant beside the ask wire: her standing wires, each naming this Worker's ACT key, sealed
  // the same way. Kept per person; an act connect replaces her prior act grant (she authorized anew), an ask connect
  // leaves it alone. A wiped store means she authorizes again.
  let actSeal: { enc: string; iv: string } | undefined;
  if (template === ACT_TEMPLATE) {
    const acc = acceptStandingWires(env, agent, exchange.delegations);
    if (!acc.ok) return { ok: false, error: acc.error };
    const grant: ActGrantV1 = { v: 1, client_id: clientId, standing: acc.standing, granted_at: Date.now() };
    actSeal = await sealWire(kek, grant as unknown as DelegationWireV1);
  }
  const row: PersonRow = {
    sub: v.claims.sub, agent, ...(agentName ? { agent_name: agentName } : {}), wire_enc: sealed.enc, wire_iv: sealed.iv, wire_ref: '', connected_at: Date.now(), client_ids: [...new Set([...live, clientId])],
    ...(actSeal ? { act_enc: actSeal.enc, act_iv: actSeal.iv } : prior?.act_enc ? { act_enc: prior.act_enc, act_iv: prior.act_iv! } : {}),
  };
  await store(env).putPerson(row);
  return { ok: true, sub: v.claims.sub, agent };
}

// ── /oauth/callback — the Home's code → the person; then OUR code → the MCP client. ──
app.get('/oauth/callback', async (c) => {
  const q = new URL(c.req.url).searchParams;
  const [id, homeState] = (q.get('state') ?? '').split('.');
  const pending = id ? await store(c.env).takePending(id) : null;
  if (!pending || pending.home_state !== homeState) return json({ error: 'invalid_request', error_description: 'no pending authorization for this state' }, 400);
  const code = q.get('code');
  if (!code) return json({ error: 'access_denied', error_description: q.get('error_description') ?? 'the Home returned no code' }, 400);
  // The Home's /token: PKCE with the verifier only this Worker held. The exchange happens server-to-server.
  const act = requestsAct(pending.scope);
  const exchange = (await fetch(`${c.env.HOME_ORIGIN}/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'authorization_code', code, code_verifier: pending.home_verifier, client_id: act ? c.env.CLIENT_ID_ACT : c.env.CLIENT_ID, redirect_uri: `${originOf(c)}/oauth/callback` }) }).then((r) => r.json()).catch(() => null)) as { id_token?: string; delegation?: DelegationWireV1; delegations?: unknown; error?: string } | null;
  if (!exchange || exchange.error) return json({ error: 'access_denied', error_description: exchange?.error ?? 'the Home\'s token exchange failed' }, 400);
  const connected = await connectFromHome(c.env, exchange, pending.client_id, act ? ACT_TEMPLATE : 'ask-as-me');
  if (!connected.ok) return json({ error: 'access_denied', error_description: connected.error }, 400);
  const ours = randomToken(32);
  await store(c.env).putCode({ code: ours, client_id: pending.client_id, redirect_uri: pending.redirect_uri, code_challenge: pending.code_challenge, scope: pending.scope, resource: pending.resource, sub: connected.sub, created_at: Date.now() });
  const back = new URL(pending.redirect_uri);
  back.searchParams.set('code', ours);
  if (pending.state) back.searchParams.set('state', pending.state);
  return c.redirect(back.toString(), 302);
});

// ── /oauth/demo-connect — the demo personas connect with no browser (the live gates; spec 392's rule). Off unless
//    DEMO_CONNECT_ENABLED. The same Home path (`demo-signin`, template ask-as-me), the same code for the client. ──
app.post('/oauth/demo-connect', async (c) => {
  if (c.env.DEMO_CONNECT_ENABLED !== 'true') return json({ error: 'not_found' }, 404);
  if (await tooMany(c.env, 'demo-connect', callerOf(c), 60, 600)) return tooManyResponse();
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const q = new URLSearchParams({ client_id: String(body.client_id ?? ''), redirect_uri: String(body.redirect_uri ?? ''), response_type: 'code', code_challenge: String(body.code_challenge ?? ''), code_challenge_method: 'S256', resource: String(body.resource ?? resourceOf(c)), ...(typeof body.scope === 'string' ? { scope: body.scope } : {}) });
  const parsed = await parseAuthorize(store(c.env), q, resourceOf(c), SCOPES);
  if (!parsed.ok) return parsed.res;
  // Spec 397 §11 — a demo persona connecting with scope act: the same gate as a browser (the registration must be
  // allowed), the Home's demo path mints the act set the gate names (`act` in the body: the capabilities and the cap).
  const act = requestsAct(parsed.req.scope);
  if (act && !clientMayAct(c.env, parsed.req.client_id, (parsed.client as { act?: boolean }).act)) return json({ error: 'invalid_scope', error_description: 'this registration may not request scope act' }, 400);
  if (act && (!c.env.CLIENT_ID_ACT || !actKeyAddress(c.env))) return json({ error: 'invalid_scope', error_description: 'scope act is not served by this Home MCP' }, 400);
  const signin = (await fetch(`${c.env.HOME_ORIGIN}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: String(body.handle ?? ''), client_id: act ? c.env.CLIENT_ID_ACT : c.env.CLIENT_ID, delegation_template: act ? ACT_TEMPLATE : 'ask-as-me', ...(act && body.act && typeof body.act === 'object' ? { act: body.act } : {}) }) }).then((r) => r.json()).catch(() => null)) as { id_token?: string; delegation?: DelegationWireV1; delegations?: unknown; agent_name?: string; error?: string } | null;
  if (!signin || signin.error) return json({ error: 'access_denied', error_description: signin?.error ?? 'the Home refused the demo sign-in' }, 400);
  // A demo persona's connection is the gate's, and the gate's alone: every prior connection of this persona ends
  // here, so a run that died before its revoke (or a revoke that once left the refresh token alive) cannot pile
  // up until the per-person client cap refuses the next run with nothing actually connected (seen 2026-09-20:
  // 100 "connected clients", every one a finished gate). Real people never come through this route.
  const who = signin.id_token ? String((JSON.parse(atob(signin.id_token.split('.')[1] ?? '') || '{}') as { sub?: string }).sub ?? '') : '';
  if (who) await store(c.env).deleteTokensFor(who).catch(() => undefined);
  const connected = await connectFromHome(c.env, signin, parsed.req.client_id, act ? ACT_TEMPLATE : 'ask-as-me');
  if (!connected.ok) return json({ error: 'access_denied', error_description: connected.error }, 400);
  const ours = randomToken(32);
  await store(c.env).putCode({ code: ours, ...parsed.req, sub: connected.sub, created_at: Date.now() });
  return json({ ok: true, code: ours, agent: connected.agent });
});

app.post('/oauth/token', async (c) => {
  const body = new URLSearchParams(await c.req.text());
  // Spec 397 §11.4 — the connection-key client's access token lives as long as the wire it rides on; every other client
  // keeps the hour and refreshes.
  const opts = body.get('client_id') === KEY_CLIENT_ID ? { ...c.env, accessTtlSeconds: KEY_ACCESS_TTL_SECONDS } : c.env;
  return tokenEndpoint(opts, store(c.env), body, c.req.header('authorization') ?? null, resourceOf(c));
});

// ── Operator (spec 397 §11.1): list registrations; allow ONE for scope act. The secret is the operator's; a host's own
//    registration body can never set the flag. ──
app.get('/oauth/clients', async (c) => {
  if (!operatorAllowed(c.env, c.req.header('x-act-registration'))) return json({ error: 'forbidden', error_description: 'the operator secret is required' }, 403);
  return json({ ok: true, clients: await listClients(store(c.env)) });
});
app.post('/oauth/clients/:id/act', async (c) => {
  if (!operatorAllowed(c.env, c.req.header('x-act-registration'))) return json({ error: 'forbidden', error_description: 'the operator secret is required' }, 403);
  const body = (await c.req.json().catch(() => ({}))) as { allow?: unknown };
  const r = await setClientAct(store(c.env), c.req.param('id'), body.allow !== false);
  return r.ok ? json(r) : json({ error: 'not_found', error_description: r.error }, 404);
});

// ── Connection key (spec 397 §11.4): the person mints a bearer for THIS resource in her own browser, by the same
//    authorization flow, the Worker as its own curated client. Shown once; the wire's revocation ends it. ──
app.get('/connect/key', (c) => c.html(keyStartPage(originOf(c), c.env.HOME_ORIGIN)));
app.get('/connect/key/start', async (c) => {
  const scope = (new URL(c.req.url).searchParams.get('scope') ?? 'ask').trim() === 'ask act' ? 'ask act' : 'ask';
  if (scope === 'ask act' && (!c.env.CLIENT_ID_ACT || !actKeyAddress(c.env))) return c.html(keyErrorPage(originOf(c), 'scope act is not served by this Home MCP'), 400);
  await ensureKeyClient(store(c.env), originOf(c));
  const verifier = randomToken(48);
  const state = randomToken(16);
  const challenge = await sha256b64(verifier);
  const q = new URLSearchParams({ response_type: 'code', client_id: KEY_CLIENT_ID, redirect_uri: `${originOf(c)}/connect/key/done`, code_challenge: challenge, code_challenge_method: 'S256', resource: resourceOf(c), scope, state });
  c.header('set-cookie', keyCookie(`${state}.${verifier}`, PENDING_TTL_MS / 1000));
  return c.redirect(`${originOf(c)}/oauth/authorize?${q.toString()}`, 302);
});
app.get('/connect/key/done', async (c) => {
  const q = new URL(c.req.url).searchParams;
  const ck = readKeyCookie(c.req.header('cookie'));
  c.header('set-cookie', keyCookie('', 0));
  if (!ck || q.get('state') !== ck.state) return c.html(keyErrorPage(originOf(c), 'this browser holds no pending key request (start again, in the same browser).'), 400);
  const code = q.get('code');
  if (!code) return c.html(keyErrorPage(originOf(c), q.get('error_description') ?? 'the authorization returned no code'), 400);
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: KEY_CLIENT_ID, redirect_uri: `${originOf(c)}/connect/key/done`, code_verifier: ck.verifier, resource: resourceOf(c) });
  const tok = (await (await tokenEndpoint({ ...c.env, accessTtlSeconds: KEY_ACCESS_TTL_SECONDS }, store(c.env), body, null, resourceOf(c))).json().catch(() => null)) as { access_token?: string; scope?: string; expires_in?: number; error_description?: string } | null;
  if (!tok?.access_token) return c.html(keyErrorPage(originOf(c), tok?.error_description ?? 'the code could not be exchanged'), 400);
  return c.html(keyDonePage(originOf(c), tok.access_token, tok.scope ?? 'ask', tok.expires_in ?? KEY_ACCESS_TTL_SECONDS));
});
app.post('/oauth/revoke', async (c) => revokeEndpoint(c.env, store(c.env), new URLSearchParams(await c.req.text()), c.req.header('authorization') ?? null));

/** The person behind a bearer: the token row → the sealed wire → the identity this Worker asks as. */
async function personOf(env: Env, sub: string, token?: { client_id: string; scope: string[] }): Promise<Person | null> {
  const row = await store(env).getPerson(sub);
  if (!row || !env.HOME_MCP_PRIVATE_KEY) return null;
  const kek = await kekFrom(tokenSecret(env));
  const wire = await openWire(kek, row.wire_enc, row.wire_iv);
  // Spec 397 §11 — the act grant is opened only for a bearer whose scope includes `act`; an ask-only client of the same
  // person never sees it, and it is never on the bearer. The client id is what the receipt names.
  const act = token && requestsAct(token.scope) && row.act_enc && row.act_iv ? (await openWire(kek, row.act_enc, row.act_iv)) as unknown as ActGrantV1 : undefined;
  return { sub, identity: { agent: row.agent, privateKey: env.HOME_MCP_PRIVATE_KEY as Hex, wire }, ...(row.agent_name ? { agentName: row.agent_name } : {}), ...(token ? { client: token.client_id } : {}), ...(act && act.v === 1 ? { act } : {}) };
}

/** Her agent refused the wire this connection holds: the connection is over. Thrown from a tool call; the transport
 *  answers 401 with the resource metadata (a conformant host re-authorizes by itself) after the tokens are revoked. */
class ConnectionRefused extends Error { constructor(readonly words: string) { super(words); this.name = 'ConnectionRefused'; } }

/** ONE tool call, whichever transport carries it. */
async function callTool(env: Env, person: Person, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  console.log(`[home-mcp] tools/call ${name} as ${person.agentName ?? person.identity.agent}`);
  const run = async (p: Person): Promise<Record<string, unknown>> => {
    if (name === 'ask') return askTool(env, p, args);
    if (name === 'discover_agents') return discoverTool(env, p, args);
    if (name === 'inspect_agent') return inspectTool(env, p, args);
    if (name === 'public_shelf') return publicShelfTool(env, p, args);
    if (name === 'engage') return engageTool(env, p, args);
    if (name === 'my_runs') return myRunsTool(env, p, args);
    if (name === 'run') return runTool(env, p, args);
    if (name === 'grant_link') return grantLinkTool(env, p, args);
    throw new RpcError(RPC_ERROR.METHOD_NOT_FOUND, `unknown tool ${name}`);
  };
  let out = await run(person);
  // Spec 410 §1.2 step 4 — her agent refused the wire. Before the connection ends, ask once whether a credential
  // rotation at her Home re-issued it: `superseded` → hold the new object and retry this one call; anything else
  // → the refusal stands and the host re-authorizes.
  if (needsReauthorization(out) && env.CHAIN_ID && env.DELEGATION_MANAGER) {
    const fresh = await refreshWire(person.identity, env.A2A_ORIGIN, { chainId: Number(env.CHAIN_ID), delegationManager: env.DELEGATION_MANAGER as Hex }).catch((e: unknown) => ({ status: 'unavailable' as const, error: e instanceof Error ? e.message : String(e) }));
    if (fresh.status === 'superseded') {
      const row = await store(env).getPerson(person.sub);
      if (row) {
        const sealed = await sealWire(await kekFrom(tokenSecret(env)), fresh.wire);
        await store(env).putPerson({ ...row, wire_enc: sealed.enc, wire_iv: sealed.iv });
      }
      console.log(`[home-mcp] wire refreshed for ${person.agentName ?? person.identity.agent} (superseded → ${fresh.hash.slice(0, 12)}…)`);
      out = await run({ ...person, identity: { ...person.identity, wire: fresh.wire } });
    } else {
      console.log(`[home-mcp] wire refresh for ${person.agentName ?? person.identity.agent}: ${fresh.status}${fresh.status === 'unavailable' ? ` (${fresh.error})` : ''}`);
    }
  }
  if (needsReauthorization(out)) throw new ConnectionRefused(String(out.error));
  return toolResult(out, 'error' in out);
}

/** The connection is over: every token of this person for this client dies, the person row goes; the next request meets the challenge. */
async function endConnection(env: Env, sub: string, clientId: string): Promise<void> {
  await store(env).deleteTokensFor(sub, clientId).catch(() => undefined);
  // Spec 397 §11 — the act grant was that client's: it goes with the client. The ask wire (and the person row) goes
  // when no client of hers is live any more, as before.
  const row = await store(env).getPerson(sub).catch(() => null);
  const live = row ? await store(env).liveClientsFor(sub).catch(() => []) : [];
  if (row && live.length > 0) { if (row.act_enc) { const { act_enc: _a, act_iv: _b, ...rest } = row; await store(env).putPerson(rest as PersonRow).catch(() => undefined); } return; }
  await store(env).deletePerson(sub).catch(() => undefined);
}

const RESOURCES = (person: Person) => [
  { uri: 'ap://home-mcp/doctrine', name: 'How this connection works', description: 'What the Home MCP is, whose agent it speaks to, and what it will never do.', mimeType: 'text/markdown' },
  { uri: 'ap://person/agent-card', name: `${person.agentName ?? 'the person'}'s agent card`, description: 'The public A2A card of the person\'s own agent — who Claude is talking to through this connection.', mimeType: 'application/json' },
  { uri: 'ap://home-mcp/host', name: 'What this host declared', description: 'Diagnostics: what the connected client said it is and can do (elicitation, streams, progress), and how its last call arrived — so the person can see what their host actually uses.', mimeType: 'application/json' },
];

async function readResource(env: Env, person: Person, uri: string, sid: string): Promise<Record<string, unknown>> {
  if (uri === 'ap://home-mcp/host') {
    const sess = sid ? await store(env).getSession(sid) : null;
    const body = sess && sess.sub === person.sub
      ? { session: sid.slice(0, 8), protocolVersion: sess.protocolVersion, clientInfo: sess.clientInfo ?? null, declared: { elicitation: !!sess.caps?.elicitation, roots: !!sess.caps?.roots, sampling: !!sess.caps?.sampling, capabilities: Object.keys(sess.caps ?? {}) }, calls: sess.calls ?? 0, lastCall: sess.lastCall ?? null, note: 'What the host declared at initialize and how its last tools/call arrived. A host that accepts no event stream gets progress and elicitation as plain results (fields to relay); this is the record of which it is.' }
      : { note: 'no session: the host sent no Mcp-Session-Id (or one from another connection); initialize first' };
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(body, null, 2) }] };
  }
  if (uri === 'ap://home-mcp/doctrine') {
    const text = [`# ${SERVER.name}`, '', SERVER.instructions, '', '## The rule', '', 'The bearer this client holds names which client of which person is calling; it never leaves this server. What reaches the person\'s agent is their own delegation to this server\'s key, pinned to the act of asking (`harness.ask`), revocable by them at their Home. Every act their agent would take still parks for THEIR signature at their Home — `grant_link` is the page; nothing here signs.', '', `Connected as: ${person.agentName ?? person.identity.agent} (${person.identity.agent})`].join('\n');
    return { contents: [{ uri, mimeType: 'text/markdown', text }] };
  }
  if (uri === 'ap://person/agent-card') {
    const label = (person.agentName ?? '').replace(/\.me$/, '');
    const pattern = env.AGENT_HOST_PATTERN ?? '';
    if (!label || !pattern.includes('{label}')) throw new RpcError(RPC_ERROR.INVALID_PARAMS, 'this person\'s agent has no public host this server can name');
    const url = `${pattern.replace('{label}', label)}/.well-known/agent-card.json`;
    const res = await fetch(url, { headers: { accept: 'application/json' } }).catch(() => null);
    if (!res || !res.ok) throw new RpcError(RPC_ERROR.INTERNAL_ERROR, `the card at ${url} answered ${res?.status ?? 'nothing'}`);
    return { contents: [{ uri, mimeType: 'application/json', text: await res.text() }] };
  }
  throw new RpcError(RPC_ERROR.INVALID_PARAMS, `unknown resource ${uri}`);
}

function registryFor(env: Env, person: Person, sid: string): MethodRegistry {
  return new MethodRegistry({ onError: (info) => console.error('[home-mcp]', info.method, info.error instanceof Error ? `${info.error.name}: ${info.error.message}` : String(info.error)) })
    .register('server/discover', () => buildServerDiscover({ serverInfo: SERVER_INFO, capabilities: CAPABILITIES }) as unknown as Record<string, unknown>)
    .register('tools/list', () => ({ tools: TOOLS }))
    .register('resources/list', () => ({ resources: RESOURCES(person) }))
    .register('resources/read', (params) => readResource(env, person, String(params?.uri ?? ''), sid))
    // A refused wire cannot be thrown through the registry (it would become "internal error"): it comes back as a
    // sentinel result the transport turns into the 401 challenge after ending the connection.
    .register('tools/call', async (params) => {
      try { return await callTool(env, person, typeof params?.name === 'string' ? params.name : '', (params?.arguments ?? {}) as Record<string, unknown>); }
      catch (e) { if (e instanceof ConnectionRefused) return { __connectionRefused: e.words }; throw e; }
    });
}

/** Spec 397 W3 — THE STREAMING CALL. Progress as the person's agent says what it is doing; a DATA question put to the
 *  person through the host when the client can (elicitation); then the result. A signature is never elicited. */
async function streamToolCall(env: Env, person: Person, req: { id: unknown; params?: Record<string, unknown> }, caps: Record<string, unknown> | null, writer: WritableStreamDefaultWriter<Uint8Array>, sid = ''): Promise<void> {
  const enc = new TextEncoder();
  const send = (m: unknown) => writer.write(enc.encode(sseFrame(m)));
  const name = typeof req.params?.name === 'string' ? req.params.name : '';
  const args = { ...((req.params?.arguments ?? {}) as Record<string, unknown>) };
  const meta = (req.params?._meta ?? {}) as { progressToken?: string | number };
  const progressToken = meta.progressToken;
  const longRunning = name === 'ask' || name === 'engage' || name === 'discover_agents';
  // The run reference for a FRESH ask is minted here so its progress can be tailed while it runs.
  const runRef = longRunning ? (typeof args.run === 'string' && args.run ? args.run : `ask-${randomToken(9)}`) : '';
  if (longRunning && !args.run) args._runRef = runRef;
  let stop = false; let n = 0;
  const tail = longRunning && progressToken !== undefined ? (async () => {
    let after = 0; let known = false;
    while (!stop) {
      const got = await progressAsPerson(person.identity, env.A2A_ORIGIN, runRef, after).catch(() => ({ lines: [], terminal: false, known: false }));
      known = known || got.known;
      for (const l of got.lines) { after = Math.max(after, l.seq); if (!l.terminal) { n += 1; await send(progressNotification(progressToken, n, l.said)); } }
      if (got.terminal || stop) break;
      if (!got.lines.length) await new Promise((r) => setTimeout(r, known ? 400 : 900));
    }
  })() : Promise.resolve();
  let result: Record<string, unknown>;
  try { result = await callTool(env, person, name, args); } catch (e) {
    stop = true; await tail.catch(() => undefined);
    // A refused wire on a stream: the stream cannot become a 401, so it says so and ends the connection — the host's
    // next request meets the challenge.
    if (e instanceof ConnectionRefused) await endConnection(env, person.sub, '').catch(() => undefined);
    await send({ jsonrpc: '2.0', id: req.id, error: { code: e instanceof RpcError ? e.code : e instanceof ConnectionRefused ? -32001 : RPC_ERROR.INTERNAL_ERROR, message: e instanceof Error ? e.message : String(e) } });
    return;
  }
  stop = true; await tail.catch(() => undefined);
  // ELICITATION — a data prompt, when the client said it can ask the person (bounded: three questions per call).
  for (let round = 0; round < 3; round++) {
    const sc = result.structuredContent as { kind?: string; prompt?: { kind?: string; prompt?: string; stepRef?: string; fields?: Array<{ name: string; label?: string; type?: string; required?: boolean; hint?: string }> }; resumeToken?: string; runRef?: string } | undefined;
    if (!caps?.elicitation || sc?.kind !== 'prompt' || sc.prompt?.kind !== 'data') break;
    const shaped = elicitationFor(sc.prompt);
    if (!shaped) break;
    const elicitId = `elicit-${randomToken(12)}`;
    const stepRef = sc.resumeToken ?? sc.prompt.stepRef ?? 's0';
    await store(env).putElicit(elicitId, { sub: person.sub, runRef: sc.runRef ?? runRef, stepRef });
    await send({ jsonrpc: '2.0', id: elicitId, method: 'elicitation/create', params: shaped });
    let answer: ElicitAnswer | undefined;
    for (let i = 0; i < 240 && !answer; i++) { await new Promise((r) => setTimeout(r, 500)); answer = (await store(env).getElicit(elicitId))?.answer; }
    await store(env).deleteElicit(elicitId);
    if (sid) await store(env).updateSession(sid, { lastCall: { at: Date.now(), name, acceptedStream: true, progressToken: progressToken !== undefined, streamed: true, elicitation: answer?.action ?? 'timeout' } }).catch(() => undefined);
    if (!answer || answer.action !== 'accept' || !answer.content) { result = toolResult({ ...(sc as Record<string, unknown>), elicitation: answer?.action ?? 'timeout', note: 'The person did not answer through the host; the run still waits — ask again with `supplied` when they do.' }); break; }
    result = await callTool(env, person, 'ask', { run: sc.runRef ?? runRef, supplied: [{ stepRef, data: answer.content }] }).catch((e) => toolResult({ error: e instanceof Error ? e.message : String(e) }, true));
  }
  await send({ jsonrpc: '2.0', id: req.id, result });
}

app.get('/mcp', (c) => c.json({ error: 'POST JSON-RPC to /mcp; no SSE stream is offered' }, 405));
app.post('/mcp', async (c) => {
  const resourceMetadataUrl = `${originOf(c)}/.well-known/oauth-protected-resource`;
  const token = await bearerOf(c.env, store(c.env), c.req.header('authorization') ?? null, resourceOf(c));
  if (!token) return buildUnauthorizedResponse({ resourceMetadataUrl, errorDescription: 'a bearer for this resource is required' });
  const raw = await c.req.text();
  // A JSON-RPC RESPONSE from the client: the answer to an elicitation this server asked on a stream (spec 397 W3).
  let asResponse: unknown = null; try { asResponse = JSON.parse(raw); } catch { /* parseJsonRpc says so below */ }
  if (isJsonRpcResponse(asResponse)) {
    const eid = String(asResponse.id);
    if (eid.startsWith('elicit-')) {
      const row = await store(c.env).getElicit(eid);
      if (!row || row.sub !== token.sub) return c.json({ jsonrpc: '2.0', id: null, error: { code: RPC_ERROR.INVALID_PARAMS, message: 'no elicitation waits under that id for this connection' } }, 404);
      const r = (asResponse.result ?? {}) as { action?: string; content?: Record<string, unknown> };
      const action = r.action === 'accept' || r.action === 'decline' || r.action === 'cancel' ? r.action : asResponse.error ? 'cancel' : 'decline';
      await store(c.env).answerElicit(eid, { action, ...(action === 'accept' && r.content && typeof r.content === 'object' ? { content: r.content } : {}) });
    }
    return c.body(null, 202);
  }
  const parsed = parseJsonRpc(raw);
  if (!parsed.ok) return c.json(parsed.res as unknown as Record<string, unknown>);
  const req = parsed.req;
  const meta = parseRequestMeta(req.params?._meta as Record<string, unknown> | undefined, c.req.header('mcp-protocol-version'));
  const requested = typeof req.params?.protocolVersion === 'string' ? req.params.protocolVersion : meta.protocolVersion;
  const version = negotiateProtocolVersion(requested) ?? SUPPORTED_PROTOCOL_VERSIONS[0];
  const id = req.id ?? null;
  if (req.method === 'initialize') {
    // The client's declared capabilities (elicitation above all) are kept under a session id it echoes on every request.
    const sid = randomToken(18);
    await store(c.env).putSession(sid, { sub: token.sub, caps: (req.params?.capabilities as Record<string, unknown> | undefined) ?? {}, protocolVersion: version, ...(req.params?.clientInfo && typeof req.params.clientInfo === 'object' ? { clientInfo: req.params.clientInfo as Record<string, unknown> } : {}), calls: 0 });
    return c.json({ jsonrpc: '2.0', id, result: { protocolVersion: version, capabilities: CAPABILITIES, serverInfo: SERVER_INFO, instructions: SERVER.instructions } }, 200, { 'mcp-session-id': sid });
  }
  if (req.method === 'notifications/initialized') return c.body(null, 202);
  if (req.method === 'ping') return c.json({ jsonrpc: '2.0', id, result: {} });
  const person = await personOf(c.env, token.sub, { client_id: token.client_id, scope: token.scope });
  if (!person) return buildUnauthorizedResponse({ resourceMetadataUrl, errorDescription: 'this person is no longer connected — authorize again' });
  // STREAMING (spec 397 W3): a tools/call whose client accepts an event stream gets progress, an elicitation when the
  // agent asks a data question and the client can put it to the person, then the result — on one SSE stream.
  const wantsStream = /text\/event-stream/i.test(c.req.header('accept') ?? '');
  const sid = c.req.header('mcp-session-id') ?? '';
  const sess = sid ? await store(c.env).getSession(sid) : null;
  const mine = !!sess && sess.sub === token.sub;
  // THE HOST'S RECORD: how this call arrived (diagnostics a person can read at ap://home-mcp/host).
  if (req.method === 'tools/call' && mine) {
    const name = String((req.params as { name?: unknown } | undefined)?.name ?? '');
    const progressToken = (req.params as { _meta?: { progressToken?: unknown } } | undefined)?._meta?.progressToken !== undefined;
    c.executionCtx.waitUntil(store(c.env).updateSession(sid, { calls: (sess!.calls ?? 0) + 1, lastCall: { at: Date.now(), name, acceptedStream: wantsStream, progressToken, streamed: wantsStream } }).catch(() => undefined));
  }
  if (wantsStream && req.method === 'tools/call') {
    const caps = mine ? sess!.caps : null;
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const work = streamToolCall(c.env, person, req as { id: unknown; params?: Record<string, unknown> }, caps, writer, mine ? sid : '').catch((e) => console.error('[home-mcp] stream', e instanceof Error ? e.message : String(e))).finally(() => writer.close().catch(() => undefined));
    c.executionCtx.waitUntil(work);
    return new Response(readable, { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': '*' } });
  }
  const res = await registryFor(c.env, person, mine ? sid : '').dispatch(req, { meta, protocolVersion: version, raw });
  const refused = (res as { result?: { __connectionRefused?: string } } | null)?.result?.__connectionRefused;
  if (typeof refused === 'string') {
    // Spec 397 W4 — her agent refused the wire: this connection is over. The tokens die and the answer is the
    // challenge, so a conformant host re-runs authorization by itself instead of showing an error.
    await endConnection(c.env, token.sub, token.client_id);
    return buildUnauthorizedResponse({ resourceMetadataUrl, errorDescription: refused });
  }
  return res === null ? c.body(null, 202) : c.json(res as unknown as Record<string, unknown>);
});

export default app;
