/**
 * Spec 381 W1 — RUN EXPORT, live: firewalled spans, a declared retention, provenance in the vault.
 *
 *   npx tsx scripts/verify-run-export.mts
 *
 * alice pays nathan.treasury 1 USDC (the single-mandate path). Then `/harness/spans` serves the run as a
 * trace: the payment span carries the receipt digest and the authority decision, and no span carries the
 * payee's address, the treasury's name or the words she said. The records listing states the retention.
 * Her vault holds `run.provenance:<runRef>` — read through her own vault question.
 */
import { hashDelegation, buildDigestBindingCaveat, paymentHandler, ROOT_AUTHORITY, registerDefaultSubsetHandlers, type Delegation, type Caveat, type MandateRequirementV1 } from '../packages/delegation/src/index.js';
import type { Address, Hex } from 'viem';
registerDefaultSubsetHandlers();

const HOME = 'https://www.faithnet.me';
const CHAIN = 34348;
const DM = '0x710cb1bF08C234Df397e0910331e0A29710EF4F7' as Address;
const ENFORCERS = { delegationManager: DM, timestamp: '0x73A7B878168b7DE48677617179A8bE894f0Dfe96', allowedTargets: '0x2156311097A936de1916a878bF53Bfd43c7b5715', allowedMethods: '0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41', value: '0x8759c1a6cEBF1D5069e9434EF46327Bf2ef69975', payment: '0x07fA0aE59FdE4B7ce8962d6fE7a1d648ec3DD5CE', digestBinding: '0xA3bb9BCC9b2F6F2419E1aBe5ED6Fd5399b9E68e1' } as const;
const NATHAN_TREASURY = '0x2c471607' ; // prefix only — the gate never needs the full payee, and the span must not carry it
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const alice = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'alice', client_id: 'demo-web' }) }));
const ALICE = String(alice.agent).toLowerCase() as Address;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36';
const A2A = 'https://alice.faithnet.ai';
const csrfRes = await fetch(`${A2A}/auth/csrf`, { headers: { origin: HOME, 'user-agent': UA } });
const csrfTok = csrfRes.headers.get('x-csrf-token') || ((await j(csrfRes.clone())) as { token?: string }).token || '';
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const H = { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrfTok, 'user-agent': UA };
const post = async (path: string, body: unknown) => j(await fetch(`${A2A}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));
const sign = async (digest: Hex): Promise<Hex> => { const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.homeSession}` }, body: JSON.stringify({ digest }) })); if (!b.signature) throw new Error(`persona-sign refused: ${JSON.stringify(b).slice(0, 200)}`); return b.signature; };

