/**
 * Spec 403 W1–W5 — A REMINDER, ONCE · A NUDGE UNDER HER PREFERENCE · HOW SHE WANTS ANSWERS · THE WEB AS EVIDENCE · UNDO.
 *
 *   npx tsx scripts/verify-reminders-and-preferences.mts        (from the repo root)
 *
 * The steward says "in 20 minutes remind me to call the pastor" at her own agent: compiled (no model), read back as a
 * reminder in her zone, kept on her yes as a ONCE row and a record entry with its moment; fired now it is delivered to
 * her Messages verbatim, its email nudge is STATED (sent, or why not), and it is gone from the row and the record.
 * Preferences: "answer me briefly, call me Ali" is kept as her record and read back; the route reads it; with email
 * nudges off a second reminder fires with no mail and says nothing about mail. Web search: a supplied `web.search`
 * returns the search's sources with the WebSearchCard binding. Undo: `calendar.event.delete` on a word parks for her
 * signature. Twins: preferences in her organization's room are refused; a reminder with no clock is asked back.
 */
import { personaCustodian } from '@agenticprimitives/runtime-member';
import { fixture as fx, HOME, A2A, skipUnless } from './fixture.mts';

const R = skipUnless(fx.org, 'an organization the steward stewards');
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
const fail = (m: string): never => { console.error(`✗ ${m}`); process.exit(1); };
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' };
const post = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));
const steward = await personaCustodian(HOME, fx.people.steward);
const me = steward.agent.toLowerCase();
const record = async (key: string) => ((await j(await fetch(`${A2A}/interactions/${me}/record.get`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: steward.bearer, recordType: key }) }))) as { record?: unknown }).record;
const nonce = Date.now().toString(36);
console.log(`── ${fx.people.steward}: a reminder, her preferences, the web, an undo ──`);

// 1. a reminder, compiled and read back
const SENTENCE = `in 20 minutes remind me to call the pastor (gate ${nonce})`;
const first = await post('/harness/ask', { session: steward.bearer, addressee: me, message: SENTENCE, tz: 'America/Denver' });
if (first.reply?.kind !== 'prompt' || !/Keep this reminder\?/.test(String(first.reply?.prompt?.prompt))) fail(`read-back: ${JSON.stringify(first).slice(0, 300)}`);
if (first.trace?.planner && first.trace.planner !== 'compiled') fail(`the plan was ${first.trace.planner}, not compiled`);
console.log(`  read back: "${String(first.reply.prompt.prompt).slice(0, 110)}…"`);
const kept = await post('/harness/ask', { session: steward.bearer, addressee: me, runRef: first.reply.runRef, supplied: [{ stepRef: first.reply.prompt.stepRef, data: { keep: 'yes' } }] });
const keptRes = (kept.reply?.result ?? {}) as { kept?: boolean; id?: string; once?: boolean; every?: string };
if (keptRes.kept !== true || !keptRes.id || keptRes.once !== true || keptRes.every !== 'once') fail(`keep: ${JSON.stringify(kept).slice(0, 300)}`);
const rec = (await record('routines.data')) as { entries?: Array<{ triggerId: string; kind: string; at?: number; declared: { tz: string } }> } | null;
const entry = rec?.entries?.find((e) => e.triggerId === keptRes.id);
if (!entry || entry.kind !== 'once' || typeof entry.at !== 'number' || entry.declared.tz !== 'America/Denver') fail(`the record does not hold the reminder as once with its moment: ${JSON.stringify(entry)}`);
const row = ((await post('/harness/triggers', { session: steward.bearer, addressee: me })).triggers ?? []).find((t: { triggerId: string }) => t.triggerId === keptRes.id);
if (row?.kind !== 'once' || Math.abs(Number(row.nextAt) - entry.at) > 1000) fail(`the row is not a once row at the record's moment: ${JSON.stringify(row).slice(0, 200)}`);
console.log(`  kept ${keptRes.id} — once, at ${new Date(entry.at).toISOString()}, in the record and on the object ✓`);

