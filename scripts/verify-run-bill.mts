/**
 * Spec 396 W3 — THE RUN'S OWN BILL, live (no model, no spend).
 *
 *   npx tsx scripts/verify-run-bill.mts
 *
 * alice asks her agent to keep a standing instruction (a supplied plan; read back, kept on her yes — two turns). The
 * run's record carries `bill`: the vault calls and DO requests the run made, by the step that made them; the run's
 * spans reply carries the `ap.vault.calls` metric beside the four. THE TWIN: the bill names no record content — only
 * step refs and numbers.
 */
const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300) }; } };
function fail(m: string): never { console.error(`\n✗ ${m}`); process.exit(1); }
const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'alice', client_id: 'demo-jp' }) }));
if (!si.homeSession) fail(`no session: ${JSON.stringify(si).slice(0, 200)}`);
const ALICE = String(si.agent).toLowerCase();
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const post = async (path: string, body: Record<string, unknown>) =>
  j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' }, body: JSON.stringify({ session: si.homeSession, ...body }) }));
type Reply = { kind: string; runRef?: string; prompt?: { stepRef: string; fields?: Array<{ name: string }> } };
let o = await post('/harness/ask', { addressee: ALICE, message: `from now on pay from alice3.treasury (bill ${Date.now().toString(36)})`, plan: { steps: [{ toolId: 'context.instruction.declare', args: { capability: 'treasury.payment.execute', value: 'alice3.treasury' } }] } });
let r = o.reply as Reply;
if (r?.kind !== 'prompt' || !r.prompt?.fields?.some((f) => f.name === 'keep')) fail(`expected the read-back: ${JSON.stringify(o).slice(0, 300)}`);
o = await post('/harness/ask', { addressee: ALICE, runRef: r.runRef, supplied: [{ stepRef: r.prompt.stepRef, data: { keep: 'yes' } }] });
r = o.reply as Reply;
const runRef = String(o.runRef ?? r.runRef);
if (r?.kind !== 'done') fail(`the run did not finish: ${JSON.stringify(o).slice(0, 300)}`);
const rec = await post('/harness/records', { addressee: ALICE, runRef });
const bill = rec.record?.bill as { vaultCalls: number; doRequests: number; byStep: Record<string, { vaultCalls: number; doRequests: number }> } | undefined;
console.log(`run ${runRef} · bill ${bill ? `${bill.vaultCalls} vault call(s) over ${bill.doRequests} DO request(s) · by step ${JSON.stringify(bill.byStep)}` : 'NONE'}`);
if (!bill || bill.doRequests < 1) fail('the record carries no bill');

const stepKeys = Object.keys(bill.byStep);
if (!stepKeys.some((k) => k === 'plan' || /^s\d+$|^step/.test(k))) fail(`the bill's steps are not step refs: ${stepKeys.join(', ')}`);
if (JSON.stringify(bill).match(/0x[0-9a-f]{40}|alice3|standing\.instructions|treasury\.payment/i)) fail('the bill carries content, not only numbers');
const spans = await post('/harness/spans', { addressee: ALICE, runRef });
const names = ((spans.metrics?.vaultCalls ?? []) as Array<{ attributes: Record<string, string>; value: number }>);
console.log(`  ap.vault.calls points: ${JSON.stringify(names)}`);
if (!spans.ok || names.length === 0) fail(`the spans reply carries no ap.vault.calls points: ${JSON.stringify(spans.metrics ?? spans).slice(0, 300)}`);
await post('/harness/instructions/forget', { scope: { capability: 'treasury.payment.execute', arg: 'payer' } });
console.log(`\n✓ spec 396 W3: the run's record carries its bill by step, and the run's metrics carry ap.vault.calls; numbers only.`);
