/**
 * Spec 397 W3 — AUTHORITY THROUGH THE HOST, live (no model: supplied plan; one on-chain payment of 1 USDC).
 *
 *   npx tsx scripts/verify-home-mcp-authority.mts
 *
 * alice, connected through the Home MCP, asks Claude to pay nathan.treasury 1 USDC. Her agent parks the run
 * `authority_required`; `grant_link` names the page on HER Home. THE TWIN FIRST: Claude's `ask { run }` before she
 * granted is `authority_required` again — never a payment. Then what her Home's /you?run= page does: her agent is
 * resumed under her session with the mandate she signs (persona-sign, prompt-free for a demo person) and the payment
 * runs. Then Claude's `run { run }` reads the record — the receipt with the transaction, no mandate — and `ask { run }`
 * on the finished run answers its record too. The bearer never signed anything.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Address, Hex } from 'viem';
import { hashDelegation, buildDigestBindingCaveat, paymentHandler, ROOT_AUTHORITY, registerDefaultSubsetHandlers, type Delegation, type Caveat, type MandateRequirementV1 } from '@agenticprimitives/delegation';
import { fixture as fx, HOME, HOME_MCP } from './fixture.mts';
registerDefaultSubsetHandlers();
const MCP = HOME_MCP;
const PAYEE = fx.treasuries.payee;
const CHAIN = 34348;
const DM = '0x710cb1bF08C234Df397e0910331e0A29710EF4F7' as Address;
const ENFORCERS = { delegationManager: DM, timestamp: '0x73A7B878168b7DE48677617179A8bE894f0Dfe96', allowedTargets: '0x2156311097A936de1916a878bF53Bfd43c7b5715', allowedMethods: '0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41', value: '0x8759c1a6cEBF1D5069e9434EF46327Bf2ef69975', payment: '0x07fA0aE59FdE4B7ce8962d6fE7a1d648ec3DD5CE', digestBinding: '0xA3bb9BCC9b2F6F2419E1aBe5ED6Fd5399b9E68e1' } as const;
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
function fail(m: string): never { console.error(`\n✗ ${m}`); process.exit(1); }
const b64u = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${MCP}${path}`, { method: 'POST', headers: { 'content-type': typeof body === 'string' ? 'application/x-www-form-urlencoded' : 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

// ── Claude's side: connect alice ──
const reg = await j(await post('/oauth/register', { client_name: 'verify-home-mcp-authority', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }));
const verifier = b64u(randomBytes(48));
const conn = await j(await post('/oauth/demo-connect', { handle: fx.people.steward, client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: b64u(createHash('sha256').update(verifier).digest()), resource: `${MCP}/mcp` }));
if (!conn.code) fail(`demo-connect: ${JSON.stringify(conn)}`);
const tok = await j(await post('/oauth/token', new URLSearchParams({ grant_type: 'authorization_code', code: conn.code, client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: verifier, resource: `${MCP}/mcp` }).toString()));
if (!tok.access_token) fail(`token: ${JSON.stringify(tok)}`);
const ALICE = String(conn.agent).toLowerCase() as Address;
const call = async (name: string, args: Record<string, unknown>) => { const r = await j(await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { authorization: `Bearer ${tok.access_token}` })); return { out: (r.result?.structuredContent ?? {}) as Record<string, unknown>, isError: !!r.result?.isError }; };

// ── the ask: a payment; it parks ──
const nonce = Date.now().toString(36);
const plan = { steps: [{ toolId: 'treasury.payment.execute', args: { payee: PAYEE, usdc: '1', memo: `via claude ${nonce}` }, id: 's0' }] };
const asked = await call('ask', { message: `pay ${PAYEE} 1 usdc (via claude ${nonce})`, plan });
const runRef = String(asked.out.runRef ?? '');
console.log(`ask → ${asked.out.kind} · run ${runRef} · ${String(asked.out.next ?? '').slice(0, 90)}…`);
if (asked.out.kind !== 'authority_required' || !runRef) fail(`expected authority_required: ${JSON.stringify(asked.out).slice(0, 400)}`);
const link = await call('grant_link', { run: runRef });
console.log(`grant_link → ${link.out.url}`);
if (!String(link.out.url ?? '').includes(`/you?run=${encodeURIComponent(runRef)}`)) fail(`the link does not name her Home's page: ${JSON.stringify(link.out)}`);

// ── TWIN: Claude asks again before she granted — still parked, never paid ──
const early = await call('ask', { run: runRef });
console.log(`twin · ask { run } before the grant → ${early.out.kind ?? early.out.error}`);
if (early.out.kind !== 'authority_required') fail(`the resume before her grant must park again: ${JSON.stringify(early.out).slice(0, 300)}`);

// ── her Home: /you?run= — the flyout resumes the run under HER session; she signs the mandate ──
const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: fx.people.steward, client_id: 'demo-web' }) }));
const sign = async (digest: Hex): Promise<Hex> => { const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${si.homeSession}` }, body: JSON.stringify({ digest }) })); if (!b.signature) throw new Error(`persona-sign: ${JSON.stringify(b).slice(0, 200)}`); return b.signature; };
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const home = async (body: Record<string, unknown>) => j(await fetch(`${HOME}/a2a/harness/ask`, { method: 'POST', headers: { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' }, body: JSON.stringify({ session: si.homeSession, addressee: ALICE, ...body }) }));
let r = await home({ runRef });
let rep = r.reply as { kind?: string; error?: string; runRef?: string; requirement?: MandateRequirementV1; delegator?: Address; delegate?: Address; prompt?: { kind?: string; stepRef?: string; digest?: Hex } };
console.log(`her Home resumes → ${rep?.kind}`);
if (rep?.kind !== 'authority_required' || !rep.requirement || !rep.delegator || !rep.delegate) fail(`the Home's resume should show the requirement: ${JSON.stringify(r).slice(0, 400)}`);
const caveats: Caveat[] = [...paymentHandler.toCaveats(rep.requirement, ENFORCERS as never), buildDigestBindingCaveat(ENFORCERS.digestBinding, 'intent', rep.requirement.intentDigest as Hex)];
let salt = 0n; for (const b of randomBytes(16)) salt = (salt << 8n) | BigInt(b);
const mandate: Delegation = { delegator: rep.delegator, delegate: rep.delegate, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
mandate.signature = await sign(hashDelegation(mandate, CHAIN, DM));
r = await home({ runRef, presented: { ...mandate, salt: salt.toString() } });
rep = r.reply;
for (let i = 0; i < 2 && rep?.kind === 'prompt' && rep.prompt?.kind === 'signature' && rep.prompt.digest; i++) {
  r = await home({ runRef, supplied: [{ stepRef: rep.prompt.stepRef ?? 's0', signature: { digest: rep.prompt.digest, signer: ALICE, signature: await sign(rep.prompt.digest) } }] });
  rep = r.reply;
}
console.log(`  she signed → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}`);
if (rep?.kind !== 'done') fail(`the payment did not finish at her Home: ${JSON.stringify(r).slice(0, 500)}`);

// ── Claude reads the outcome: the record, not a mandate ──
await new Promise((res) => setTimeout(res, 2500));
const rec = await call('run', { run: runRef });
const receipts = (rec.out.receipts ?? []) as Array<{ toolId: string; status: string; mandateRef?: string }>;
const steps = (rec.out.steps ?? []) as Array<{ toolId: string; txHash?: string }>;
console.log(`run → outcome ${rec.out.outcome} · receipts ${JSON.stringify(receipts.map((x) => `${x.toolId}:${x.status}`))} · tx ${steps.find((s) => s.txHash)?.txHash?.slice(0, 14) ?? 'none'}…`);
if (rec.isError || rec.out.outcome !== 'completed') fail(`the record does not show the payment: ${JSON.stringify(rec.out).slice(0, 400)}`);
if (!steps.some((s) => s.toolId === 'treasury.payment.execute' && s.txHash)) fail('no transaction on the payment step');
if (JSON.stringify(rec.out).includes('"signature"')) fail('the record view leaked a signature');
const again = await call('ask', { run: runRef });
console.log(`ask { run } after → ${again.out.kind ?? again.out.error}`);
if (again.out.kind !== 'done') fail(`the finished run should answer its record: ${JSON.stringify(again.out).slice(0, 300)}`);
const mine = await call('my_runs', { limit: 5 });
console.log(`my_runs → ${((mine.out.runs ?? []) as unknown[]).length} run(s), ${((mine.out.waitingOnThem ?? []) as unknown[]).length} waiting`);
console.log('\n✓ spec 397 W3: asked through Claude, parked for her, signed at her Home, finished; Claude read the receipt and never a signature');
