/**
 * Spec 422 §9.1 — THE SECURITY SECTION, ASKED (supplied plans; no model call). The owner's rule: the Ask performs every
 * feature the section's buttons perform and answers every question its pages answer.
 *
 *   npx tsx scripts/verify-security-asks.mts        (FIXTURE_JSON=… / HANDLE=… for another estate)
 *
 * The steward asks her agent what signs for her (person.credentials.list) and how protected she is
 * (person.security.posture): both answer from the CHAIN (counts, presence) and her vault's labels, and name what they
 * could not read. Then the acts, as the Home runs them: a RENAME asks for the ceremony, the gate performs it the way
 * her Home does (writes `security.credentials` over her session) and resumes confirmed — the agent reads the new name
 * back. THE TWINS: a credential ADD resumed WITHOUT the ceremony is refused ("not recorded on chain") — the runtime never
 * claims an addition it did not witness; an UNLINK of a channel she never linked is refused by name. Nothing here
 * touches the chain's custodian set.
 */
import { fixture as fx, HOME } from './fixture.mts';
import { personaCustodian } from '@agenticprimitives/runtime-member';

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };
const me = await personaCustodian(HOME, fx.people.steward);
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' };
const post = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: H, body: JSON.stringify({ session: me.bearer, ...(body as object) }) }));
type Reply = { kind?: string; error?: string; text?: string; runRef?: string; resumeToken?: string; prompt?: { kind: string; stepRef?: string; prompt?: string; summary?: Record<string, unknown> }; results?: Array<{ toolId: string; result: unknown }>; result?: unknown; interaction?: { result?: string; navigationTarget?: string } };
const ask = async (message: string, toolId: string, args: Record<string, unknown>): Promise<Reply> => ((await post('/harness/ask', { addressee: me.agent, message, plan: { steps: [{ toolId, args }] } })).reply ?? {}) as Reply;
const resume = async (rep: Reply): Promise<Reply> => ((await post('/harness/ask', { addressee: me.agent, runRef: rep.runRef, supplied: [{ stepRef: rep.resumeToken ?? rep.prompt?.stepRef, confirmed: true }] })).reply ?? {}) as Reply;
const resultOf = (rep: Reply, toolId: string): Record<string, unknown> => ((rep.results?.find((x) => x.toolId === toolId)?.result ?? rep.result ?? {}) as Record<string, unknown>);
const record = async (op: 'record.get' | 'record.put', recordType: string, record?: unknown) => j(await fetch(`${HOME}/a2a/interactions/${me.agent}/${op}`, { method: 'POST', headers: H, body: JSON.stringify({ session: me.bearer, recordType, ...(record !== undefined ? { record } : {}) }) }));

console.log(`── ${fx.people.steward} ${me.agent} ──`);

// 1. what signs for her — from the chain, the labels from her vault
const list = await ask('what signs for me?', 'person.credentials.list', {});
const lr = resultOf(list, 'person.credentials.list') as { count?: number; items?: Array<{ grade: string; kind: string; label: string; state: string }>; unlabelled?: { passkeys: number; custodians: number }; counts?: { custodians: number; passkeys: number }; note?: string };
console.log(`  credentials.list → ${list.kind}${list.error ? ` ${list.error}` : ''} · ${lr.count} items · chain ${JSON.stringify(lr.counts)} · unlabelled ${JSON.stringify(lr.unlabelled)} · app ${list.interaction?.result ?? '-'} → ${list.interaction?.navigationTarget ?? '-'}`);
if (list.kind !== 'answer' && list.kind !== 'done') fail(`credentials.list did not answer: ${JSON.stringify(list).slice(0, 400)}`);
if (!lr.counts || lr.counts.custodians + lr.counts.passkeys < 1) fail(`the chain holds no credential for ${me.agent}? ${JSON.stringify(lr).slice(0, 300)}`);
if (!/never a signer|never signs/i.test(lr.note ?? '')) fail(`the listing must say a channel never signs: ${lr.note}`);
if (list.interaction?.navigationTarget !== 'security-sign-in') fail(`the reply must bind the Sign-in page (interaction.navigationTarget), got ${JSON.stringify(list.interaction)}`);

// 2. how protected she is — the ladder
const post_ = await ask('what happens if I lose my phone?', 'person.security.posture', {});
const pr = resultOf(post_, 'person.security.posture') as { rung?: string; note?: string; custodyMode?: number };
console.log(`  security.posture → ${post_.kind} · rung ${pr.rung} · mode ${pr.custodyMode} · "${(pr.note ?? '').slice(0, 110)}…"`);
if (!['just-you', 'backups', 'trustees'].includes(String(pr.rung))) fail(`no rung: ${JSON.stringify(pr).slice(0, 300)}`);
if (!/Next step:/.test(pr.note ?? '')) fail(`the posture must name the next step: ${pr.note}`);

