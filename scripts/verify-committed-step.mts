/**
 * Spec 382 W1 (appendix M6) — THE COMMITTED STEP RUNS AT THE PARTICIPANT, live on Missio Nexus.
 *
 *   npx tsx scripts/verify-committed-step.mts
 *
 * alice (steward) requests, adopts and proposes a two-step plan — each step a 1 USDC payment to
 * nathan.treasury. bob and carol offer, alice allocates, both commit (bob's stale-hash commit first: 409).
 * Each commit parks a run at its participant. bob claims his in HIS Ask, is asked for HIS mandate, grants
 * and approves → done → the step is satisfied on the endeavor with his run, mandate, tx and commitment as
 * evidence. carol claims hers and presents nothing → authority_required; her step stays open.
 */
import { hashDelegation, buildDigestBindingCaveat, paymentHandler, ROOT_AUTHORITY, registerDefaultSubsetHandlers, type Delegation, type Caveat, type MandateRequirementV1 } from '@agenticprimitives/delegation';
import { canonicalizeMessage, sha256Hex32 } from '@agenticprimitives/fabric/messaging';
import type { Address, Hex } from 'viem';
registerDefaultSubsetHandlers();

const HOME = 'https://www.faithnet.me';
const A2A = 'https://a2a.faithnet.io';
const CHAIN = 34348;
const DM = '0x710cb1bF08C234Df397e0910331e0A29710EF4F7' as Address;
const ENFORCERS = { delegationManager: DM, timestamp: '0x73A7B878168b7DE48677617179A8bE894f0Dfe96', allowedTargets: '0x2156311097A936de1916a878bF53Bfd43c7b5715', allowedMethods: '0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41', value: '0x8759c1a6cEBF1D5069e9434EF46327Bf2ef69975', payment: '0x07fA0aE59FdE4B7ce8962d6fE7a1d648ec3DD5CE', digestBinding: '0xA3bb9BCC9b2F6F2419E1aBe5ED6Fd5399b9E68e1' } as const;
const ORG = '0x3b99f2b452766de5df0dbcdfc676f27257151333' as Address; // Missio Nexus
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36';
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const signin = async (handle: string) => j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-web' }) }));
const signerFor = (token: string) => async (digest: Hex): Promise<Hex> => { const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ digest }) })); if (!b.signature) throw new Error(`persona-sign refused: ${JSON.stringify(b).slice(0, 200)}`); return b.signature; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const alice = await signin('alice'); const ALICE = String(alice.agent).toLowerCase() as Address;
// THE PAYING PARTICIPANT is alice — as a person, from her own typed treasury (the demo persons' other treasuries carry no on-chain
// agent type, and the value rail rightly refuses to pay from one). She is also the endeavor's coordinator; the point under test is that
// the step runs on HER agent under HER mandate and is recorded by her, never by the organization.
const bob = alice; const BOB = ALICE;
const carol = await signin('carol'); const CAROL = String(carol.agent).toLowerCase() as Address;
const related = await j(await fetch(`${HOME}/connect/related-orgs?person=${ALICE}`, { headers: { authorization: `Bearer ${alice.homeSession}` } }));
const stewardship = (related.orgs ?? []).find((o: { orgAgent: string }) => o.orgAgent.toLowerCase() === ORG)?.stewardshipDelegation;
if (!stewardship) throw new Error('alice holds no stewardship wire for Missio Nexus');
const ix = async (token: string, op: string, payload: Record<string, unknown>, withStewardship = false) => {
  const out = await j(await fetch(`${A2A}/interactions/${ORG}/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: token, ...(withStewardship ? { stewardship } : {}), ...payload }) }));
  if (!/\.(get|list)$/.test(op)) await sleep(900); // pace the organization's vault budget
  return out;
};
const askAt = async (handle: string, token: string, body: Record<string, unknown>) => {
  const host = `https://${handle}.faithnet.ai`;
  const cs = await fetch(`${host}/auth/csrf`, { headers: { origin: HOME, 'user-agent': UA } });
  const tok = cs.headers.get('x-csrf-token') || ((await j(cs.clone())) as { token?: string }).token || '';
  const cookie = (cs.headers.get('set-cookie') ?? '').split(';')[0];
  const H = { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': tok, 'user-agent': UA };
  return { post: async (path: string, b: Record<string, unknown>) => j(await fetch(`${host}${path}`, { method: 'POST', headers: H, body: JSON.stringify({ session: token, ...b }) })), first: await j(await fetch(`${host}/harness/runs`, { method: 'POST', headers: H, body: JSON.stringify({ session: token, ...body }) })) };
};

// ── 0. setup: auto-work OFF for the run (its plan-drafting and work turns spend the organization's vault
// budget — 120 verified calls a minute — beside the gate's own ops, and the gate proposes its own plan).
// Restored at the end, whatever happens.
const autoBefore = await ix(alice.homeSession, 'autowork.get', {}, true);
const restoreAutoWork = async () => { if (autoBefore.enabled) await ix(alice.homeSession, 'autowork.enable', {}, true).catch(() => undefined); };
process.on('exit', () => { /* restored below on every path */ });
if (autoBefore.enabled) { await ix(alice.homeSession, 'autowork.disable', {}, true); console.log('setup: auto-work paused for the run'); }
const pace = () => sleep(900);
try {

// ── 1. the endeavor, the plan ───────────────────────────────────────────────────────────────────────
const nonce = Date.now().toString(36);
const LABEL = `Corridor kickoff ${nonce}`;
const requested = await ix(alice.homeSession, 'endeavor.request', { goal: `${LABEL}: pay the two venue deposits`, entryPoint: 'home-request' }, true);
const requestId = requested.requestId ?? requested.request?.requestId;
if (!requestId) throw new Error(`endeavor.request: ${JSON.stringify(requested).slice(0, 300)}`);
const findEndeavor = async (): Promise<string | undefined> => {
  const list = await ix(alice.homeSession, 'endeavor.list', {}, true);
  return ((list.endeavors ?? list.rows ?? []) as Array<Record<string, unknown>>).find((e) => `${e.title ?? ''}${e.goal ?? ''}`.includes(nonce))?.endeavorId as string | undefined;
};
let endeavorId = await findEndeavor();
if (!endeavorId) { await ix(alice.homeSession, 'endeavor.create', { requestId, decision: 'adopt' }, true).catch(() => ({})); for (let i = 0; i < 10 && !endeavorId; i++) { await sleep(2500); endeavorId = await findEndeavor(); } }
if (!endeavorId) throw new Error('the request never became an endeavor');
console.log(`endeavor ${endeavorId} (${LABEL})`);
const steps = [
  { stepId: 'step_deposit_a', kind: 'contribution', description: 'Pay 1 USDC to nathan.treasury', capabilityRequirements: [{ capabilityIri: 'urn:ap:cap:treasury.payment.execute', minAssertionStrength: 'declared' }] },
  { stepId: 'step_deposit_b', kind: 'contribution', description: 'Pay 1 USDC to nathan.treasury', capabilityRequirements: [{ capabilityIri: 'urn:ap:cap:treasury.payment.execute', minAssertionStrength: 'declared' }] },
];
const proposed = await ix(alice.homeSession, 'endeavor.proposePlan', { endeavorId, steps, edges: [], milestones: [] }, true);
if (!proposed.ok) throw new Error(`proposePlan: ${JSON.stringify(proposed).slice(0, 300)}`);
let get = await ix(alice.homeSession, 'endeavor.get', { endeavorId }, true);
const mine = ((get.plans ?? []) as Array<{ planId: string; revision: number; contentHash: string; steps?: Array<{ stepId: string }> }>).find((p) => p.planId === proposed.planId && p.revision === proposed.revision)
  ?? (get.plan?.planId === proposed.planId ? get.plan : null);
const planRef = { planId: proposed.planId, revision: proposed.revision, hash: (mine?.contentHash ?? get.plan?.contentHash) as string };
if (!planRef.hash) throw new Error(`no content hash for the proposed plan: ${JSON.stringify(get).slice(0, 400)}`);
const adopted = await ix(alice.homeSession, 'endeavor.adoptPlan', { endeavorId, planRef }, true);
if (!adopted.ok) throw new Error(`adoptPlan: ${JSON.stringify(adopted).slice(0, 300)}`);
console.log(`  plan ${planRef.planId}@${planRef.revision} adopted (${planRef.hash.slice(0, 12)}…)`);

// ── 2. offers, allocations, commitments ─────────────────────────────────────────────────────────────
const offerAndAllocate = async (who: { homeSession: string }, WHO: Address, stepId: string) => {
  const offer = await ix(who.homeSession, 'endeavor.propose', { endeavorId, planRef, steps: [stepId], note: 'I will pay it from my treasury' });
  if (!offer.ok) throw new Error(`offer by ${WHO.slice(0, 8)}: ${JSON.stringify(offer).slice(0, 300)}`);
  const alloc = await ix(alice.homeSession, 'endeavor.allocate', { endeavorId, proposalRef: offer.proposalId, participant: WHO, steps: [stepId] }, true);
  if (!alloc.ok) throw new Error(`allocate to ${WHO.slice(0, 8)}: ${JSON.stringify(alloc).slice(0, 300)}`);
  return alloc.allocationId as string;
};
const commit = async (who: { homeSession: string }, WHO: Address, allocationRef: string, stepId: string, ref: { planId: string; revision: number; hash: string }) => {
  const payloadHash = await sha256Hex32(canonicalizeMessage({ endeavorId, allocationRef, planRef: { planId: ref.planId, revision: ref.revision, hash: ref.hash }, steps: [stepId] }));
  const signature = await signerFor(who.homeSession)(payloadHash as Hex);
  return ix(who.homeSession, 'endeavor.commit', { endeavorId, allocationRef, participant: WHO, planRef: ref, steps: [stepId], signature: { payloadHash, signer: WHO, scheme: 'erc1271', signature } });
};
const allocB = await offerAndAllocate(bob, BOB, 'step_deposit_a');
const allocC = await offerAndAllocate(carol, CAROL, 'step_deposit_b');
console.log(`  offers admitted and allocated: alice→step_deposit_a (${allocB}), carol→step_deposit_b (${allocC})`);
const stale = await commit(bob, BOB, allocB, 'step_deposit_a', { ...planRef, hash: `0x${'0'.repeat(63)}b` });
if (stale.ok || !/stale/i.test(String(stale.error ?? ''))) throw new Error(`a stale-hash commitment was not refused: ${JSON.stringify(stale).slice(0, 200)}`);
console.log(`  ✓ twin: a stale plan hash rejects the commitment — ${stale.error}`);
const cB = await commit(bob, BOB, allocB, 'step_deposit_a', planRef);
if (!cB.ok) throw new Error(`bob's commit: ${JSON.stringify(cB).slice(0, 300)}`);
const cC = await commit(carol, CAROL, allocC, 'step_deposit_b', planRef);
if (!cC.ok) throw new Error(`carol's commit: ${JSON.stringify(cC).slice(0, 300)}`);
console.log(`  alice committed (${cB.commitmentId}), carol committed (${cC.commitmentId}) — one plan hash, two signed promises`);

// ── 3. each commitment parked a run at ITS participant ─────────────────────────────────────────────
type Run = { runRef: string; asker: string; addressee: string; openToStewards?: boolean; origin?: { endeavorId: string; stepId: string; principal: string; commitmentRef?: string; planHash?: string } };
const parkedAt = async (handle: string, token: string, WHO: Address, stepId: string): Promise<{ run: Run; post: (path: string, b: Record<string, unknown>) => Promise<any> }> => {
  for (let i = 0; i < 12; i++) {
    const { post, first } = await askAt(handle, token, { addressee: WHO });
    const run = ((first.runs ?? []) as Run[]).find((r) => r.origin?.endeavorId === endeavorId && r.origin.stepId === stepId);
    if (run) return { run, post };
    await sleep(2500);
  }
  throw new Error(`no run parked at ${handle} for ${stepId}`);
};
const b = await parkedAt('alice', bob.homeSession, BOB, 'step_deposit_a');
console.log(`  parked at alice: ${b.run.runRef} (asker ${b.run.asker.slice(0, 8)}…, openToStewards ${b.run.openToStewards ?? false}, commitment ${b.run.origin?.commitmentRef}, plan ${String(b.run.origin?.planHash).slice(0, 12)}…)`);
if (b.run.asker.toLowerCase() !== BOB || b.run.openToStewards) throw new Error('the committed step is not the participant\'s own run');
if (b.run.origin?.commitmentRef !== cB.commitmentId || b.run.origin?.planHash !== planRef.hash) throw new Error('the parked run does not carry the commitment and the adopted hash');
const c = await parkedAt('carol', carol.homeSession, CAROL, 'step_deposit_b');
console.log(`  parked at carol: ${c.run.runRef}`);
const carolsRunSeenByAlice = ((await askAt('alice', alice.homeSession, { addressee: CAROL })).first.runs ?? []) as Run[];
if (carolsRunSeenByAlice.some((r) => r.runRef === c.run.runRef)) throw new Error('the steward can see (and so claim) carol\'s committed run');
console.log('  ✓ carol\'s run is hers alone: the steward cannot claim it');

// ── 4. bob finishes his under HIS mandate ───────────────────────────────────────────────────────────
type Reply = { kind?: string; error?: string; runRef?: string; text?: string; resumeToken?: string; requirement?: MandateRequirementV1; delegator?: Address; delegate?: Address; capability?: string;
  prompt?: { kind?: string; stepRef?: string; digest?: Hex; prompt?: string; signer?: string; payload?: unknown; fields?: Array<{ name: string; type: string; choices?: Array<{ value: string; label?: string; hint?: string }> }> } };
const mint = async (who: { homeSession: string }, rep: Reply): Promise<Record<string, unknown>> => {
  const req = rep.requirement!;
  const caveats: Caveat[] = [...paymentHandler.toCaveats(req, ENFORCERS as never), buildDigestBindingCaveat(ENFORCERS.digestBinding, 'intent', req.intentDigest as Hex)];
  let salt = 0n; for (const x of crypto.getRandomValues(new Uint8Array(16))) salt = (salt << 8n) | BigInt(x);
  const d: Delegation = { delegator: rep.delegator!, delegate: rep.delegate!, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
  d.signature = await signerFor(who.homeSession)(hashDelegation(d, CHAIN, DM));
  return { ...d, salt: salt.toString() };
};
const usdcOf = (hint?: string) => Number(/([\d.]+)\s*USDC/i.exec(hint ?? '')?.[1] ?? '0');
let r = await b.post('/harness/ask', { addressee: BOB, runRef: b.run.runRef });
let rep = r.reply as Reply;
let askedForMandate: Reply | null = null;
for (let turn = 0; turn < 10 && rep?.kind !== 'done'; turn++) {
  console.log(`alice's turn ${turn + 1} → ${rep?.kind}${rep?.kind === 'prompt' ? ` (${rep.prompt?.kind}: "${rep.prompt?.prompt?.slice(0, 60)}")` : rep?.kind === 'authority_required' ? ` (${rep.capability ?? ''}; delegator ${rep.delegator?.slice(0, 10)}…)` : rep?.error ? ` ${rep.error}` : ''}`);
  if (rep?.kind === 'refused') throw new Error(`bob's run was refused: ${rep.error}`);
  if (rep?.kind === 'answer') throw new Error(`bob's run ANSWERED instead of acting: ${rep.text?.slice(0, 200)}`);
  let presented: unknown = null; const supplied: unknown[] = [];
  if (rep?.kind === 'authority_required') {
    if (!rep.requirement || !rep.delegator || !rep.delegate) throw new Error(`mandate asked without a requirement: ${JSON.stringify(r).slice(0, 400)}`);
    if (rep.delegator.toLowerCase() === ORG.toLowerCase()) throw new Error("the mandate asked is the organization's — the step is not running as bob");
    askedForMandate = rep; presented = await mint(bob, rep);
  } else if (rep?.kind === 'prompt' && rep.prompt?.kind === 'data') {
    const data: Record<string, unknown> = {};
    for (const f of rep.prompt.fields ?? []) {
      if (f.choices?.length) {
        // A NAMED treasury (typed on chain — the value rail refuses an untyped one), with a balance to pay from.
        const named = f.choices.filter((c) => !/unnamed/i.test(c.label ?? '') && usdcOf(c.hint) >= 1);
        const best = [...(named.length ? named : f.choices)].sort((x, y) => usdcOf(y.hint) - usdcOf(x.hint))[0]!;
        data[f.name] = best.value; console.log(`  answers ${f.name}: ${best.label ?? best.value} (${best.hint ?? ''})`);
      }
      else if (f.name === 'payee') { data[f.name] = 'nathan.treasury'; console.log('  answers payee: nathan.treasury'); }
      else if (/usdc|amount/i.test(f.name)) data[f.name] = '1';
      else data[f.name] = `venue deposit ${nonce}`;
    }
    supplied.push({ stepRef: rep.resumeToken ?? rep.prompt.stepRef ?? 's0', data });
  } else if (rep?.kind === 'prompt' && rep.prompt?.kind === 'signature' && rep.prompt.digest) {
    supplied.push({ stepRef: rep.resumeToken ?? rep.prompt.stepRef ?? 's0', signature: { digest: rep.prompt.digest, signer: BOB, signature: await signerFor(bob.homeSession)(rep.prompt.digest), ...(rep.prompt.payload !== undefined ? { payload: rep.prompt.payload } : {}) } });
  } else throw new Error(`unexpected turn: ${JSON.stringify(r).slice(0, 500)}`);
  r = await b.post('/harness/ask', { addressee: BOB, runRef: b.run.runRef, ...(presented ? { presented } : {}), ...(supplied.length ? { supplied } : {}) });
  rep = r.reply;
}
console.log(`  → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}; step recorded: ${JSON.stringify(r.satisfiedStep ?? null)}`);
if (rep?.kind !== 'done') throw new Error(`bob's step did not finish: ${JSON.stringify(r).slice(0, 700)}`);
if (!askedForMandate) throw new Error('bob was never asked for his mandate — the step ran on nobody\'s authority');
const sat = r.satisfiedStep as { ok?: boolean; error?: string } | undefined;
if (!sat?.ok) throw new Error(`the step was done but not recorded on the endeavor: ${sat?.error ?? 'no report'}`);

// ── 5. the endeavor: bob's step satisfied by bob, with his receipt; carol's still open ─────────────
get = await ix(alice.homeSession, 'endeavor.get', { endeavorId }, true);
const planSteps = (get.plan?.steps ?? []) as Array<{ stepId: string; satisfied: boolean; evidence?: string }>;
const sA = planSteps.find((s) => s.stepId === 'step_deposit_a'); const sB = planSteps.find((s) => s.stepId === 'step_deposit_b');
console.log(`  step_deposit_a satisfied=${sA?.satisfied} evidence="${(sA?.evidence ?? '').slice(0, 160)}"`);
if (!sA?.satisfied) throw new Error('bob\'s committed step is not satisfied on the endeavor');
if (!/run:|receipt/i.test(sA.evidence ?? '') || !new RegExp(cB.commitmentId).test(sA.evidence ?? '')) throw new Error('the evidence does not cite bob\'s run and commitment');
const trail = ((get.events ?? []) as Array<{ type?: string; kind?: string; actor?: string }>).filter((e) => (e.type ?? e.kind) === 'PlanStepSatisfied');
if (trail.length && !trail.some((e) => String(e.actor ?? '').toLowerCase() === BOB)) throw new Error(`the step was not recorded by the participant: ${JSON.stringify(trail).slice(0, 200)}`);
else if (trail.length) console.log('  ✓ recorded BY THE PARTICIPANT (the event trail names her as the actor, not the organization)');
console.log('  ✓ one plan hash, two commitments, the participant\'s run recorded from her receipt');

// ── 6. twin: carol claims hers and presents nothing ─────────────────────────────────────────────────
let rc = await c.post('/harness/ask', { addressee: CAROL, runRef: c.run.runRef });
let repc = rc.reply as Reply;
// She answers what is asked of her — which treasury, whom — and presents NOTHING: the mandate is the gate.
for (let turn = 0; turn < 4 && repc?.kind === 'prompt' && repc.prompt?.kind === 'data'; turn++) {
  const data: Record<string, unknown> = {};
  for (const f of repc.prompt.fields ?? []) data[f.name] = f.choices?.length ? f.choices[0]!.value : f.name === 'payee' ? 'nathan.treasury' : 'second deposit';
  rc = await c.post('/harness/ask', { addressee: CAROL, runRef: c.run.runRef, supplied: [{ stepRef: repc.resumeToken ?? 's0', data }] });
  repc = rc.reply;
}
console.log(`carol claims hers and presents no mandate → ${repc?.kind}${repc?.error ? ` ${repc.error}` : ''}${repc?.delegator ? ` (asked for ${repc.delegator.slice(0, 10)}…'s mandate)` : ''}`);
if (repc?.kind !== 'authority_required') throw new Error(`expected authority_required for carol: ${JSON.stringify(rc).slice(0, 400)}`);
get = await ix(alice.homeSession, 'endeavor.get', { endeavorId }, true);
const sB2 = ((get.plan?.steps ?? []) as Array<{ stepId: string; satisfied: boolean }>).find((s) => s.stepId === 'step_deposit_b');
if (sB2?.satisfied) throw new Error('carol\'s step was satisfied without her mandate');
console.log(`  ✓ carol's step stays open (satisfied=${sB2?.satisfied}); a commitment changed who it waits on, never what it may do`);
console.log('\nspec 382 W1 live: the committed step ran at the participant under the participant\'s mandate; recorded from their receipt; the un-mandated one stayed open. ✓');
} finally { await restoreAutoWork(); if (autoBefore.enabled) console.log('auto-work restored'); }
