/**
 * Spec 406 W1 — THE OPERATOR VIEW over the evidence (supplied plans; no model).
 *
 *   npx tsx scripts/verify-operator-view.mts        (FIXTURE_JSON=… for another estate; roles `steward`, `member`, `org`)
 *
 *   1. the steward asks ONE read at the organization; the run lands in the operator index with its kind, capability and
 *      bill (numbers and ids — no words of the ask, no argument, no result);
 *   2. the estate query (every agent she stewards) counts it; the agent query too; latency and the bill are numbers;
 *   3. a REBUILD from the records is idempotent (the same run once) — the index is a projection, never the record;
 *   4. the twin: a member (not a steward) cannot read the organization's operations (403); the recent row names the run
 *      whose record `/harness/records` still holds (the evidence is elsewhere, and reachable).
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
const nonce = Date.now().toString(36);
console.log(`── operator view · ${fx.org.handle} ${org} · steward ${fx.people.steward} ──`);

// ── 1. one read at the organization ──
const asked = await post('/harness/ask', { session: steward.bearer, addressee: org, message: `who is in ${fx.org.name}? (ops ${nonce})`, plan: { steps: [{ toolId: 'organization.membership.list', args: { org: fx.org.name.toLowerCase() } }] } });
const runRef = String(asked.body.reply?.runRef ?? '');
if (asked.body.reply?.kind !== 'answer' || !runRef) fail(`the read did not answer: ${JSON.stringify(asked.body).slice(0, 300)}`);
console.log(`  asked → ${asked.body.reply.kind} · run ${runRef}`);
await new Promise((r) => setTimeout(r, 2500)); // the record and its index row land after the reply (waitUntil)

// ── 2. the estate and agent queries ──
const estate = await post('/harness/ops', { session: steward.bearer, scope: 'estate', window: '24h' });
if (estate.status !== 200 || !estate.body.summary) fail(`the estate query did not answer: ${estate.status} ${JSON.stringify(estate.body).slice(0, 300)}`);
const s = estate.body.summary as { agents: string[]; totals: { runs: number; answered: number; vaultCalls: number; p50Ms: number | null }; recent: Array<{ run_ref: string; kind: string; capability: string | null; vault_calls: number; duration_ms: number | null }>; byCapability: Array<{ capability: string; runs: number }> };
const mine = s.recent.find((r) => r.run_ref === runRef);
if (!s.agents.includes(org)) fail(`the estate query does not cover ${fx.org.handle}: ${JSON.stringify(s.agents)}`);
if (!mine || mine.kind !== 'answer' || mine.capability !== 'organization.membership.list') fail(`the run is not in the index as it ran: ${JSON.stringify(s.recent.slice(0, 3)).slice(0, 400)}`);
if (JSON.stringify(estate.body).includes(nonce)) fail('the words of the ask reached the operator index');
console.log(`  estate (24 h): ${s.totals.runs} runs over ${s.agents.length} agents · answered ${s.totals.answered} · vault calls ${s.totals.vaultCalls} · p50 ${s.totals.p50Ms ?? '—'} ms · the run indexed as ${mine.kind} / ${mine.capability} / ${mine.vault_calls} vault calls / ${mine.duration_ms ?? '—'} ms · no words`);
const agentQ = await post('/harness/ops', { session: steward.bearer, scope: 'agent', addressee: org, window: '24h' });
if (!(agentQ.body.summary?.recent ?? []).some((r: { run_ref: string }) => r.run_ref === runRef)) fail(`the agent query does not carry the run: ${JSON.stringify(agentQ.body).slice(0, 300)}`);

// ── 3. a rebuild from the records is idempotent (the first backfills what the store holds; the second changes nothing) ──
const rebuilt = await post('/harness/ops', { session: steward.bearer, scope: 'agent', addressee: org, rebuild: true });
if (rebuilt.status !== 200 || !Array.isArray(rebuilt.body.rebuilt)) fail(`rebuild failed: ${JSON.stringify(rebuilt.body).slice(0, 200)}`);
const once = Number((await post('/harness/ops', { session: steward.bearer, scope: 'agent', addressee: org, window: '30d' })).body.summary.totals.runs);
await post('/harness/ops', { session: steward.bearer, scope: 'agent', addressee: org, rebuild: true });
const twice = Number((await post('/harness/ops', { session: steward.bearer, scope: 'agent', addressee: org, window: '30d' })).body.summary.totals.runs);
if (twice !== once || once < 1) fail(`a second rebuild changed the count (${once} → ${twice}) — the index is not a projection of the records`);
console.log(`  rebuilt from ${rebuilt.body.rebuilt[0].records} record(s) → ${rebuilt.body.rebuilt[0].indexed} indexed · a second rebuild leaves ${twice} (idempotent)`);

// ── 4. twins: a member is refused; the record is where the evidence is ──
const twin = await post('/harness/ops', { session: member.bearer, scope: 'agent', addressee: org, window: '24h' });
if (twin.status !== 403) fail(`a member read the organization's operations: ${twin.status}`);
const rec = await post('/harness/records', { session: steward.bearer, addressee: org });
if (!(rec.body.records ?? []).some((r: { runRef: string }) => r.runRef === runRef)) fail('the run record the index names is not in the record store');
console.log(`  twin: ${fx.people.member} (a member) → 403 · the record ${runRef.slice(0, 20)}… is in the store (the evidence)`);

console.log(`\n✓ spec 406 W1: the operator view — a run counted with its kind, capability, bill and latency in one indexed read over the estate; no words in the index; a rebuild from the records is idempotent; a member is refused; the record is the evidence.`);
