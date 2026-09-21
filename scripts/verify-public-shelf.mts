/**
 * Spec 412 — THE PUBLIC SHELF: what the owner marks public, served by the owner's agent to anyone (no model).
 *
 *   npx tsx scripts/verify-public-shelf.mts        (FIXTURE_JSON=… for another estate; role `steward`)
 *
 *   1. alice saves a markdown page + a private draft to HER Library through the Home's route, marks the folder public and
 *      the draft private (`visibility`) — the Home's GET says the effective policy of each;
 *   2. a STRANGER (no credential at all) reads her shelf over A2A at the interface her agent card names:
 *      `library.public.list` lists the page and not the draft, bodies stripped; `library.public.read` returns the page's text;
 *   3. the TWIN: the draft asked for BY ID on the same lane is "not on the shelf" and no byte of it leaves; a message with
 *      no public skill on the lane is still refused (401) — the door did not open for anything else;
 *   4. her Home's `/published` and `/published/<id>` render the same shelf and the same page for anyone;
 *   5. her own Ask answers "what have I made public" through the same read (`library.public.list`);
 *   6. W5 — HER AGENT WRITES: `library.file.save` (public) + `library.file.publish` through /harness/ask land a page in her
 *      vault with a release signed under her agent's session leaf; the stranger's lane serves it with the release;
 *   7. Claude's door: the Home MCP's `public_shelf` tool reads her shelf (and one document) exactly as the stranger did,
 *      connected as ANOTHER person — a public read spends nothing of theirs.
 */
import { createHash, randomBytes } from 'node:crypto';
import { personaCustodian } from '@agenticprimitives/runtime-member';
import { fixture as fx, HOME, HOME_MCP } from './fixture.mts';

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };
const me = await personaCustodian(HOME, fx.people.steward);
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const nonce = Date.now().toString(36);
const LIB = { 'content-type': 'application/json', authorization: `Bearer ${me.bearer}` };
const lib = async (body: Record<string, unknown>) => j(await fetch(`${HOME}/connect/library`, { method: 'POST', headers: LIB, body: JSON.stringify(body) }));
const personHome = `https://${fx.people.steward}.${new URL(HOME).host.replace(/^www\./, '')}`;
console.log(`── the public shelf · ${fx.people.steward} ${me.agent} · ${personHome} ──`);

// ── 1. a public folder, a page in it, a private draft beside it ──
const folder = `shelf-${nonce}`;
const f = await lib({ action: 'save', artifact: { name: folder, kind: 'md', source: 'blob', folder: '', isFolder: true } });
if (!f.ok) fail(`folder not saved: ${JSON.stringify(f).slice(0, 200)}`);
const pageText = `---\ntitle: On patience (${nonce})\nlicense: CC-BY-4.0\n---\n\n# On patience\n\nWait well. The public word is persimmon-${nonce}.\n`;
const page = await lib({ action: 'save', artifact: { id: `pg-${nonce}`, name: 'On patience.md', kind: 'md', source: 'blob', folder, bytesB64: b64(pageText), contentType: 'text/markdown', size: pageText.length } });
const draft = await lib({ action: 'save', artifact: { id: `dr-${nonce}`, name: 'Draft.md', kind: 'md', source: 'blob', folder, bytesB64: b64(`the private word is quince-${nonce}`), contentType: 'text/markdown', size: 30, accessPolicy: 'private' } });
if (!page.ok || !draft.ok) fail(`pages not saved: ${JSON.stringify({ page, draft }).slice(0, 300)}`);
const flip = await lib({ action: 'visibility', id: f.artifact.id, accessPolicy: 'public' });
if (!flip.ok || flip.artifact.accessPolicy !== 'public') fail(`the folder was not made public: ${JSON.stringify(flip).slice(0, 200)}`);
await lib({ action: 'publish', id: `pg-${nonce}` });
const got = await j(await fetch(`${HOME}/connect/library`, { headers: LIB }));
const eff = (id: string) => (got.artifacts as Array<{ id: string; effectiveAccessPolicy?: string }>).find((a) => a.id === id)?.effectiveAccessPolicy;
if (eff(`pg-${nonce}`) !== 'public' || eff(`dr-${nonce}`) !== 'private') fail(`effective policies wrong: page ${eff(`pg-${nonce}`)}, draft ${eff(`dr-${nonce}`)}`);
console.log(`  folder ${folder} public → the page is public by cascade, the draft private by its own word`);

