/**
 * P1.4 — AN AGENT'S BUDGET, enforced at the door (supplied plans; no model).
 *
 *   npx tsx scripts/verify-agent-budget.mts        (FIXTURE_JSON=… for another estate; roles `steward`, `org`)
 *
 *   1. the steward reads Missio Nexus's budget (unbounded) and today's counters;
 *   2. sets a budget of (today's asks + 1) per day; ONE ask goes through (a read, answered) — counted;
 *   3. the next ask is REFUSED at the door: 429, kind refused, the reason names the numbers; nothing planned, no model;
 *   4. a resume is not a new ask: a run parked earlier for authority is still resumable (not counted, not refused);
 *   5. the twin: a member (not a steward) cannot set the budget (403); the steward clears it and asks again → answered.
 */
import { personaCustodian } from '@agenticprimitives/runtime-member';
import { fixture as fx, HOME } from './fixture.mts';

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };
const steward = await personaCustodian(HOME, fx.people.steward);
const member = await personaCustodian(HOME, fx.people.member);
const nameInfo = async (n: string): Promise<string> => { const r = await j(await fetch(`${HOME}/connect/name-info?name=${encodeURIComponent(n)}`)); if (!r.exists || !r.agent) fail(`${n} does not resolve`); return String(r.agent).toLowerCase(); };
const org = await nameInfo(fx.org.handle);
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' };
const post = async (path: string, body: unknown) => { const r = await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }); return { status: r.status, body: await j(r) }; };
const budget = (session: string, set?: Record<string, unknown>) => post('/harness/budget', { session, addressee: org, ...(set ? { set } : {}), days: 1 });
const ask = (message: string) => post('/harness/ask', { session: steward.bearer, addressee: org, message, plan: { steps: [{ toolId: 'organization.membership.list', args: { org: fx.org.name.toLowerCase() } }] } });
console.log(`── agent budget · ${fx.org.handle} ${org} · steward ${fx.people.steward} · member ${fx.people.member} ──`);

// ── 1. read ──
const b0 = await budget(steward.bearer);
if (b0.status !== 200 || b0.body.ok !== true) fail(`the steward could not read the budget: ${JSON.stringify(b0.body).slice(0, 200)}`);
const today0 = (b0.body.days as Array<{ day: string; asks: number; vaultCalls: number }>)[0]!;
console.log(`  budget: ${b0.body.budget.asksPerDay ?? '∞'} asks · ${b0.body.budget.vaultCallsPerDay ?? '∞'} vault calls / day · today ${today0.asks} asks, ${today0.vaultCalls} vault calls`);

// ── 5a. twin first: a member cannot set it ──
const twin = await budget(member.bearer, { asksPerDay: 1 });
if (twin.status !== 403) fail(`a member set the organization's budget: ${twin.status} ${JSON.stringify(twin.body).slice(0, 200)}`);
console.log(`  twin: ${fx.people.member} (a member) setting the budget → 403`);

try {
  // ── 2. a budget of today+1: one ask goes through ──
  const limit = today0.asks + 1;
  const b1 = await budget(steward.bearer, { asksPerDay: limit, note: 'verify-agent-budget' });
  if (b1.body.budget?.asksPerDay !== limit) fail(`the budget did not set: ${JSON.stringify(b1.body).slice(0, 200)}`);
  const one = await ask(`who is in ${fx.org.name}?`);
  if (one.status !== 200 || one.body.reply?.kind !== 'answer') fail(`the ask within budget did not answer: ${one.status} ${JSON.stringify(one.body).slice(0, 300)}`);
  console.log(`  budget ${limit}/day set → one ask answered (counted)`);

  // ── 3. the next is refused at the door ──
  const two = await ask(`who is in ${fx.org.name}? (again)`);
  if (two.status !== 429 || two.body.reply?.kind !== 'refused' || !/budget for today is spent: \d+ of \d+ asks/.test(String(two.body.reply?.error))) fail(`the ask over budget was not refused at the door: ${two.status} ${JSON.stringify(two.body).slice(0, 300)}`);
  console.log(`  over budget → 429 refused: "${String(two.body.reply.error).slice(0, 90)}"`);

  // ── 4. a resume is not a new ask ──
  const parked = await post('/harness/ask', { session: steward.bearer, addressee: org, runRef: 'run-does-not-exist-budget-probe' });
  if (parked.status === 429) fail('a resume was counted as a fresh ask');
  console.log(`  a resume is not a fresh ask (→ ${parked.status}, not 429)`);
} finally {
  // ── 5b. the steward clears it ──
  const cleared = await budget(steward.bearer, { asksPerDay: null, vaultCallsPerDay: null, note: '' });
  if (cleared.body.budget?.asksPerDay !== null) fail(`the budget did not clear: ${JSON.stringify(cleared.body).slice(0, 200)}`);
}
const after = await ask(`who is in ${fx.org.name}? (cleared)`);
if (after.status !== 200 || after.body.reply?.kind !== 'answer') fail(`after clearing, the ask did not answer: ${after.status}`);
console.log('  cleared → answered again');
console.log(`\n✓ P1.4: an agent's budget — declared by its steward as its own record, counted by the day at the runtime, enforced at the door before a model is called; a member cannot set it; a resume is not a fresh ask.`);
