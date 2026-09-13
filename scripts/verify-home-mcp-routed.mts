/**
 * Spec 397 — THE ROUTED HOP THROUGH THE HOST, three ways (paced: the ministry's planner and composer are model calls).
 *
 *   npx tsx scripts/verify-home-mcp-routed.mts
 *
 * 1. FROM A ROOM: alice, through Claude, asks AT missio-nexus.org to engage ligonier.svc — the organization's agent
 *    routes the step under her forwarded credential (the profile names the room that routed), Ligonier answers.
 * 2. A QUESTION BACK: an ask that makes Ligonier prompt for an item id parks HER run with Ligonier's question and fields;
 *    Claude answers with ask { run, supplied } and the answer continues LIGONIER's run — the item comes back.
 * 3. PROGRESS FROM THE HOP: a streamed engage relays Ligonier's own progress lines ("ligonier.svc: …") to the host.
 * THE TWIN: the question parked her run only — no authority was asked of her for a read (kind is prompt, never authority_required).
 */
import { createHash, randomBytes } from 'node:crypto';
import { fixture as fx, HOME_MCP, skipUnless } from './fixture.mts';
const MCP = HOME_MCP;
const MIN = skipUnless(fx.ministry, 'ministry in the public registry with a content-catalog playbook');
const minOrg = MIN.org.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ANSWER_ID = process.env.ANSWER_ID ?? 'pauls-transformation-in-christ';
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
function fail(m: string): never { console.error(`\n✗ ${m}`); process.exit(1); }
const b64u = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${MCP}${path}`, { method: 'POST', headers: { 'content-type': typeof body === 'string' ? 'application/x-www-form-urlencoded' : 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

const reg = await j(await post('/oauth/register', { client_name: 'verify-home-mcp-routed', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }));
const verifier = b64u(randomBytes(48));
const conn = await j(await post('/oauth/demo-connect', { handle: fx.people.steward, client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: b64u(createHash('sha256').update(verifier).digest()), resource: `${MCP}/mcp` }));
if (!conn.code) fail(`demo-connect: ${JSON.stringify(conn)}`);
const tok = await j(await post('/oauth/token', new URLSearchParams({ grant_type: 'authorization_code', code: conn.code, client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: verifier, resource: `${MCP}/mcp` }).toString()));
if (!tok.access_token) fail(`token: ${JSON.stringify(tok)}`);
const auth = { authorization: `Bearer ${tok.access_token}` };
const call = async (name: string, args: Record<string, unknown>) => { const r = await j(await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, auth)); return { out: (r.result?.structuredContent ?? {}) as Record<string, unknown>, isError: !!r.result?.isError }; };
const ministryLinks = (text: string) => (text.match(new RegExp(`https://[a-z.]*${minOrg}/[^\\s)>\\]]+`, 'g')) ?? []).length;

// ── 1. from the room ──
let t0 = Date.now();
const room = await call('ask', { addressee: fx.org.handle, message: `ask ${MIN.svc} for three short teachings on justification with links`, plan: { steps: [{ toolId: 'engagement.agent.invoke', args: { agent: MIN.svc, message: 'Three short teachings on justification from your catalog, each with its link.' } }] } });
// The reply's `routed` steps are the room's own record of the hop: who answered, reached how, under which of its runs.
const roomRouted = ((room.out.routed as Array<{ agent: string; name?: string; observedVia: string; runRef?: string }> | undefined) ?? []);
const roomSaid = String(room.out.text ?? '');
console.log(`from the room → ${room.out.kind} · ${Date.now() - t0} ms · routed to ${roomRouted.map((r) => `${r.name ?? r.agent} (${r.observedVia})`).join(', ') || 'nobody'} · links ${ministryLinks(roomSaid)}`);
if (room.isError || room.out.kind !== 'answer') fail(`the room could not engage: ${JSON.stringify(room.out).slice(0, 400)}`);
if (!roomRouted.some((r) => r.name === MIN.svc) || ministryLinks(roomSaid) < 1) fail(`${MIN.name} did not answer the room's engagement: ${roomSaid.slice(0, 200)}`);

