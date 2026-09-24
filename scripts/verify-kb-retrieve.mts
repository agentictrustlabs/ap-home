/**
 * Spec 413 — RETRIEVAL OVER THE PUBLIC TIER: a work its owner made public AND released becomes a passage anyone's agent
 * can retrieve, with its citation; anything short of that never does, and a withdrawal takes it back out (no model).
 *
 *   npx tsx scripts/verify-kb-retrieve.mts        (FIXTURE_JSON=… for another estate; role `steward`; needs `publicKb`)
 *
 *   1. her agent saves a public page and RELEASES it (signed under its session leaf) through /harness/ask — the Library act
 *      sends the shelf hint on the queue; a second public page is saved and never released;
 *   2. the tier: `/kb/retrieve` for the page's own sentence returns its passage (kind shelf, her SA, the release id she
 *      signed, the served commitment) — polled, because the queue and the index are both asynchronous;
 *   3. her Ask: `kb.retrieve` through her own harness (a supplied plan — the tool is offered on this estate) returns the same
 *      passage, marked untrusted and carrying no score;
 *   4. TWIN — the public page that was never released is never retrievable, and the indexer says why ("never released");
 *   5. TWIN — she makes the released page private (her agent's act, another hint); the tier WITHDRAWS it: retrieval stops
 *      returning it. That is also the tidy: nothing this gate wrote stays in the public tier.
 */
import { personaCustodian } from '@agenticprimitives/runtime-member';
import { fixture as fx, HOME, skipUnless } from './fixture.mts';

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };
const kb = skipUnless(fx.publicKb, 'a public-tier index (fixture.publicKb)');
const me = await personaCustodian(HOME, fx.people.steward);
const nonce = Date.now().toString(36);
const POLL_MS = 10_000;
const WAIT_MS = 300_000; // the queue batches (≤ 5 s) and Vectorize applies writes asynchronously (seen: ~2 min)
console.log(`── retrieval over the public tier · ${fx.people.steward} ${me.agent} · ${kb.discovery} ──`);

const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' };
const act = async (message: string, toolId: string, args: Record<string, unknown>) =>
  j(await fetch(`${HOME}/a2a/harness/ask`, { method: 'POST', headers: H, body: JSON.stringify({ session: me.bearer, addressee: me.agent, message, plan: { steps: [{ toolId, args }] } }) }));

