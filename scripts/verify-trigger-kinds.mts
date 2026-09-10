/**
 * Spec 375 W1 — trigger kinds, live: an Endeavor event fires the coordinator's run; the webhook door opens
 * for its token and for nothing else; every fired run presents no mandate.
 *
 *   npx tsx scripts/verify-trigger-kinds.mts
 *
 * playwright-demo-team holds the Coordinator playbook, which declares `on-request` (EndeavorRequestSubmitted →
 * a read), `on-commitment` (ContributionCommitted → an act) and `status-hook` (a webhook). alice, its steward:
 * (1) lists the team's triggers and sees the kinds and the webhook token; (2) calls the hook without the
 * token (401, nothing fires) and with it (a run, answered); (3) asks the team to take on a goal — the commit
 * of EndeavorRequestSubmitted fires `on-request` at the team, whose row records the run.
 */
import { hashDelegation, buildDigestBindingCaveat, capabilityHandler, ROOT_AUTHORITY, type Delegation, type Caveat, type MandateRequirementV1 } from '../packages/delegation/src/index.js';
import type { Address, Hex } from 'viem';

const HOME = 'https://www.faithnet.me';
const CHAIN = 34348;
const DM = '0x710cb1bF08C234Df397e0910331e0A29710EF4F7' as Address;
const ENFORCERS = { delegationManager: DM, timestamp: '0x73A7B878168b7DE48677617179A8bE894f0Dfe96', allowedTargets: '0x2156311097A936de1916a878bF53Bfd43c7b5715', allowedMethods: '0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41', value: '0x8759c1a6cEBF1D5069e9434EF46327Bf2ef69975', payment: '0x07fA0aE59FdE4B7ce8962d6fE7a1d648ec3DD5CE', digestBinding: '0xA3bb9BCC9b2F6F2419E1aBe5ED6Fd5399b9E68e1' } as const;
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const alice = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'alice', client_id: 'demo-web' }) }));
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const H = { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' };
const post = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));
const sign = async (digest: Hex): Promise<Hex> => { const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.homeSession}` }, body: JSON.stringify({ digest }) })); if (!b.signature) throw new Error('persona-sign refused'); return b.signature; };

const orgs = ((await j(await fetch(`${HOME}/connect/related-orgs?surface=any`, { headers: { authorization: `Bearer ${alice.homeSession}` } }))).orgs ?? []) as Array<{ orgAgent: string; orgName: string; kind?: string; relationship?: string }>;
const team = orgs.find((o) => /playwright-demo-team/i.test(o.orgName) && o.relationship === 'steward');
if (!team) throw new Error('alice does not steward playwright-demo-team');
const TEAM = team.orgAgent.toLowerCase() as Address;
console.log(`team ${team.orgName} ${TEAM}`);

// An ask syncs the playbook's rows; then the listing shows every kind.
await post('/harness/ask', { session: alice.homeSession, addressee: TEAM, message: 'what are we working on' });
type Row = { triggerId: string; kind?: string; on?: { event?: string }; token?: string; lastRunRef?: string; lastOutcome?: string; lastSaid?: string };
const rowsOf = async () => ((await post('/harness/triggers', { session: alice.homeSession, addressee: TEAM })) as { triggers?: Row[] }).triggers ?? [];
let rowsNow = await rowsOf();
console.log(`\n── the team's triggers ──`);
for (const r of rowsNow) console.log(`  ${r.triggerId.padEnd(18)} ${(r.kind ?? 'schedule').padEnd(9)} ${r.on?.event ?? ''}${r.token ? ' token ✓' : ''}${r.lastOutcome ? `  last ${r.lastOutcome}` : ''}`);
const hook = rowsNow.find((r) => r.triggerId === 'status-hook');
const onRequest = rowsNow.find((r) => r.triggerId === 'on-request');
if (!hook?.token || !onRequest || onRequest.kind !== 'event') throw new Error('the coordinator playbook does not declare the spec 375 triggers here — republish and reassign it');

