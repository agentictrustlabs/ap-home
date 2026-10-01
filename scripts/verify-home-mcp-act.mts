/**
 * Spec 397 §11 — ACT-AS-ME, live: THE SAME PAYMENT, FOUR WAYS (no model: supplied plans; two on-chain payments at most).
 *
 *   HOME_MCP_ACT_REGISTRATION_SECRET=… npx tsx scripts/verify-home-mcp-act.mts
 *
 * alice connects an ACT client (a registration that presented the operator's act secret; scope `ask act`) and
 * pre-authorizes ONE act: pay nathan.treasury up to 2 USDC from alice3.treasury. Then:
 *   1. within the cap  — pay 1 USDC: completes with NO second signature; the receipt names the client and act-as-me.
 *   2. over the cap    — pay 5 USDC: parks `authority_required`, grant_link still names her Home.
 *   3. after she revokes the payment wire on chain — pay 1 USDC again: refused / parked, never paid.
 *   4. an ask-as-me client (a plain registration, scope `ask`) — pay 1 USDC: parks, as it always did.
 * And the twin that holds throughout: Claude's dynamic registration cannot request scope `act` (invalid_scope), and
 * no record Claude reads carries the act wire or a signature.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createPublicClient, encodeFunctionData, http, type Address, type Hex } from 'viem';
import { hashDelegation, type Delegation } from '@agenticprimitives/delegation';
import { fixture as fx, HOME, A2A, HOME_MCP, skipUnless } from './fixture.mts';
const MCP = HOME_MCP;
const RPC = process.env.RPC_URL ?? `${A2A}/rpc`;
const CHAIN = 34348;
const DM = '0x710cb1bF08C234Df397e0910331e0A29710EF4F7' as Address;
const USDC = '0xdaE09066A2cc32f6203605619137dcF01A9B49Ae' as Address;
const ACT_SECRET = skipUnless(process.env.HOME_MCP_ACT_REGISTRATION_SECRET?.trim() || null, 'act registration secret (HOME_MCP_ACT_REGISTRATION_SECRET)');
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
function fail(m: string): never { console.error(`\n✗ ${m}`); process.exit(1); }
const b64u = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${MCP}${path}`, { method: 'POST', headers: { 'content-type': typeof body === 'string' ? 'application/x-www-form-urlencoded' : 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const nameOf = async (n: string): Promise<Address> => { const b = await j(await fetch(`${HOME}/connect/name-info?name=${encodeURIComponent(n)}`)); if (!b.exists || !b.agent) fail(`${n} is not registered`); return String(b.agent).toLowerCase() as Address; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PAYEE = await nameOf(fx.treasuries.payee);
/** The treasury HER AGENT pays from — read from the parked need of the ask-as-me ask below (way 4), never assumed. */
let TREASURY = '' as Address;
const CB = 'https://claude.ai/api/mcp/auth_callback';

/** Connect alice through a registration: `act` ⇒ the act set rides; else ask-as-me. Returns a tool caller. */
async function connect(name: string, act: boolean) {
  const reg = await j(await post('/oauth/register', { client_name: name, redirect_uris: [CB] }, act ? { 'x-act-registration': ACT_SECRET } : {}));
  if (!reg.client_id) fail(`register: ${JSON.stringify(reg)}`);
  const verifier = b64u(randomBytes(48));
  const body: Record<string, unknown> = { handle: fx.people.steward, client_id: reg.client_id, redirect_uri: CB, code_challenge: b64u(createHash('sha256').update(verifier).digest()), resource: `${MCP}/mcp`, scope: act ? 'ask act' : 'ask' };
  if (act) body.act = { capabilities: ['treasury.payment.execute'], payment: { treasury: TREASURY, payee: PAYEE, asset: USDC, maxAmount: '2000000' } };
  const conn = await j(await post('/oauth/demo-connect', body));
  if (!conn.code) fail(`demo-connect (${name}): ${JSON.stringify(conn)}`);
  const tok = await j(await post('/oauth/token', new URLSearchParams({ grant_type: 'authorization_code', code: conn.code, client_id: reg.client_id, redirect_uri: CB, code_verifier: verifier, resource: `${MCP}/mcp` }).toString()));
  if (!tok.access_token) fail(`token (${name}): ${JSON.stringify(tok)}`);
  const call = async (tool: string, args: Record<string, unknown>) => { const r = await j(await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }, { authorization: `Bearer ${tok.access_token}` })); return { out: (r.result?.structuredContent ?? {}) as Record<string, unknown>, isError: !!r.result?.isError }; };
  return { clientId: String(reg.client_id), agent: String(conn.agent).toLowerCase() as Address, scope: String(tok.scope ?? ''), call };
}
const pay = (usdc: string, tag: string) => ({ message: `pay ${PAYEE} ${usdc} usdc (${tag})`, plan: { steps: [{ toolId: 'treasury.payment.execute', args: { payee: PAYEE, usdc, memo: tag }, id: 's0' }] } });

