/**
 * Spec 402 W3 — A ROUTINE FROM A SENTENCE.
 *
 *   npx tsx scripts/verify-routine-from-sentence.mts        (from the repo root)
 *
 * The steward says "every Monday at 8, tell me what I remember about myself" at her own agent; the sentence is compiled
 * (never a model), read back as one card, kept on her yes as a schedule row of her own on her agent's object; it lists;
 * fired now it runs as her agent holding nothing and the answer is DELIVERED to her Messages; removed on her word.
 * Twins: a playbook re-sync keeps the declared routine (it is hers, not the playbook's); said in her organization's
 * room the routine is refused; a sentence without a clock is asked back. No model call anywhere (supplied plans; the
 * fired ask is itself a supplied-shape read — memory list — so the composer renders, never composes).
 */
import { personaCustodian } from '@agenticprimitives/runtime-member';
import { fixture as fx, HOME, skipUnless, resolveOrgAgent } from './fixture.mts';

const R = skipUnless(fx.org, 'an organization the steward stewards');
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
const fail = (m: string): never => { console.error(`✗ ${m}`); process.exit(1); };
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' };
const post = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));
const steward = await personaCustodian(HOME, fx.people.steward);
const me = steward.agent.toLowerCase();
const ORG_AGENT = await resolveOrgAgent(steward.bearer, R); // the fixture may name the organization only (the estate does)
const nonce = Date.now().toString(36);
const SENTENCE = `every Monday at 8, tell me what you remember about me (gate ${nonce})`;
console.log(`── ${fx.people.steward} declares a routine from a sentence at her own agent ──`);

// 1. the sentence, compiled — read back as one card
const first = await post('/harness/ask', { session: steward.bearer, addressee: me, message: SENTENCE, tz: 'America/Denver' });
if (first.reply?.kind !== 'prompt' || !/Keep this routine\?/.test(String(first.reply?.prompt?.prompt))) fail(`read-back: ${JSON.stringify(first).slice(0, 300)}`);
console.log(`  read back: "${String(first.reply.prompt.prompt).slice(0, 120)}…"`);
if (!/every week, starting Monday/.test(String(first.reply.prompt.prompt))) fail('the read-back did not say "every week, starting Monday"');
// the plan was compiled, never a model
if (first.trace?.planner && first.trace.planner !== 'compiled') fail(`the plan was ${first.trace.planner}, not compiled`);

// 2. her yes keeps it
const kept = await post('/harness/ask', { session: steward.bearer, addressee: me, runRef: first.reply.runRef, supplied: [{ stepRef: first.reply.prompt.stepRef, data: { keep: 'yes' } }] });
const keptRes = (kept.reply?.result ?? {}) as { kept?: boolean; id?: string; every?: string; ask?: string };
if (kept.reply?.kind !== 'done' || keptRes.kept !== true || !keptRes.id) fail(`keep: ${JSON.stringify(kept).slice(0, 300)}`);
console.log(`  kept ${keptRes.id} · ${keptRes.every} · "${keptRes.ask}"`);

// 3. it lists, and the Routines route shows it as declared
const listed = await post('/harness/ask', { session: steward.bearer, addressee: me, message: 'what routines do I have', plan: { steps: [{ toolId: 'person.routine.list', args: {} }] } });
const rows = ((listed.reply?.results?.[0]?.result ?? {}) as { routines?: Array<{ id: string }> }).routines ?? [];
if (!rows.some((r) => r.id === keptRes.id)) fail(`list: ${JSON.stringify(listed).slice(0, 300)}`);
const triggers = await post('/harness/triggers', { session: steward.bearer, addressee: me });
const row = (triggers.triggers ?? []).find((t: { triggerId: string }) => t.triggerId === keptRes.id);
if (!row?.declared || row.playbookDigest !== 'declared') fail(`the trigger row is not marked declared: ${JSON.stringify(row).slice(0, 200)}`);
console.log(`  listed; the row is hers (declared by ${String(row.declared.by).slice(0, 10)}…, ${row.declared.when})`);

// twin A — a playbook re-sync keeps it (the row is not the playbook's)
const before = await post('/harness/triggers', { session: steward.bearer, addressee: me });
const _sync = await post('/harness/ask', { session: steward.bearer, addressee: me, message: 'what do you remember about me', plan: { steps: [{ toolId: 'person.memory.list', args: {} }] } }); // any ask re-syncs the playbook's triggers
const after = await post('/harness/triggers', { session: steward.bearer, addressee: me });
if (!(after.triggers ?? []).some((t: { triggerId: string }) => t.triggerId === keptRes.id)) fail('twin: a playbook re-sync removed the declared routine');
console.log(`  twin: a playbook re-sync keeps it (${(before.triggers ?? []).length} → ${(after.triggers ?? []).length} rows) ✓`);

