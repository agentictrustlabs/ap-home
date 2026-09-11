/**
 * Spec 397 W2 — THE ENTERPRISE THROUGH THE PERSON'S AGENT, live (one model-backed hop: the ministry composes its plan).
 *
 *   npx tsx scripts/verify-home-mcp-discovery.mts
 *
 * alice, connected through the Home MCP as in W1, calls discover_agents for a study on justification: HER agent asks the
 * public registry and answers with Ligonier (by name). Then engage: HER agent sends her words to ligonier.svc as her,
 * under her forwarded credential; Ligonier's agent plans under its own content-catalog playbook and answers a six-week
 * study with links; the reply names the ministry as the source and her run records the hop. THE TWINS: engaging a name
 * the registry does not know is refused in words; an outside agent's answer is an observation (no act, no mandate
 * asked of her — the run completes without authority_required).
 */
import { createHash, randomBytes } from 'node:crypto';
const MCP = process.env.HOME_MCP_URL ?? 'https://home-mcp-faithnet.richardpedersen3.workers.dev';
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
function fail(m: string): never { console.error(`\n✗ ${m}`); process.exit(1); }
const b64u = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${MCP}${path}`, { method: 'POST', headers: { 'content-type': typeof body === 'string' ? 'application/x-www-form-urlencoded' : 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

// ── connect alice (W1's door) ──
const reg = await j(await post('/oauth/register', { client_name: 'verify-home-mcp-discovery', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }));
const verifier = b64u(randomBytes(48));
const conn = await j(await post('/oauth/demo-connect', { handle: 'alice', client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: b64u(createHash('sha256').update(verifier).digest()), resource: `${MCP}/mcp` }));
if (!conn.code) fail(`demo-connect: ${JSON.stringify(conn)}`);
const tok = await j(await post('/oauth/token', new URLSearchParams({ grant_type: 'authorization_code', code: conn.code, client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: verifier, resource: `${MCP}/mcp` }).toString()));
if (!tok.access_token) fail(`token: ${JSON.stringify(tok)}`);
const call = async (name: string, args: Record<string, unknown>) => { const r = await j(await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { authorization: `Bearer ${tok.access_token}` })); return { out: (r.result?.structuredContent ?? {}) as Record<string, unknown>, isError: !!r.result?.isError, raw: r }; };
const list = await j(await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, { authorization: `Bearer ${tok.access_token}` }));
const names = (list.result?.tools ?? []).map((t: { name: string }) => t.name);
console.log(`alice connected · agent ${conn.agent} · tools ${JSON.stringify(names)}`);
if (!names.includes('discover_agents') || !names.includes('engage')) fail('discover_agents / engage not offered');

// ── discover, through her agent ──
let t0 = Date.now();
const found = await call('discover_agents', { intent: 'a study on justification', capability: 'gc:CFnDiscipleshipCurricula', limit: 5 });
const agents = (found.out.agents ?? []) as Array<{ agent: string | null; name: string | null; displayName: string; relevance: number | null; card: string | null }>;
console.log(`discover → ${found.out.kind} · ${agents.length} agent(s) · ${Date.now() - t0} ms · run ${found.out.runRef}`);
for (const a of agents) console.log(`  ${a.displayName} · name ${a.name ?? '?'} · ${a.agent} · relevance ${a.relevance} · card ${a.card}`);
if (found.isError) fail(`discover: ${JSON.stringify(found.out).slice(0, 300)}`);
const lig = agents.find((a) => /ligonier/i.test(a.displayName) || a.name === 'ligonier.svc');
if (!lig?.name) fail('Ligonier was not found by name through her agent');

// ── engage, as her ──
t0 = Date.now();
const ASK = process.env.ASK ?? 'Build me a six-week study on justification from your catalog — one session a week, each naming its items with links.';
const eng = await call('engage', { agent: lig.name, message: ASK });
const said = String(eng.out.said ?? eng.out.text ?? '');
const via = eng.out.via as { name?: string; agent?: string; observedVia?: string; runRef?: string } | undefined;
console.log(`engage → kind ${eng.out.kind} · ${Date.now() - t0} ms · via ${via?.name ?? '?'} (${via?.observedVia ?? '?'}, its run ${via?.runRef ?? '-'}) · her run ${eng.out.runRef}`);
console.log(`  ${said.replace(/\s+/g, ' ').slice(0, 400)}…`); if (process.env.DEBUG) console.log('  keys', Object.keys(eng.out).join(','), 'text', String(eng.out.text ?? '').slice(0, 200));
if (eng.isError || eng.out.refused) fail(`engage: ${JSON.stringify(eng.out).slice(0, 400)}`);
const links = (said.match(/https:\/\/[a-z.]*ligonier\.org\/[^\s)>\]]+/g) ?? []).length;
console.log(`  ligonier.org links in the answer: ${links} · weeks named: ${(said.match(/week\s*\d/gi) ?? []).length}`);
if (via?.name !== 'ligonier.svc') fail(`the hop was not to ligonier.svc: ${JSON.stringify(via)}`);
if (links < 3) fail('the ministry\'s answer carries fewer than three links into its catalog');
if (eng.out.kind === 'authority_required') fail('an engagement asked for her authority — an observation must not');

// ── twin: a name the registry does not know ──
const bogus = await call('engage', { agent: 'nobody-here-zz.svc', message: 'hello' });
console.log(`twin · engage an unknown name → refused: ${String(bogus.out.refused ?? bogus.out.text ?? '').slice(0, 120)}`);
if (!bogus.out.refused && !/no agent|not found|names no/i.test(String(bogus.out.text ?? ''))) fail('an unknown name must be refused in words');
console.log('\n✓ spec 397 W2: found in the registry and engaged through her agent — Ligonier\'s own answer, with its links, as an observation of her run');
