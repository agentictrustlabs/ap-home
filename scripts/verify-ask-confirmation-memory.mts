/**
 * SCOPED CONFIRMATION MEMORY, live — spec 385 W2.
 *
 *   [ASK_MODEL=groq] npx tsx scripts/verify-ask-confirmation-memory.mts [handle] [word] [act-ask] [other-ask]
 *
 * ASK_MODEL names one of the planners the agent offers (`/harness/vocabulary` → `models[].id`); unset, the
 * deployment default runs. ASK_PLAN=1 sends the plan the Home's own buttons would send (the invite step and
 * the roster read, `org` = the word) so the gate holds when no planner is reachable. Either changes who
 * proposes the plan, never what the resolver asks, remembers or cites.
 *
 * The person asks something that names a word TWO of their agents answer to, is asked "which one?", picks.
 * The next ask of the same word in the same place resolves to that pick, CITED, and still asks the mandate.
 * A different capability naming the same word does not inherit the pick. Clearing it (the Home's Forget)
 * makes the question come back. Nothing here is signed: the memory is written on the turn that supplied
 * the choice, and every run is left at `authority_required` — a remembered choice never reaches a verifier.
 *
 * Defaults are alice's live estate, which already holds a natural ambiguity: `somali-corridor-team.impact`
 * and "Somali Corridor Team" are both teams she stewards. No contrived records.
 */
import type { Hex } from 'viem';

const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const handle = process.argv[2] ?? 'alice';
/** Words two or more of alice's org-class agents answer to (teams, circles, organizations she stewards). The
 *  rolling conversation window (spec 370 P7, 12 turns) settles a word it saw settled before — correctly, and
 *  BEFORE any question — so a repeatable gate must ask a word the window does not currently hold. */
const ROTATION = ['somali corridor team', 'rich', 'thompson', 'xyz', 'voice test'];
let word = (process.argv[3] ?? '').toLowerCase();
// THREE DIFFERENT SENTENCES for the same act: re-sending the SAME question re-enters the unfinished run
// (spec 350 W3), whose supplied choice then rides the checkpoint — that would prove the checkpoint, not the
// memory. A different invitee is a different run; the word, the capability and the argument are the same.
const MODEL = process.env.ASK_MODEL;
const PLAN = process.env.ASK_PLAN === '1';

type Choice = { label: string; value: string; hint?: string };
type Field = { name: string; label?: string; type?: string; choices?: Choice[] };
type Prompt = { kind: string; prompt: string; stepRef: string; fields?: Field[]; scope?: { word: string; capability: string; arg: string }; digest?: Hex; signer?: string; payload?: unknown };
type Party = { arg: string; raw?: string; agent: string; label?: string; hint?: string };
type Receipt = { stepRef: string; toolId?: string; status?: string; authority?: { presentedRef?: string | null } };
type Binding = { arg: string; raw: string; agent: string; label?: string; source: string; because?: string };
type Reply = { kind: string; text?: string; error?: string; prompt?: Prompt; parties?: Party[]; capability?: string; runRef?: string; receipts?: Receipt[]; result?: { refused?: string }; plannerTrace?: { bindings?: Binding[] } };
type Out = { ok?: boolean; reply?: Reply; runRef?: string; error?: string; detail?: string };
type Entry = { word: string; capability: string; capabilityWords: string; arg: string; agent: string; label?: string; at: string };

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300) }; } };
function fail(m: string): never { console.error(`\n✗ ${m}`); process.exit(1); }

const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-jp' }) }));
if (!si.homeSession) fail(`no session for ${handle}: ${JSON.stringify(si).slice(0, 200)}`);
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const post = async (path: string, body: Record<string, unknown>) =>
  j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' }, body: JSON.stringify({ session: si.homeSession, ...body }) }));
const ask = (body: Record<string, unknown>): Promise<Out> => post('/harness/ask', { addressee: si.agent, ...(MODEL ? { model: MODEL } : {}), ...body }) as Promise<Out>;
const list = async (): Promise<Entry[]> => { const o = await post('/harness/confirmations', {}); if (!o.ok) fail(`list: ${JSON.stringify(o).slice(0, 200)}`); return o.entries as Entry[]; };
const forget = (e: { word: string; capability: string; arg: string }) => post('/harness/confirmations/forget', { scope: { word: e.word, capability: e.capability, arg: e.arg } });

