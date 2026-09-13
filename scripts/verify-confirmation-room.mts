/**
 * Spec 394 W2 — THE CONFIRMATION MEMORY IS NAMESPACED BY THE ROOM, live (no model — plans supplied; no spend).
 *
 *   npx tsx scripts/verify-confirmation-room.mts [word]
 *
 * alice, addressing MISSIO NEXUS, asks to invite bob to <word> — a word two of her own org-class agents answer to —
 * is asked "which one?", and picks. The confirmation is written with the room = the organization. At HOME the same
 * word for the same act is asked AGAIN (the room's choice is not read there — the twin). At the organization the
 * next ask of the word is settled from the memory, cited "remembered: you chose … for this before". Every run is
 * left at authority_required or a question: nothing signed, nothing moves.
 */
import type { Hex } from 'viem';
import { fixture as fx, HOME, A2A, resolveOrgAgent } from './fixture.mts';

const ROTATION = fx.ambiguousWords;
type Choice = { label: string; value: string };
type Field = { name: string; choices?: Choice[] };
type Prompt = { kind: string; prompt: string; stepRef: string; fields?: Field[]; scope?: { word: string; capability: string; arg: string } };
type Party = { arg: string; raw?: string; agent: string; label?: string; hint?: string };
type Reply = { kind: string; error?: string; prompt?: Prompt; parties?: Party[]; runRef?: string; receipts?: Array<{ authority?: { presentedRef?: string | null } }> };
type Out = { ok?: boolean; reply?: Reply; runRef?: string; error?: string };
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300) }; } };
function fail(m: string): never { console.error(`\n✗ ${m}`); process.exit(1); }
const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: fx.people.steward, client_id: 'demo-jp' }) }));
if (!si.homeSession) fail(`no session: ${JSON.stringify(si).slice(0, 200)}`);
const ALICE = String(si.agent).toLowerCase();
const ORG = process.env.ORG ? process.env.ORG.toLowerCase() : await resolveOrgAgent(si.homeSession);
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const post = async (path: string, body: Record<string, unknown>) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' }, body: JSON.stringify({ session: si.homeSession, ...body }) }));
const askAt = (addressee: string, body: Record<string, unknown>): Promise<Out> => post('/harness/ask', { addressee, ...body }) as Promise<Out>;
const list = async () => { const o = await post('/harness/confirmations', {}); return (o.entries ?? []) as Array<{ word: string; capability: string; arg: string; agent: string; context?: string }>; };
const forget = (e: { word: string; capability: string; arg: string; context?: string }) => post('/harness/confirmations/forget', { scope: e });

// the word: one the rolling window (alice's own conversation.recent) does not currently hold
const windowTurns = async () => { const o = await j(await fetch(`${A2A}/interactions/${ALICE}/record.get`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: si.homeSession, recordType: 'conversation.recent' }) })); return (o.record?.turns ?? []) as Array<{ parties?: Array<{ raw: string }> }>; };
let word = (process.argv[2] ?? '').toLowerCase();
if (!word) { const turns = await windowTurns(); word = ROTATION.find((w) => !turns.some((t) => (t.parties ?? []).some((p) => p.raw.trim().toLowerCase() === w))) ?? ''; }
if (!word) fail(`the rolling window holds every rotation word (${ROTATION.join(', ')}) — pass a word two of alice's agents answer to`);
const plan = (invitee: string) => ({ steps: [{ toolId: 'organization.membership.invite', args: { org: word, invitee } }] });
const choiceFor = (o: Out): { field: Field; prompt: Prompt } | null => { const p = o.reply?.prompt; if (o.reply?.kind !== 'prompt' || p?.kind !== 'data') return null; const f = (p.fields ?? []).find((x) => (x.choices?.length ?? 0) > 1 && (p.scope?.word === word || new RegExp(`“${word}”`, 'i').test(p.prompt))); return f ? { field: f, prompt: p } : null; };
const remembered = (o: Out) => (o.reply?.parties ?? []).find((p) => /remembered: you chose/i.test(p.hint ?? '') && (p.raw ?? '').toLowerCase() === word) ?? null;
const presented = (turns: Out[]) => turns.flatMap((o) => o.reply?.receipts ?? []).some((r) => /^0x[0-9a-f]{64}$/i.test(String(r.authority?.presentedRef ?? '')));
/** One ask, answering ONLY the "which one?" for our word with `pick`; other data prompts with their first choice. */
async function drive(addressee: string, message: string, p: ReturnType<typeof plan>, pick: (c: Choice[]) => Choice | null): Promise<{ turns: Out[]; picked: Choice | null; asked: boolean }> {
  const turns: Out[] = []; let r = await askAt(addressee, { message, plan: p }); turns.push(r);
  const runRef = r.runRef ?? r.reply?.runRef; let picked: Choice | null = null; let asked = false;
  for (let i = 0; i < 5; i++) {
    const c = choiceFor(r);
    if (c) { asked = true; const x = pick(c.field.choices ?? []); if (!x) break; picked = x; r = await askAt(addressee, { runRef, supplied: [{ stepRef: c.prompt.stepRef, data: { [c.field.name]: x.value } }] }); turns.push(r); continue; }
    if (r.reply?.kind === 'prompt' && r.reply.prompt?.kind === 'data') { const f = r.reply.prompt.fields?.[0]; const first = f?.choices?.[0]; if (!f || !first) break; r = await askAt(addressee, { runRef, supplied: [{ stepRef: r.reply.prompt.stepRef, data: { [f.name]: first.value } }] }); turns.push(r); continue; }
    break;
  }
  return { turns, picked, asked };
}
const say = (label: string, d: { turns: Out[]; picked: Choice | null; asked: boolean }) => console.log(`  ${label} → ${d.asked ? `asked "which one?"${d.picked ? `, picked ${d.picked.label}` : ''}` : 'no question'} · ended ${d.turns[d.turns.length - 1]!.reply?.kind}${remembered(d.turns[d.turns.length - 1]!) ? ' · cited the memory' : ''}`);