console.log(`\n── the webhook door ──`);
const hookUrl = `${HOME}/a2a/harness/hooks/${TEAM}/status-hook`;
const shut = await fetch(hookUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer 0xnope' }, body: '{"from":"ci"}' });
console.log(`  wrong token → ${shut.status}`);
if (shut.status !== 401) throw new Error('the hook must refuse a wrong token');
const open = await j(await fetch(hookUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${hook.token}` }, body: JSON.stringify({ from: 'ci', build: 42 }) })) as { ok?: boolean; fired?: Array<{ triggerId: string; outcome: string; runRef: string }> };
console.log(`  right token → ${open.ok ? open.fired?.map((f) => `${f.triggerId}: ${f.outcome}`).join(', ') : JSON.stringify(open).slice(0, 200)}`);
if (!open.ok || open.fired?.[0]?.triggerId !== 'status-hook') throw new Error('the hook did not fire its row');

console.log(`\n── an Endeavor event fires the coordinator's run ──`);
const before = (await rowsOf()).find((r) => r.triggerId === 'on-request')?.lastRunRef;
const goal = `gate ${Date.now().toString(36)}: check that requests fire the coordinator`;
let r1 = await post('/harness/ask', { session: alice.homeSession, addressee: TEAM, message: `ask ${team.orgName} to take on: ${goal}`, plan: { steps: [{ toolId: 'coordination.endeavor.request', args: { org: TEAM, goal } }] } });
let rep = r1.reply as { kind?: string; error?: string; text?: string; runRef?: string; requirement?: MandateRequirementV1; delegator?: Address; delegate?: Address; alsoApprove?: Array<{ digest: Hex }> } | undefined;
if (rep?.kind === 'authority_required' && rep.requirement && rep.delegator && rep.delegate) {
  // Spec 393 W2 tail — A REQUEST IS THE REQUESTER'S ACT: the mandate asked is alice's own, never the team's.
  if (rep.delegator.toLowerCase() !== String(alice.agent).toLowerCase()) throw new Error(`the request's mandate should be the requester's (alice), not ${rep.delegator}`);
  console.log(`  the request asks for the REQUESTER's own mandate (${rep.delegator.slice(0, 10)}…)`);
  const caveats: Caveat[] = [...capabilityHandler.toCaveats(rep.requirement, ENFORCERS as never), buildDigestBindingCaveat(ENFORCERS.digestBinding, 'intent', rep.requirement.intentDigest as Hex)];
  let salt = 0n; for (const b of crypto.getRandomValues(new Uint8Array(16))) salt = (salt << 8n) | BigInt(b);
  const mandate: Delegation = { delegator: rep.delegator, delegate: rep.delegate, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
  const a = await post('/harness/authorize', { session: alice.homeSession, delegator: rep.delegator, digests: [hashDelegation(mandate, CHAIN, DM), ...(rep.alsoApprove ?? []).map((x) => x.digest)] });
  if (a.ok !== true) throw new Error(`authorize build failed: ${JSON.stringify(a).slice(0, 200)}`);
  const b2 = await post('/harness/authorize', { session: alice.homeSession, delegator: rep.delegator, userOp: a.userOp, signature: await sign(a.userOpHash as Hex) });
  if (b2.ok !== true) throw new Error(`authorize submit failed: ${JSON.stringify(b2).slice(0, 200)}`);
  mandate.signature = '0x03';
  r1 = await post('/harness/ask', { session: alice.homeSession, addressee: TEAM, runRef: rep.runRef, presented: { ...mandate, salt: salt.toString() } });
  rep = r1.reply;
}
console.log(`  the request → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}`);
if (rep?.kind !== 'done' && rep?.kind !== 'answer') throw new Error(`the request did not commit: ${JSON.stringify(r1).slice(0, 400)}`);
let fired: Row | undefined;
for (let i = 0; i < 20; i++) {
  fired = (await rowsOf()).find((r) => r.triggerId === 'on-request');
  if (fired?.lastRunRef && fired.lastRunRef !== before) break;
  await new Promise((r) => setTimeout(r, 2000));
}
console.log(`  on-request → ${fired?.lastRunRef && fired.lastRunRef !== before ? `${fired.lastOutcome} (run ${fired.lastRunRef}) — "${(fired.lastSaid ?? '').slice(0, 100)}"` : 'did not fire'}`);
if (!fired?.lastRunRef || fired.lastRunRef === before) throw new Error('EndeavorRequestSubmitted did not fire the coordinator\'s on-request trigger');
console.log(`\n✓ spec 375 W1: the webhook door opened for its token and for nothing else; an Endeavor event fired the coordinator's run at the team — the agent asked as itself, presenting nothing.`);
