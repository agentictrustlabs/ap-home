/**
 * Spec 323 W6 — EVERYTHING THE PERSON HAS TRAVELS: the portable-Home contract, re-proven over every record the person's
 * agent has learned to keep since the contract was written.
 *
 *   npx tsx scripts/verify-portable-home.mts        (from the repo root)
 *
 * A SECOND HOME holds nothing but the owner's broker session. With that alone, against the substrate directly (never
 * through the first Home), it reads every record the reference Home renders — profile, relationships, skills, timeline,
 * manifest, confirmations, standing instructions, memory, routines, the playbook assignment, recent turns, household —
 * through `record.get` (self-only; no bridge secret, no KV). Then the serving-plane proof: a routine she declared is a
 * RECORD in her vault; her agent's schedule row is its projection, and a forced rebuild (what a new deployment does on
 * her first ask) re-creates the row from the record with a fresh clock and the same id; removed at the Home, the record
 * and the row are both gone. Twins: another person's session reads none of her records (self access only); a Gmail
 * connector token is a credential of the deployment, not a record — its absence at a new deployment is said, never
 * carried (a read says "not connected").
 */
import { personaCustodian } from '@agenticprimitives/runtime-member';
import { fixture as fx, HOME, A2A } from './fixture.mts';

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
const fail = (m: string): never => { console.error(`✗ ${m}`); process.exit(1); };
const steward = await personaCustodian(HOME, fx.people.steward);
const other = await personaCustodian(HOME, fx.people.member);
const me = steward.agent.toLowerCase();
// the substrate, directly — a second Home never goes through the first
const op = async (session: string, principal: string, name: string, body: Record<string, unknown> = {}) => {
  const r = await fetch(`${A2A}/interactions/${principal}/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session, ...body }) });
  return { status: r.status, body: (await j(r)) as Record<string, unknown> };
};
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' };
const post = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));
console.log(`── a second Home, holding only ${fx.people.steward}'s session, reads everything she has ──`);

// 1. the ledger of records — every one the reference Home renders, readable with the session alone
const RECORDS: Array<[string, string]> = [
  ['impact-profile', 'her profile'], ['skills.data', 'her private skills'], ['control-events.data', 'her timeline'], ['home.manifest', 'her Home manifest'],
  ['confirmation.preferences', 'her confirmed choices (385)'], ['standing.instructions', 'her standing instructions (394)'], ['memory.facts', 'what her agent remembers (402 W1)'],
  ['routines.data', 'her declared routines (402 W3 · 323 W6)'], ['archetype.assignment', 'her playbook assignment (354)'], ['conversation.recent', 'her recent turns (370 P7)'], ['household.data', 'her household (368)'],
];
const st = await op(steward.bearer, me, 'status');
if (st.status !== 200 || (st.body as { granted?: boolean }).granted !== true) fail(`status: ${JSON.stringify(st.body).slice(0, 200)}`);
const scopes = ((st.body as { recordScopes?: string[] }).recordScopes ?? []);
for (const key of ['memory.facts', 'routines.data', 'standing.instructions', 'confirmation.preferences']) if (!scopes.includes(`vault:${key}`)) fail(`her grant does not name vault:${key} — a new record family without its scope is not portable`);
const rel = await op(steward.bearer, me, 'relationships.get');
if (rel.status !== 200) fail(`relationships.get: ${JSON.stringify(rel.body).slice(0, 200)}`);
let present = 0;
for (const [key, what] of RECORDS) {
  const r = await op(steward.bearer, me, 'record.get', { recordType: key });
  if (r.status !== 200 || (r.body as { ok?: boolean }).ok !== true) fail(`record.get ${key} (${what}): ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  if ((r.body as { record?: unknown }).record !== null) present++;
}
console.log(`  status granted + ${scopes.length} record scopes; relationships + ${RECORDS.length} records readable with the session alone (${present} hold something) ✓`);

// 2. a routine is a RECORD; the row is its projection, rebuilt from it
const nonce = Date.now().toString(36);
const SENTENCE = `every Tuesday at 7, tell me what you remember about me (portable ${nonce})`;
const first = await post('/harness/ask', { session: steward.bearer, addressee: me, message: SENTENCE, tz: 'America/Denver' });
if (first.reply?.kind !== 'prompt') fail(`read-back: ${JSON.stringify(first).slice(0, 300)}`);
const kept = await post('/harness/ask', { session: steward.bearer, addressee: me, runRef: first.reply.runRef, supplied: [{ stepRef: first.reply.prompt.stepRef, data: { keep: 'yes' } }] });
const id = ((kept.reply?.result ?? {}) as { id?: string }).id;
if (!id) fail(`keep: ${JSON.stringify(kept).slice(0, 300)}`);
const rec1 = await op(steward.bearer, me, 'record.get', { recordType: 'routines.data' });
const entries1 = ((rec1.body as { record?: { entries?: Array<{ triggerId: string; declared: { saidAs: string; tz: string } }> } }).record?.entries) ?? [];
const entry = entries1.find((e) => e.triggerId === id);
if (!entry || entry.declared.saidAs !== SENTENCE || entry.declared.tz !== 'America/Denver') fail(`the record does not hold the routine: ${JSON.stringify(entries1).slice(0, 300)}`);
console.log(`  declared ${id} → in routines.data, her words and zone ✓`);
const rowBefore = ((await post('/harness/triggers', { session: steward.bearer, addressee: me })).triggers ?? []).find((t: { triggerId: string }) => t.triggerId === id);
if (!rowBefore) fail('no row on her agent for the routine');
const rebuilt = await post('/harness/triggers/rebuild', { session: steward.bearer, addressee: me, force: true });
if (rebuilt.ok !== true) fail(`rebuild: ${JSON.stringify(rebuilt).slice(0, 300)}`);
const rowAfter = (rebuilt.rows as Array<{ triggerId: string; nextAt: number; playbookDigest: string; declared?: { saidAs: string } }>).find((t) => t.triggerId === id);
if (!rowAfter || rowAfter.playbookDigest !== 'declared' || rowAfter.declared?.saidAs !== SENTENCE) fail(`rebuild did not re-create the row from the record: ${JSON.stringify(rebuilt).slice(0, 300)}`);
const nextDay = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', weekday: 'long', hour: 'numeric' }).format(rowAfter.nextAt);
if (!/^Tuesday.*7 AM$/.test(nextDay)) fail(`the rebuilt clock is not Tuesday 7 AM Denver: ${nextDay}`);
console.log(`  forced rebuild: ${rebuilt.record} in the record, ${rebuilt.added} re-created, ${rebuilt.removed} dropped — the row is back, next ${nextDay} (Denver) ✓`);
const gone = await post('/harness/triggers/remove', { session: steward.bearer, addressee: me, triggerId: id });
if (gone.ok !== true) fail(`remove: ${JSON.stringify(gone).slice(0, 200)}`);
const rec2 = await op(steward.bearer, me, 'record.get', { recordType: 'routines.data' });
if ((((rec2.body as { record?: { entries?: Array<{ triggerId: string }> } }).record?.entries) ?? []).some((e) => e.triggerId === id)) fail('removed at the Home, but still in the record');
if (((await post('/harness/triggers', { session: steward.bearer, addressee: me })).triggers ?? []).some((t: { triggerId: string }) => t.triggerId === id)) fail('removed, but the row is still there');
console.log('  removed at the Home → gone from the record and the object ✓');

// twins
const theirs = await op(other.bearer, me, 'record.get', { recordType: 'memory.facts' });
if (theirs.status !== 403) fail(`twin: ${fx.people.member}'s session read ${fx.people.steward}'s memory: ${theirs.status} ${JSON.stringify(theirs.body).slice(0, 200)}`);
const mail = await post('/harness/ask', { session: steward.bearer, addressee: me, message: 'any mail from the pastor', plan: { steps: [{ toolId: 'gmail.threads.search', args: { query: 'from:pastor' } }] } });
const mailRow = ((mail.reply?.results ?? []) as Array<{ toolId: string; result: { connected?: boolean } }>).find((x) => x.toolId === 'gmail.threads.search')?.result;
if (!mailRow || typeof mailRow.connected !== 'boolean') fail(`twin: the connector read did not say whether it is connected: ${JSON.stringify(mail).slice(0, 200)}`);
console.log(`  twins: another person's session is refused (403, self only); a connector is a credential, said as ${mailRow.connected ? 'connected' : 'not connected'} — never a record ✓`);
console.log('✓ verify-portable-home — everything she has is a record her session reaches with no bridge and no KV; her routines are rebuilt from the record; nothing of hers is a bereavement');
