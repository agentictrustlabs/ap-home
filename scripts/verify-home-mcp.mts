/**
 * Spec 397 W1 — THE HOME MCP, live (Claude's entrance to a PERSON's own agent).
 *
 *   npx tsx scripts/verify-home-mcp.mts
 *
 * An MCP client registers itself (RFC 7591), sends alice through the Home's connect (the demo-signin persona path,
 * template ask-as-me — a browser would land on the Home's own authorize), gets a code, exchanges it with PKCE for an
 * opaque bearer bound to /mcp, then initialize → tools/list → ask "who is in Missio Nexus?" — answered BY HER AGENT
 * with HER standing, the Home MCP speaking as her under her delegation to its key. THE TWINS: the bearer presented at
 * her agent's /harness/ask directly is refused (it is a token of the Home MCP, of nothing else); a second client's own
 * token sees nothing of hers (every bearer names its own connection); the resource-bound token is refused elsewhere.
 * No model unless the planner is under test: the ask carries a supplied plan (spec 392's rule).
 */
import { createHash, randomBytes } from 'node:crypto';
import { fixture as fx, A2A, HOME_MCP, memberWord, orgWord } from './fixture.mts';
const MCP = HOME_MCP;
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
function fail(m: string): never { console.error(`\n✗ ${m}`); process.exit(1); }
const b64u = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${MCP}${path}`, { method: 'POST', headers: { 'content-type': typeof body === 'string' ? 'application/x-www-form-urlencoded' : 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

// ── discovery: the resource says who authorizes it; the AS says how ──
const prm = await j(await fetch(`${MCP}/.well-known/oauth-protected-resource`));
const as = await j(await fetch(`${MCP}/.well-known/oauth-authorization-server`));
console.log(`PRM resource ${prm.resource} · AS ${as.issuer} · PKCE ${JSON.stringify(as.code_challenge_methods_supported)}`);
if (prm.resource !== `${MCP}/mcp` || as.issuer !== MCP) fail('metadata does not name this server');

// ── RFC 7591: the client registers itself ──
const reg = await j(await post('/oauth/register', { client_name: 'verify-home-mcp', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none' }));
if (!reg.client_id) fail(`register: ${JSON.stringify(reg)}`);
console.log(`client ${reg.client_id}`);

// ── alice connects (the persona path; a person would be on the Home's authorize) ──
const verifier = b64u(randomBytes(48));
const challenge = b64u(createHash('sha256').update(verifier).digest());
const conn = await j(await post('/oauth/demo-connect', { handle: fx.people.steward, client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: challenge, resource: `${MCP}/mcp`, scope: 'ask' }));
if (!conn.code) fail(`demo-connect: ${JSON.stringify(conn)}`);
console.log(`alice connected · agent ${conn.agent}`);

// ── the code → a bearer, with the verifier ──
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const tok = await j(await post('/oauth/token', form({ grant_type: 'authorization_code', code: conn.code, client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: verifier, resource: `${MCP}/mcp` })));
if (!tok.access_token) fail(`token: ${JSON.stringify(tok)}`);
console.log(`bearer ${tok.token_type} · expires ${tok.expires_in}s · scope ${tok.scope}`);

// ── MCP: initialize → tools/list → ask ──
const rpc = async (method: string, params: Record<string, unknown> = {}, bearer = tok.access_token as string) => post('/mcp', { jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method, params }, { authorization: `Bearer ${bearer}`, 'mcp-protocol-version': '2025-06-18' });
const noAuth = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
console.log(`no bearer → ${noAuth.status} · ${noAuth.headers.get('www-authenticate')?.slice(0, 80)}`);
if (noAuth.status !== 401 || !/resource_metadata/.test(noAuth.headers.get('www-authenticate') ?? '')) fail('unauthenticated /mcp must answer 401 with resource_metadata');
const init = await j(await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify', version: '0' } }));
if (!init.result?.serverInfo) fail(`initialize: ${JSON.stringify(init)}`);
const list = await j(await rpc('tools/list'));
const names = (list.result?.tools ?? []).map((t: { name: string }) => t.name);
console.log(`server ${init.result.serverInfo.name} · tools ${JSON.stringify(names)}`);
if (!names.includes('ask')) fail('no ask tool');

const plan = { steps: [{ toolId: 'organization.membership.list', args: { org: fx.org.name.toLowerCase() } }] }; // a supplied plan: the planner is not under test
const t0 = Date.now();
const ask = await j(await rpc('tools/call', { name: 'ask', arguments: { message: `who is in ${fx.org.name}?`, plan } }));
const out = ask.result?.structuredContent ?? {};
console.log(`ask → kind ${out.kind ?? '?'} · run ${out.runRef ?? '-'} · ${Date.now() - t0} ms · isError ${ask.result?.isError ?? false}`);
console.log(`  ${String(out.text ?? out.error ?? JSON.stringify(out)).slice(0, 300)}`);
if (ask.result?.isError || !out.kind) fail(`ask: ${JSON.stringify(ask).slice(0, 400)}`);
if (!orgWord().test(String(out.text ?? '')) && !memberWord().test(String(out.text ?? ''))) fail(`the answer does not speak of ${fx.org.name} or its members`);

// ── TWIN 1: the bearer at her agent directly is nothing ──
const direct = await fetch(`${A2A}/harness/ask`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok.access_token}` }, body: JSON.stringify({ addressee: conn.agent, message: `who is in ${fx.org.name}?` }) });
console.log(`twin · bearer at her agent → ${direct.status}`);
if (direct.status < 400) fail('the Home MCP bearer must be refused at her agent');

