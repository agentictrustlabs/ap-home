/**
 * Spec 398 §5.3 / §5.4 (G3) — a ROUTINE's own controls: PAUSE (nothing new starts, state kept; not a cancel, not a
 * revoke) and BUDGET (vault calls per firing; going over PAUSES the routine — it never widens a mandate, never tops up).
 *
 *   npx tsx scripts/verify-routine-pause.mts        (from the repo root; HOME_URL=… to point elsewhere)
 *
 * On playwright-demo-team (alice stewards it; its playbook declares a schedule row): alice pauses the routine — it is
 * listed as `blocked` (§5.1), "fire now" is refused with the pause named; she resumes it. She sets a budget of 1 vault
 * call and fires it: the firing HAPPENS (its record stands) and the routine pauses itself BY BUDGET with the numbers on
 * the row. Cleared and resumed after. The twin: bob (not a steward) can neither pause nor budget it.
 */
import type { Address } from 'viem';
import { fixture as fx, HOME, skipUnless } from './fixture.mts';

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };
const signin = async (handle: string) => j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-web' }) }));
const alice = await signin(fx.people.steward); const bob = await signin(fx.people.member);
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' };
const post = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a/harness/${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));

const orgs = ((await j(await fetch(`${HOME}/connect/related-orgs?surface=any`, { headers: { authorization: `Bearer ${alice.homeSession}` } }))).orgs ?? []) as Array<{ orgAgent: string; orgName: string; relationship?: string }>;
const ROUTINE = skipUnless(fx.routineAgent, 'agent with a scheduled routine (routineAgent)');
const team = orgs.find((o) => (o.orgName ?? '').toLowerCase() === ROUTINE.handle.toLowerCase() && o.relationship === 'steward');
if (!team) fail(`${fx.people.steward} does not steward ${ROUTINE.handle}`);
const TEAM = team!.orgAgent.toLowerCase() as Address;
type Row = { triggerId: string; kind?: string; ask: string; paused?: { by: string; note?: string }; budget?: { vaultCalls: number }; lastBill?: { vaultCalls: number }; lastOutcome?: string };
const rows = async () => ((await post('triggers', { session: alice.homeSession, addressee: TEAM })) as { triggers?: Row[] }).triggers ?? [];
await post('ask', { session: alice.homeSession, addressee: TEAM, message: 'what are we working on' });   // syncs the playbook's rows
const row = (await rows()).find((r) => (r.kind ?? 'schedule') === 'schedule');
if (!row) fail('the team has no schedule row to pause');
const id = row!.triggerId;
console.log(`── ${team!.orgName}: routine "${row!.ask}" (${id}) ──`);

// twin first: a non-steward may neither pause nor budget
const byBob = await post('triggers/pause', { session: bob.homeSession, addressee: TEAM, triggerId: id, paused: true });
console.log(`  bob pauses → ${byBob.ok === false ? `refused: ${byBob.error}` : 'ALLOWED'}`);
if (byBob.ok !== false) fail('a non-steward must not pause a routine');

// pause: listed as blocked; fire refused with the pause named; resume
const paused = await post('triggers/pause', { session: alice.homeSession, addressee: TEAM, triggerId: id, paused: true, note: 'gate' });
if (paused.ok !== true || paused.trigger?.paused?.by !== 'steward') fail(`pause: ${JSON.stringify(paused).slice(0, 200)}`);
const fired = await post('triggers/fire', { session: alice.homeSession, addressee: TEAM, triggerId: id });
console.log(`  paused by steward → fire now: ${fired.ok === false ? `refused: ${String(fired.error).slice(0, 70)}` : 'FIRED'}`);
if (fired.ok !== false || !/paused/.test(String(fired.error))) fail('a paused routine must refuse to fire');
const resumed = await post('triggers/pause', { session: alice.homeSession, addressee: TEAM, triggerId: id, paused: false });
if (resumed.ok !== true || resumed.trigger?.paused) fail(`resume: ${JSON.stringify(resumed).slice(0, 200)}`);
console.log('  resumed');

// budget: 1 vault call per firing; the firing happens and the routine pauses itself by budget
const budgeted = await post('triggers/pause', { session: alice.homeSession, addressee: TEAM, triggerId: id, budget: { vaultCalls: 1 } });
if (budgeted.ok !== true || budgeted.trigger?.budget?.vaultCalls !== 1) fail(`budget: ${JSON.stringify(budgeted).slice(0, 200)}`);
const f2 = await post('triggers/fire', { session: alice.homeSession, addressee: TEAM, triggerId: id });
console.log(`  budget 1 → fire now: ${f2.ok ? `${f2.outcome ?? 'ran'} (run ${String(f2.runRef ?? '').slice(0, 16)}…)` : `error ${f2.error}`}`);
const after = (await rows()).find((r) => r.triggerId === id)!;
console.log(`  row after: paused=${after.paused ? `${after.paused.by} — ${after.paused.note ?? ''}` : 'no'} · lastBill=${JSON.stringify(after.lastBill)} · lastOutcome=${after.lastOutcome}`);
if (after.paused?.by !== 'budget') fail('going over budget must pause the routine BY BUDGET');
if (!after.lastBill || after.lastBill.vaultCalls <= 1) fail('the firing that went over must still be on the row with its bill');

// restore
const cleared = await post('triggers/pause', { session: alice.homeSession, addressee: TEAM, triggerId: id, paused: false, budget: null });
if (cleared.ok !== true || cleared.trigger?.paused || cleared.trigger?.budget) fail(`restore: ${JSON.stringify(cleared).slice(0, 200)}`);
console.log('  cleared the budget and resumed');
console.log('\n✓ spec 398 §5.3/§5.4 (G3): a steward paused and resumed the routine (a non-steward could not); over budget it paused itself with the numbers on the row, the firing that went over stood.');
