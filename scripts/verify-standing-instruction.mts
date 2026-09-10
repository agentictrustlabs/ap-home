/**
 * Spec 394 W1 — STANDING INSTRUCTIONS, live on alice's own estate (no model, no spend).
 *
 *   npx tsx scripts/verify-standing-instruction.mts
 *
 * alice declares "from now on, pay from alice3.treasury" (a supplied plan; the agent reads it back; her supplied
 * yes is the write). Then "send nathan.treasury 1 USDC" with NO payer parks at authority_required naming
 * alice3.treasury as the delegator, the payer binding cited `standing`. THE TWINS: the same ask saying
 * `payer: alice2.treasury` names alice2 — a standing instruction never overrides a spoken value; after Forget, the
 * next ask does not name alice3. Every run is left at authority_required: nothing is signed, nothing moves.
 */
const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const DEFAULT_TREASURY = process.env.STANDING_TREASURY ?? 'alice3.treasury';
const OTHER_TREASURY = process.env.OTHER_TREASURY ?? 'alice2.treasury';
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300) }; } };
function fail(m: string): never { console.error(`\n✗ ${m}`); process.exit(1); }
type Binding = { arg: string; raw: string; agent: string; label?: string; source: string; because?: string };
type Reply = { kind: string; text?: string; error?: string; runRef?: string; delegator?: string; prompt?: { kind: string; prompt: string; stepRef: string; fields?: Array<{ name: string }> }; result?: Record<string, unknown>; plannerTrace?: { bindings?: Binding[] } };
type Out = { ok?: boolean; reply?: Reply; error?: string };

const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'alice', client_id: 'demo-jp' }) }));
if (!si.homeSession) fail(`no session: ${JSON.stringify(si).slice(0, 200)}`);
const ALICE = String(si.agent).toLowerCase();
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const post = async (path: string, body: Record<string, unknown>) =>
  j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' }, body: JSON.stringify({ session: si.homeSession, ...body }) }));
const ask = (body: Record<string, unknown>): Promise<Out> => post('/harness/ask', { addressee: ALICE, ...body }) as Promise<Out>;
const list = async () => { const o = await post('/harness/instructions', {}); if (!o.ok) fail(`list: ${JSON.stringify(o).slice(0, 200)}`); return o.entries as Array<{ context: string; capability: string; arg: string; value: string; label?: string }>; };
const describe = (r: Reply | undefined) => `${r?.kind}${r?.prompt ? ` (${r.prompt.kind}: ${r.prompt.prompt.slice(0, 110)})` : ''}${r?.delegator ? ` · delegator ${r.delegator}` : ''}${r?.error ? ` — ${r.error}` : ''}`;
const nonce = Date.now().toString(36);

// the two treasuries, by name → address (the resolver's own naming service, through the vocabulary's resolver)
const resolveName = async (name: string): Promise<string> => {
  const o = await post('/harness/resolve', { name });
  if (o.ok && typeof o.agent === 'string') return String(o.agent).toLowerCase();
  // fall back to alice's own links, which name her treasuries
  const rel = await j(await fetch(`${HOME}/connect/related-orgs?person=${ALICE}`, { headers: { authorization: `Bearer ${si.homeSession}` } }));
  const hit = (rel.orgs ?? []).find((x: { orgName?: string }) => String(x.orgName ?? '').toLowerCase() === name.toLowerCase());
  if (!hit) fail(`${name} is not among alice's agents`);
  return String(hit.orgAgent).toLowerCase();
};
const T_DEFAULT = await resolveName(DEFAULT_TREASURY);
const T_OTHER = await resolveName(OTHER_TREASURY);
console.log(`alice ${ALICE} · ${DEFAULT_TREASURY} ${T_DEFAULT} · ${OTHER_TREASURY} ${T_OTHER}`);

// ── 0. a clean slate for the scope under test ──
await post('/harness/instructions/forget', { scope: { capability: 'treasury.payment.execute', arg: 'payer' } });

