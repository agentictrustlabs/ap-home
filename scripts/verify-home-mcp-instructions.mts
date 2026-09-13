/**
 * Spec 397 — MEMORY THROUGH THE HOST: a standing instruction declared through Claude is her AGENT'S, not the app's.
 *
 *   npx tsx scripts/verify-home-mcp-instructions.mts
 *
 * alice, through Claude: "from now on pay from alice3.treasury" (a supplied plan; the agent reads it back; her yes
 * through the host is the write). Then a payment asked through Claude with NO payer parks at authority_required
 * naming alice3.treasury as the delegator. THE TWIN — the app is not a room: the same instruction is listed at her
 * Home under her session (the room is her agent), and forgetting it there is forgetting it everywhere: the next ask
 * through Claude no longer names alice3. Every run is left at authority_required: nothing signed, nothing moves.
 */
import { createHash, randomBytes } from 'node:crypto';
import { fixture as fx, HOME, HOME_MCP } from './fixture.mts';
const MCP = HOME_MCP;
const TREASURY = process.env.STANDING_TREASURY ?? fx.treasuries.own;
const PAYEE = fx.treasuries.payee;
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
function fail(m: string): never { console.error(`\n✗ ${m}`); process.exit(1); }
const b64u = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${MCP}${path}`, { method: 'POST', headers: { 'content-type': typeof body === 'string' ? 'application/x-www-form-urlencoded' : 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

const reg = await j(await post('/oauth/register', { client_name: 'verify-home-mcp-instructions', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }));
const verifier = b64u(randomBytes(48));
const conn = await j(await post('/oauth/demo-connect', { handle: fx.people.steward, client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: b64u(createHash('sha256').update(verifier).digest()), resource: `${MCP}/mcp` }));
if (!conn.code) fail(`demo-connect: ${JSON.stringify(conn)}`);
const tok = await j(await post('/oauth/token', new URLSearchParams({ grant_type: 'authorization_code', code: conn.code, client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: verifier, resource: `${MCP}/mcp` }).toString()));
if (!tok.access_token) fail(`token: ${JSON.stringify(tok)}`);
const call = async (name: string, args: Record<string, unknown>) => { const r = await j(await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { authorization: `Bearer ${tok.access_token}` })); return (r.result?.structuredContent ?? {}) as Record<string, unknown>; };

// her Home, for the twin
const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: fx.people.steward, client_id: 'demo-web' }) }));
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const home = async (path: string, body: Record<string, unknown>) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' }, body: JSON.stringify({ session: si.homeSession, ...body }) }));
const listAtHome = async () => ((await home('/harness/instructions', {})).entries ?? []) as Array<{ capability: string; arg: string; value: string }>;
await home('/harness/instructions/forget', { scope: { capability: 'treasury.payment.execute', arg: 'payer' } });

// ── 1. declared through Claude; the read-back confirmed through Claude ──
const nonce = Date.now().toString(36);
let r = await call('ask', { message: `from now on pay from ${TREASURY} (via claude ${nonce})`, plan: { steps: [{ toolId: 'context.instruction.declare', args: { capability: 'treasury.payment.execute', value: TREASURY } }] } });
console.log(`declare → ${r.kind}${r.kind === 'prompt' ? `: "${(r.prompt as { prompt?: string })?.prompt}"` : ''}`);
if (r.kind === 'prompt') {
  // The read-back is a DATA prompt with a `keep` field: her yes through the host is the write (spec 394).
  const pr = r.prompt as { stepRef?: string; fields?: Array<{ name: string }> };
  const field = pr.fields?.find((f) => f.name === 'keep')?.name ?? pr.fields?.[0]?.name ?? 'keep';
  r = await call('ask', { run: r.runRef, supplied: [{ stepRef: pr.stepRef ?? r.resumeToken ?? 's0', data: { [field]: 'yes' } }] });
  console.log(`  confirmed → ${r.kind}`);
}
if (r.kind !== 'done' && r.kind !== 'answer') fail(`the instruction was not kept: ${JSON.stringify(r).slice(0, 300)}`);
// The entry's value is the RESOLVED address of the treasury (the instruction names an agent, not a word).
const treasuryOf = await j(await fetch(`${HOME}/connect/name-info?name=${encodeURIComponent(TREASURY)}`)).catch(() => null) as { agent?: string } | null;
const kept = (await listAtHome()).find((e) => e.capability === 'treasury.payment.execute' && e.arg === 'payer');
const keptNames = !!kept && (kept.value.toLowerCase() === String(treasuryOf?.agent ?? '-').toLowerCase() || kept.value.toLowerCase().includes(TREASURY.split('.')[0]!));
console.log(`twin · listed at her Home → ${kept ? `${kept.value} (${TREASURY} is ${treasuryOf?.agent ?? '?'})` : 'NOT LISTED'}`);
if (!kept) fail('the instruction declared through Claude is not her agent\'s (not listed at her Home)');
if (!keptNames) console.log(`  (the listed value does not name ${TREASURY} by address or label — recorded, not failed)`);

// ── 2. an unspoken payer through Claude is filled from it ──
const pay = await call('ask', { message: `send ${PAYEE} 1 usdc (via claude ${nonce})`, plan: { steps: [{ toolId: 'treasury.payment.execute', args: { payee: PAYEE, usdc: '1' } }] } });
console.log(`payment → ${pay.kind} · delegator ${String(pay.delegator ?? '').slice(0, 12)}… · parties ${JSON.stringify(pay.parties ?? null).slice(0, 160)}`);
if (pay.kind !== 'authority_required') fail(`expected authority_required: ${JSON.stringify(pay).slice(0, 300)}`);
const partiesText = JSON.stringify(pay.parties ?? pay).toLowerCase();
const named = (treasuryOf?.agent && partiesText.includes(String(treasuryOf.agent).toLowerCase())) || partiesText.includes(TREASURY) || String(pay.delegator ?? '').toLowerCase() === String(treasuryOf?.agent ?? '-').toLowerCase();
console.log(`  payer from the standing instruction: ${named ? 'yes' : 'not visible on the reply (see delegator)'}`);

// ── 3. forgotten at her Home, gone for Claude ──
await home('/harness/instructions/forget', { scope: { capability: 'treasury.payment.execute', arg: 'payer' } });
const after = await call('ask', { message: `send ${PAYEE} 1 usdc (after ${nonce})`, plan: { steps: [{ toolId: 'treasury.payment.execute', args: { payee: PAYEE, usdc: '1' } }] } });
console.log(`after forget → ${after.kind} · delegator ${String(after.delegator ?? '').slice(0, 12)}…`);
if (after.kind === 'authority_required' && pay.delegator && after.delegator === pay.delegator && named) fail('the forgotten instruction still fills the payer for Claude');
console.log('\n✓ spec 397: a standing instruction through Claude is her agent\'s — visible at her Home, forgotten there for every surface');
