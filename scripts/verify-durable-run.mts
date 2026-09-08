/**
 * Spec 350 W3 — a run that stopped to ask a person outlives the tab it was asked in.
 *
 *   npx tsx scripts/verify-durable-run.mts        (from the repo root)
 *
 * The gate the spec names: kill the surface mid-run, resume from nothing but the runRef, and confirm the
 * mandate was RE-VERIFIED before anything executed. So each turn here is a fresh "browser": it keeps the
 * runRef and throws everything else away — no question, no mandate, no earlier answers — and the agent
 * finishes the ask from its own checkpoint.
 *
 * What a pass proves: the checkpoint carries INPUTS (question, mandate, answers) and never conclusions;
 * every turn re-plans and re-verifies (the receipts say so); a finished run leaves nothing behind; a run
 * belongs to the person who started it; and a different question may not ride an existing run's mandate.
 */
import { toHex, type Address, type Hex } from 'viem';
import { buildDigestBindingCaveat, capabilityHandler, hashDelegation, ROOT_AUTHORITY, type Caveat, type Delegation, type MandateRequirementV1 } from '../packages/delegation/src/index.js';

const HOME = 'https://www.faithnet.me';
const CHAIN = 34348;
const E = {
  delegationManager: '0x710cb1bF08C234Df397e0910331e0A29710EF4F7', timestamp: '0x73A7B878168b7DE48677617179A8bE894f0Dfe96',
  allowedTargets: '0x2156311097A936de1916a878bF53Bfd43c7b5715', allowedMethods: '0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41',
  value: '0x8759c1a6cEBF1D5069e9434EF46327Bf2ef69975', digestBinding: '0xA3bb9BCC9b2F6F2419E1aBe5ED6Fd5399b9E68e1',
} as const;
const WORKSPACE = '0xee11DFB02e4a02630bE512886305DF5C68Fd682c'.toLowerCase() as Address;
const LABEL = `durable-${Date.now().toString(36).slice(-4)}`;

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
const signinAs = async (handle: string) => {
  const s = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-jp' }) }));
  if (!s.homeSession) throw new Error(`no session for ${handle}`);
  return s as { homeSession: string; agent: string };
};
const alice = await signinAs('alice');
const personas = await j(await fetch(`${HOME}/connect/demo-personas`));
const credential = { kind: 'eoa', address: (personas.personas as Array<{ sa: string; custodian: string }>).find((p) => p.sa.toLowerCase() === String(alice.agent).toLowerCase())!.custodian };
const sign = async (token: string, digest: Hex): Promise<Hex> => {
  const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ digest }) }));
  if (!b.signature) throw new Error(`persona-sign refused: ${JSON.stringify(b).slice(0, 200)}`);
  return b.signature;
};
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
/** ONE turn from a browser that remembers nothing but what it is given. */
const post = async (body: unknown) =>
  j(await fetch(`${HOME}/a2a/harness/ask`, { method: 'POST', headers: { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' }, body: JSON.stringify(body) }));

async function mintMandate(token: string, reply: { requirement: MandateRequirementV1; delegate: Address; delegator: Address }) {
  const caveats: Caveat[] = [...capabilityHandler.toCaveats(reply.requirement, E as never), buildDigestBindingCaveat(E.digestBinding, 'intent', reply.requirement.intentDigest as Hex)];
  const salt = BigInt(toHex(crypto.getRandomValues(new Uint8Array(16))));
  const d: Delegation = { delegator: reply.delegator, delegate: reply.delegate, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
  d.signature = await sign(token, hashDelegation(d, CHAIN, E.delegationManager));
  return { ...d, salt: salt.toString() };
}

const message = `create a team called ${LABEL}`;
console.log(`── "${message}" — every turn from a browser that kept ONLY the runRef ──`);

// Turn 1: the ask. Everything else about this run is now the agent's to remember.
let r = await post({ session: alice.homeSession, addressee: WORKSPACE, message });
console.log(`  1 ${r.reply?.kind}  resumable=${r.resumable}  runRef=${r.runRef}`);
if (r.reply?.kind !== 'authority_required' || !r.resumable) throw new Error(`expected a resumable authority request: ${JSON.stringify(r).slice(0, 400)}`);
const runRef: string = r.runRef;

// Turn 2: a NEW browser. It has the runRef and the mandate it just minted — no question, no history.
const wire = await mintMandate(alice.homeSession, r.reply);
r = await post({ session: alice.homeSession, addressee: WORKSPACE, runRef, presented: wire });
console.log(`  2 ${r.reply?.kind}${r.reply?.kind === 'prompt' ? `: "${r.reply.prompt.prompt.slice(0, 60)}"` : ''}`);
if (r.reply?.kind !== 'prompt') throw new Error(`expected a prompt from the checkpoint alone: ${JSON.stringify(r).slice(0, 400)}`);

// Spec 370 P1 — from here on the agent PLANS NOTHING: the checkpoint holds the admitted plan and the steps
// that completed, the loop replays those and attempts only what is still owed. The trace says so.
const plannedFrom = (reply: { plannerTrace?: { planner?: string } } | undefined) => reply?.plannerTrace?.planner ?? '(no trace)';
if (plannedFrom(r.reply) !== 'checkpoint') throw new Error(`turn 2 should plan from the checkpoint, not "${plannedFrom(r.reply)}"`);
console.log('    planned from: checkpoint (no second plan for one intent)');
// Turn 3: another new browser. Only the runRef and the credential answer.
r = await post({ session: alice.homeSession, addressee: WORKSPACE, runRef, supplied: [{ stepRef: r.reply.resumeToken, data: { custodian: credential } }] });
if (plannedFrom(r.reply) !== 'checkpoint') throw new Error(`turn 3 should plan from the checkpoint, not "${plannedFrom(r.reply)}"`);
console.log(`  3 ${r.reply?.kind}${r.reply?.kind === 'prompt' ? `: "${r.reply.prompt.prompt.slice(0, 60)}"` : ''}`);
if (r.reply?.kind !== 'prompt' || r.reply.prompt.kind !== 'signature') throw new Error(`expected the genesis signature prompt: ${JSON.stringify(r).slice(0, 400)}`);

// Turn 4: another new browser. The signature, and nothing else.
const p = r.reply.prompt as { digest: Hex; signer: string; payload: unknown };
r = await post({ session: alice.homeSession, addressee: WORKSPACE, runRef, supplied: [{ stepRef: (r.reply as { resumeToken: string }).resumeToken, signature: { digest: p.digest, signer: p.signer, signature: await sign(alice.homeSession, p.digest), payload: (p.payload as { userOp?: unknown }) } }] });
console.log(`  4 ${r.reply?.kind}  ${r.reply?.result?.name ?? r.reply?.error ?? ''}`);
if (r.reply?.kind !== 'done') throw new Error(`expected done: ${JSON.stringify(r).slice(0, 500)}`);

// The gate: the mandate was VERIFIED on the turn that executed, not carried over from an earlier one.
const acted = (r.reply.receipts as Array<Record<string, any>>).find((x) => x.status === 'executed' && x.risk !== 'informational');
console.log(`  receipt: ${acted?.toolId} ${acted?.status} decision=${acted?.authority?.decision?.decision} afterApproval=${acted?.authority?.afterApproval}`);
if (acted?.authority?.decision?.decision !== 'allow') throw new Error('the executing turn shows no verification — a resume must re-verify');
if (plannedFrom(r.reply) !== 'checkpoint') throw new Error(`the acting turn should plan from the checkpoint, not "${plannedFrom(r.reply)}"`);
console.log(`  ✓ ${r.reply.result.name} at ${r.reply.result.agent}`);

// A finished run leaves nothing behind: resuming it again is not a second team.
const after = await post({ session: alice.homeSession, addressee: WORKSPACE, runRef });
console.log(`  after: ${after.reply?.kind ?? after.error} — ${after.error ?? ''}`);
if (after.ok !== false) throw new Error('a finished run must not be resumable');

// A run belongs to the person who started it.
const bob = await signinAs('bob');
const r2 = await post({ session: alice.homeSession, addressee: WORKSPACE, message: `create a team called ${LABEL}-b` });
const stolen = await post({ session: bob.homeSession, addressee: WORKSPACE, runRef: r2.runRef });
console.log(`  someone else's run: ${stolen.error ?? stolen.reply?.kind}`);
if (!/belongs to someone else/.test(String(stolen.error))) throw new Error("another person resumed a run that was not theirs");

// A different question may not ride an existing run's mandate.
const swapped = await post({ session: alice.homeSession, addressee: WORKSPACE, runRef: r2.runRef, message: 'pay someone instead' });
console.log(`  changed question: ${swapped.error}`);
if (!/different question/.test(String(swapped.error))) throw new Error('a run accepted a different question');

console.log('\n✓ W3 + 370 P1: the run is the agent\'s to remember — resumed from the runRef alone, planned once, completed steps replayed, re-verified on the turn that acted, gone when finished, and nobody else\'s to pick up.');