console.log(`${fx.people.steward} ${ALICE} · room ${fx.org.name} ${ORG} · word "${word}"`);
for (const e of (await list()).filter((e) => e.word === word)) await forget(e);

// 1. at the organization: asked, picks → the memory is written FOR THE ROOM
const one = await drive(ORG, `invite ${fx.people.member} to ${word}`, plan(fx.people.member), (cs) => cs.find((c) => c.label.includes('.')) ?? cs[0] ?? null);
say('1. at the organization', one);
if (!one.picked) fail(`no "which one?" for "${word}" at the organization: ${JSON.stringify(one.turns[0]).slice(0, 400)}`);
if (presented(one.turns)) fail('a mandate was presented that nobody signed');
const kept = (await list()).find((e) => e.word === word && e.capability === 'organization.membership.invite');
console.log(`     remembered: ${kept ? `${kept.agent.slice(0, 10)}… in room ${kept.context ?? 'any'}` : 'NOTHING'}`);
if (!kept || kept.context !== ORG) fail(`the confirmation should be kept for the room ${ORG}: ${JSON.stringify(kept)}`);

// 2. at HOME: the room's choice is not read — the question comes back (the twin)
const two = await drive(ALICE, `invite ${fx.people.member2} to ${word}`, plan(fx.people.member2), () => null);
say('2. at home (twin)', two);
if (remembered(two.turns[0]!) || (!two.asked && two.turns[0]!.reply?.kind !== 'prompt')) {
  // the rolling window (word-scoped by design, 370 P7) may settle it — that is not the durable room memory
  const w = (two.turns[0]!.reply?.parties ?? []).find((p) => (p.raw ?? '').toLowerCase() === word);
  if (w && /remembered: you chose/i.test(w.hint ?? '')) fail(`the organization's choice was read at home: ${w.hint}`);
  console.log(`     (settled at home by ${w?.hint ?? 'something other than the room memory'})`);
}

// 3. at the organization again: settled from the memory, cited
const three = await drive(ORG, `invite ${fx.people.outsider} to ${word}`, plan(fx.people.outsider), () => null);
say('3. at the organization again', three);
if (three.asked) fail('asked "which one?" again at the organization although the choice was remembered there');
const cited = three.turns.map(remembered).find(Boolean);
if (!cited) fail(`the room's memory was not cited: ${JSON.stringify(three.turns[0]!.reply?.parties ?? []).slice(0, 300)}`);
if (cited.agent.toLowerCase() !== one.picked.value.toLowerCase()) fail(`cited ${cited.agent}, remembered ${one.picked.value}`);
if (presented(three.turns)) fail('a remembered choice pre-authorized the act');
await forget(kept);
console.log(`\n✓ spec 394 W2 (confirmations): a choice made at the organization was kept for that room, cited there on the next ask, and not read at home. Nothing signed, nothing moved.`);
