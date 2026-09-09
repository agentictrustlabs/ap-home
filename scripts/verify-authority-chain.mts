/**
 * Spec 383 W1 (appendix M10) — THE CHAIN ON THE RECEIPT, live.
 *
 *   npx tsx scripts/verify-authority-chain.mts
 *
 * alice's plan pays nathan.treasury 1 USDC with `executor: runtime-c3s0.svc` (spec 376): her harness mints a
 * child from her mandate and hands the step to the runtime, which runs it under the chain [child, parent].
 * The runtime's receipt names the CHAIN — both grants by digest, alice's treasury as the accountability
 * root, the harness SA as the acting agent — and the actor context of the hop. alice's own receipt names
 * the parent alone and where it went. Twin: alice presents a FORGED child (its `authority` names a parent
 * nobody presented) to her own agent → refused `chain-parent-missing` before any caveat is read.
 */
import { hashDelegation, buildDigestBindingCaveat, paymentHandler, ROOT_AUTHORITY, registerDefaultSubsetHandlers, type Delegation, type Caveat, type MandateRequirementV1 } from '../packages/delegation/src/index.js';
import type { Address, Hex } from 'viem';
registerDefaultSubsetHandlers();

const HOME = 'https://www.faithnet.me';
const CHAIN = 34348;
const DM = '0x710cb1bF08C234Df397e0910331e0A29710EF4F7' as Address;
const ENFORCERS = { delegationManager: DM, timestamp: '0x73A7B878168b7DE48677617179A8bE894f0Dfe96', allowedTargets: '0x2156311097A936de1916a878bF53Bfd43c7b5715', allowedMethods: '0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41', value: '0x8759c1a6cEBF1D5069e9434EF46327Bf2ef69975', payment: '0x07fA0aE59FdE4B7ce8962d6fE7a1d648ec3DD5CE', digestBinding: '0xA3bb9BCC9b2F6F2419E1aBe5ED6Fd5399b9E68e1' } as const;
const RUNTIME = '0x309b2a566e93cc77aabe895d0ec2702c36856ebd' as Address; // runtime-c3s0.svc
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const alice = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'alice', client_id: 'demo-web' }) }));
const ALICE = String(alice.agent).toLowerCase() as Address;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36';
const A2A = 'https://alice.faithnet.ai';
const csrfRes = await fetch(`${A2A}/auth/csrf`, { headers: { origin: HOME, 'user-agent': UA } });
const csrfTok = csrfRes.headers.get('x-csrf-token') || ((await j(csrfRes.clone())) as { token?: string }).token || '';
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const H = { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrfTok, 'user-agent': UA };
const post = async (path: string, body: unknown) => j(await fetch(`${A2A}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));
const sign = async (digest: Hex): Promise<Hex> => { const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.homeSession}` }, body: JSON.stringify({ digest }) })); if (!b.signature) throw new Error(`persona-sign refused: ${JSON.stringify(b).slice(0, 200)}`); return b.signature; };
type Chain = { links: Array<{ ref: string; delegator: string; delegate: string; parentRef: string | null }>; accountabilityRoot: string; actingAgent: string; depth: number; chainDigest: string };
type Receipt = { stepRef: string; status: string; authority?: { presentedRef: string | null; decision: { decision: string; evidence?: { chain?: Chain } } }; binding?: { actor?: { rootPrincipal?: string; originatingAgent?: string; actingAgent: string }; correlation?: { delegatedTo?: { agent: string; runRef: string }; inResponseTo?: { agent: string } } } };
type Reply = { kind?: string; error?: string; runRef?: string; requirement?: MandateRequirementV1; delegator?: Address; delegate?: Address; prompt?: { kind?: string; stepRef?: string; digest?: Hex; prompt?: string }; routed?: Array<{ stepRef: string; agent: string; runRef?: string; observedVia: string; childRef?: string }>; receipts?: Receipt[] };
const salt = () => { let s = 0n; for (const b of crypto.getRandomValues(new Uint8Array(16))) s = (s << 8n) | BigInt(b); return s; };

