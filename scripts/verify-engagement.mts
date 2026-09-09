/**
 * Spec 384 W2 (appendix M7) — PROBE → OFFER → MANDATE, live.
 *
 *   npx tsx scripts/verify-engagement.mts
 *
 * alice's agent probes two candidates for `treasury.payment.execute` — runtime-c3s0.svc (a service agent:
 * a FIRM offer, signed as itself) and bob.me (a person's agent: a human channel is required) — and one
 * candidate for a capability nobody has (a decline). Then the accepted offer is fulfilled: a payment step
 * handed to the runtime with the offer's digest on it. Twin: a mandate that names NO offer is refused
 * (`offer-not-bound`) — an offer never becomes a commitment without the signature that names it; the mandate
 * that binds the offer runs the step at the provider.
 */
import { hashDelegation, buildDigestBindingCaveat, paymentHandler, ROOT_AUTHORITY, registerDefaultSubsetHandlers, type Delegation, type Caveat, type MandateRequirementV1 } from '../packages/delegation/src/index.js';
import type { Address, Hex } from 'viem';
registerDefaultSubsetHandlers();

const HOME = 'https://www.faithnet.me';
const CHAIN = 34348;
const DM = '0x710cb1bF08C234Df397e0910331e0A29710EF4F7' as Address;
const ENFORCERS = { delegationManager: DM, timestamp: '0x73A7B878168b7DE48677617179A8bE894f0Dfe96', allowedTargets: '0x2156311097A936de1916a878bF53Bfd43c7b5715', allowedMethods: '0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41', value: '0x8759c1a6cEBF1D5069e9434EF46327Bf2ef69975', payment: '0x07fA0aE59FdE4B7ce8962d6fE7a1d648ec3DD5CE', digestBinding: '0xA3bb9BCC9b2F6F2419E1aBe5ED6Fd5399b9E68e1' } as const;
const RUNTIME = '0x309b2a566e93cc77aabe895d0ec2702c36856ebd' as Address;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36';
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const alice = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'alice', client_id: 'demo-web' }) }));
const ALICE = String(alice.agent).toLowerCase() as Address;
const A2A = 'https://alice.faithnet.ai';
const csrfRes = await fetch(`${A2A}/auth/csrf`, { headers: { origin: HOME, 'user-agent': UA } });
const csrfTok = csrfRes.headers.get('x-csrf-token') || ((await j(csrfRes.clone())) as { token?: string }).token || '';
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const H = { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrfTok, 'user-agent': UA };
const post = async (path: string, body: unknown) => j(await fetch(`${A2A}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));
const sign = async (digest: Hex): Promise<Hex> => { const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.homeSession}` }, body: JSON.stringify({ digest }) })); if (!b.signature) throw new Error(`persona-sign refused: ${JSON.stringify(b).slice(0, 200)}`); return b.signature; };
const salt = () => { let s = 0n; for (const b of crypto.getRandomValues(new Uint8Array(16))) s = (s << 8n) | BigInt(b); return s; };
type Row = { agent: string; name: string | null; state: string; kind?: string; offer?: { offerId: string; offerDigest: string; expiresAt: string; provider: string; requirement: { intentDigest: string; projectionDigest?: string } }; reason?: string; refused?: string };
type Reply = { kind?: string; error?: string; runRef?: string; text?: string; requirement?: MandateRequirementV1 & { offerDigest?: Hex }; delegator?: Address; delegate?: Address; prompt?: { kind?: string; stepRef?: string; digest?: Hex }; routed?: Array<{ agent: string; observedVia: string; childRef?: string }>; results?: Array<{ toolId: string; result: { candidates?: Row[] } }> };

// ── 1. the probes ────────────────────────────────────────────────────────────────────────────────────
const nonce = Date.now().toString(36);
const words = `pay nathan.treasury 1 usdc (engagement ${nonce})`;
const r1 = await post('/harness/ask', { session: alice.homeSession, addressee: ALICE, message: `ask who would ${words}`, plan: { steps: [
  { toolId: 'engagement.probe', args: { capability: 'treasury.payment.execute', candidates: ['runtime-c3s0.svc', 'bob.me'], words }, id: 's0' },
  { toolId: 'engagement.probe', args: { capability: 'x.nobody.does', candidates: ['runtime-c3s0.svc'], words: 'do the impossible' }, id: 's1' },
] } });
const rep = r1.reply as Reply;
console.log(`probe → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}`);
if (rep?.kind !== 'answer') throw new Error(`expected an answer: ${JSON.stringify(r1).slice(0, 700)}`);
const rows0 = (rep.results?.find((x) => x.toolId === 'engagement.probe')?.result.candidates ?? []) as Row[];
const rows1 = (rep.results?.filter((x) => x.toolId === 'engagement.probe')[1]?.result.candidates ?? []) as Row[];
for (const r of [...rows0, ...rows1]) console.log(`  ${r.name ?? r.agent.slice(0, 10)}: ${r.kind ?? r.state}${r.reason ? ` — ${r.reason}` : ''}${r.refused ? ` — ${r.refused}` : ''}${r.offer ? ` — offer ${r.offer.offerId} digest ${r.offer.offerDigest.slice(0, 12)}… expires ${r.offer.expiresAt}` : ''}`);
const offerRow = rows0.find((r) => r.agent.toLowerCase() === RUNTIME && r.kind === 'offer' && r.offer);
if (!offerRow?.offer) throw new Error('runtime-c3s0.svc made no firm offer');
if (!rows0.some((r) => r.kind === 'human-ux-required')) throw new Error("bob's agent did not say a human channel is required");
if (!rows1.some((r) => r.kind === 'decline')) throw new Error('the runtime did not decline the capability it does not do');
console.log(`  ✓ one firm offer (signed by ${offerRow.offer.provider.slice(0, 10)}…), one human-channel answer, one decline — and nothing was accepted`);
const OFFER = offerRow.offer.offerDigest as Hex;

