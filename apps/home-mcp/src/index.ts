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
import { progressAsPerson } from './a2a.js';
import { authorizationServerMetadata, parseAuthorize, registerClient, tokenEndpoint, revokeEndpoint, bearerOf, PENDING_TTL_MS } from './oauth.js';
import { TOOLS, askTool, grantLinkTool, discoverTool, engageTool, runTool, myRunsTool, type Person } from './tools.js';
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
  HOME_MCP_PRIVATE_KEY?: string;
  TOKEN_SECRET?: string;
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

app.get('/health', (c) => c.json({ ok: true, service: 'home-mcp', spec: 397, tools: TOOLS.map((t) => t.name), home: c.env.HOME_ORIGIN }));
app.get('/', (c) => c.json({ service: SERVER.name, mcp: `POST ${resourceOf(c)} (Streamable HTTP; OAuth 2.1 — see /.well-known/oauth-protected-resource)`, tools: TOOLS.map((t) => t.name), doctrine: SERVER.instructions }));

// ── RFC 9728 / RFC 8414 ──
app.get('/.well-known/oauth-protected-resource', (c) => serveProtectedResourceMetadata(createProtectedResourceMetadata({ resource: resourceOf(c), authorizationServers: [originOf(c)], scopesSupported: [...SCOPES], resourceDocumentation: `${originOf(c)}/` })));
app.get('/.well-known/oauth-protected-resource/mcp', (c) => serveProtectedResourceMetadata(createProtectedResourceMetadata({ resource: resourceOf(c), authorizationServers: [originOf(c)], scopesSupported: [...SCOPES], resourceDocumentation: `${originOf(c)}/` })));
app.get('/.well-known/oauth-authorization-server', (c) => c.json(authorizationServerMetadata(originOf(c), SCOPES)));

// ── RFC 7591 ──
app.post('/oauth/register', async (c) => registerClient(store(c.env), (await c.req.json().catch(() => ({}))) as Record<string, unknown>));

// ── /oauth/authorize — validated here, COMPLETED at the Home (a relying app never runs a credential ceremony). ──
app.get('/oauth/authorize', async (c) => {
  const parsed = await parseAuthorize(store(c.env), new URL(c.req.url).searchParams, resourceOf(c), SCOPES);
  if (!parsed.ok) return parsed.res;
  const id = randomToken(24);
  const homeVerifier = randomToken(48);
  const homeState = randomToken(16);
  await store(c.env).putPending({ id, ...parsed.req, home_verifier: homeVerifier, home_state: homeState, created_at: Date.now() });
  const home = new URL(c.env.HOME_ORIGIN);
  home.searchParams.set('client_id', c.env.CLIENT_ID);
  home.searchParams.set('redirect_uri', `${originOf(c)}/oauth/callback`);
  home.searchParams.set('response_type', 'code');
  home.searchParams.set('scope', 'openid agent');
  home.searchParams.set('state', `${id}.${homeState}`);
  home.searchParams.set('nonce', randomToken(12));
  home.searchParams.set('code_challenge', await sha256b64(homeVerifier));
  home.searchParams.set('code_challenge_method', 'S256');
  home.searchParams.set('delegation_template', 'ask-as-me');
  return c.redirect(home.toString(), 302);
});