// ── 1. the handed-off payment (spec 376) ─────────────────────────────────────────────────────────────
const nonce = Date.now().toString(36);
const goal = `pay nathan.treasury 1 usdc (chain ${nonce})`;
const plan = { steps: [{ toolId: 'treasury.payment.execute', args: { payee: 'nathan.treasury', usdc: '1', memo: `chain ${nonce}` }, id: 's0', executor: RUNTIME }] };
let r1 = await post('/harness/ask', { session: alice.homeSession, addressee: ALICE, message: goal, plan });
let rep = r1.reply as Reply;
console.log(`ask → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}`);
if (rep?.kind !== 'authority_required' || !rep.requirement || !rep.delegator || !rep.delegate) throw new Error(`expected the parent mandate to be asked: ${JSON.stringify(r1).slice(0, 500)}`);
const req = rep.requirement;
const caveats: Caveat[] = [...paymentHandler.toCaveats(req, ENFORCERS as never), buildDigestBindingCaveat(ENFORCERS.digestBinding, 'intent', req.intentDigest as Hex)];
const parent: Delegation = { delegator: rep.delegator, delegate: rep.delegate, authority: ROOT_AUTHORITY, caveats, salt: salt(), signature: '0x' };
parent.signature = await sign(hashDelegation(parent, CHAIN, DM));
const parentRef = hashDelegation(parent, CHAIN, DM).toLowerCase();
const TREASURY = rep.delegator.toLowerCase();
console.log(`  alice signed the parent ${parentRef.slice(0, 12)}… (${TREASURY.slice(0, 10)}… → harness ${rep.delegate.slice(0, 10)}…)`);
r1 = await post('/harness/ask', { session: alice.homeSession, addressee: ALICE, runRef: rep.runRef, presented: { ...parent, salt: parent.salt.toString() } });
rep = r1.reply;
for (let i = 0; i < 2; i++) {
  const p = rep?.prompt;
  if (rep?.kind !== 'prompt' || p?.kind !== 'signature' || !p.digest) break;
  r1 = await post('/harness/ask', { session: alice.homeSession, addressee: ALICE, runRef: rep.runRef, supplied: [{ stepRef: p.stepRef ?? 's0', signature: { digest: p.digest, signer: ALICE, signature: await sign(p.digest) } }] });
  rep = r1.reply;
}
console.log(`  resume → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}`);
if (rep?.kind !== 'done') throw new Error(`the handed-off step did not finish: ${JSON.stringify(r1).slice(0, 600)}`);
const via = rep.routed?.[0];
if (!via?.runRef || via.observedVia !== 'handoff' || !via.childRef) throw new Error(`the answer does not cite the hand-off: ${JSON.stringify(rep.routed)}`);
const childRef = String(via.childRef).toLowerCase();
console.log(`  handed to ${via.agent.slice(0, 10)}… run ${via.runRef}, child ${childRef.slice(0, 12)}…`);

// ── 2. alice's receipt: the parent alone, and where the step went ────────────────────────────────────
const mine = (rep.receipts ?? []).find((x) => x.stepRef === 's0');
const myChain = mine?.authority?.decision.evidence?.chain;
console.log(`  alice's receipt: chain depth ${myChain?.depth} root ${myChain?.accountabilityRoot?.slice(0, 10)}… acting ${myChain?.actingAgent?.slice(0, 10)}…; actor ${JSON.stringify(mine?.binding?.actor)}; delegatedTo ${mine?.binding?.correlation?.delegatedTo?.agent?.slice(0, 10)}…`);
if (!myChain || myChain.depth !== 1 || myChain.accountabilityRoot !== TREASURY || myChain.links[0]!.ref.toLowerCase() !== parentRef) throw new Error('alice\'s receipt does not name her root mandate as a chain of one');
if (mine?.binding?.actor?.rootPrincipal !== ALICE || mine.binding.actor.actingAgent !== ALICE) throw new Error('alice\'s receipt does not name her as principal and her agent as the acting agent');
if (mine?.binding?.correlation?.delegatedTo?.agent?.toLowerCase() !== RUNTIME) throw new Error('alice\'s receipt does not say where the step went');