// ── 1. declare: read back, then kept from the supplied yes ──
let o = await ask({ message: `from now on pay from ${DEFAULT_TREASURY} (${nonce})`, plan: { steps: [{ toolId: 'context.instruction.declare', args: { capability: 'treasury.payment.execute', value: DEFAULT_TREASURY } }] } });
let r = o.reply;
console.log(`  1. declare → ${describe(r)}`);
if (r?.kind !== 'prompt' || !r.prompt?.fields?.some((f) => f.name === 'keep')) fail(`expected the read-back prompt: ${JSON.stringify(o).slice(0, 500)}`);
if (!/alice3|${DEFAULT_TREASURY}|payer/i.test(r.prompt.prompt)) fail(`the read-back does not name the default: ${r.prompt.prompt}`);
o = await ask({ runRef: r.runRef, supplied: [{ stepRef: r.prompt.stepRef, data: { keep: 'yes' } }] });
r = o.reply;
console.log(`     yes → ${describe(r)}${r?.result?.kept !== undefined ? ` · kept=${String(r.result.kept)}` : ''}`);
if (r?.kind !== 'done' && r?.kind !== 'answer') fail(`the declaration did not land: ${JSON.stringify(o).slice(0, 500)}`);
const kept = (await list()).find((e) => e.capability === 'treasury.payment.execute' && e.arg === 'payer');
console.log(`     listed: ${kept ? `${kept.context} · ${kept.label ?? kept.value}` : 'NOT LISTED'}`);
if (!kept || kept.value !== T_DEFAULT) fail('the instruction is not in alice\'s vault (is `vault:standing.instructions` in her grant? re-issue with scripts/reissue-interactions-grants.mts alice)');

// ── 2. an unspoken payer is filled from it and cited ──
o = await ask({ message: `send nathan.treasury 1 USDC (${nonce}a)`, plan: { steps: [{ toolId: 'treasury.payment.execute', args: { payee: 'nathan.treasury', usdc: '1' } }] } });
r = o.reply;
const payer = r?.plannerTrace?.bindings?.find((b) => b.arg === 'payer');
console.log(`  2. pay, no payer → ${describe(r)} · payer binding ${payer ? `${payer.label ?? payer.agent} (${payer.source})` : 'none'}`);
if (r?.kind !== 'authority_required') fail(`expected the payment to wait on its mandate: ${JSON.stringify(o).slice(0, 500)}`);
if (String(r.delegator).toLowerCase() !== T_DEFAULT) fail(`the delegator should be ${DEFAULT_TREASURY} (the standing instruction), got ${r.delegator}`);
if (!payer || payer.source !== 'standing') fail(`the payer binding should cite standing: ${JSON.stringify(r.plannerTrace?.bindings)}`);

// ── 3. twin: a spoken payer is never overridden ──
o = await ask({ message: `send nathan.treasury 1 USDC from ${OTHER_TREASURY} (${nonce}b)`, plan: { steps: [{ toolId: 'treasury.payment.execute', args: { payer: OTHER_TREASURY, payee: 'nathan.treasury', usdc: '1' } }] } });
r = o.reply;
console.log(`  3. pay from ${OTHER_TREASURY} → ${describe(r)}`);
if (r?.kind !== 'authority_required' || String(r.delegator).toLowerCase() !== T_OTHER) fail(`a spoken payer must stand: ${JSON.stringify(o).slice(0, 400)}`);

// ── 4. forget: the next ask does not name the default ──
const f = await post('/harness/instructions/forget', { scope: { capability: 'treasury.payment.execute', arg: 'payer' } });
if (!f.ok) fail(`forget: ${JSON.stringify(f).slice(0, 200)}`);
o = await ask({ message: `send nathan.treasury 1 USDC (${nonce}c)`, plan: { steps: [{ toolId: 'treasury.payment.execute', args: { payee: 'nathan.treasury', usdc: '1' } }] } });
r = o.reply;
console.log(`  4. after forget → ${describe(r)}`);
if (r?.kind === 'authority_required' && String(r.delegator).toLowerCase() === T_DEFAULT && r.plannerTrace?.bindings?.some((b) => b.arg === 'payer' && b.source === 'standing')) fail('the cleared instruction still fills the payer');
console.log(`\n✓ spec 394 W1: declared on her yes, listed; filled the unspoken payer and cited standing; never over a spoken payer; cleared, it fills nothing. Every run left at authority_required — nothing signed, nothing moved.`);