/** The Home's token exchange → the id_token (who) and the ask-as-me delegation (how). Verified here against the Home's JWKS. */
async function connectFromHome(env: Env, exchange: { id_token?: string; delegation?: DelegationWireV1; agent_name?: string }, clientId: string): Promise<{ ok: true; sub: string; agent: string } | { ok: false; error: string }> {
  if (!exchange.id_token || !exchange.delegation) return { ok: false, error: 'the Home returned no id_token or no delegation' };
  const jwksUrl = env.BROKER_JWKS_URL ?? `${env.HOME_ORIGIN}/jwks`;
  const jwks = (await fetch(jwksUrl).then((r) => r.json()).catch(() => null)) as { keys: Array<JsonWebKey & { kid?: string; alg?: string }> } | null;
  if (!jwks) return { ok: false, error: 'the Home\'s JWKS could not be read' };
  const v = await verifyIdToken(exchange.id_token, { keys: await importJwks(jwks), expectedIss: env.HOME_ORIGIN, expectedAud: env.CLIENT_ID });
  if (!v.ok) return { ok: false, error: `the Home's id_token did not verify: ${v.reason}` };
  const agent = String(v.claims.sub).match(/0x[0-9a-fA-F]{40}$/)?.[0]?.toLowerCase();
  if (!agent) return { ok: false, error: 'the id_token names no agent' };
  const wire = exchange.delegation;
  const key = env.HOME_MCP_PRIVATE_KEY ? privateKeyToAccount(env.HOME_MCP_PRIVATE_KEY as Hex).address.toLowerCase() : '';
  // The wire is OURS to hold only if it names this Worker's key as delegate and the person as delegator.
  if (wire.delegator.toLowerCase() !== agent) return { ok: false, error: 'the delegation is not the connecting person\'s' };
  if (!key || wire.delegate.toLowerCase() !== key) return { ok: false, error: 'the delegation does not name this Home MCP\'s key' };
  const kek = await kekFrom(env.TOKEN_SECRET ?? 'unset');
  const sealed = await sealWire(kek, wire);
  const prior = await store(env).getPerson(v.claims.sub);
  // The person's REGISTRY NAME (alice.me) from the Home's reverse lookup — the id_token's agent_name is their display name.
  const rn = (await fetch(`${env.HOME_ORIGIN}/connect/reverse-name?address=${agent}`).then((r) => r.json()).catch(() => null)) as { name?: string | null } | null;
  const agentName = typeof rn?.name === 'string' && rn.name ? rn.name : (v.claims.agent_name ?? exchange.agent_name);
  const row: PersonRow = { sub: v.claims.sub, agent, ...(agentName ? { agent_name: agentName } : {}), wire_enc: sealed.enc, wire_iv: sealed.iv, wire_ref: '', connected_at: Date.now(), client_ids: [...new Set([...(prior?.client_ids ?? []), clientId])] };
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
  const exchange = (await fetch(`${c.env.HOME_ORIGIN}/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'authorization_code', code, code_verifier: pending.home_verifier, client_id: c.env.CLIENT_ID, redirect_uri: `${originOf(c)}/oauth/callback` }) }).then((r) => r.json()).catch(() => null)) as { id_token?: string; delegation?: DelegationWireV1; error?: string } | null;
  if (!exchange || exchange.error) return json({ error: 'access_denied', error_description: exchange?.error ?? 'the Home\'s token exchange failed' }, 400);
  const connected = await connectFromHome(c.env, exchange, pending.client_id);
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
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const q = new URLSearchParams({ client_id: String(body.client_id ?? ''), redirect_uri: String(body.redirect_uri ?? ''), response_type: 'code', code_challenge: String(body.code_challenge ?? ''), code_challenge_method: 'S256', resource: String(body.resource ?? resourceOf(c)), ...(typeof body.scope === 'string' ? { scope: body.scope } : {}) });
  const parsed = await parseAuthorize(store(c.env), q, resourceOf(c), SCOPES);
  if (!parsed.ok) return parsed.res;
  const signin = (await fetch(`${c.env.HOME_ORIGIN}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: String(body.handle ?? ''), client_id: c.env.CLIENT_ID, delegation_template: 'ask-as-me' }) }).then((r) => r.json()).catch(() => null)) as { id_token?: string; delegation?: DelegationWireV1; agent_name?: string; error?: string } | null;
  if (!signin || signin.error) return json({ error: 'access_denied', error_description: signin?.error ?? 'the Home refused the demo sign-in' }, 400);
  const connected = await connectFromHome(c.env, signin, parsed.req.client_id);
  if (!connected.ok) return json({ error: 'access_denied', error_description: connected.error }, 400);
  const ours = randomToken(32);
  await store(c.env).putCode({ code: ours, ...parsed.req, sub: connected.sub, created_at: Date.now() });
  return json({ ok: true, code: ours, agent: connected.agent });
});

app.post('/oauth/token', async (c) => tokenEndpoint(c.env, store(c.env), new URLSearchParams(await c.req.text()), c.req.header('authorization') ?? null, resourceOf(c)));
app.post('/oauth/revoke', async (c) => revokeEndpoint(c.env, store(c.env), new URLSearchParams(await c.req.text()), c.req.header('authorization') ?? null));

/** The person behind a bearer: the token row → the sealed wire → the identity this Worker asks as. */
async function personOf(env: Env, sub: string): Promise<Person | null> {
  const row = await store(env).getPerson(sub);
  if (!row || !env.HOME_MCP_PRIVATE_KEY) return null;
  const wire = await openWire(await kekFrom(env.TOKEN_SECRET ?? 'unset'), row.wire_enc, row.wire_iv);
  return { sub, identity: { agent: row.agent, privateKey: env.HOME_MCP_PRIVATE_KEY as Hex, wire }, ...(row.agent_name ? { agentName: row.agent_name } : {}) };
}

