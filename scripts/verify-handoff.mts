/**
 * Spec 376 W1 — HANDOFF AS A CHILD DELEGATION, live.
 *
 *   npx tsx scripts/verify-handoff.mts
 *
 * alice's plan pays nathan's treasury 1 USDC with `executor: runtime-c3s0.svc`. Her agent asks her for the
 * mandate as ever (the parent: her treasury → the harness). On resume the step is not run here: her
 * harness's own Smart Agent mints a CHILD from that mandate — same payee, same asset, minutes long, bound
 * to the one step's digest — signs it, and hands the step to the runtime, which runs it under the chain
 * [child, parent] and redeems both on chain. Her answer says who did it and cites the child.
 */
import { hashDelegation, buildDigestBindingCaveat, paymentHandler, ROOT_AUTHORITY, registerDefaultSubsetHandlers, type Delegation, type Caveat, type MandateRequirementV1 } from '@agenticprimitives/delegation';
import type { Address, Hex } from 'viem';
// Priorities §3.2 G5 — the cross-Home leg (CROSS=1): preflighted; skipped-and-said until B holds its caller token and the parent wire exists.
import { requireCrossHome } from './cross-home-preflight.mts';
if (process.env.CROSS === '1') await requireCrossHome('verify-handoff', { needsParentWire: true });
registerDefaultSubsetHandlers();

const HOME = 'https://www.faithnet.me';
const CHAIN = 34348;
const DM = '0x710cb1bF08C234Df397e0910331e0A29710EF4F7' as Address;
const ENFORCERS = { delegationManager: DM, timestamp: '0x73A7B878168b7DE48677617179A8bE894f0Dfe96', allowedTargets: '0x2156311097A936de1916a878bF53Bfd43c7b5715', allowedMethods: '0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41', value: '0x8759c1a6cEBF1D5069e9434EF46327Bf2ef69975', payment: '0x07fA0aE59FdE4B7ce8962d6fE7a1d648ec3DD5CE', digestBinding: '0xA3bb9BCC9b2F6F2419E1aBe5ED6Fd5399b9E68e1' } as const;
const RUNTIME = '0x309b2a566e93cc77aabe895d0ec2702c36856ebd' as Address; // runtime-c3s0.svc
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const alice = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'alice', client_id: 'demo-web' }) }));
const ALICE = String(alice.agent).toLowerCase() as Address;
// The Worker host directly (the Home's proxy is not under test here); CSRF from that host.
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36';
const A2A = 'https://alice.faithnet.ai';
const csrfRes = await fetch(`${A2A}/auth/csrf`, { headers: { origin: HOME, 'user-agent': UA } });
const csrfTok = csrfRes.headers.get('x-csrf-token') || ((await j(csrfRes.clone())) as { token?: string }).token || '';
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const H = { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrfTok, 'user-agent': UA };
const post = async (path: string, body: unknown) => j(await fetch(`${A2A}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));
const sign = async (digest: Hex): Promise<Hex> => { const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.homeSession}` }, body: JSON.stringify({ digest }) })); if (!b.signature) throw new Error(`persona-sign refused: ${JSON.stringify(b).slice(0, 120)}`); return b.signature; };