const summarize = (o: Out) => {
  const r = o.reply;
  const p = r?.prompt;
  const parties = (r?.parties ?? []).map((x) => `${x.arg}=${x.label ?? x.agent.slice(0, 10)}${x.hint ? ` (${x.hint})` : ''}`).join(', ');
  return `${r?.kind ?? o.error}${p ? ` — "${p.prompt}"${p.scope ? ` [scope ${p.scope.word} · ${p.scope.capability} · ${p.scope.arg}]` : ''}` : ''}${r?.kind === 'refused' || r?.kind === 'error' ? ` — ${r.error ?? r.text}` : ''}${parties ? ` · ${parties}` : ''} [${(o.runRef ?? r?.runRef ?? '').slice(4, 12)}]`;
};
const choiceFor = (o: Out, w: string): { field: Field; prompt: Prompt } | null => {
  const p = o.reply?.prompt;
  if (o.reply?.kind !== 'prompt' || p?.kind !== 'data') return null;
  const f = (p.fields ?? []).find((x) => (x.choices?.length ?? 0) > 1 && (p.scope?.word === w || new RegExp(`“${w}”`, 'i').test(p.prompt)));
  return f ? { field: f, prompt: p } : null;
};

/** Drive one fresh ask until it needs a mandate (never given), answering ONLY the "which one?" for our word
 *  with `pick`, and any other data prompt with its first choice. Returns every turn. */
async function drive(message: string, pick: (choices: Choice[]) => Choice | null, plan?: { steps: Array<{ toolId: string; args: Record<string, unknown> }> }): Promise<{ turns: Out[]; picked: Choice | null; scope: Prompt['scope'] | null }> {
  const turns: Out[] = [];
  let r = await ask({ message, ...(PLAN && plan ? { plan } : {}) });
  turns.push(r);
  const runRef = r.runRef ?? r.reply?.runRef;
  let picked: Choice | null = null; let scope: Prompt['scope'] | null = null;
  for (let i = 0; i < 6; i++) {
    console.log(`    ${summarize(r)}`);
    const c = choiceFor(r, word);
    if (c) {
      const p = pick(c.field.choices ?? []);
      if (!p) return { turns, picked, scope: c.prompt.scope ?? null };
      picked = p; scope = c.prompt.scope ?? null;
      console.log(`    → pick "${p.label}" (${p.value.slice(0, 10)}…)`);
      r = await ask({ runRef, supplied: [{ stepRef: c.prompt.stepRef, data: { [c.field.name]: p.value } }] });
      turns.push(r); continue;
    }
    if (r.reply?.kind === 'prompt' && r.reply.prompt?.kind === 'data') {
      const f = r.reply.prompt.fields?.[0];
      const first = f?.choices?.[0];
      if (!f || !first) break;
      console.log(`    → answer ${f.name} = ${first.label}`);
      r = await ask({ runRef, supplied: [{ stepRef: r.reply.prompt.stepRef, data: { [f.name]: first.value } }] });
      turns.push(r); continue;
    }
    break;
  }
  return { turns, picked, scope };
}
const last = (t: Out[]) => t[t.length - 1]!;
/** A run that PRESENTED a mandate — the one thing a remembered choice must never make happen. A step judged
 *  elsewhere (`routed`, spec 366) or a self-acting read presents nothing here; a refusal is not an act. */
const presentedMandate = (t: Out[]) => t.flatMap((o) => o.reply?.receipts ?? []).find((r) => /^0x[0-9a-f]{64}$/i.test(String(r.authority?.presentedRef ?? '')));
const ending = (o: Out) => {
  const r = o.reply;
  if (!r) return String(o.error);
  if (r.kind === 'done' && r.result?.refused) return `done (routed step refused: ${r.result.refused.slice(0, 80)})`;
  if (r.kind === 'done') return `done (${(r.receipts ?? []).map((x) => `${x.toolId} ${x.status} via ${x.authority?.presentedRef ?? 'nothing'}`).join('; ')})`;
  return r.kind;
};
const rememberedParty = (o: Out) => (o.reply?.parties ?? []).find((p) => /remembered: you chose/i.test(p.hint ?? '') && (p.raw ?? '').toLowerCase() === word) ?? null;