// ── twin 0: a plain (Claude-style) registration may not request scope act ──
{
  const reg = await j(await post('/oauth/register', { client_name: 'verify-home-mcp-act-plain', redirect_uris: [CB] }));
  const verifier = b64u(randomBytes(48));
  const r = await j(await post('/oauth/demo-connect', { handle: fx.people.steward, client_id: reg.client_id, redirect_uri: CB, code_challenge: b64u(createHash('sha256').update(verifier).digest()), resource: `${MCP}/mcp`, scope: 'ask act', act: { capabilities: ['treasury.payment.execute'] } }));
  console.log(`twin · a plain registration asking for scope act → ${r.error ?? r.code ?? JSON.stringify(r).slice(0, 80)}`);
  if (r.error !== 'invalid_scope') fail(`a registration without the operator's say may not get scope act: ${JSON.stringify(r).slice(0, 300)}`);
}

// ── 4 (first, so the need is known): an ask-as-me client — the same payment parks, as it always did ──
const askC = await connect('verify-home-mcp-act-ask', false);
const nonce = Date.now().toString(36);
const four = await askC.call('ask', pay('1', `ask-as-me ${nonce}`));
console.log(`4 · ask-as-me client pays 1 USDC → ${four.out.kind} · pays from ${four.out.delegator}`);
if (four.out.kind !== 'authority_required' || !/^0x[0-9a-f]{40}$/i.test(String(four.out.delegator))) fail(`an ask-as-me client must park and name the treasury: ${JSON.stringify(four.out).slice(0, 400)}`);
TREASURY = String(four.out.delegator).toLowerCase() as Address;

// ── the act client: alice pre-authorizes one payment wire (payee nathan.treasury, cap 2 USDC, from that treasury) ──
const actC = await connect('verify-home-mcp-act', true);
console.log(`act client ${actC.clientId} · scope "${actC.scope}" · alice ${actC.agent}`);
if (!/\bact\b/.test(actC.scope)) fail(`the token should carry scope act: ${actC.scope}`);

// ── 1. within the cap: completes with no second signature ──
const one = await actC.call('ask', pay('1', `act-as-me within cap ${nonce}`));
const run1 = String(one.out.runRef ?? '');
console.log(`1 · pay 1 USDC → ${one.out.kind}${one.out.error ? ` ${one.out.error}` : ''} · run ${run1} · acted_under ${JSON.stringify(one.out.acted_under ?? null)}${one.out.act_note ? ` · ${String(one.out.act_note).slice(0, 160)}` : ''}`);
if (one.out.kind !== 'done') fail(`within the cap must complete without her signature: ${JSON.stringify(one.out).slice(0, 500)}`);
const au = one.out.acted_under as { template?: string; capability?: string; wire?: string } | undefined;
if (au?.template !== 'act-as-me' || au.capability !== 'treasury.payment.execute' || !au.wire) fail(`the reply must say it acted under act-as-me: ${JSON.stringify(one.out).slice(0, 300)}`);
await sleep(2500);
const rec = await actC.call('run', { run: run1 });
const steps = (rec.out.steps ?? []) as Array<{ toolId: string; txHash?: string }>;
const receipts = (rec.out.receipts ?? []) as Array<{ toolId: string; status: string }>;
console.log(`  run → outcome ${rec.out.outcome} · receipts ${JSON.stringify(receipts.map((x) => `${x.toolId}:${x.status}`))} · tx ${steps.find((s) => s.txHash)?.txHash?.slice(0, 14) ?? 'none'}…`);
if (rec.out.outcome !== 'completed' || !steps.some((s) => s.toolId === 'treasury.payment.execute' && s.txHash)) fail(`the record does not show the payment: ${JSON.stringify(rec.out).slice(0, 400)}`);
const recText = JSON.stringify(rec.out);
if (recText.includes('"signature"') || recText.toLowerCase().includes(au.wire.toLowerCase())) fail('the record view leaked the act wire or a signature');
console.log(`  record names act-as-me → ${recText.includes('act-as-me')} · names the client → ${recText.includes(actC.clientId)}`);

// ── 2. over the cap: parks for her signature ──
const two = await actC.call('ask', pay('5', `act-as-me over cap ${nonce}`));
console.log(`2 · pay 5 USDC → ${two.out.kind}${two.out.act_note ? ` · ${String(two.out.act_note).slice(0, 90)}` : ''}`);
if (two.out.kind !== 'authority_required') fail(`over the cap must park: ${JSON.stringify(two.out).slice(0, 400)}`);
const link = await actC.call('grant_link', { run: String(two.out.runRef) });
if (!String(link.out.url ?? '').includes('/you?run=')) fail(`grant_link must still name her Home: ${JSON.stringify(link.out)}`);

