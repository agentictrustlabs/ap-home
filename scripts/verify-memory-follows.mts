/**
 * Spec 402 W1 — MEMORY THAT FOLLOWS THE PERSON.
 *
 *   npx tsx scripts/verify-memory-follows.mts        (from the repo root)
 *
 * The steward tells her own agent a fact ("remember that …"); her agent lists it back with when and who said it; the
 * fact reaches the planner as memory (a supplied read of it says so); the Home's memory route shows the same record;
 * she forgets it and it is gone everywhere. Twins: her organization's agent does not read her memory (the same list,
 * addressed to the organization, is refused as not offered there); another person's agent remembers nothing of hers.
 * Supplied plans throughout — no model call.
 */
import { personaCustodian } from '@agenticprimitives/runtime-member';
import { fixture as fx, HOME, skipUnless } from './fixture.mts';

const R = skipUnless(fx.org, 'an organization the steward stewards');
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
const fail = (m: string): never => { console.error(`✗ ${m}`); process.exit(1); };
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' };
const post = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));

const steward = await personaCustodian(HOME, fx.people.steward);
const other = await personaCustodian(HOME, fx.people.member);
const ask = async (who: { bearer: string; agent: string }, addressee: string, message: string, plan: unknown) => post('/harness/ask', { session: who.bearer, addressee, message, plan });
const nonce = Date.now().toString(36);
const FACT = `I lead the Thursday discovery circle (gate ${nonce})`;
console.log(`── ${fx.people.steward} tells her agent a fact; her organization ${R.handle} and ${fx.people.member} must not see it ──`);

// 1. remember
const kept = await ask(steward, steward.agent, `remember that ${FACT}`, { steps: [{ toolId: 'person.memory.remember', args: { fact: FACT, tags: ['gate'] } }] });
const keptRes = (kept.reply?.result ?? kept.reply?.results?.[0]?.result ?? {}) as { remembered?: boolean; id?: string };
if (kept.reply?.kind !== 'done' || keptRes.remembered !== true || !keptRes.id) fail(`remember: ${JSON.stringify(kept).slice(0, 300)}`);
console.log(`  remembered as ${keptRes.id}`);

// 2. list — with when and who said it
const listed = await ask(steward, steward.agent, 'what do you remember about me', { steps: [{ toolId: 'person.memory.list', args: {} }] });
const facts = ((listed.reply?.results?.[0]?.result ?? {}) as { facts?: Array<{ id: string; fact: string; source: string; learnedAt: string }> }).facts ?? [];
const mine = facts.find((f) => f.id === keptRes.id);
if (!mine || mine.source !== 'you' || !mine.learnedAt) fail(`list: ${JSON.stringify(listed).slice(0, 300)}`);
console.log(`  listed: "${mine!.fact}" · ${mine!.source} · ${mine!.learnedAt.slice(0, 10)}`);

// 3. the Home's route shows the same record
const home = await post('/harness/memory', { session: steward.bearer });
if (!(home.entries ?? []).some((e: { id: string }) => e.id === keptRes.id)) fail('the Home route does not show the fact');
console.log('  the Home route shows it ✓');

// twin A — her organization's agent does not read her memory: the read is not offered there
const org = await ask(steward, R.agent, 'what do you remember about me', { steps: [{ toolId: 'person.memory.list', args: {} }] });
const orgFacts = ((org.reply?.results?.[0]?.result ?? {}) as { facts?: unknown[] }).facts;
if (org.reply?.kind === 'answer' && Array.isArray(orgFacts) && orgFacts.some((f) => (f as { id?: string }).id === keptRes.id)) fail(`twin: the organization's agent read her memory: ${JSON.stringify(org).slice(0, 200)}`);
console.log(`  twin: the organization's agent does not read it (${org.reply?.kind}${org.reply?.error ? `: ${String(org.reply.error).slice(0, 60)}` : ''}) ✓`);

// twin B — another person's agent remembers nothing of hers
const theirs = await ask(other, other.agent, 'what do you remember about me', { steps: [{ toolId: 'person.memory.list', args: {} }] });
const theirFacts = ((theirs.reply?.results?.[0]?.result ?? {}) as { facts?: Array<{ id: string }> }).facts ?? [];
if (theirFacts.some((f) => f.id === keptRes.id)) fail('twin: another person\'s agent has her fact');
console.log('  twin: another person\'s agent remembers nothing of hers ✓');

// 4. forget — gone everywhere
const gone = await ask(steward, steward.agent, 'forget that', { steps: [{ toolId: 'person.memory.forget', args: { id: keptRes.id } }] });
const goneRes = (gone.reply?.result ?? gone.reply?.results?.[0]?.result ?? {}) as { forgotten?: boolean };
if (goneRes.forgotten !== true) fail(`forget: ${JSON.stringify(gone).slice(0, 300)}`);
const after = await post('/harness/memory', { session: steward.bearer });
if ((after.entries ?? []).some((e: { id: string }) => e.id === keptRes.id)) fail('forgotten, but the Home route still shows it');
console.log('  forgotten — gone from the list and the Home route ✓');
console.log('✓ verify-memory-follows — a fact the person told her agent is hers alone, cited as memory, forgettable');