// ── 3. the runtime's receipt: the CHAIN, whole ───────────────────────────────────────────────────────
const rec = await post('/harness/records', { session: alice.homeSession, addressee: RUNTIME, runRef: via.runRef });
if (!rec.ok) throw new Error(`the runtime's record: ${JSON.stringify(rec).slice(0, 300)}`);
const theirs = ((rec.record?.receipts ?? []) as Receipt[]).find((x) => x.status === 'executed' || x.authority);
const chain = theirs?.authority?.decision.evidence?.chain;
console.log(`  runtime's receipt: chain depth ${chain?.depth}, links ${chain?.links.map((l) => `${l.ref.slice(0, 10)}…(${l.delegator.slice(0, 6)}→${l.delegate.slice(0, 6)})`).join(' ← ')}, root ${chain?.accountabilityRoot?.slice(0, 10)}…, acting ${chain?.actingAgent?.slice(0, 10)}…, digest ${chain?.chainDigest?.slice(0, 12)}…`);
console.log(`  runtime's actor context: ${JSON.stringify(theirs?.binding?.actor)}; inResponseTo ${theirs?.binding?.correlation?.inResponseTo?.agent?.slice(0, 10)}…`);
if (!chain || chain.depth !== 2) throw new Error('the runtime\'s receipt does not carry the two-link chain');
if (chain.links[0]!.ref.toLowerCase() !== childRef || chain.links[1]!.ref.toLowerCase() !== parentRef) throw new Error('the chain\'s links are not [child, parent]');
if (chain.links[0]!.parentRef?.toLowerCase() !== parentRef || chain.links[1]!.parentRef !== null) throw new Error('the links do not name their parents');
if (chain.accountabilityRoot !== TREASURY) throw new Error(`the accountability root is not alice's treasury: ${chain.accountabilityRoot}`);
if (chain.actingAgent !== chain.links[0]!.delegate.toLowerCase()) throw new Error('the acting agent is not the leaf delegate');
const actor = theirs?.binding?.actor;
if (actor?.actingAgent !== RUNTIME) throw new Error(`the runtime's receipt does not name the runtime as the acting agent: ${JSON.stringify(actor)}`);
if (actor.originatingAgent !== ALICE || actor.rootPrincipal !== ALICE) throw new Error(`the runtime's receipt does not name alice as the originator and principal: ${JSON.stringify(actor)}`);
console.log('  ✓ three parties, two grants, one chain digest — named on the receipt, not inferred from the last link');

// ── 4. twin: a forged child, presented alone ─────────────────────────────────────────────────────────
const r2 = await post('/harness/ask', { session: alice.homeSession, addressee: ALICE, message: `pay nathan.treasury 1 usdc (forged child ${nonce})`, plan: { steps: [{ toolId: 'treasury.payment.execute', args: { payee: 'nathan.treasury', usdc: '1', memo: `forged ${nonce}` }, id: 's0' }] } });
const rep2 = r2.reply as Reply;
if (rep2?.kind !== 'authority_required' || !rep2.requirement || !rep2.delegator || !rep2.delegate) throw new Error(`twin: expected a mandate ask: ${JSON.stringify(r2).slice(0, 400)}`);
const req2 = rep2.requirement;
const forged: Delegation = {
  delegator: rep2.delegator, delegate: rep2.delegate,
  authority: `0x${'7'.repeat(63)}e` as Hex, // a parent nobody presented — and nobody has
  caveats: [...paymentHandler.toCaveats(req2, ENFORCERS as never), buildDigestBindingCaveat(ENFORCERS.digestBinding, 'intent', req2.intentDigest as Hex)], salt: salt(), signature: '0x',
};
forged.signature = await sign(hashDelegation(forged, CHAIN, DM));
const r3 = await post('/harness/ask', { session: alice.homeSession, addressee: ALICE, runRef: rep2.runRef, presented: { ...forged, salt: forged.salt.toString() } });
const rep3 = r3.reply as Reply;
console.log(`twin (a child whose parent was never presented) → ${rep3?.kind}: ${(rep3?.error ?? '').slice(0, 200)}`);
if (rep3?.kind === 'done' || rep3?.kind === 'prompt') throw new Error('a child alone was accepted as authority');
if (!/chain-parent-missing|child alone is not authority/i.test(rep3?.error ?? '')) throw new Error(`refused for another reason: ${JSON.stringify(r3).slice(0, 400)}`);
console.log('  ✓ refused before a caveat was read: a receiver cannot be satisfied by the last link alone');
console.log('\nspec 383 W1 live: the chain is on the receipt, verified whole; the last link alone satisfies nobody. ✓');