// ── 3. she revokes the payment wire on chain at her Home; the next payment is refused ──
const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: fx.people.steward, client_id: 'demo-web' }) }));
const auth = { authorization: `Bearer ${si.homeSession}` };
const grants = await j(await fetch(`${HOME}/connect/app-grants`, { headers: auth }));
const row = ((grants.grants ?? []) as Array<{ clientId: string; template: string; wires?: Array<{ capability: string; ref: Hex; wire: Delegation & { salt: string } }> }>).find((g) => g.clientId === 'home-mcp-act');
console.log(`Connected assistants → act row ${row ? `${row.template} with ${row.wires?.length ?? 0} wire(s)` : 'MISSING'}`);
const pw = row?.wires?.find((w) => w.capability === 'treasury.payment.execute');
if (!row || !pw) fail('her Home lists no act-as-me payment wire to revoke');
const wire = { ...pw.wire, salt: BigInt(pw.wire.salt) } as Delegation;
const digest = hashDelegation(wire, CHAIN, DM);
if (digest.toLowerCase() !== pw.ref.toLowerCase() || digest.toLowerCase() !== au.wire.toLowerCase()) fail(`the listed wire (${pw.ref.slice(0, 12)}…) is not the one the payment acted under (${au.wire.slice(0, 12)}…)`);
const REVOKE_ABI = [{ type: 'function', name: 'revokeDelegationByOwner', stateMutability: 'nonpayable', inputs: [{ name: 'delegation', type: 'tuple', components: [{ name: 'delegator', type: 'address' }, { name: 'delegate', type: 'address' }, { name: 'authority', type: 'bytes32' }, { name: 'caveats', type: 'tuple[]', components: [{ name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }, { name: 'args', type: 'bytes' }] }, { name: 'salt', type: 'uint256' }, { name: 'signature', type: 'bytes' }] }], outputs: [] }] as const;
const EXECUTE_ABI = [{ type: 'function', name: 'execute', stateMutability: 'nonpayable', inputs: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }], outputs: [] }] as const;
const inner = encodeFunctionData({ abi: REVOKE_ABI, functionName: 'revokeDelegationByOwner', args: [{ delegator: wire.delegator, delegate: wire.delegate, authority: wire.authority, caveats: wire.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: (c.args ?? '0x') as Hex })), salt: wire.salt, signature: wire.signature }] });
const callData = encodeFunctionData({ abi: EXECUTE_ABI, functionName: 'execute', args: [DM, 0n, inner] });
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const H = { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '', ...auth };
const sign = async (d: Hex): Promise<Hex> => { const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ digest: d }) })); if (!b.signature) throw new Error(`persona-sign: ${JSON.stringify(b).slice(0, 200)}`); return b.signature; };
let txHash: string | undefined;
for (let attempt = 0; attempt < 3 && !txHash; attempt++) {
  // The wire is the TREASURY's: the revoke is its own call, signed by the persona that custodies it.
  const b = await j(await fetch(`${HOME}/a2a/account/build-call-userop`, { method: 'POST', headers: H, body: JSON.stringify({ sender: wire.delegator, callData, session: si.homeSession }) }));
  if (!b.ok || !b.userOpHash) { console.log(`  build → ${JSON.stringify(b).slice(0, 200)}`); await sleep(2000); continue; }
  const signature = await sign(b.userOpHash);
  const s = await j(await fetch(`${HOME}/a2a/account/submit-call-userop`, { method: 'POST', headers: H, body: JSON.stringify({ userOp: { ...b.userOp, signature }, session: si.homeSession }) }));
  if (s.ok) txHash = s.transactionHash; else console.log(`  submit → ${JSON.stringify(s).slice(0, 200)}`);
}
if (!txHash) fail('the revocation could not be submitted from her treasury');
console.log(`3 · revoked on chain · tx ${txHash.slice(0, 14)}…`);
const pub = createPublicClient({ transport: http(RPC) });
let revoked = false;
for (let i = 0; i < 10 && !revoked; i++) { await sleep(1500); revoked = (await pub.readContract({ address: DM, abi: [{ type: 'function', name: 'isRevoked', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'bool' }] }], functionName: 'isRevoked', args: [digest] })) as boolean; }
if (!revoked) fail('the chain still honours the payment wire');
await fetch(`${HOME}/connect/app-grants`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ clientId: 'home-mcp-act', ref: pw.ref, revoked: true }) });
const three = await actC.call('ask', pay('1', `act-as-me after revoke ${nonce}`));
console.log(`  pay 1 USDC after the revoke → ${three.out.kind ?? three.out.error}${three.out.error ? ` ${String(three.out.error).slice(0, 100)}` : ''}`);
if (three.out.kind === 'done') fail(`a revoked wire paid: ${JSON.stringify(three.out).slice(0, 400)}`);
const after = await j(await fetch(`${HOME}/connect/app-grants`, { headers: auth }));
const rowAfter = ((after.grants ?? []) as Array<{ clientId: string; wires?: unknown[] }>).find((g) => g.clientId === 'home-mcp-act');
if (rowAfter?.wires?.length) fail('the revoked wire is still listed under Connected assistants');

console.log(`1 · pay 1 USDC → ${one.out.kind}${one.out.error ? ` ${one.out.error}` : ''} · run ${run1} · acted_under ${JSON.stringify(one.out.acted_under ?? null)}${one.out.act_note ? ` · ${String(one.out.act_note).slice(0, 160)}` : ''}`);console.log('\n✓ spec 397 §11: within the cap paid without a second signature; over the cap parked; after her revoke refused; ask-as-me still parks; a plain registration cannot request act');
