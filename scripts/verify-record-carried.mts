/**
 * Spec 406 W3 — CARRYING THE RECORD TO ANOTHER HOME (supplied plans; no model).
 *
 *   npx tsx scripts/verify-record-carried.mts        (SECOND_HOME / SECOND_A2A name the other estate; alice must be a person there)
 *
 *   1. at Faithnet, alice asks one read; its PROV bundle is exported and ANCHORED (spec 406 W2); she reads the bundle
 *      under her session (`POST /harness/provenance`);
 *   2. at the SECOND Home (the ap-home estate — its own runtime, its own vault), alice signs in as the same Smart Agent
 *      and CARRIES the bundle into her vault there (`POST /harness/records/import`);
 *   3. the second Home serves it (`/harness/provenance` — the vault is the record) and its PUBLIC projection reads the
 *      anchor FROM THE CHAIN by recomputing the digest: the anchor names the Faithnet runtime's harness agent, a time,
 *      and the intent — nothing the carrier said is trusted;
 *   4. the twin: a bundle altered in transit imports (it is hers to keep) but the chain holds no anchor for it — the
 *      second Home says `anchor: null`; and a record that is not provenance or a receipt is refused at the door.
 */
import { keccak256, toBytes, type Hex } from 'viem';
import { personaCustodian } from '@agenticprimitives/runtime-member';
import { fixture as fx, HOME } from './fixture.mts';

const SECOND_HOME = process.env.SECOND_HOME ?? 'https://home-rho-orpin.vercel.app';
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };
const stable = (v: unknown): string => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(stable).join(',')}]` : `{${Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
const digestOf = (bundle: unknown): Hex => keccak256(toBytes(stable(bundle)));
async function homeClient(home: string, handle: string) {
  const me = await personaCustodian(home, handle);
  const csrfRes = await fetch(`${home}/a2a/auth/csrf`, { headers: { origin: home } });
  const csrf = (await j(csrfRes)) as { token?: string };
  const H = { 'content-type': 'application/json', origin: home, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' };
  return { me, post: async (path: string, body: unknown) => { const r = await fetch(`${home}/a2a${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }); return { status: r.status, body: await j(r) }; } };
}
const A = await homeClient(HOME, fx.people.steward);
const B = await homeClient(SECOND_HOME, fx.people.steward);
if (A.me.agent.toLowerCase() !== B.me.agent.toLowerCase()) fail(`${fx.people.steward} is not the same agent at both Homes: ${A.me.agent} vs ${B.me.agent}`);
const agent = A.me.agent.toLowerCase();
console.log(`── carrying the record · ${fx.people.steward} ${agent} · ${HOME} → ${SECOND_HOME} ──`);

// ── 1. a run at Faithnet, anchored; the bundle in her hands ──
const asked = await A.post('/harness/ask', { session: A.me.bearer, addressee: agent, message: 'what do you remember about me', plan: { steps: [{ toolId: 'person.memory.list', args: {} }] } });
const runRef = String(asked.body.reply?.runRef ?? '');
if (asked.body.reply?.kind !== 'answer' || !runRef) fail(`the read did not answer at Faithnet: ${JSON.stringify(asked.body).slice(0, 300)}`);
let pubA: { anchor?: { digest: string; anchoredBy: string; txHash?: string } } = {};
for (let i = 0; i < 12 && !pubA.anchor; i++) { await new Promise((r) => setTimeout(r, 2500)); pubA = (await A.post('/provenance/public', { agent, runRef })).body; }
if (!pubA.anchor?.digest) fail(`the run was not anchored at Faithnet: ${JSON.stringify(pubA).slice(0, 300)}`);
const bundleRes = await A.post('/harness/provenance', { session: A.me.bearer, addressee: agent, runRef, format: 'jsonld' });
const bundle = bundleRes.body.provenance ?? bundleRes.body.graph ?? bundleRes.body.document;
if (!bundle || digestOf(bundle) !== pubA.anchor.digest) fail(`the bundle she holds does not hash to the anchor: ${JSON.stringify(bundleRes.body).slice(0, 200)}`);
console.log(`  Faithnet: run ${runRef} anchored (${pubA.anchor.digest.slice(0, 14)}… by ${pubA.anchor.anchoredBy.slice(0, 10)}…) · the bundle in her hands`);

// ── 2. carried into her vault at the second Home ──
const key = `run.provenance:${runRef}`;
const imported = await B.post('/harness/records/import', { session: B.me.bearer, recordType: key, record: bundle });
if (imported.status !== 200 || imported.body.ok !== true) fail(`the second Home did not take the record: ${imported.status} ${JSON.stringify(imported.body).slice(0, 300)}`);
console.log(`  ${SECOND_HOME}: ${key} written to her vault there (${imported.body.hasProvenance?.public?.route ?? ''})`);

// ── 3. served there; the anchor read from the chain ──
const served = await B.post('/harness/provenance', { session: B.me.bearer, addressee: agent, runRef, format: 'jsonld' });
if (served.body.ok !== true || !served.body.carried || digestOf(served.body.provenance) !== pubA.anchor.digest) fail(`the second Home does not serve the carried bundle as it was: ${JSON.stringify(served.body).slice(0, 300)}`);
const pubB = await B.post('/provenance/public', { agent, runRef });
const anchorB = pubB.body.anchor as { digest: string; anchoredBy: string; at: number; intentDigest: string; readFrom: string } | null;
if (!pubB.body.carried || !anchorB || anchorB.readFrom !== 'chain' || anchorB.digest !== pubA.anchor.digest || anchorB.anchoredBy.toLowerCase() !== pubA.anchor.anchoredBy.toLowerCase()) fail(`the second Home's public projection does not read the anchor from the chain: ${JSON.stringify(pubB.body).slice(0, 300)}`);
console.log(`  ${SECOND_HOME}: served as carried · anchor read FROM THE CHAIN — by ${anchorB.anchoredBy.slice(0, 10)}… (Faithnet's harness agent) at ${new Date(anchorB.at * 1000).toISOString()} · intent ${anchorB.intentDigest.slice(0, 14)}…`);

// ── 4. twins ──
const tampered = { ...(bundle as object), carriedNote: 'altered in transit' };
const tRef = `${runRef}-tampered`;
const imp2 = await B.post('/harness/records/import', { session: B.me.bearer, recordType: `run.provenance:${tRef}`, record: tampered });
if (imp2.body.ok !== true) fail(`the tampered bundle could not even be kept (it is hers to keep): ${JSON.stringify(imp2.body).slice(0, 200)}`);
const pubT = await B.post('/provenance/public', { agent, runRef: tRef });
if (pubT.body.anchor !== null) fail(`a tampered bundle found an anchor: ${JSON.stringify(pubT.body).slice(0, 200)}`);
const refused = await B.post('/harness/records/import', { session: B.me.bearer, recordType: 'memory.facts', record: { entries: [] } });
if (refused.status !== 400) fail(`a non-provenance record was taken as carried: ${refused.status}`);
console.log('  twins: a bundle altered in transit → anchor: null on the chain · a memory record is refused at the door');

console.log(`\n✓ spec 406 W3: the record TRAVELS — alice, the same Smart Agent at two Homes, carried her run's PROV bundle from Faithnet into her vault at the ap-home estate; the second Home serves it and reads its anchor from the chain (Faithnet's harness agent, the time, the intent); a tampered bundle finds no anchor.`);