const nonce = Date.now().toString(36);
// SENTENCE=1 (spec 376 W2): no plan is supplied — the ask itself names who is to do it, the planner sets the
// step's executor from those words, and the harness resolves the name in alice's own tier. Same chain after.
const SENTENCE = process.env.SENTENCE === '1';
// PLAYBOOK=1 (spec 376 W2, the playbook-declared specialist): no plan, no name in the words — alice's agent holds
// the person-steward-runtime playbook, whose rule hands every payment to runtime-c3s0.svc. The compiled payment
// shape plans the step; `withSpecialists` sets its executor; the same chain follows.
const PLAYBOOK = process.env.PLAYBOOK === '1';
const goal = SENTENCE ? `have runtime-c3s0.svc pay nathan.treasury 1 usdc for handoff ${nonce}` : PLAYBOOK ? `pay nathan.treasury 1 usdc for handoff ${nonce}` : `pay nathan.treasury 1 usdc (handoff ${nonce})`;
// LOCAL=1 runs the same plan with no executor — the single-mandate path through the same invoker, as a regression.
const LOCAL = process.env.LOCAL === '1';
const plan = { steps: [{ toolId: 'treasury.payment.execute', args: { payee: 'nathan.treasury', usdc: '1', memo: `${LOCAL ? 'local' : 'handoff'} ${nonce}` }, id: 's0', ...(LOCAL ? {} : { executor: RUNTIME }) }] };
console.log(`alice ${ALICE} → step executor runtime-c3s0.svc ${RUNTIME}`);
let r1 = await post('/harness/ask', { session: alice.homeSession, addressee: ALICE, message: goal, ...(SENTENCE || PLAYBOOK ? {} : { plan }) });
let rep = r1.reply as { kind?: string; error?: string; text?: string; runRef?: string; requirement?: MandateRequirementV1; delegator?: Address; delegate?: Address; routed?: Array<{ agent: string; name?: string; observedVia: string; runRef?: string; childRef?: string; receipts?: number }> } | undefined;
console.log(`  ask → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}${rep?.delegator ? ` (delegator ${rep.delegator.slice(0, 10)}…)` : ''}`);
if (rep?.kind === 'prompt') console.log(`  prompt: ${JSON.stringify((rep as { prompt?: unknown }).prompt).slice(0, 600)}`);
if (rep?.kind !== 'authority_required' || !rep.requirement || !rep.delegator || !rep.delegate) throw new Error(`expected the PARENT mandate to be asked of alice first: ${JSON.stringify(r1).slice(0, 500)}`);
const req = rep.requirement;
const caveats: Caveat[] = [...paymentHandler.toCaveats(req, ENFORCERS as never), buildDigestBindingCaveat(ENFORCERS.digestBinding, 'intent', req.intentDigest as Hex)];
let salt = 0n; for (const b of crypto.getRandomValues(new Uint8Array(16))) salt = (salt << 8n) | BigInt(b);
const mandate: Delegation = { delegator: rep.delegator, delegate: rep.delegate, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
mandate.signature = await sign(hashDelegation(mandate, CHAIN, DM));
console.log(`  alice signed the parent (${rep.delegator.slice(0, 10)}… → harness)`);
r1 = await post('/harness/ask', { session: alice.homeSession, addressee: ALICE, runRef: rep.runRef, presented: { ...mandate, salt: salt.toString() } });
rep = r1.reply;
// The payment policy's own obligation: a second-party approval over the step's digest (spec 350 ApprovalPort),
// signed by alice as the parent's steward. The child is minted only after the parent's obligations are met.
for (let i = 0; i < 2; i++) {
  const p = (rep as { kind?: string; prompt?: { kind?: string; stepRef?: string; digest?: Hex } } | undefined)?.prompt;
  if (rep?.kind !== 'prompt' || p?.kind !== 'signature' || !p.digest) break;
  console.log(`  parent obligation: ${(rep as { prompt?: { prompt?: string } }).prompt?.prompt?.slice(0, 70)}… — alice approves`);
  const supplied = [{ stepRef: p.stepRef ?? 's0', signature: { digest: p.digest, signer: ALICE, signature: await sign(p.digest) } }];
  r1 = await post('/harness/ask', { session: alice.homeSession, addressee: ALICE, runRef: (rep as { runRef?: string }).runRef, supplied });
  rep = r1.reply;
}
console.log(`  resume → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}${rep?.text ? ` ${JSON.stringify(rep.text).slice(0, 160)}` : ''}`);
console.log(`  plan as admitted: ${JSON.stringify((r1.reply as { plannerTrace?: { plan?: unknown; planner?: string } }).plannerTrace?.plan)} (${(r1.reply as { plannerTrace?: { planner?: string } }).plannerTrace?.planner})`);
console.log(`  step result: ${(JSON.stringify((r1.reply as { result?: unknown }).result) ?? 'none').slice(0, 300)}`);
const via = rep?.routed?.[0];
const waitingOn = (rep as { on?: { name?: string; runRef?: string }; commitment?: { conditions?: string } } | undefined);
if (rep?.kind === 'waiting') console.log(`  parked: on ${waitingOn?.on?.name} run ${waitingOn?.on?.runRef} — ${(rep as { text?: string }).text}`);
console.log(`  handed to: ${via ? `${via.name ?? via.agent} (${via.observedVia}${via.runRef ? `, run ${via.runRef}` : ''}${via.childRef ? `, child ${String(via.childRef).slice(0, 14)}…` : ''}, ${via.receipts ?? 0} receipt(s))` : 'nobody'}`);
if (rep?.kind !== 'done') throw new Error(`the ${LOCAL ? 'local' : 'handed-off'} step did not finish: ${JSON.stringify(r1).slice(0, 700)}`);
if (LOCAL) { if (via) throw new Error('a local step must not cite a hand-off'); console.log('\n✓ regression: the single-mandate payment still settles through the chain-aware invoker.'); process.exit(0); }
if (via?.observedVia !== 'handoff' || via.agent.toLowerCase() !== RUNTIME || !via.childRef) throw new Error('the answer does not cite the hand-off and its child');
const receipt = (rep as { receipts?: Array<{ stepRef: string; status: string; binding?: { correlation?: { delegatedTo?: { agent: string; runRef: string } } } }> }).receipts?.find((x) => x.stepRef === 's0');
console.log(`  parent receipt: ${receipt ? `${receipt.status}, delegatedTo ${JSON.stringify(receipt.binding?.correlation?.delegatedTo)}` : 'none'}`);
if (receipt?.binding?.correlation?.delegatedTo?.agent?.toLowerCase() !== RUNTIME) throw new Error('the parent receipt does not link to the specialist\'s run');
console.log(`\n✓ spec 376 ${PLAYBOOK ? 'W2 (the playbook\'s specialist — no name in the words, no plan supplied; the rule on alice\'s playbook handed the step)' : SENTENCE ? 'W2 (sentence form — the executor came from alice\'s words, resolved in her own tier)' : 'W1'}: the step ran at runtime-c3s0.svc under a child mandate alice's harness attenuated from hers and redeemed as a chain; her receipt names the specialist's run and its child.`);