// 4. fire it now — as her agent holding nothing; the answer is delivered to her Messages (a message from her agent,
//    carrying the routine's ref — the Home's inbox view shows it as a DM)
const fired = await post('/harness/triggers/fire', { session: steward.bearer, addressee: me, triggerId: keptRes.id });
if (fired.ok !== true || fired.outcome !== 'answered') fail(`fire: ${JSON.stringify(fired).slice(0, 300)}`);
console.log(`  fired now → ${fired.outcome}: "${String(fired.said ?? '').slice(0, 80).replace(/\n/g, ' ')}…"`);
let delivered = false;
for (let i = 0; i < 10 && !delivered; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  const inbox = await j(await fetch(`${HOME}/connect/inbox`, { headers: { authorization: `Bearer ${steward.bearer}` } })) as { items?: Array<{ messageId: string; contextRefs?: Array<{ kind: string; id: string }> }>; envelopeMeta?: Record<string, { from?: string }> };
  delivered = (inbox.items ?? []).some((it) => (it.contextRefs ?? []).some((r) => r.kind === 'routine' && r.id === keptRes.id) && String(inbox.envelopeMeta?.[it.messageId]?.from ?? '').toLowerCase().endsWith(me.slice(2)));
}
if (!delivered) fail('the routine\'s answer was not delivered to her Messages');
console.log('  the answer landed in her Messages, from her agent, carrying the routine\'s ref ✓');

// twin B — in her organization's room, a routine of her own is refused; a sentence without a clock is asked back
const room = await post('/harness/ask', { session: steward.bearer, addressee: ORG_AGENT, message: `every day at 9, say hello (gate ${nonce})`, plan: { steps: [{ toolId: 'person.routine.declare', args: { sentence: `every day at 9, say hello (gate ${nonce})` } }] } });
const roomRes = (room.reply?.result ?? room.reply?.results?.[0]?.result ?? {}) as { refused?: string };
if (!roomRes.refused && room.reply?.kind !== 'refused') fail(`twin: the organization's agent kept her routine: ${JSON.stringify(room).slice(0, 200)}`);
const noclock = await post('/harness/ask', { session: steward.bearer, addressee: me, message: 'tell me the news', plan: { steps: [{ toolId: 'person.routine.declare', args: { sentence: 'tell me the news' } }] } });
if (noclock.reply?.kind !== 'prompt') fail(`twin: a sentence without a clock was not asked back: ${JSON.stringify(noclock).slice(0, 200)}`);
console.log('  twins: refused in a room; a clockless sentence is asked back ✓');

// 4b. Spec 402 W3b — a CONNECTOR trigger: "when mail arrives from the pastor, summarize it" compiles to a Gmail POLL
//     (the clock runs it every 15 minutes; only new mail fires the ask). Fired now on a home with no Gmail connected, the
//     poll says so — an honest failure on the row, never a run and never a guess.
const mailSentence = `when mail arrives from the pastor about the retreat, summarize it (gate ${nonce})`;
const m1 = await post('/harness/ask', { session: steward.bearer, addressee: me, message: mailSentence, tz: 'America/Denver' });
if (m1.reply?.kind !== 'prompt' || !/whenever mail matching/.test(String(m1.reply?.prompt?.prompt))) fail(`connector read-back: ${JSON.stringify(m1).slice(0, 300)}`);
const m2 = await post('/harness/ask', { session: steward.bearer, addressee: me, runRef: m1.reply.runRef, supplied: [{ stepRef: m1.reply.prompt.stepRef, data: { keep: 'yes' } }] });
const mailRes = (m2.reply?.result ?? {}) as { kept?: boolean; id?: string };
if (mailRes.kept !== true || !mailRes.id) fail(`connector keep: ${JSON.stringify(m2).slice(0, 300)}`);
const mailRow = ((await post('/harness/triggers', { session: steward.bearer, addressee: me })).triggers ?? []).find((t: { triggerId: string }) => t.triggerId === mailRes.id);
if (mailRow?.kind !== 'connector' || mailRow?.on?.connector !== 'google-gmail' || !/from:pastor/.test(String(mailRow?.on?.query))) fail(`connector row: ${JSON.stringify(mailRow).slice(0, 200)}`);
const polled = await post('/harness/triggers/fire', { session: steward.bearer, addressee: me, triggerId: mailRes.id });
if (polled.outcome !== 'failed' || !/Gmail is not connected/.test(String(polled.said))) fail(`connector poll: ${JSON.stringify(polled).slice(0, 300)}`);
console.log(`  connector routine: kept as a Gmail poll (${mailRow.on.query}); fired with no Gmail connected → "${String(polled.said).slice(0, 60)}…" ✓`);
await post('/harness/ask', { session: steward.bearer, addressee: me, message: 'stop that routine', plan: { steps: [{ toolId: 'person.routine.remove', args: { id: mailRes.id } }] } });

// 5. removed on her word
const gone = await post('/harness/ask', { session: steward.bearer, addressee: me, message: 'stop that routine', plan: { steps: [{ toolId: 'person.routine.remove', args: { id: keptRes.id } }] } });
if (((gone.reply?.result ?? {}) as { removed?: boolean }).removed !== true) fail(`remove: ${JSON.stringify(gone).slice(0, 300)}`);
const final = await post('/harness/triggers', { session: steward.bearer, addressee: me });
if ((final.triggers ?? []).some((t: { triggerId: string }) => t.triggerId === keptRes.id)) fail('removed, but the row is still there');
console.log('  removed ✓');
console.log('✓ verify-routine-from-sentence — a sentence with a clock became her own routine: read back, kept on her yes, fired as her agent, answered to her, removed on her word');