// ── 2. a stranger reads the shelf over A2A, no credential ──
const shelfJson = await j(await fetch(`${personHome}/published/shelf`));
if (!shelfJson.ok || !shelfJson.endpoint) fail(`the Home could not name the agent's interface: ${JSON.stringify(shelfJson).slice(0, 300)}`);
const endpoint: string = shelfJson.endpoint;
const lane = async (data: Record<string, unknown>) => {
  const r = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'a2a-version': '1.0' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { messageId: `m-${Math.random().toString(36).slice(2)}`, role: 'ROLE_USER', parts: [{ data }] } } }) });
  return { status: r.status, body: await j(r) as { result?: { parts?: Array<{ data?: Record<string, unknown> }> }; error?: { message?: string } } };
};
const list = await lane({ skill: 'library.public.list', folder });
const files = (list.body.result?.parts?.find((p) => p.data)?.data?.files ?? []) as Array<{ id: string; isFolder: boolean; release?: { signed: boolean } | null }>;
if (list.status !== 200 || !files.some((x) => x.id === `pg-${nonce}`) || files.some((x) => x.id === `dr-${nonce}`)) fail(`the stranger's list is wrong (${list.status}): ${JSON.stringify(list.body).slice(0, 400)}`);
if (JSON.stringify(list.body).includes('persimmon') || JSON.stringify(list.body).includes('quince')) fail('the list carried bodies');
console.log(`  stranger · library.public.list at ${endpoint}: the page listed${files.find((x) => x.id === `pg-${nonce}`)?.release ? ' with its release' : ''}, the draft absent, no bodies`);
const read = await lane({ skill: 'library.public.read', id: `pg-${nonce}` });
const rd = read.body.result?.parts?.find((p) => p.data)?.data as { read?: boolean; text?: string; untrusted?: boolean } | undefined;
if (read.status !== 200 || rd?.read !== true || !String(rd.text).includes(`persimmon-${nonce}`) || rd.untrusted !== true) fail(`the stranger's read is wrong: ${JSON.stringify(read.body).slice(0, 400)}`);
console.log('  stranger · library.public.read: the page\'s text, marked untrusted');

// ── 3. twins: the draft by id; a non-public message ──
const twin = await lane({ skill: 'library.public.read', id: `dr-${nonce}` });
const td = twin.body.result?.parts?.find((p) => p.data)?.data as { read?: boolean } | undefined;
if (twin.status !== 200 || td?.read !== false || JSON.stringify(twin.body).includes('quince')) fail(`the private draft leaked or errored on the lane: ${JSON.stringify(twin.body).slice(0, 300)}`);
const closed = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'a2a-version': '1.0' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { messageId: 'x', role: 'ROLE_USER', parts: [{ text: 'what files do I have' }, { data: { skill: 'library.file.read', id: `dr-${nonce}` } }] } } }) });
if (closed.status !== 401) fail(`a non-public message was not refused on the anonymous door: ${closed.status} ${(await closed.text()).slice(0, 200)}`);
console.log('  twins: the draft by id → not on the shelf, nothing leaves; a private read on the anonymous door → 401');

// ── 4. the Home's pages ──
const shelfPage = await (await fetch(`${personHome}/published`)).text();
if (!shelfPage.includes(`On patience`) || shelfPage.includes('Draft.md')) fail('the /published page does not show the shelf (or shows the draft)');
const docPage = await (await fetch(`${personHome}/published/pg-${nonce}`)).text();
if (!docPage.includes(`persimmon-${nonce}`) || !docPage.includes('shelf-provenance')) fail('the /published/<id> page does not render the page with its provenance');
const notPage = await (await fetch(`${personHome}/published/dr-${nonce}`)).text();
if (!notPage.includes('shelf-not-public') || notPage.includes('quince')) fail('the private draft\'s page is not "not on the shelf"');
console.log(`  ${personHome}/published and /published/pg-${nonce} render it; the draft's page says not on the shelf`);

// ── 5. her own Ask, the same read ──
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' };
const ask = await j(await fetch(`${HOME}/a2a/harness/ask`, { method: 'POST', headers: H, body: JSON.stringify({ session: me.bearer, addressee: me.agent, message: 'what have I made public', plan: { steps: [{ toolId: 'library.public.list', args: { folder } }] } }) }));
const own = ((ask.reply?.results ?? []) as Array<{ toolId: string; result: { files?: Array<{ id: string }> } }>).find((x) => x.toolId === 'library.public.list')?.result;
if (ask.reply?.kind !== 'answer' || !own?.files?.some((x) => x.id === `pg-${nonce}`)) fail(`her Ask did not answer from the shelf: ${JSON.stringify(ask.reply ?? ask).slice(0, 400)}`);
console.log('  her Ask · library.public.list: the same shelf');