// ── TWIN 2: the token is bound to this resource ──
const elsewhere = await j(await post('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: reg.client_id, resource: 'https://other.example/mcp' })));
console.log(`twin · refresh for another resource → ${elsewhere.error ?? 'ISSUED'}`);
if (!elsewhere.error) fail('a token for another resource must be refused');

// ── TWIN 3: a second client's token is its own connection; her run is not its to resume ──
const reg2 = await j(await post('/oauth/register', { client_name: 'verify-home-mcp-2', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }));
const v2 = b64u(randomBytes(48));
const conn2 = await j(await post('/oauth/demo-connect', { handle: fx.people.member, client_id: reg2.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: b64u(createHash('sha256').update(v2).digest()), resource: `${MCP}/mcp` }));
const tok2 = await j(await post('/oauth/token', form({ grant_type: 'authorization_code', code: conn2.code, client_id: reg2.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: v2, resource: `${MCP}/mcp` })));
if (!tok2.access_token) fail(`second client token: ${JSON.stringify(tok2)}`);
// bob's connection names HER run and nothing else: at his agent there is no such run (a message would start his own).
const cross = await j(await rpc('tools/call', { name: 'ask', arguments: { run: out.runRef ?? 'run-none' } }, tok2.access_token));
const crossOut = cross.result?.structuredContent ?? {};
console.log(`twin · bob's client resumes alice's run → isError ${cross.result?.isError ?? false} · kind ${crossOut.kind ?? '-'} · ${String(crossOut.error ?? crossOut.text ?? '').slice(0, 120)}`);
if (out.runRef && !cross.result?.isError && crossOut.kind !== 'refused') fail("another connection resumed alice's run");

// ── revoke: the bearer dies ──
await post('/oauth/revoke', form({ token: tok.access_token, client_id: reg.client_id }));
const after = await rpc('tools/list');
console.log(`revoked → ${after.status}`);
if (after.status !== 401) fail('a revoked bearer must be refused');
console.log('\n✓ spec 397 W1: Claude\'s entrance to alice\'s agent — her connection, her standing, her agent\'s answer; the bearer is a token of the Home MCP and of nothing else');