// 3. RENAME, as the Home runs it: a label she holds → the ceremony prompt → the gate writes her record → resume → read back
const before = (await record('record.get', 'security.credentials')) as { record?: { v: number; items: Array<{ ref: unknown; label: string; createdAt: string; state?: string }> } };
const items = before.record?.v === 1 ? before.record.items : [];
const stamp = `gate-${Date.now().toString(36)}`;
const live = items.find((i) => (i.state ?? 'active') === 'active');
let target = live;
if (!target) {
  // no label yet on this estate: label this run's own fact — the chain's first custodian is unknown by address here, so a
  // synthetic passkey label that the chain DENIES is honest only as "retired"; use a wallet label the gate can clean up.
  target = { ref: { kind: 'custodian', address: me.agent }, label: `self ${stamp}`, createdAt: new Date().toISOString() };
  const put = await record('record.put', 'security.credentials', { v: 1, items: [...items, target] });
  if (put.ok !== true) fail(`could not seed a label: ${JSON.stringify(put).slice(0, 200)}`);
  console.log(`  (seeded a label to rename: "${target.label}")`);
}
const askRename = await ask(`rename my ${target.label} to ${stamp}`, 'person.credential.label', { credential: target.label, label: stamp });
console.log(`  credential.label → ${askRename.kind} · prompt ${askRename.prompt?.kind} · ceremony ${String(askRename.prompt?.summary?.ceremony)}`);
if (askRename.kind !== 'prompt' || askRename.prompt?.kind !== 'confirmation' || askRename.prompt?.summary?.ceremony !== 'credential-label') fail(`rename must ask for the credential-label ceremony: ${JSON.stringify(askRename).slice(0, 400)}`);
// the Home's ceremony: the label written over her session
const now = (await record('record.get', 'security.credentials')) as { record?: { v: number; items: Array<{ ref: unknown; label: string; createdAt: string }> } };
const renamed = (now.record?.items ?? []).map((i) => (JSON.stringify(i.ref) === JSON.stringify(target!.ref) ? { ...i, label: stamp } : i));
const put = await record('record.put', 'security.credentials', { v: 1, items: renamed });
if (put.ok !== true) fail(`the Home's write failed: ${JSON.stringify(put).slice(0, 200)}`);
const done = await resume(askRename);
const dr = resultOf(done, 'person.credential.label') as { renamed?: boolean; label?: string; refused?: string };
console.log(`  resumed → ${done.kind} · renamed=${dr.renamed} label=${dr.label}${dr.refused ? ` refused=${dr.refused}` : ''}`);
if (dr.renamed !== true || dr.label !== stamp) fail(`the agent did not read the new name back: ${JSON.stringify(done).slice(0, 400)}`);
// restore her label (or drop the seeded one)
const restored = live ? renamed.map((i) => (i.label === stamp ? { ...i, label: live.label } : i)) : items;
await record('record.put', 'security.credentials', { v: 1, items: restored });

// 4. TWIN — an ADD resumed without the ceremony is refused: nothing landed on chain, so nothing is claimed
const askAdd = await ask('add a passkey called gate-phantom', 'person.credential.add', { kind: 'passkey', label: `phantom ${stamp}` });
if (askAdd.kind !== 'prompt' || askAdd.prompt?.summary?.ceremony !== 'credential-add') fail(`add must ask for the credential-add ceremony: ${JSON.stringify(askAdd).slice(0, 300)}`);
const phantom = await resume(askAdd);
const ar = resultOf(phantom, 'person.credential.add') as { added?: boolean; refused?: string };
console.log(`  credential.add without the ceremony → ${phantom.kind} · added=${ar.added} · ${ar.refused ?? ''}`);
// A refused step composes into the reply's words ("Nothing was changed: …"); the refusal may sit on the result or the text.
if (ar.added === true || !/not recorded on chain/.test(`${ar.refused ?? ''} ${phantom.text ?? ''}`)) fail(`an add nobody performed must be refused by the chain's word: ${JSON.stringify(phantom).slice(0, 400)}`);

// 5. TWIN — unlinking a channel she never linked is refused by name
const un = await ask('remove my email', 'person.channel.unlink', { kind: 'email', channel: `nobody-${stamp}@example.invalid` });
const ur = resultOf(un, 'person.channel.unlink') as { refused?: string };
console.log(`  channel.unlink (never linked) → ${un.kind} · ${ur.refused ?? JSON.stringify(un).slice(0, 120)}`);
if (!/no email is linked/.test(`${ur.refused ?? ''} ${un.text ?? ''}`)) fail(`an unlink of nothing must be refused by name: ${JSON.stringify(un).slice(0, 300)}`);

console.log('\n✓ verify-security-asks: the Security section answers and acts through the Ask — the chain decides what signs, the ceremonies are the Home\'s, the agent only reports what her records show.');