interface Passage { kind: string; subject: string; entryId?: string; releaseId?: string; commitment?: string; text: string; score?: number }
const retrieve = async (query: string): Promise<Passage[]> => {
  const r = await j(await fetch(`${kb.discovery}/kb/retrieve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, topK: 10 }) }));
  if (r.ok !== true) fail(`the tier refused to retrieve: ${JSON.stringify(r).slice(0, 300)}`);
  return (r.passages ?? []) as Passage[];
};
const until = async <T,>(what: string, probe: () => Promise<T | null>): Promise<T> => {
  const started = Date.now();
  for (;;) {
    const got = await probe();
    if (got !== null) { console.log(`    (${what} after ${Math.round((Date.now() - started) / 1000)} s)`); return got; }
    if (Date.now() - started > WAIT_MS) fail(`${what}: not within ${WAIT_MS / 1000} s`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
};

// ── 1. a released public page, and a public page never released ──
const folder = `kb-${nonce}`;
const released = `kb-rel-${nonce}`;
const unreleased = `kb-unrel-${nonce}`;
// A sentence no other passage in the tier says, so the nearest passage to it is this page's or nobody's.
const sentence = `A keeper of the lighthouse at Quillmere counts the spring tides with a brass abacus and writes each count in ledger ${nonce}.`;
const saved = await act(`keep this page as Quillmere ${nonce}`, 'library.file.save', { id: released, name: `Quillmere ${nonce}.md`, folder, text: `# The Quillmere ledger\n\n${sentence}\n`, accessPolicy: 'public' });
if (saved.reply?.kind !== 'done' || saved.reply?.result?.saved !== true) fail(`her agent did not save the page: ${JSON.stringify(saved.reply ?? saved).slice(0, 300)}`);
const rel = await act(`publish a release of Quillmere ${nonce}`, 'library.file.publish', { id: released });
const release = rel.reply?.result?.release as { releaseId?: string; signed?: boolean } | undefined;
if (rel.reply?.kind !== 'done' || release?.signed !== true || !release.releaseId) fail(`her agent did not release the page: ${JSON.stringify(rel.reply ?? rel).slice(0, 300)}`);
const draft = await act(`keep this page as Quillmere notes ${nonce}`, 'library.file.save', { id: unreleased, name: `Quillmere notes ${nonce}.md`, folder, text: `# Quillmere notes\n\nUnreleased: the keeper's second ledger ${nonce} is kept by a brass abacus too.\n`, accessPolicy: 'public' });
if (draft.reply?.kind !== 'done') fail(`her agent did not save the unreleased page: ${JSON.stringify(draft.reply ?? draft).slice(0, 300)}`);
console.log(`  her agent saved + released ${released} (release ${release.releaseId.slice(0, 14)}…) and saved ${unreleased} public, unreleased`);

// ── 2. the tier returns the released page's passage, with the release she signed ──
const found = await until('the released page is retrievable', async () => (await retrieve(sentence)).find((p) => p.entryId === released) ?? null);
if (found.kind !== 'shelf' || found.subject.toLowerCase() !== me.agent.toLowerCase() || found.releaseId !== release.releaseId || !found.commitment || !found.text.includes(nonce)) {
  fail(`the passage does not carry its citation: ${JSON.stringify(found).slice(0, 400)}`);
}
console.log(`  /kb/retrieve · the page's passage: kind shelf, publisher ${found.subject.slice(0, 10)}…, releaseId = the signed release, commitment ${found.commitment.slice(0, 12)}…`);

// ── 3. her own Ask reaches it through the tool ──
const asked = await act(`what has been written about the Quillmere ledger ${nonce}`, 'kb.retrieve', { query: sentence, topK: 10 });
const results = (asked.reply?.results ?? []) as Array<{ toolId: string; result?: { passages?: Passage[]; untrusted?: boolean } }>;
const viaTool = results.find((x) => x.toolId === 'kb.retrieve')?.result ?? (asked.reply?.result as { passages?: Passage[]; untrusted?: boolean } | undefined);
const toolHit = viaTool?.passages?.find((p) => p.entryId === released);
if (!toolHit || viaTool?.untrusted !== true || 'score' in toolHit) fail(`kb.retrieve through her harness did not return the passage as an untrusted, unscored observation: ${JSON.stringify(asked.reply ?? asked).slice(0, 400)}`);
console.log('  her Ask · kb.retrieve: the same passage, untrusted, no score');

// ── 4. TWIN — the unreleased public page never enters the tier, and the indexer says why ──
const why = await j(await fetch(`${kb.indexer}/shelf`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner: me.agent, entryId: unreleased }) }));
if (why.status !== 'withdrawn' || !/never released/.test(String(why.reason))) fail(`the indexer did not refuse the unreleased page as never released: ${JSON.stringify(why).slice(0, 300)}`);
if ((await retrieve(`Quillmere notes ${nonce} second ledger brass abacus`)).some((p) => p.entryId === unreleased)) fail('the unreleased page is retrievable');
console.log(`  twin · the public page never released: not retrievable — the indexer: "${why.reason}"`);

// ── 5. TWIN — made private, it is withdrawn from the tier (and that is the tidy) ──
const hidden = await act(`make Quillmere ${nonce} private`, 'library.file.visibility', { id: released, accessPolicy: 'private' });
if (hidden.reply?.kind !== 'done') fail(`her agent did not make the page private: ${JSON.stringify(hidden.reply ?? hidden).slice(0, 300)}`);
await act(`make Quillmere notes ${nonce} private`, 'library.file.visibility', { id: unreleased, accessPolicy: 'private' });
await until('the private page is withdrawn from the tier', async () => ((await retrieve(sentence)).some((p) => p.entryId === released) ? null : true));
console.log('  twin · made private: the tier withdrew it — retrieval no longer returns it');

console.log(`\n✓ spec 413: a page its owner made public AND released is retrievable from the public tier with the release she signed; her agent reaches it through kb.retrieve as an untrusted, unscored observation; a public page never released never enters the tier; making it private withdraws it.`);