// THE WORD: one the rolling window has not settled lately. Read from the person's own `conversation.recent`
// under their own session (an owner read; the record is theirs), never from anything a server asserts.
type WindowTurn = { said: string; parties?: Array<{ arg: string; raw: string; agent: string }> };
const windowTurns = async (): Promise<WindowTurn[]> => {
  const o = await j(await fetch(`${HOME.replace('www.faithnet.me', 'a2a.faithnet.io').replace(/^https:\/\/www\./, 'https://a2a.')}/interactions/${String(si.agent).toLowerCase()}/record.get`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: si.homeSession, recordType: 'conversation.recent' }) }));
  return (o.record?.turns ?? []) as WindowTurn[];
};
const heldByWindow = (turns: WindowTurn[], w: string) => turns.some((t) => (t.parties ?? []).some((p) => p.raw.trim().toLowerCase() === w));
if (!word) {
  const turns = await windowTurns();
  word = ROTATION.find((w) => !heldByWindow(turns, w)) ?? '';
  if (!word) fail(`the rolling window (${turns.length} turns) currently holds every rotation word (${ROTATION.join(', ')}) — ask ${handle} something else a dozen times, or wait`);
}
const ACT = process.argv[4] ?? `invite bob to ${word}`;
const ACT2 = `invite carol to ${word}`;
const ACT3 = `invite dave to ${word}`;
const OTHER = process.argv[5] ?? `who is in ${word}`;
const invitePlan = (invitee: string) => ({ steps: [{ toolId: 'organization.membership.invite', args: { org: word, invitee } }] });
const ACT_PLAN = invitePlan('bob');
const OTHER_PLAN = { steps: [{ toolId: 'organization.membership.list', args: { org: word } }] };

console.log(`as ${handle} (${si.agent}) — word "${word}"`);

// 0. A clean slate for THIS word: the memory is correctable, so clearing is a real op, not a test fixture.
for (const e of (await list()).filter((e) => e.word === word)) { console.log(`  clearing ${e.word} · ${e.capability} · ${e.arg}`); await forget(e); }

// 1. THE FIRST TIME: two agents answer to the word; the person is asked and picks.
console.log(`\n1. "${ACT}" — expecting "which one?"`);
// Prefer the candidate that publishes an endpoint (a dotted, registered name): the routed step then reaches
// the team's own agent and comes back asking for its steward's mandate, the fuller twin of "still asks".
const first = await drive(ACT, (choices) => choices.find((c) => c.label.includes('.')) ?? choices[0] ?? null, ACT_PLAN);
if (!first.picked) fail(`no "which one?" for "${word}" — ${summarize(first.turns[0]!)}. The gate needs a word two of ${handle}'s agents answer to.`);
if (!first.scope) fail('the choice prompt carried no scope — the trusted resume cannot be attributed');
const end1 = last(first.turns);
if (presentedMandate(first.turns)) fail('the run presented a mandate this script never signed — a choice must never authorize');
console.log(`  ended at ${ending(end1)} — nothing signed, nothing presented`);

// 2. IT IS REMEMBERED — scoped to the word, the capability, the argument; whom they picked.
const after = (await list()).filter((e) => e.word === word);
console.log(`\n2. remembered: ${after.map((e) => `${e.word} → ${e.label ?? e.agent} as ${e.arg} when you ${e.capabilityWords}`).join('; ') || '(nothing)'}`);
const kept = after.find((e) => e.capability === first.scope!.capability && e.arg === first.scope!.arg);
if (!kept) fail('the confirmation was not written to the person\'s vault (is `vault:confirmation.preferences` in their grant? re-issue with scripts/reissue-interactions-grants.mts)');
if (kept.agent.toLowerCase() !== first.picked.value.toLowerCase()) fail(`remembered ${kept.agent}, picked ${first.picked.value}`);

