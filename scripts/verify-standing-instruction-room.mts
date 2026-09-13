/**
 * Spec 394 W2 — THE ROOM IS A NAMESPACE, live (no model, no spend).
 *
 *   npx tsx scripts/verify-standing-instruction-room.mts
 *
 * alice declares "pay from alice3.treasury" WHILE ADDRESSING Missio Nexus (the room = the organization). Asked at
 * the organization, "send nathan.treasury 1 USDC" with no payer parks naming alice3 (`standing`). Asked at HOME, the
 * same sentence does NOT read that instruction — the payer comes from elsewhere (her marked primary, or a question).
 * Then the other direction: the room-scoped one cleared, a default declared at home (`any`) IS read at the
 * organization. Every run is left at authority_required: nothing signed, nothing moves.
 */
import { fixture as fx, HOME, resolveOrgAgent } from './fixture.mts';
const DEFAULT_TREASURY = process.env.STANDING_TREASURY ?? fx.treasuries.own;
const PAYEE = fx.treasuries.payee;
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300) }; } };
function fail(m: string): never { console.error(`\n✗ ${m}`); process.exit(1); }
type Binding = { arg: string; agent: string; label?: string; source: string };
type Reply = { kind: string; error?: string; runRef?: string; delegator?: string; prompt?: { kind: string; prompt: string; stepRef: string; fields?: Array<{ name: string }> }; result?: Record<string, unknown>; plannerTrace?: { bindings?: Binding[] } };
type Out = { ok?: boolean; reply?: Reply; error?: string };

const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: fx.people.steward, client_id: 'demo-jp' }) }));
if (!si.homeSession) fail(`no session: ${JSON.stringify(si).slice(0, 200)}`);
const ALICE = String(si.agent).toLowerCase();
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const post = async (path: string, body: Record<string, unknown>) =>
  j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' }, body: JSON.stringify({ session: si.homeSession, ...body }) }));
const askAt = (addressee: string, body: Record<string, unknown>): Promise<Out> => post('/harness/ask', { addressee, ...body }) as Promise<Out>;
const rel = await j(await fetch(`${HOME}/connect/related-orgs?person=${ALICE}`, { headers: { authorization: `Bearer ${si.homeSession}` } }));
const T_DEFAULT = String((rel.orgs ?? []).find((x: { orgName?: string }) => String(x.orgName ?? '').toLowerCase() === DEFAULT_TREASURY.toLowerCase())?.orgAgent ?? '').toLowerCase();
if (!T_DEFAULT) fail(`${DEFAULT_TREASURY} is not among alice's agents`);
const describe = (r: Reply | undefined) => `${r?.kind}${r?.prompt ? ` (${r.prompt.kind}: ${r.prompt.prompt.slice(0, 90)})` : ''}${r?.delegator ? ` · delegator ${r.delegator}` : ''}${r?.error ? ` — ${r.error}` : ''}`;
const payerOf = (r: Reply | undefined) => r?.plannerTrace?.bindings?.find((b) => b.arg === 'payer');
const nonce = Date.now().toString(36);
const PAY = { steps: [{ toolId: 'treasury.payment.execute', args: { payee: PAYEE, usdc: '1' } }] };
const ORG = process.env.ORG ? process.env.ORG.toLowerCase() : await resolveOrgAgent(si.homeSession);
const declareAt = async (addressee: string, label: string) => {
  let o = await askAt(addressee, { message: `from now on pay from ${DEFAULT_TREASURY} (${label} ${nonce})`, plan: { steps: [{ toolId: 'context.instruction.declare', args: { capability: 'treasury.payment.execute', value: DEFAULT_TREASURY } }] } });
  let r = o.reply;
  if (r?.kind !== 'prompt' || !r.prompt?.fields?.some((f) => f.name === 'keep')) fail(`${label}: expected the read-back: ${JSON.stringify(o).slice(0, 400)}`);
  o = await askAt(addressee, { runRef: r.runRef, supplied: [{ stepRef: r.prompt.stepRef, data: { keep: 'yes' } }] });
  r = o.reply;
  if (r?.kind !== 'done' && r?.kind !== 'answer') fail(`${label}: not kept: ${JSON.stringify(o).slice(0, 400)}`);
  console.log(`  declared at ${label}: context=${String(r.result?.context)}`);
  return String(r.result?.context);
};
const clear = async () => { for (const ctx of ['any', ORG]) await post('/harness/instructions/forget', { scope: { context: ctx, capability: 'treasury.payment.execute', arg: 'payer' } }); };

await clear();
// ── 1. declared AT the organization: read there, not at home ──
const ctx = await declareAt(ORG, 'the organization');
if (ctx !== ORG) fail(`the room should be the organization (${ORG}), got ${ctx}`);
let o = await askAt(ORG, { message: `send ${PAYEE} 1 USDC (${nonce}a)`, plan: PAY });
let p = payerOf(o.reply);
console.log(`  at the organization → ${describe(o.reply)} · payer ${p ? `${p.label ?? p.agent} (${p.source})` : 'none'}`);
if (o.reply?.kind !== 'authority_required' || String(o.reply.delegator).toLowerCase() !== T_DEFAULT || p?.source !== 'standing') fail('at the organization the room-scoped instruction should fill the payer');
o = await askAt(ALICE, { message: `send ${PAYEE} 1 USDC (${nonce}b)`, plan: PAY });
p = payerOf(o.reply);
console.log(`  at home → ${describe(o.reply)} · payer ${p ? `${p.label ?? p.agent} (${p.source})` : 'none'}`);
if (p?.source === 'standing' || (o.reply?.kind === 'authority_required' && String(o.reply.delegator).toLowerCase() === T_DEFAULT && p?.source === 'standing')) fail('a default declared for the organization was read at home');

// ── 2. declared at home (`any`): read at the organization too ──
await clear();
const ctx2 = await declareAt(ALICE, 'home');
if (ctx2 !== 'any') fail(`home should be \`any\`, got ${ctx2}`);
o = await askAt(ORG, { message: `send ${PAYEE} 1 USDC (${nonce}c)`, plan: PAY });
p = payerOf(o.reply);
console.log(`  at the organization (home default) → ${describe(o.reply)} · payer ${p ? `${p.label ?? p.agent} (${p.source})` : 'none'}`);
if (o.reply?.kind !== 'authority_required' || String(o.reply.delegator).toLowerCase() !== T_DEFAULT || p?.source !== 'standing') fail('a default declared at home should be read in the organization');
await clear();
console.log(`\n✓ spec 394 W2: a default declared for the organization filled the payer there and not at home; a default declared at home was read in the organization. Nothing signed, nothing moved.`);