// ── 1. a payment, the single-mandate path ─────────────────────────────────────────────────────────────
const nonce = Date.now().toString(36);
const goal = `pay nathan.treasury 1 usdc (export ${nonce})`;
const plan = { steps: [{ toolId: 'treasury.payment.execute', args: { payee: 'nathan.treasury', usdc: '1', memo: `export ${nonce}` }, id: 's0' }] };
let r1 = await post('/harness/ask', { session: alice.homeSession, addressee: ALICE, message: goal, plan });
let rep = r1.reply as { kind?: string; error?: string; runRef?: string; requirement?: MandateRequirementV1; delegator?: Address; delegate?: Address; prompt?: { kind?: string; stepRef?: string; digest?: Hex; prompt?: string } };
console.log(`ask → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}`);
if (rep?.kind !== 'authority_required' || !rep.requirement || !rep.delegator || !rep.delegate) throw new Error(`expected the mandate to be asked: ${JSON.stringify(r1).slice(0, 500)}`);
const req = rep.requirement;
const caveats: Caveat[] = [...paymentHandler.toCaveats(req, ENFORCERS as never), buildDigestBindingCaveat(ENFORCERS.digestBinding, 'intent', req.intentDigest as Hex)];
let salt = 0n; for (const b of crypto.getRandomValues(new Uint8Array(16))) salt = (salt << 8n) | BigInt(b);
const mandate: Delegation = { delegator: rep.delegator, delegate: rep.delegate, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
mandate.signature = await sign(hashDelegation(mandate, CHAIN, DM));
r1 = await post('/harness/ask', { session: alice.homeSession, addressee: ALICE, runRef: rep.runRef, presented: { ...mandate, salt: salt.toString() } });
rep = r1.reply;
for (let i = 0; i < 2; i++) {
  const p = rep?.prompt;
  if (rep?.kind !== 'prompt' || p?.kind !== 'signature' || !p.digest) break;
  const supplied = [{ stepRef: p.stepRef ?? 's0', signature: { digest: p.digest, signer: ALICE, signature: await sign(p.digest) } }];
  r1 = await post('/harness/ask', { session: alice.homeSession, addressee: ALICE, runRef: rep.runRef, supplied });
  rep = r1.reply;
}
console.log(`  → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''} (run ${rep?.runRef})`);
if (rep?.kind !== 'done' || !rep.runRef) throw new Error(`the payment did not finish: ${JSON.stringify(r1).slice(0, 600)}`);
const runRef = rep.runRef;
// The record (the asker's own) carries the step's result — the payee's address is there, and it is what the
// spans must NOT carry. Read it from the record, never guessed.
await new Promise((r) => setTimeout(r, 2500)); // the record and the export land off the run's path
const recRes = await post('/harness/records', { session: alice.homeSession, addressee: ALICE, runRef });
if (!recRes.ok) throw new Error(`record: ${JSON.stringify(recRes).slice(0, 300)}`);
const step0 = (recRes.record as { steps?: Array<{ args?: Record<string, unknown>; result?: Record<string, unknown> }> }).steps?.[0];
const payee = String(step0?.result?.payee ?? step0?.args?.payee ?? '').toLowerCase();
console.log(`  payee (from the record's result, for the negative check): ${payee.slice(0, 10)}…`);
if (!/^0x[0-9a-f]{40}$/.test(payee)) throw new Error(`the record names no payee — the negative check has nothing to check: ${JSON.stringify(step0).slice(0, 300)}`);

// ── 2. the spans: what was done, never what it was about ─────────────────────────────────────────────
const sp = await post('/harness/spans', { session: alice.homeSession, addressee: ALICE, runRef });
if (!sp.ok) throw new Error(`spans: ${JSON.stringify(sp).slice(0, 300)}`);
const spans = sp.spans as Array<{ name: string; parentSpanId?: string; attributes: Record<string, unknown> }>;
console.log(`spans → ${spans.length}: ${spans.map((s) => s.name).join(' · ')} (retention ${sp.retention?.doDays}d on the object, vault ${sp.retention?.vaultRecord}; exporter ${sp.exporter})`);
const pay = spans.find((s) => s.attributes['gen_ai.tool.name'] === 'treasury.payment.execute');
if (!pay) throw new Error('no payment span');
console.log(`  payment span: decision=${pay.attributes['ap.authority.decision']} receipt=${String(pay.attributes['ap.receipt.digest']).slice(0, 14)}… status=${pay.attributes['ap.step.status']} playbook=${pay.attributes['ap.playbook.id'] ?? '-'}`);
if (pay.attributes['ap.authority.decision'] !== 'allow') throw new Error('the payment span does not carry the allow');
if (!/^0x[0-9a-f]{64}$/.test(String(pay.attributes['ap.receipt.digest']))) throw new Error('the payment span carries no receipt digest');
const text = JSON.stringify(spans).toLowerCase();
if (text.includes(payee)) throw new Error('a span carries the payee\'s address');
if (text.includes(ALICE)) throw new Error('a span carries alice\'s address');
if (text.includes('nathan')) throw new Error('a span carries the treasury\'s name');
if (text.includes(`export ${nonce}`) || text.includes('pay nathan')) throw new Error('a span carries the utterance');
if (/0x[0-9a-f]{40}(?![0-9a-f])/.test(text.replace(/0x[0-9a-f]{64}/g, ''))) throw new Error('a span carries some address');
console.log('  ✓ step names + receipt digest + verdict; no payee, no name, no utterance, no address');
if (!Number.isFinite(Number(sp.retention?.doDays))) throw new Error('the retention is not declared');
// THE EXPORT REPORT, from the record: did the provenance land in her vault? Read, not inferred.
let exp = sp.export as { provenance?: { written?: boolean; recordType?: string; error?: string }; spans?: { count?: number; sent?: boolean } } | null;
for (let i = 0; i < 6 && !exp; i++) { await new Promise((r) => setTimeout(r, 1500)); exp = ((await post('/harness/spans', { session: alice.homeSession, addressee: ALICE, runRef })).export ?? null) as typeof exp; }
console.log(`  export report: ${JSON.stringify(exp)}`);
if (!exp?.provenance?.written) throw new Error(`the provenance did not land in her vault: ${exp?.provenance?.error ?? 'no report'}`);
if (exp.provenance.recordType !== `run.provenance:${runRef}`) throw new Error('the provenance record is not keyed by the run');
const listing = await post('/harness/records', { session: alice.homeSession, addressee: ALICE });
if (!listing.ok) throw new Error(`records: ${JSON.stringify(listing).slice(0, 200)}`);
console.log(`  records listing: ${listing.records?.length ?? 0} record(s), retention ${JSON.stringify(listing.retention ?? null)}`);
if (!Number.isFinite(Number(listing.retention?.doDays))) throw new Error('the listing does not state the retention');

// ── 3. the provenance, in her vault ───────────────────────────────────────────────────────────────────
const q = await post('/harness/ask', { session: alice.homeSession, addressee: ALICE, message: `what run provenance records do I hold` });
const qr = q.reply as { kind?: string; text?: string; evidence?: unknown; error?: string };
console.log(`vault question → ${qr?.kind}: ${(qr?.text ?? qr?.error ?? '').slice(0, 300)}`);
const held = String(qr?.text ?? '').toLowerCase();
if (!/run provenance/.test(held)) throw new Error('her vault question does not classify the run\'s provenance as such — the ontology binding is not reaching the survey');
console.log('  ✓ run.provenance is a record of hers, and her vault question knows what it is');
console.log('\nspec 381 W1 live: the run left the estate as a firewalled trace and stayed in her vault as provenance. ✓');
