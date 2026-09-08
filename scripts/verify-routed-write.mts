/**
 * Spec 374 W1 — A ROUTED WRITE, live: the act parks at the subject, the asker holds a commitment, the
 * steward's completion flows back and finishes the asker's run.
 *
 *   npx tsx scripts/verify-routed-write.mts
 *
 * bob, a member of Missio Nexus and not its steward, asks HIS agent to invite carol there. The act is
 * routed to missio-nexus.org, which cannot finish it for bob and parks it open to its stewards; bob's run
 * suspends on a COMMITMENT and he is told it is waiting on the organization's steward. alice, a steward,
 * finds the parked run at the organization, grants the organization's mandate under her own credential
 * and finishes it there. The organization's agent DELIVERS the outcome to bob's agent, which resumes the
 * run that waited — bob's agent signed nothing, and nothing of the organization's ever left it.
 */
import { hashDelegation, buildDigestBindingCaveat, capabilityHandler, ROOT_AUTHORITY, type Delegation, type Caveat, type MandateRequirementV1 } from '../packages/delegation/src/index.js';
import type { Address, Hex } from 'viem';

const HOME = 'https://www.faithnet.me';
const CHAIN = 34348;
const DM = '0x710cb1bF08C234Df397e0910331e0A29710EF4F7' as Address;
const ENFORCERS = {
  delegationManager: DM, timestamp: '0x73A7B878168b7DE48677617179A8bE894f0Dfe96',
  allowedTargets: '0x2156311097A936de1916a878bF53Bfd43c7b5715', allowedMethods: '0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41',
  value: '0x8759c1a6cEBF1D5069e9434EF46327Bf2ef69975', payment: '0x07fA0aE59FdE4B7ce8962d6fE7a1d648ec3DD5CE',
  digestBinding: '0xA3bb9BCC9b2F6F2419E1aBe5ED6Fd5399b9E68e1',
} as const;
const ORG = '0x3b99f2b452766de5df0dbcdfc676f27257151333' as Address;   // missio-nexus.org
const INVITEE = process.argv[2] ?? 'carol.me'; // a typed name the planner carries and the resolver reads via naming

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const signin = async (handle: string) => j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-web' }) }));
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const H = { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' };
const post = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));

const bob = await signin('bob'); const alice = await signin('alice');
const BOB = String(bob.agent).toLowerCase() as Address;
const signAs = (token: string) => async (digest: Hex): Promise<Hex> => {
  const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ digest }) }));
  if (!b.signature) throw new Error(`persona-sign refused: ${JSON.stringify(b).slice(0, 150)}`);
  return b.signature;
};
type Runs = { runs?: Array<{ runRef: string; asker: string; message: string; awaiting?: { kind: string; prompt?: string; commitment?: { debtor: string; at: { runRef: string } } }; outsider?: { agent: string; surface: string } }> };
const runsOf = async (token: string, addressee: Address) => ((await post('/harness/runs', { session: token, addressee })) as Runs).runs ?? [];

// ── 1. bob asks his own agent; the act is routed and parks at the organization ──
console.log('── bob (a member) asks his agent to invite someone to Missio Nexus ──');
const ask = `invite ${INVITEE} to Missio Nexus`;
const r1 = await post('/harness/ask', { session: bob.homeSession, addressee: BOB, message: ask });
const rep = r1.reply as { kind?: string; text?: string; error?: string; runRef?: string; stepRef?: string; on?: { agent: string; name?: string; runRef: string }; commitment?: { debtor: string; creditor: string; state: string; conditions: string } } | undefined;
console.log(`  bob's agent → ${rep?.kind}: ${JSON.stringify(rep?.text ?? rep?.error ?? '').slice(0, 220)}`);
if (rep?.kind !== 'waiting' || !rep.on || !rep.commitment) throw new Error(`expected a WAITING reply with a commitment: ${JSON.stringify(r1).slice(0, 600)}`);
console.log(`  commitment: ${rep.commitment.state} — debtor ${rep.on.name ?? rep.on.agent}, creditor ${rep.commitment.creditor.slice(0, 10)}…, "${rep.commitment.conditions}", waits as ${rep.on.runRef}`);
if (rep.on.agent.toLowerCase() !== ORG) throw new Error('the act did not park at missio-nexus.org');
if (rep.commitment.creditor.toLowerCase() !== BOB) throw new Error('the creditor is not bob\'s agent');
if (r1.resumable) throw new Error('a run waiting on a commitment must not be resumable by the asker');

const bobRuns = await runsOf(bob.homeSession, BOB);
const bobRun = bobRuns.find((r) => r.runRef === rep.runRef);
console.log(`  bob's unfinished runs: ${bobRun ? `✓ ${bobRun.runRef} awaiting ${bobRun.awaiting?.kind} — "${(bobRun.awaiting?.prompt ?? '').slice(0, 80)}"` : '✗ not listed'}`);
if (bobRun?.awaiting?.kind !== 'commitment') throw new Error('bob\'s run is not listed as waiting on a commitment');

