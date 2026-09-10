/**
 * Spec 395 W2 — A COUNTERPARTY VERIFIES BY RECOMPUTATION (no model, no spend).
 *
 *   npx tsx scripts/verify-receipt-recompute.mts
 *
 * The holder of a step receipt recomputes its digest (sha256 over the canonical receipt — the same function the
 * agent used) and asks the agent's PUBLIC projection, with no session, whether a run anchored that digest on the
 * chain. Here the holder is alice reading her own receipt back off her run record — the receipt's bytes are what a
 * payee, a gateway or an auditor would hold; the verification path is the counterparty's: the public route only.
 * THE TWIN: one changed field in the receipt ("status") and the digest no longer matches any row — a tampered
 * receipt cannot borrow a real run's anchor.
 */
import { receiptDigest, type StepReceipt } from '../packages/orchestration/src/index.js';

const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const A2A = process.env.A2A_URL ?? 'https://a2a.faithnet.io';
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
function fail(m: string): never { console.error(`\n✗ ${m}`); process.exit(1); }

const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'alice', client_id: 'demo-jp' }) }));
if (!si.homeSession) fail(`no session: ${JSON.stringify(si).slice(0, 200)}`);
const ALICE = String(si.agent).toLowerCase();
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const post = async (path: string, body: Record<string, unknown>) =>
  j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' }, body: JSON.stringify({ session: si.homeSession, ...body }) }));
const pub = async (runRef: string) => j(await fetch(`${A2A}/provenance/public`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: ALICE, runRef }) }));

// ── the receipt the holder has: the anchored step's, off alice's own record (the bytes a payee would hold) ──
const listing = await post('/harness/records', { addressee: ALICE });
if (!listing.ok) fail(`records: ${JSON.stringify(listing).slice(0, 200)}`);
let held: { runRef: string; receipt: StepReceipt; tx: string } | undefined;
for (const r of (listing.records ?? []) as Array<{ runRef: string }>) {
  const full = await post('/harness/records', { addressee: ALICE, runRef: r.runRef });
  const rec = full.record as { receipts?: StepReceipt[]; steps?: Array<{ stepRef?: string; result?: { txHash?: string; facts?: { txHash?: string } } }> } | undefined;
  const step = (rec?.steps ?? []).find((s) => /^0x[0-9a-fA-F]{64}$/.test(String(s.result?.txHash ?? s.result?.facts?.txHash ?? '')));
  const receipt = step && (rec?.receipts ?? []).find((x) => x.stepRef === step.stepRef);
  if (step && receipt) { held = { runRef: r.runRef, receipt, tx: String(step.result?.txHash ?? step.result?.facts?.txHash).toLowerCase() }; break; }
}
if (!held) fail('no recent run of alice\'s left a transaction with a receipt — run scripts/verify-run-export.mts first');
console.log(`held: receipt of ${held.runRef} · ${held.receipt.stepRef} (${held.receipt.toolId}) · tx ${held.tx.slice(0, 14)}…`);

// ── recompute, then ask the public projection ──
const digest = await receiptDigest(held.receipt);
const p = await pub(held.runRef);
if (!p.ok) fail(`public projection: ${JSON.stringify(p).slice(0, 200)}`);
const row = (p.rows as Array<{ '@id': string; receiptDigest?: string; anchoredBy: string }>).find((x) => x.receiptDigest === digest);
console.log(`  recomputed ${digest.slice(0, 14)}… → ${row ? `anchored by ${row.anchoredBy.slice(0, 14)}… (${row['@id']})` : 'NO ROW'}`);
if (!row) fail(`no public row anchors the recomputed digest: ${JSON.stringify(p.rows).slice(0, 300)}`);
if (row.anchoredBy !== held.tx) fail(`the row's anchor ${row.anchoredBy} is not the transaction the holder saw (${held.tx})`);

// ── twin: a tampered receipt matches no row ──
const tampered: StepReceipt = { ...held.receipt, toolId: `${held.receipt.toolId}.tampered` };
const tamperedDigest = await receiptDigest(tampered);
const borrowed = (p.rows as Array<{ receiptDigest?: string }>).find((x) => x.receiptDigest === tamperedDigest);
console.log(`  tampered (toolId changed) ${tamperedDigest.slice(0, 14)}… → ${borrowed ? 'MATCHED A ROW' : 'no row'}`);
if (borrowed || tamperedDigest === digest) fail('a tampered receipt borrowed a real anchor');
console.log(`\n✓ spec 395 W2: the holder recomputed the receipt's digest and the agent's public projection — no session — named the transaction that anchors it; a receipt changed in one field anchors nothing.`);
