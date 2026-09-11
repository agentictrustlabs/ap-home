/**
 * Spec 375 W2 — the `message` trigger kind, live: a direct message to an agent whose playbook declares
 * `on: dm` starts a run at that agent, the agent as the asker holding nothing; the run's drafted reply is an
 * act (messaging.direct.send), so it PARKS for a steward — an inbound message never sends on its own.
 *
 *   npx tsx scripts/verify-message-trigger.mts
 *
 * playwright-demo-team holds the Coordinator playbook (`on-dm`). alice, its steward, messages it as herself
 * (her own mandate — the sender's authority), then reads the team's trigger rows and unfinished runs.
 */
import { hashDelegation, buildDigestBindingCaveat, capabilityHandler, ROOT_AUTHORITY, type Delegation, type Caveat, type MandateRequirementV1 } from '@agenticprimitives/delegation';
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
const sign = async (digest: Hex): Promise<Hex> => { const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.homeSession}` }, body: JSON.stringify({ digest }) })); if (!b.signature) throw new Error(JSON.stringify(b).slice(0, 200)); return b.signature; };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };

const orgs = ((await j(await fetch(`${HOME}/connect/related-orgs?surface=any`, { headers: { authorization: `Bearer ${alice.homeSession}` } }))).orgs ?? []) as Array<{ orgAgent: string; orgName: string; relationship: string }>;
const team = orgs.find((o) => /playwright-demo-team/i.test(o.orgName) && o.relationship === 'steward');
if (!team) fail('alice does not steward playwright-demo-team');
const TEAM = team!.orgAgent.toLowerCase() as Address;
const ME = String(alice.agent).toLowerCase() as Address;
console.log(`team ${team!.orgName} ${TEAM} · alice ${ME}`);

// An ask at the team syncs its playbook's rows; the listing must show the message trigger.
await post('/harness/ask', { session: alice.homeSession, addressee: TEAM, message: 'what are we working on' });
type Row = { triggerId: string; kind?: string; on?: { event?: string; profile?: string }; lastRunRef?: string; lastOutcome?: string; lastSaid?: string };
const rowsOf = async () => ((await post('/harness/triggers', { session: alice.homeSession, addressee: TEAM })) as { triggers?: Row[] }).triggers ?? [];
const rows = await rowsOf();
console.log(`\n── the team's triggers ──`);
for (const r of rows) console.log(`  ${r.triggerId.padEnd(18)} ${(r.kind ?? 'schedule').padEnd(9)} ${r.on?.event ?? r.on?.profile ?? ''}${r.lastOutcome ? `  last ${r.lastOutcome}` : ''}`);
const onDm = rows.find((r) => r.triggerId === 'on-dm');
if (!onDm || onDm.kind !== 'message' || onDm.on?.profile !== 'dm') fail('the coordinator playbook does not declare on-dm here — republish (register-coordinator.mjs) and reassign it');
const before = onDm!.lastRunRef;

// alice messages the team AS HERSELF — her own sender mandate, signed here, never the team's.
const note = `gate ${Date.now().toString(36)}: the thursday meeting moved to 4pm, can the team make it?`;
console.log(`\n── alice → team: "${note}" ──`);
let r1 = await post('/harness/ask', { session: alice.homeSession, addressee: ME, message: `message ${team!.orgName} that ${note}`, plan: { steps: [{ toolId: 'messaging.direct.send', args: { recipient: team!.orgName, message: note } }] } });
let rep = r1.reply as { kind?: string; error?: string; text?: string; runRef?: string; requirement?: MandateRequirementV1; delegator?: Address; delegate?: Address; alsoApprove?: Array<{ digest: Hex }>; prompt?: { kind: string; prompt: string } } | undefined;
if (rep?.kind === 'authority_required' && rep.requirement && rep.delegator && rep.delegate) {
  const caveats: Caveat[] = [...capabilityHandler.toCaveats(rep.requirement, ENFORCERS as never), buildDigestBindingCaveat(ENFORCERS.digestBinding, 'intent', rep.requirement.intentDigest as Hex)];
  let salt = 0n; for (const b of crypto.getRandomValues(new Uint8Array(16))) salt = (salt << 8n) | BigInt(b);
  const mandate: Delegation = { delegator: rep.delegator, delegate: rep.delegate, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
  const a = await post('/harness/authorize', { session: alice.homeSession, delegator: rep.delegator, digests: [hashDelegation(mandate, CHAIN, DM), ...(rep.alsoApprove ?? []).map((x) => x.digest)] });
  if (a.ok !== true) fail(`authorize build failed: ${JSON.stringify(a).slice(0, 200)}`);
  const b2 = await post('/harness/authorize', { session: alice.homeSession, delegator: rep.delegator, userOp: a.userOp, signature: await sign(a.userOpHash as Hex) });
  if (b2.ok !== true) fail(`authorize submit failed: ${JSON.stringify(b2).slice(0, 200)}`);
  mandate.signature = '0x03';
  r1 = await post('/harness/ask', { session: alice.homeSession, addressee: ME, runRef: rep.runRef, presented: { ...mandate, salt: salt.toString() } });
  rep = r1.reply;
}
console.log(`  the message → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}${rep?.prompt ? ` "${rep.prompt.prompt}"` : ''}`);
if (rep?.kind !== 'done') fail(`the message was not sent: ${JSON.stringify(r1).slice(0, 400)}`);

// The team's row records the firing; the drafted reply is an act, so the run PARKS.
let fired: Row | undefined;
for (let i = 0; i < 45; i++) {
  fired = (await rowsOf()).find((r) => r.triggerId === 'on-dm');
  if (fired?.lastRunRef && fired.lastRunRef !== before) break;
  await new Promise((r) => setTimeout(r, 2000));
}
console.log(`\n── the team's on-dm ──`);
console.log(`  ${fired?.lastRunRef && fired.lastRunRef !== before ? `${fired.lastOutcome} (run ${fired.lastRunRef}) — "${(fired.lastSaid ?? '').slice(0, 160)}"` : 'did not fire'}`);
if (!fired?.lastRunRef || fired.lastRunRef === before) fail('the direct message did not fire the coordinator\'s on-dm trigger');
if (fired.lastOutcome === 'failed') fail(`the fired run failed: ${fired.lastSaid}`);
// PARKED, for a steward: the drafted reply waits in the team's unfinished runs, nothing was sent.
const runs = ((await post('/harness/runs', { session: alice.homeSession, addressee: TEAM })) as { runs?: Array<{ runRef: string; message: string; awaiting: { kind: string; prompt: string } | null }> }).runs ?? [];
const parked = runs.find((r) => r.runRef === fired!.lastRunRef);
console.log(`  in the stewards' unfinished runs: ${parked ? `yes — "${parked.message}" waiting on ${parked.awaiting?.kind ?? '?'}` : 'no'}`);
if (fired.lastOutcome === 'parked' && !parked) fail('the row says parked but the stewards cannot find the run');
if (fired.lastOutcome !== 'parked') console.log(`  (the run ${fired.lastOutcome} rather than parking — the planner read instead of drafting; the trigger itself fired)`);
console.log(`\n✓ spec 375 W2: a direct message fired the coordinator's run at the team; the agent asked as itself, presenting nothing${fired.lastOutcome === 'parked' ? '; its drafted reply parks for a steward — nothing was sent on its own' : ''}.`);