// ── 2. fulfilling the offer: the mandate must NAME it ────────────────────────────────────────────────
const plan = { steps: [{ toolId: 'treasury.payment.execute', args: { payee: 'nathan.treasury', usdc: '1', memo: `engagement ${nonce}`, offerDigest: OFFER }, id: 's0', executor: RUNTIME }] };
let r2 = await post('/harness/ask', { session: alice.homeSession, addressee: ALICE, message: words, plan });
let rep2 = r2.reply as Reply;
console.log(`act → ${rep2?.kind}${rep2?.error ? ` ${rep2.error}` : ''}; requirement.offerDigest = ${rep2?.requirement?.offerDigest?.slice(0, 12) ?? 'none'}…`);
if (rep2?.kind !== 'authority_required' || !rep2.requirement || !rep2.delegator || !rep2.delegate) throw new Error(`expected the mandate to be asked: ${JSON.stringify(r2).slice(0, 600)}`);
if (rep2.requirement.offerDigest?.toLowerCase() !== OFFER.toLowerCase()) throw new Error('the requirement does not name the offer');
const req = rep2.requirement;
const mint = async (withOffer: boolean): Promise<Record<string, unknown>> => {
  const caveats: Caveat[] = [...paymentHandler.toCaveats(req, ENFORCERS as never), buildDigestBindingCaveat(ENFORCERS.digestBinding, 'intent', req.intentDigest as Hex), ...(withOffer ? [buildDigestBindingCaveat(ENFORCERS.digestBinding, 'offer', OFFER)] : [])];
  const d: Delegation = { delegator: rep2.delegator!, delegate: rep2.delegate!, authority: ROOT_AUTHORITY, caveats, salt: salt(), signature: '0x' };
  d.signature = await sign(hashDelegation(d, CHAIN, DM));
  return { ...d, salt: d.salt.toString() };
};
// twin: a mandate that names NO offer
const r3 = await post('/harness/ask', { session: alice.homeSession, addressee: ALICE, runRef: rep2.runRef, presented: await mint(false) });
const rep3 = r3.reply as Reply;
console.log(`twin (mandate naming no offer) → ${rep3?.kind}: ${(rep3?.error ?? '').slice(0, 200)}`);
if (rep3?.kind === 'done' || rep3?.kind === 'prompt') throw new Error('a mandate that named no offer was accepted for a step that fulfils one');
if (!/offer-not-bound|names no offer/i.test(rep3?.error ?? '')) throw new Error(`refused for another reason: ${JSON.stringify(r3).slice(0, 400)}`);
console.log('  ✓ an offer never becomes a commitment without the signature that names it');
// the mandate that binds the offer
r2 = await post('/harness/ask', { session: alice.homeSession, addressee: ALICE, message: words, plan });
rep2 = r2.reply;
if (rep2?.kind !== 'authority_required') throw new Error(`re-ask: ${JSON.stringify(r2).slice(0, 300)}`);
let r4 = await post('/harness/ask', { session: alice.homeSession, addressee: ALICE, runRef: rep2.runRef, presented: await mint(true) });
let rep4 = r4.reply as Reply;
for (let i = 0; i < 2; i++) {
  const p = rep4?.prompt;
  if (rep4?.kind !== 'prompt' || p?.kind !== 'signature' || !p.digest) break;
  r4 = await post('/harness/ask', { session: alice.homeSession, addressee: ALICE, runRef: rep2.runRef, supplied: [{ stepRef: p.stepRef ?? 's0', signature: { digest: p.digest, signer: ALICE, signature: await sign(p.digest) } }] });
  rep4 = r4.reply;
}
console.log(`mandate naming the offer → ${rep4?.kind}${rep4?.error ? ` ${rep4.error}` : ''}; handed to ${rep4?.routed?.[0]?.agent?.slice(0, 10) ?? 'nobody'} (${rep4?.routed?.[0]?.observedVia ?? '-'})`);
if (rep4?.kind !== 'done') throw new Error(`the accepted offer was not fulfilled: ${JSON.stringify(r4).slice(0, 600)}`);
if (rep4.routed?.[0]?.agent?.toLowerCase() !== RUNTIME) throw new Error('the step did not run at the provider that offered');
console.log('\nspec 384 W2 live: probe → offer → the mandate that names the offer → the provider ran it. ✓');
