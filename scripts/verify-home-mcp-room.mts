/**
 * Spec 397 — A ROOM THROUGH CLAUDE: asking AT an organization by name, under her standing there (no model; supplied plans).
 *
 *   npx tsx scripts/verify-home-mcp-room.mts
 *
 * alice, through Claude, asks missio-nexus.org "who is in this organization?": the Home MCP resolves the NAME through the
 * registry, her agent's app credential reaches the organization's agent, which derives her standing from ITS records and
 * answers the roster. Then a standing instruction declared AT the organization through Claude is the ROOM's (spec 394
 * W2): her Home lists it under that organization's context, and forgetting it there is enough. THE TWINS: a name nobody
 * registered is refused before anything is asked; a room's instruction is not her own agent's default.
 */
import { createHash, randomBytes } from 'node:crypto';
const MCP = process.env.HOME_MCP_URL ?? 'https://home-mcp-faithnet.richardpedersen3.workers.dev';
const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const ORG = 'missio-nexus.org';
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
function fail(m: string): never { console.error(`\n✗ ${m}`); process.exit(1); }
const b64u = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${MCP}${path}`, { method: 'POST', headers: { 'content-type': typeof body === 'string' ? 'application/x-www-form-urlencoded' : 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

const reg = await j(await post('/oauth/register', { client_name: 'verify-home-mcp-room', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }));
const verifier = b64u(randomBytes(48));
const conn = await j(await post('/oauth/demo-connect', { handle: 'alice', client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: b64u(createHash('sha256').update(verifier).digest()), resource: `${MCP}/mcp` }));
if (!conn.code) fail(`demo-connect: ${JSON.stringify(conn)}`);
const tok = await j(await post('/oauth/token', new URLSearchParams({ grant_type: 'authorization_code', code: conn.code, client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: verifier, resource: `${MCP}/mcp` }).toString()));
if (!tok.access_token) fail(`token: ${JSON.stringify(tok)}`);
const call = async (name: string, args: Record<string, unknown>) => { const r = await j(await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { authorization: `Bearer ${tok.access_token}` })); return { out: (r.result?.structuredContent ?? {}) as Record<string, unknown>, isError: !!r.result?.isError }; };
const orgInfo = await j(await fetch(`${HOME}/connect/name-info?name=${ORG}`)) as { agent?: string };
const ORG_ADDR = String(orgInfo.agent ?? '').toLowerCase();
if (!ORG_ADDR) fail(`${ORG} is not registered`);

// ── the roster, asked AT the organization by name ──
const roster = await call('ask', { addressee: ORG, message: 'who is in this organization?', plan: { steps: [{ toolId: 'organization.membership.list', args: {} }] } });
console.log(`ask at ${ORG} → ${roster.out.kind} · ${String(roster.out.text ?? roster.out.error ?? '').replace(/\s+/g, ' ').slice(0, 120)}…`);
if (roster.isError || roster.out.kind !== 'answer' || !/nathan|bob|carol|member/i.test(String(roster.out.text ?? ''))) fail(`the room did not answer its roster: ${JSON.stringify(roster.out).slice(0, 300)}`);

// ── TWIN: a name nobody registered ──
const nobody = await call('ask', { addressee: 'nobody-here-zz.org', message: 'hello' });
console.log(`twin · unknown room → ${nobody.isError ? `refused: ${String(nobody.out.error).slice(0, 90)}` : 'ANSWERED'}`);
if (!nobody.isError) fail('an unregistered room name must be refused before anything is asked');

// ── a standing instruction declared AT the room through Claude is the ROOM's ──
const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'alice', client_id: 'demo-web' }) }));
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const home = async (path: string, body: Record<string, unknown>) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' }, body: JSON.stringify({ session: si.homeSession, ...body }) }));
const forget = () => home('/harness/instructions/forget', { scope: { capability: 'treasury.payment.execute', arg: 'payer', context: ORG_ADDR } });
await forget();
const nonce = Date.now().toString(36);
let d = await call('ask', { addressee: ORG, message: `from now on pay from alice3.treasury here (${nonce})`, plan: { steps: [{ toolId: 'context.instruction.declare', args: { capability: 'treasury.payment.execute', value: 'alice3.treasury' } }] } });
console.log(`declare at ${ORG} → ${d.out.kind}${d.out.kind === 'prompt' ? `: "${(d.out.prompt as { prompt?: string })?.prompt}"` : ''}`);
if (d.out.kind === 'prompt') {
  const pr = d.out.prompt as { stepRef?: string; fields?: Array<{ name: string }> };
  const field = pr.fields?.find((f) => f.name === 'keep')?.name ?? pr.fields?.[0]?.name ?? 'keep';
  d = await call('ask', { addressee: ORG, run: d.out.runRef, supplied: [{ stepRef: pr.stepRef ?? 's0', data: { [field]: 'yes' } }] });
  console.log(`  confirmed → ${d.out.kind}`);
}
if (d.out.kind !== 'done' && d.out.kind !== 'answer') fail(`the room's instruction was not kept: ${JSON.stringify(d.out).slice(0, 300)}`);
const entries = ((await home('/harness/instructions', {})).entries ?? []) as Array<{ context?: string; capability: string; arg: string; value: string }>;
const room = entries.find((e) => e.capability === 'treasury.payment.execute' && e.arg === 'payer' && String(e.context ?? '').toLowerCase() === ORG_ADDR);
const own = entries.find((e) => e.capability === 'treasury.payment.execute' && e.arg === 'payer' && !e.context);
console.log(`twin · listed at her Home → room entry ${room ? 'yes' : 'NO'} · her own default ${own ? 'ALSO SET' : 'untouched'}`);
if (!room) fail('the instruction declared at the room through Claude is not listed under that room at her Home');
await forget();
const gone = ((await home('/harness/instructions', {})).entries ?? []) as Array<{ context?: string; arg: string }>;
if (gone.some((e) => e.arg === 'payer' && String(e.context ?? '').toLowerCase() === ORG_ADDR)) fail('forgetting at her Home did not clear the room entry');
console.log('\n✓ spec 397: a room through Claude — the organization answered under her standing; an instruction declared there is the room\'s, seen and cleared at her Home');