// 3. THE NEXT TIME: no question, the pick cited, and the mandate STILL asked.
console.log(`\n3. "${ACT2}" — expecting no question, a citation, and authority still required`);
const second = await drive(ACT2, () => null, invitePlan('carol'));
if (second.picked !== null || choiceFor(second.turns[0]!, word)) fail('asked "which one?" again although the choice was remembered');
const cited = second.turns.map(rememberedParty).find(Boolean);
if (!cited) fail(`the remembered choice was not cited on the parties — ${JSON.stringify(last(second.turns).reply?.parties ?? []).slice(0, 300)}`);
if (cited.agent.toLowerCase() !== first.picked.value.toLowerCase()) fail(`cited ${cited.agent}, remembered ${first.picked.value}`);
console.log(`  cited: ${cited.label ?? cited.agent} — "${cited.hint}"`);
const end2 = last(second.turns);
if (presentedMandate(second.turns)) fail('a remembered choice pre-authorized the act — a mandate was presented that nobody signed');
if (ending(end2) !== ending(end1).replace(/run-[0-9a-f-]+/g, '')) console.log(`  (first time ended "${ending(end1)}", this time "${ending(end2)}")`);
console.log(`  ended at ${ending(end2)} — authority judged exactly as the first time, nothing presented`);

// 4. A DIFFERENT CAPABILITY naming the same word does not inherit the pick.
console.log(`\n4. "${OTHER}" — a different capability; the payee's choice must not leak into it`);
const other = await drive(OTHER, () => null, OTHER_PLAN);
const leaked = other.turns.map(rememberedParty).find(Boolean);
if (leaked) fail(`the pick leaked across capabilities: ${leaked.hint}`);
// An ANSWER carries no parties; how its words were settled is on the trace's bindings (the Home's How pane).
// The durable memory must not be the source; the rolling window (word-scoped by design, spec 370 P7) may be,
// and then it says so.
const bound = other.turns.flatMap((o) => o.reply?.plannerTrace?.bindings ?? []).find((b) => b.raw.toLowerCase() === word);
if (bound?.because && /for this before/i.test(bound.because)) fail(`the pick leaked across capabilities on the binding: ${bound.because}`);
const askedAgain = choiceFor(other.turns[0]!, word);
console.log(`  ${askedAgain ? `asked "which one?" again [scope ${askedAgain.prompt.scope?.capability ?? '?'}]` : bound ? `settled by ${bound.source}${bound.because ? ` — "${bound.because}"` : ''}, not by the invite's memory` : `no remembered citation (${summarize(other.turns[0]!)})`}`);
if (askedAgain && askedAgain.prompt.scope?.capability === first.scope.capability) fail('the other ask compiled to the SAME capability — the twin proves nothing; pass a different other-ask');

// 5. CLEARED IN THE OPEN: the Home's Forget, then the question comes back.
console.log(`\n5. forget, then "${ACT3}" — expecting "which one?" again`);
const cleared = await forget(kept);
if (!cleared.ok) fail(`forget: ${JSON.stringify(cleared).slice(0, 200)}`);
if ((await list()).some((e) => e.word === word && e.capability === kept.capability && e.arg === kept.arg)) fail('still remembered after forget');
const third = await drive(ACT3, () => null, invitePlan('dave'));
// After forgetting, the DURABLE memory is gone: nothing may cite "for this before", and nothing may have
// written it back (a recall is never a confirmation). The ROLLING window may still settle the word from
// the runs above — it is consulted after the durable memory, and it says so ("you chose last time"); once
// it decays, the question itself comes back. Both are the truth; a silent resolution is not.
const durable = third.turns.map(rememberedParty).find(Boolean);
if (durable) fail(`still cited the durable memory after forgetting: ${durable.hint}`);
if ((await list()).some((e) => e.word === word && e.capability === kept.capability && e.arg === kept.arg)) fail('a recall wrote the memory back — only a supplied choice may');
const t0 = third.turns[0]!;
const windowHit = (t0.reply?.parties ?? []).find((p) => (p.raw ?? '').toLowerCase() === word && /you chose last time/i.test(p.hint ?? ''));
if (choiceFor(t0, word)) console.log('  the question came back');
else if (windowHit) console.log(`  the rolling window answered, and said so: "${windowHit.hint}"`);
else fail(`resolved "${word}" without a question and without saying why — ${summarize(t0)}`);

console.log('\n✓ spec 385 W2: picked once, remembered scoped and cited, the mandate still asked, no leak across capabilities, cleared in the open.');