// ── 6. W5 — her agent writes: save (public) + publish, through her own harness ──
const written = await j(await fetch(`${HOME}/a2a/harness/ask`, { method: 'POST', headers: H, body: JSON.stringify({ session: me.bearer, addressee: me.agent, message: `keep this page as Agent page ${nonce}`, plan: { steps: [{ toolId: 'library.file.save', args: { id: `ag-${nonce}`, name: `Agent page ${nonce}.md`, folder, text: `# Agent page\n\nWritten by my agent — the word is tamarind-${nonce}.`, accessPolicy: 'public' } }] } }) }));
const wr = (written.reply?.result ?? {}) as { saved?: boolean; file?: { id: string; version: number } };
if (written.reply?.kind !== 'done' || wr.saved !== true || wr.file?.id !== `ag-${nonce}`) fail(`her agent did not save the page: ${JSON.stringify(written.reply ?? written).slice(0, 400)}`);
const released = await j(await fetch(`${HOME}/a2a/harness/ask`, { method: 'POST', headers: H, body: JSON.stringify({ session: me.bearer, addressee: me.agent, message: `publish a release of my page ${nonce}`, plan: { steps: [{ toolId: 'library.file.publish', args: { id: `ag-${nonce}` } }] } }) }));
const rl = (released.reply?.result ?? {}) as { published?: boolean; release?: { version: string; signed: boolean; signature?: string } };
if (released.reply?.kind !== 'done' || rl.published !== true || rl.release?.version !== '1.0.0' || rl.release.signed !== true || !String(rl.release.signature).startsWith('0x51')) fail(`her agent did not release the page under its session leaf: ${JSON.stringify(released.reply ?? released).slice(0, 400)}`);
const agentRead = await lane({ skill: 'library.public.read', id: `ag-${nonce}` });
const ar = agentRead.body.result?.parts?.find((p) => p.data)?.data as { read?: boolean; text?: string; file?: { release?: { signed: boolean } } } | undefined;
if (ar?.read !== true || !String(ar.text).includes(`tamarind-${nonce}`) || ar.file?.release?.signed !== true) fail(`the agent-written page is not on the stranger's lane with its release: ${JSON.stringify(agentRead.body).slice(0, 300)}`);
console.log(`  W5 · her agent saved + released the page (session-leaf signature); the stranger reads it with the release`);

// ── 7. Claude's door: the Home MCP's public_shelf, connected as the MEMBER (not the owner) ──
const b64u = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const mcpPost = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${HOME_MCP}${path}`, { method: 'POST', headers: { 'content-type': typeof body === 'string' ? 'application/x-www-form-urlencoded' : 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const reg = await j(await mcpPost('/oauth/register', { client_name: `verify-public-shelf-${nonce}`, redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }));
const v = b64u(randomBytes(48));
const conn = await j(await mcpPost('/oauth/demo-connect', { handle: fx.people.member, client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: b64u(createHash('sha256').update(v).digest()), resource: `${HOME_MCP}/mcp` }));
if (!conn.code) fail(`demo-connect ${fx.people.member}: ${JSON.stringify(conn).slice(0, 200)}`);
const tok = await j(await mcpPost('/oauth/token', new URLSearchParams({ grant_type: 'authorization_code', code: conn.code, client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: v, resource: `${HOME_MCP}/mcp` }).toString()));
if (!tok.access_token) fail(`token: ${JSON.stringify(tok).slice(0, 200)}`);
const mcpCall = async (args: Record<string, unknown>) => { const r = await j(await mcpPost('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'public_shelf', arguments: args } }, { authorization: `Bearer ${tok.access_token}` })); return (r.result?.structuredContent ?? {}) as Record<string, unknown>; };
const shelfViaMcp = await mcpCall({ agent: `${fx.people.steward}.me`, folder });
const mcpFiles = (shelfViaMcp.files ?? []) as Array<{ id: string }>;
if (!mcpFiles.some((x) => x.id === `ag-${nonce}`) || mcpFiles.some((x) => x.id === `dr-${nonce}`)) fail(`public_shelf through the Home MCP is wrong: ${JSON.stringify(shelfViaMcp).slice(0, 300)}`);
const docViaMcp = await mcpCall({ agent: `${fx.people.steward}.me`, id: `ag-${nonce}` });
if (docViaMcp.read !== true || !String(docViaMcp.text).includes(`tamarind-${nonce}`) || docViaMcp.untrusted !== true) fail(`public_shelf read through the Home MCP is wrong: ${JSON.stringify(docViaMcp).slice(0, 300)}`);
const privateViaMcp = await mcpCall({ agent: `${fx.people.steward}.me`, id: `dr-${nonce}` });
if (privateViaMcp.read !== false || JSON.stringify(privateViaMcp).includes('quince')) fail(`the private draft leaked through the Home MCP: ${JSON.stringify(privateViaMcp).slice(0, 200)}`);
await mcpPost('/oauth/revoke', new URLSearchParams({ token: tok.access_token, client_id: reg.client_id }).toString()).catch(() => undefined);
console.log(`  Claude's door · public_shelf as ${fx.people.member}: ${fx.people.steward}'s shelf and the page, the draft not on it`);

// tidy: the folder and everything under it
await lib({ action: 'delete', id: f.artifact.id });
console.log(`\n✓ spec 412: public by the owner's word (folder cascade, a private word holds); served by her agent to a stranger over A2A with no credential; the private draft never leaves; her Home's /published shows the same; her own Ask reads the same shelf; her agent writes and releases as her (W5); Claude reads it through the Home MCP.`);