/** ONE tool call, whichever transport carries it. */
async function callTool(env: Env, person: Person, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  console.log(`[home-mcp] tools/call ${name} as ${person.agentName ?? person.identity.agent}`);
  if (name === 'ask') { const out = await askTool(env, person, args); return toolResult(out, 'error' in out); }
  if (name === 'discover_agents') { const out = await discoverTool(env, person, args); return toolResult(out, 'error' in out); }
  if (name === 'engage') { const out = await engageTool(env, person, args); return toolResult(out, 'error' in out); }
  if (name === 'my_runs') { const out = await myRunsTool(env, person, args); return toolResult(out, 'error' in out); }
  if (name === 'run') { const out = await runTool(env, person, args); return toolResult(out, 'error' in out); }
  if (name === 'grant_link') { const out = grantLinkTool(env, person, args); return toolResult(out, 'error' in out); }
  throw new RpcError(RPC_ERROR.METHOD_NOT_FOUND, `unknown tool ${name}`);
}

const RESOURCES = (person: Person) => [
  { uri: 'ap://home-mcp/doctrine', name: 'How this connection works', description: 'What the Home MCP is, whose agent it speaks to, and what it will never do.', mimeType: 'text/markdown' },
  { uri: 'ap://person/agent-card', name: `${person.agentName ?? 'the person'}'s agent card`, description: 'The public A2A card of the person\'s own agent — who Claude is talking to through this connection.', mimeType: 'application/json' },
];

async function readResource(env: Env, person: Person, uri: string): Promise<Record<string, unknown>> {
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

function registryFor(env: Env, person: Person): MethodRegistry {
  return new MethodRegistry({ onError: (info) => console.error('[home-mcp]', info.method, info.error instanceof Error ? `${info.error.name}: ${info.error.message}` : String(info.error)) })
    .register('server/discover', () => buildServerDiscover({ serverInfo: SERVER_INFO, capabilities: CAPABILITIES }) as unknown as Record<string, unknown>)
    .register('tools/list', () => ({ tools: TOOLS }))
    .register('resources/list', () => ({ resources: RESOURCES(person) }))
    .register('resources/read', (params) => readResource(env, person, String(params?.uri ?? '')))
    .register('tools/call', async (params) => callTool(env, person, typeof params?.name === 'string' ? params.name : '', (params?.arguments ?? {}) as Record<string, unknown>));
}

/** Spec 397 W3 — THE STREAMING CALL. Progress as the person's agent says what it is doing; a DATA question put to the
 *  person through the host when the client can (elicitation); then the result. A signature is never elicited. */
async function streamToolCall(env: Env, person: Person, req: { id: unknown; params?: Record<string, unknown> }, caps: Record<string, unknown> | null, writer: WritableStreamDefaultWriter<Uint8Array>): Promise<void> {
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
  try { result = await callTool(env, person, name, args); } catch (e) { stop = true; await tail.catch(() => undefined); await send({ jsonrpc: '2.0', id: req.id, error: { code: e instanceof RpcError ? e.code : RPC_ERROR.INTERNAL_ERROR, message: e instanceof Error ? e.message : String(e) } }); return; }
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
    await store(c.env).putSession(sid, { sub: token.sub, caps: (req.params?.capabilities as Record<string, unknown> | undefined) ?? {}, protocolVersion: version });
    return c.json({ jsonrpc: '2.0', id, result: { protocolVersion: version, capabilities: CAPABILITIES, serverInfo: SERVER_INFO, instructions: SERVER.instructions } }, 200, { 'mcp-session-id': sid });
  }
  if (req.method === 'notifications/initialized') return c.body(null, 202);
  if (req.method === 'ping') return c.json({ jsonrpc: '2.0', id, result: {} });
  const person = await personOf(c.env, token.sub);
  if (!person) return buildUnauthorizedResponse({ resourceMetadataUrl, errorDescription: 'this person is no longer connected — authorize again' });
  // STREAMING (spec 397 W3): a tools/call whose client accepts an event stream gets progress, an elicitation when the
  // agent asks a data question and the client can put it to the person, then the result — on one SSE stream.
  const wantsStream = /text\/event-stream/i.test(c.req.header('accept') ?? '');
  if (wantsStream && req.method === 'tools/call') {
    const sid = c.req.header('mcp-session-id') ?? '';
    const sess = sid ? await store(c.env).getSession(sid) : null;
    const caps = sess && sess.sub === token.sub ? sess.caps : null;
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const work = streamToolCall(c.env, person, req as { id: unknown; params?: Record<string, unknown> }, caps, writer).catch((e) => console.error('[home-mcp] stream', e instanceof Error ? e.message : String(e))).finally(() => writer.close().catch(() => undefined));
    c.executionCtx.waitUntil(work);
    return new Response(readable, { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': '*' } });
  }
  const res = await registryFor(c.env, person).dispatch(req, { meta, protocolVersion: version, raw });
  return res === null ? c.body(null, 202) : c.json(res as unknown as Record<string, unknown>);
});

export default app;