// 2. fired now: delivered verbatim, the nudge stated, then gone from both
const fired = await post('/harness/triggers/fire', { session: steward.bearer, addressee: me, triggerId: keptRes.id });
if (fired.ok !== true || fired.outcome !== 'answered' || !/^Reminder: call the pastor/.test(String(fired.said))) fail(`fire: ${JSON.stringify(fired).slice(0, 300)}`);
if (!/emailed alice@|not emailed \(/.test(String(fired.said))) fail(`the nudge's outcome was not stated: "${fired.said}"`);
console.log(`  fired → "${String(fired.said).slice(0, 110)}" ✓`);
let delivered = false;
for (let i = 0; i < 10 && !delivered; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  const inbox = await j(await fetch(`${HOME}/connect/inbox`, { headers: { authorization: `Bearer ${steward.bearer}` } })) as { items?: Array<{ messageId: string; contextRefs?: Array<{ kind: string; id: string }> }> };
  delivered = (inbox.items ?? []).some((it) => (it.contextRefs ?? []).some((r) => r.kind === 'routine' && r.id === keptRes.id));
}
if (!delivered) fail('the reminder was not delivered to her Messages');
if (((await post('/harness/triggers', { session: steward.bearer, addressee: me })).triggers ?? []).some((t: { triggerId: string }) => t.triggerId === keptRes.id)) fail('fired, but the row is still there');
const rec2 = (await record('routines.data')) as { entries?: Array<{ triggerId: string }> } | null;
if ((rec2?.entries ?? []).some((e) => e.triggerId === keptRes.id)) fail('fired, but still in the record');
console.log('  delivered to her Messages; gone from the row and the record ✓');

// 3. preferences — kept as her record, read back, honoured by the nudge
const set = await post('/harness/ask', { session: steward.bearer, addressee: me, message: 'answer me briefly and call me Ali', plan: { steps: [{ toolId: 'person.preferences.set', args: { style: 'brief', callMe: 'Ali' } }] } });
const setRes = (set.reply?.result ?? {}) as { changed?: boolean; preferences?: { answer?: { style?: string; callMe?: string } } };
if (setRes.changed !== true || setRes.preferences?.answer?.style !== 'brief' || setRes.preferences?.answer?.callMe !== 'Ali') fail(`preferences set: ${JSON.stringify(set).slice(0, 300)}`);
const got = await post('/harness/preferences', { session: steward.bearer });
if (got.ok !== true || got.preferences?.answer?.callMe !== 'Ali' || typeof got.emailRail !== 'boolean') fail(`preferences route: ${JSON.stringify(got).slice(0, 200)}`);
console.log(`  preferences kept (brief, "Ali"); route reads them; email rail ${got.emailRail ? 'present' : 'absent'}, address ${got.email ?? 'none'} ✓`);
const off = await post('/harness/preferences', { session: steward.bearer, set: { notify: { email: false } } });
if (off.preferences?.notify?.email !== false) fail(`could not turn nudges off: ${JSON.stringify(off).slice(0, 200)}`);
const second = await post('/harness/ask', { session: steward.bearer, addressee: me, message: `in 30 minutes remind me to lock up (gate ${nonce})`, tz: 'America/Denver' });
const keep2 = await post('/harness/ask', { session: steward.bearer, addressee: me, runRef: second.reply?.runRef, supplied: [{ stepRef: second.reply?.prompt?.stepRef, data: { keep: 'yes' } }] });
const id2 = ((keep2.reply?.result ?? {}) as { id?: string }).id;
if (!id2) fail(`second reminder: ${JSON.stringify(keep2).slice(0, 200)}`);
const fired2 = await post('/harness/triggers/fire', { session: steward.bearer, addressee: me, triggerId: id2 });
if (fired2.outcome !== 'answered' || /emailed|not emailed/.test(String(fired2.said))) fail(`with nudges off the mail was still spoken of: "${fired2.said}"`);
console.log('  with email nudges off, a reminder fires to Messages alone ✓');
await post('/harness/preferences', { session: steward.bearer, set: { notify: { email: null }, answer: { style: null, callMe: null } } });

// 4. the web as evidence
const search = await post('/harness/ask', { session: steward.bearer, addressee: me, message: 'search the web for Cloudflare Email Service', plan: { steps: [{ toolId: 'web.search', args: { query: 'Cloudflare Email Service', max: 3 } }] } });
const sRow = ((search.reply?.results ?? []) as Array<{ toolId: string; result: { searched?: boolean; sources?: string[]; untrusted?: boolean; refused?: string } }>).find((x) => x.toolId === 'web.search')?.result;
if (search.reply?.kind !== 'answer' || !sRow?.searched || !(sRow.sources ?? []).length || sRow.untrusted !== true) fail(`search: ${JSON.stringify(search).slice(0, 400)}`);
if (search.reply?.interaction?.result !== 'WebSearchCard') fail(`no WebSearchCard binding: ${JSON.stringify(search.reply?.interaction)}`);
console.log(`  web search → ${sRow.sources!.length} sources (${new URL(sRow.sources![0]!).hostname}…), WebSearchCard ✓`);

// 5. undo parks for her signature
const undo = await post('/harness/ask', { session: steward.bearer, addressee: me, message: 'remove that event from my calendar', plan: { steps: [{ toolId: 'calendar.event.delete', args: { id: 'gate-event' } }] } });
if (undo.reply?.kind !== 'authority_required' || undo.reply?.capability !== 'calendar.event.delete') fail(`undo did not park: ${JSON.stringify(undo).slice(0, 300)}`);
console.log('  calendar.event.delete on a word → authority_required (her signature) ✓');

// twins
const room = await post('/harness/ask', { session: steward.bearer, addressee: R.agent, message: 'answer me briefly', plan: { steps: [{ toolId: 'person.preferences.set', args: { style: 'brief' } }] } });
const roomRes = (room.reply?.result ?? room.reply?.results?.[0]?.result ?? {}) as { refused?: string };
if (!roomRes.refused && room.reply?.kind !== 'refused') fail(`twin: the organization's agent kept her preferences: ${JSON.stringify(room).slice(0, 200)}`);
const noclock = await post('/harness/ask', { session: steward.bearer, addressee: me, message: 'remind me to call bob', plan: { steps: [{ toolId: 'person.routine.declare', args: { sentence: 'remind me to call bob' } }] } });
if (noclock.reply?.kind !== 'prompt' || !/tomorrow at 3/.test(String(noclock.reply?.prompt?.prompt))) fail(`twin: a reminder with no clock was not asked back in reminder words: ${JSON.stringify(noclock).slice(0, 200)}`);
console.log('  twins: refused in a room; a clockless reminder is asked back ✓');
console.log('✓ verify-reminders-and-preferences — a reminder fires once and is gone; the nudge is stated and obeys her preference; how she wants answers is her record; the web is evidence; an undo takes her signature');