// ── 2. the organization's steward finds the parked run at the organization ──
console.log('\n── alice (a steward) finds it among Missio Nexus\'s unfinished runs and finishes it there ──');
const orgRuns = await runsOf(alice.homeSession, ORG);
const parked = orgRuns.find((r) => r.runRef === rep.on!.runRef);
console.log(`  at missio-nexus.org: ${parked ? `✓ ${parked.runRef} asker ${parked.asker.slice(0, 10)}… outsider ${JSON.stringify(parked.outsider)} awaiting ${parked.awaiting?.kind}` : '✗ not listed'}`);
if (!parked) throw new Error('the parked run is not in the organization\'s unfinished list');
if (parked.outsider?.surface !== 'subject-ask') throw new Error('the parked run does not say it came in as a routed ask');
if (parked.asker.toLowerCase() !== BOB) throw new Error('the parked run does not name bob as its asker');

const sign = signAs(alice.homeSession);
const pick = await post('/harness/ask', { session: alice.homeSession, addressee: ORG, runRef: parked.runRef });
let rp = pick.reply as { kind?: string; error?: string; requirement?: MandateRequirementV1; delegator?: Address; delegate?: Address; alsoApprove?: Array<{ digest: Hex; purpose: string }>; prompt?: { kind?: string; stepRef?: string; digest?: Hex; prompt?: string }; runRef?: string } | undefined;
console.log(`  alice picks it up → ${rp?.kind}${rp?.error ? ` ${rp.error}` : ''}${rp?.delegator ? ` (delegator ${rp.delegator.slice(0, 10)}…)` : ''}`);
if (rp?.kind !== 'authority_required' || !rp.requirement || !rp.delegator) throw new Error(`expected the organization's mandate to be asked of its steward: ${JSON.stringify(pick).slice(0, 500)}`);
if (rp.delegator.toLowerCase() !== ORG) throw new Error('the mandate asked is not the organization\'s');
const req = rp.requirement;
const caveats: Caveat[] = [...capabilityHandler.toCaveats(req, ENFORCERS as never), buildDigestBindingCaveat(ENFORCERS.digestBinding, 'intent', req.intentDigest as Hex)];
let salt = 0n; for (const b of crypto.getRandomValues(new Uint8Array(16))) salt = (salt << 8n) | BigInt(b);
const mandate: Delegation = { delegator: rp.delegator, delegate: rp.delegate!, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
const digests = [hashDelegation(mandate, CHAIN, DM), ...(rp.alsoApprove ?? []).map((x) => x.digest)];
const a = await post('/harness/authorize', { session: alice.homeSession, delegator: rp.delegator, digests });
if (a.ok !== true) throw new Error(`authorize build failed: ${JSON.stringify(a).slice(0, 300)}`);
const b2 = await post('/harness/authorize', { session: alice.homeSession, delegator: rp.delegator, userOp: a.userOp, signature: await sign(a.userOpHash as Hex) });
if (b2.ok !== true) throw new Error(`authorize submit failed: ${JSON.stringify(b2).slice(0, 300)}`);
mandate.signature = '0x03';
console.log(`  alice approved the organization's mandate on chain (tx ${String(b2.txHash).slice(0, 18)}…)`);
let fin = await post('/harness/ask', { session: alice.homeSession, addressee: ORG, runRef: parked.runRef, presented: { ...mandate, salt: salt.toString() } });
rp = fin.reply;
if (rp?.kind === 'prompt' && rp.prompt?.kind === 'signature' && rp.prompt.digest) {
  const supplied = [{ stepRef: rp.prompt.stepRef ?? 's0', signature: { digest: rp.prompt.digest, signer: String(alice.agent).toLowerCase(), signature: await sign(rp.prompt.digest) } }];
  fin = await post('/harness/ask', { session: alice.homeSession, addressee: ORG, runRef: parked.runRef, supplied });
  rp = fin.reply;
}
console.log(`  the organization finishes → ${rp?.kind}${rp?.error ? ` ${rp.error}` : ''}`);
console.log(`  delivery to the creditor: ${JSON.stringify(fin.routedDelivery ?? 'not reported')}`);
if (rp?.kind !== 'done' && rp?.kind !== 'answer') throw new Error(`the steward could not finish the parked act: ${JSON.stringify(fin).slice(0, 500)}`);

// ── 3. the outcome was delivered: bob's run is no longer waiting ──
console.log('\n── the completion flowed back to bob\'s agent ──');
const after = await runsOf(bob.homeSession, BOB);
const still = after.find((r) => r.runRef === rep.runRef);
console.log(`  bob's unfinished runs: ${still ? `✗ still waiting (${still.awaiting?.kind})` : '✓ the run finished — nothing waits'}`);
if (still) throw new Error('bob\'s run did not resume on the delivered answer');
console.log(`\n✓ spec 374 W1: the ask was routed and the mandate was not — Missio Nexus parked the act for its steward, bob held a commitment, alice finished it at the organization under her own credential, and the organization's agent delivered the outcome that finished bob's run. Bob's agent signed nothing.`);