// ── 2. a question back, answered through the host ──
// Whether Ligonier ASKS (plans `catalog.resource.get` without the id → a data prompt, deterministic from there) or
// answers in prose ("what id?") is its planner's call on each turn; what this gate tests is the PARKING of a question
// that was asked. Bounded retries of the same call (ADR-0013) — three turns, the last one judged.
let asked!: Awaited<ReturnType<typeof call>>; let prompt: { kind?: string; prompt?: string; stepRef?: string; fields?: Array<{ name: string }> } | undefined;
for (let attempt = 1; attempt <= 3; attempt++) {
  t0 = Date.now();
  asked = await call('engage', { agent: MIN.svc, message: 'Fetch one specific item from your catalog by its id and give me its full record. I have the id ready — ask me for it.' });
  prompt = asked.out.prompt as typeof prompt;
  console.log(`engage (a question back)${attempt > 1 ? ` · attempt ${attempt}` : ''} → ${asked.out.kind} · ${Date.now() - t0} ms · "${String(prompt?.prompt ?? '').slice(0, 90)}" · fields ${JSON.stringify((prompt?.fields ?? []).map((f) => f.name))}`);
  if (asked.out.kind === 'authority_required') fail('a read asked for her authority');
  if (asked.out.kind === 'prompt') break;
  console.log(`  (Ligonier answered in prose instead of asking: "${String(asked.out.text ?? '').slice(0, 100)}" — its planner's turn, not the hop's; asking again)`);
}
if (asked.out.kind !== 'prompt' || prompt?.kind !== 'data' || !prompt.fields?.length) fail(`expected Ligonier's question to park her run: ${JSON.stringify(asked.out).slice(0, 400)}`);
const field = prompt.fields.find((f) => /id/i.test(f.name))?.name ?? prompt.fields[0]!.name;
t0 = Date.now();
const answered = await call('ask', { run: asked.out.runRef, supplied: [{ stepRef: (asked.out.resumeToken as string | undefined) ?? prompt.stepRef ?? 's0', data: { [field]: ANSWER_ID } }] });
const hop2 = ((answered.out.results as Array<{ toolId: string; result: Record<string, unknown> }> | undefined) ?? []).find((r) => r.toolId === 'engagement.agent.invoke')?.result ?? {};
const said2 = String((hop2.said as string | undefined) ?? answered.out.text ?? '');
console.log(`  answered → ${answered.out.kind} · ${Date.now() - t0} ms · ${said2.replace(/\s+/g, ' ').slice(0, 120)}…`);
if (answered.isError || (answered.out.kind !== 'answer' && answered.out.kind !== 'done')) fail(`the continuation did not finish: ${JSON.stringify(answered.out).slice(0, 400)}`);
if (!/transformation/i.test(said2) && !JSON.stringify(hop2).toLowerCase().includes(ANSWER_ID)) fail('the answered item did not come back');

// ── 3. progress from the hop, on a stream ──
const initRes = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify', version: '0' } } }, auth);
const sid = initRes.headers.get('mcp-session-id') ?? '';
const res = await post('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { _meta: { progressToken: 'p' }, name: 'engage', arguments: { agent: MIN.svc, message: 'What topics do you cover?' } } }, { ...auth, 'mcp-session-id': sid, accept: 'text/event-stream' });
if (!/text\/event-stream/.test(res.headers.get('content-type') ?? '')) fail('no stream');
const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = ''; const relayed: string[] = []; let own = 0; let final: Record<string, unknown> | undefined;
for (;;) {
  const { value, done } = await reader.read(); if (done) break;
  buf += dec.decode(value, { stream: true }); let i: number;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const frame = buf.slice(0, i); buf = buf.slice(i + 2);
    const data = frame.split('\n').find((l) => l.startsWith('data: '))?.slice(6); if (!data) continue;
    const m = JSON.parse(data) as { method?: string; params?: { message?: string }; result?: Record<string, unknown> };
    if (m.method === 'notifications/progress') { const msg = String(m.params?.message ?? ''); if (msg.startsWith(`${MIN.svc}:`)) relayed.push(msg); else own += 1; }
    else if (m.result) final = m.result;
  }
}
console.log(`streamed engage → ${own} own line(s), ${relayed.length} relayed from ${MIN.svc}${relayed[0] ? ` ("${relayed[0].slice(0, 70)}")` : ''} · result ${(final?.structuredContent as { kind?: string } | undefined)?.kind}`);
if (relayed.length < 1) fail('no progress line from the engaged agent reached the host');
console.log('\n✓ spec 397: routed through the host — from a room, a question back answered on her run and finished on Ligonier\'s, the hop\'s progress relayed');
