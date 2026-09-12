/**
 * Spec 398 §5.3 — CANCEL is one of four things. A run that stopped to ask a person can be STOPPED by that person:
 * what already happened stands, the record says so, and nobody else can stop it.
 *
 *   HOME_URL=… HANDLE=… WORKSPACE=… npx tsx scripts/verify-cancel.mts        (from the repo root)
 *
 * The journey: alice asks her workspace to create a team → the run parks on authority (nothing executed) → she
 * stops it → the runtime says "stopped after step 0", the run is gone from the parked list, its record reads
 * `canceled` (never `failed`) and a resume is refused. The negative twin: bob cannot stop alice's run — a cancel is
 * as much the asker's as a resume is (claimableBy), and a refusal names it.
 */
import type { Address } from 'viem';

const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const HANDLE = process.env.HANDLE ?? 'alice';
const OTHER = process.env.OTHER ?? 'bob';
const WORKSPACE = (process.env.WORKSPACE ?? '0xee11DFB02e4a02630bE512886305DF5C68Fd682c').toLowerCase() as Address;
const LABEL = `stop-${Date.now().toString(36).slice(-4)}`;

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };
const signinAs = async (handle: string) => {
  const s = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-jp' }) }));
  if (!s.homeSession) fail(`no session for ${handle}`);
  return s as { homeSession: string; agent: string };
};
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const H = { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' };
const post = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a/harness/${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));

const alice = await signinAs(HANDLE);
const message = `create a team called ${LABEL}`;
console.log(`── "${message}" at the workspace — then stop it ──`);

// 1. The ask parks: the genesis needs a mandate nobody has minted.
const r1 = await post('ask', { session: alice.homeSession, addressee: WORKSPACE, message });
console.log(`  ask → ${r1.reply?.kind}  resumable=${r1.resumable}  runRef=${r1.runRef}`);
if (r1.reply?.kind !== 'authority_required' || !r1.resumable) fail(`expected a parked authority request: ${JSON.stringify(r1).slice(0, 300)}`);
const runRef: string = r1.runRef;

// 2. It is listed as waiting for a signature (398 §5.1 — the projected word, not the native one).
const listed = await post('runs', { session: alice.homeSession, addressee: WORKSPACE });
const mine = (listed.runs as Array<{ runRef: string; state?: string }>).find((r) => r.runRef === runRef);
console.log(`  parked list: ${mine ? `state=${mine.state}` : 'NOT LISTED'}`);
if (mine?.state !== 'awaiting-approval') fail('the parked run must be listed as awaiting-approval');

// 3. The negative twin FIRST: someone else cannot stop it.
const other = await signinAs(OTHER);
const theirs = await post('cancel', { session: other.homeSession, addressee: WORKSPACE, runRef });
console.log(`  ${OTHER} stops it → ${theirs.ok === false ? `refused: ${theirs.error}` : 'ALLOWED'}`);
if (theirs.ok !== false) fail(`${OTHER} must not be able to stop ${HANDLE}'s run`);

// 4. The asker stops it: nothing had run, so nothing stands.
const stopped = await post('cancel', { session: alice.homeSession, addressee: WORKSPACE, runRef, note: 'changed my mind' });
console.log(`  ${HANDLE} stops it → ${stopped.ok ? `state=${stopped.state} stoppedAfter=${stopped.stoppedAfter}` : `refused: ${stopped.error}`}`);
if (stopped.ok !== true || stopped.state !== 'canceled' || stopped.stoppedAfter !== 0) fail(`expected a cancel after step 0: ${JSON.stringify(stopped).slice(0, 300)}`);

// 5. Gone from the parked list; a resume is refused; the record reads canceled — never failed.
const after = await post('runs', { session: alice.homeSession, addressee: WORKSPACE });
if ((after.runs as Array<{ runRef: string }>).some((r) => r.runRef === runRef)) fail('a canceled run must leave the parked list');
const resumed = await post('ask', { session: alice.homeSession, addressee: WORKSPACE, runRef });
console.log(`  resume → ${resumed.ok === false ? `refused: ${resumed.error}` : resumed.reply?.kind}`);
if (resumed.ok !== false) fail('a canceled run must not be resumable');
const records = await post('records', { session: alice.homeSession, addressee: WORKSPACE });
const rec = (records.records as Array<{ runRef: string; outcome: string; canceled?: { afterSteps: number; by: string; note?: string } }>).find((r) => r.runRef === runRef);
console.log(`  record: outcome=${rec?.outcome} canceled=${rec?.canceled ? `after ${rec.canceled.afterSteps} by ${rec.canceled.by.slice(0, 10)}… "${rec.canceled.note ?? ''}"` : 'NO'}`);
if (!rec?.canceled) fail('the record must be kept and marked canceled');
if (rec.outcome === 'failed') fail('a canceled run is not a failed one (398 §5.3)');
if (rec.canceled.by.toLowerCase() !== String(alice.agent).toLowerCase()) fail('the record must name who stopped it');

console.log('\n✓ spec 398 §5.3: the asker stopped the run; what stood is recorded; nobody else could; a resume is refused.');
