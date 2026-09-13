/**
 * Spec 395 W1 — THE PUBLIC PROVENANCE PROJECTION, live (no model, no spend).
 *
 *   npx tsx scripts/verify-public-provenance.mts
 *
 * alice's most recent run that left a chain transaction (the nightly run-export gate's 1 USDC payment leaves one
 * within the record's 7-day life). `POST /provenance/public { agent, runRef }` — NO session — answers one anchored
 * row whose receiptDigest equals the digest her own PRIVATE record names for that step and whose anchoredBy is the
 * transaction her receipt carries; the JSON carries no address and none of the run's words. THE TWINS: a run of hers
 * with no transaction answers rows: [] with every step refused by name; a bogus runRef is 404.
 */
import { fixture as fx, HOME, A2A } from './fixture.mts';

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
function fail(m: string): never { console.error(`\n✗ ${m}`); process.exit(1); }
type Receipt = { stepRef: string; toolId?: string; status?: string };
type Row = { runRef: string; receipts?: Receipt[]; steps?: Array<{ id?: string; result?: unknown }> };

const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: fx.people.steward, client_id: 'demo-jp' }) }));
if (!si.homeSession) fail(`no session: ${JSON.stringify(si).slice(0, 200)}`);
const ALICE = String(si.agent).toLowerCase();
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const post = async (path: string, body: Record<string, unknown>) =>
  j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' }, body: JSON.stringify({ session: si.homeSession, ...body }) }));
// the PUBLIC route, straight at the agent's Worker, with no session and no cookie
const pub = async (body: Record<string, unknown>) => { const r = await fetch(`${A2A}/provenance/public`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await j(r) }; };

// ── alice's recent runs: one with a transaction, one without ──
const listing = await post('/harness/records', { addressee: ALICE });
if (!listing.ok) fail(`records: ${JSON.stringify(listing).slice(0, 200)}`);
const rows = (listing.records ?? []) as Row[];
console.log(`alice ${ALICE} · ${rows.length} recent run(s) on her agent`);
let anchored: { runRef: string; stepRef: string; tx: string; receiptDigest?: string } | undefined;
let bare: string | undefined;
for (const r of rows) {
  const full = await post('/harness/records', { addressee: ALICE, runRef: r.runRef });
  const rec = full.record as { receipts?: Receipt[]; steps?: Array<{ id?: string; stepRef?: string; result?: { txHash?: string; facts?: { txHash?: string } } }> } | undefined;
  const withTx = (rec?.steps ?? []).find((s) => { const t = s.result?.txHash ?? s.result?.facts?.txHash; return typeof t === 'string' && /^0x[0-9a-fA-F]{64}$/.test(t); });
  if (withTx && !anchored) anchored = { runRef: r.runRef, stepRef: String(withTx.stepRef ?? withTx.id), tx: String(withTx.result?.txHash ?? withTx.result?.facts?.txHash).toLowerCase() };
  else if (!withTx && !bare && (rec?.receipts?.length ?? 0) > 0) bare = r.runRef;
  if (anchored && bare) break;
}
if (!anchored) fail('no recent run of alice\'s left a transaction — run scripts/verify-run-export.mts first');
console.log(`  anchored run ${anchored.runRef} · step ${anchored.stepRef} · tx ${anchored.tx.slice(0, 14)}…`);

// ── her PRIVATE graph names the step's receipt digest (asker only) ──
const priv = await post('/harness/provenance', { addressee: ALICE, runRef: anchored.runRef });
if (!priv.ok) fail(`private provenance: ${JSON.stringify(priv).slice(0, 200)}`);
const graph = (priv.provenance?.graph ?? priv.provenance?.['@graph'] ?? []) as Array<Record<string, unknown>>;
const stepNode = graph.find((n) => String(n['@id'] ?? n.id ?? '').endsWith(`:${anchored!.stepRef}`) && (n.receiptDigest || n['apexec:receiptDigest']));
const privateDigest = String(stepNode?.receiptDigest ?? stepNode?.['apexec:receiptDigest'] ?? '');
console.log(`  private graph: step receipt digest ${privateDigest ? privateDigest.slice(0, 14) + '…' : 'NOT FOUND'} · public pointer ${JSON.stringify(priv.hasProvenance?.public ?? null)}`);
if (!privateDigest) fail(`the private graph names no receipt digest for ${anchored.stepRef}: ${JSON.stringify(graph.map((n) => n['@id'] ?? n.id)).slice(0, 300)}`);
if (priv.hasProvenance?.public?.route !== '/provenance/public') fail('hasProvenance carries no public pointer');

// ── the PUBLIC projection, with no session ──
const p = await pub({ agent: ALICE, runRef: anchored.runRef });
console.log(`  public → ${p.status} · rows ${p.body.rows?.length ?? '?'} · refused ${JSON.stringify((p.body.refused ?? []).map((x: { reason: string }) => x.reason))}`);
if (p.status !== 200 || !p.body.ok) fail(`public projection: ${JSON.stringify(p.body).slice(0, 300)}`);
const row = (p.body.rows as Array<Record<string, string>>).find((x) => x['@id'].endsWith(`:${anchored!.stepRef}`));
if (!row) fail(`no anchored row for ${anchored.stepRef}: ${JSON.stringify(p.body.rows).slice(0, 300)}`);
console.log(`  row: anchoredBy ${row.anchoredBy.slice(0, 14)}… · receiptDigest ${row.receiptDigest?.slice(0, 14)}… · ${row.capability} · ${row.completionState}`);
if (row.anchoredBy !== anchored.tx) fail(`the row's anchor is not the step's transaction (${row.anchoredBy} ≠ ${anchored.tx})`);
if (row.receiptDigest !== privateDigest) fail(`the public receipt digest (${row.receiptDigest}) is not the private graph's (${privateDigest})`);
if (row.assurance !== 'OnchainConfirmed') fail(`assurance ${row.assurance}`);
const json = JSON.stringify(p.body.rows);
if (/0x[0-9a-f]{40}(?![0-9a-f])/i.test(json)) fail('an address is in the public rows');
if (/actedOnBehalfOf|wasAttributedTo|args|result|goal|usdc|payee|payer/i.test(json)) fail('a private field is in the public rows');

// ── twins ──
if (bare) {
  const b = await pub({ agent: ALICE, runRef: bare });
  console.log(`  twin (no transaction) → ${b.status} · rows ${b.body.rows?.length} · refused ${JSON.stringify((b.body.refused ?? []).map((x: { reason: string }) => x.reason))}`);
  if (b.status !== 200 || (b.body.rows ?? []).length !== 0 || !(b.body.refused ?? []).every((x: { reason: string }) => x.reason === 'missing_or_malformed_anchor')) fail('a run with no transaction should project nothing, every step refused for want of an anchor');
} else console.log('  twin (no transaction): no recent run without a transaction — skipped');
const bogus = await pub({ agent: ALICE, runRef: `run-${Date.now().toString(36)}-nope` });
console.log(`  twin (unknown run) → ${bogus.status}`);
if (bogus.status !== 404) fail('an unknown run should be 404');
console.log(`\n✓ spec 395 W1: the anchored outcome is public — digests and ids through S1, the same receipt digest the private graph names, the transaction as the anchor; no address, nothing the run was about; a run with no transaction projects nothing.`);
