/**
 * Spec 396 — DO ECONOMICS, MEASURED (no model, no spend). Every InteractionsDO op reports what it cost on its
 * response headers (spec 396: `x-ap-vault-calls`, `x-ap-vault-throttled`, `x-ap-ms`, `x-ap-vault-tools`). This
 * drives the ops the live gates and the Home use most against Missio Nexus and prints the bill per op, then what
 * the organization's vault budget (120 verified calls a minute, demo-mcp's limiter) buys in each.
 *
 *   npx tsx scripts/measure-do-economics.mts [--json]
 */
const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const A2A = process.env.A2A_URL ?? 'https://a2a.faithnet.io';
const ORG = (process.env.ORG ?? '0x3b99f2b452766de5df0dbcdfc676f27257151333').toLowerCase();
const BUDGET_PER_MIN = 120;
const asJson = process.argv.includes('--json');
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 200), _status: r.status }; } };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };
const signin = async (handle: string) => j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-web' }) }));
const alice = await signin('alice'); const ALICE = String(alice.agent).toLowerCase();
const carol = await signin('carol');
const related = await j(await fetch(`${HOME}/connect/related-orgs?person=${ALICE}`, { headers: { authorization: `Bearer ${alice.homeSession}` } }));
const stewardship = (related.orgs ?? []).find((o: { orgAgent: string }) => o.orgAgent.toLowerCase() === ORG)?.stewardshipDelegation;
if (!stewardship) fail('alice holds no stewardship wire for the organization');

type Bill = { op: string; who: string; status: number; ms: number; vaultCalls: number; throttled: number; tools: string; note?: string };
const bills: Bill[] = [];
const measure = async (label: string, who: string, token: string, op: string, payload: Record<string, unknown>, withStewardship = false): Promise<Record<string, unknown>> => {
  const t0 = Date.now();
  const res = await fetch(`${A2A}/interactions/${ORG}/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: token, ...(withStewardship ? { stewardship } : {}), ...payload }) });
  const body = await j(res);
  const vaultCalls = Number(res.headers.get('x-ap-vault-calls') ?? -1);
  if (vaultCalls < 0) fail(`${op}: the deploy reports no cost headers (x-ap-vault-calls) — deploy spec 396's instrumentation first`);
  bills.push({ op: label, who, status: res.status, ms: Number(res.headers.get('x-ap-ms') ?? Date.now() - t0), vaultCalls, throttled: Number(res.headers.get('x-ap-vault-throttled') ?? 0), tools: res.headers.get('x-ap-vault-tools') ?? '', ...(body.error ? { note: String(body.error).slice(0, 60) } : {}) });
  // a heavy op spends most of the minute's budget: let the window turn before the next measurement
  await new Promise((r) => setTimeout(r, vaultCalls > 30 ? 62_000 : 1200));
  return body;
};

// --rebuild: backfill the index's `parties` (spec 396's lever) once, as the steward, before measuring.
if (process.argv.includes('--rebuild')) {
  const r = await measure('endeavor.index.rebuild (once)', 'alice', alice.homeSession, 'endeavor.index.rebuild', {}, true);
  console.log(`rebuilt the index: ${JSON.stringify(r).slice(0, 120)}\n`);
}
const list = await measure('endeavor.list (steward)', 'alice', alice.homeSession, 'endeavor.list', {}, true);
const endeavors = (list.endeavors ?? []) as Array<{ endeavorId: string }>;
await measure('endeavor.list (member)', 'carol', carol.homeSession, 'endeavor.list', {});
if (endeavors[0]) await measure('endeavor.get', 'alice', alice.homeSession, 'endeavor.get', { endeavorId: endeavors[0].endeavorId }, true);
await measure('autowork.get', 'alice', alice.homeSession, 'autowork.get', {}, true);
if (endeavors[0]) {
  const raised = await measure('endeavor.decision.request (write)', 'alice', alice.homeSession, 'endeavor.decision.request', { endeavorId: endeavors[0].endeavorId, title: `Economics probe ${Date.now().toString(36)}`, approvers: [ALICE] }, true);
  if (raised.decisionId) await measure('endeavor.decide (write)', 'alice', alice.homeSession, 'endeavor.decide', { endeavorId: endeavors[0].endeavorId, decisionId: raised.decisionId, outcome: 'rejected', reason: 'economics probe' });
}

// ── the run's own bill (spec 396 W3): a two-turn declaration on alice's agent, read off its record, not off headers ──
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const home = async (path: string, body: Record<string, unknown>) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' }, body: JSON.stringify({ session: alice.homeSession, ...body }) }));
let runBill: { vaultCalls: number; doRequests: number; byStep: Record<string, { vaultCalls: number; doRequests: number }> } | null = null;
{
  const ask = await home('/harness/ask', { addressee: ALICE, message: `from now on pay from alice3.treasury (economics ${Date.now().toString(36)})`, plan: { steps: [{ toolId: 'context.instruction.declare', args: { capability: 'treasury.payment.execute', value: 'alice3.treasury' } }] } });
  const r = ask.reply as { kind?: string; runRef?: string; prompt?: { stepRef: string } } | undefined;
  if (r?.kind === 'prompt' && r.prompt) {
    const done = await home('/harness/ask', { addressee: ALICE, runRef: r.runRef, supplied: [{ stepRef: r.prompt.stepRef, data: { keep: 'yes' } }] });
    const rec = await home('/harness/records', { addressee: ALICE, runRef: String(done.runRef ?? r.runRef) });
    runBill = (rec.record?.bill as typeof runBill) ?? null;
    await home('/harness/instructions/forget', { scope: { capability: 'treasury.payment.execute', arg: 'payer' } });
  }
}

if (asJson) { console.log(JSON.stringify({ org: ORG, endeavors: endeavors.length, budgetPerMin: BUDGET_PER_MIN, bills, runBill }, null, 2)); process.exit(0); }
console.log(`Missio Nexus ${ORG} · ${endeavors.length} endeavor(s) visible to a steward · vault budget ${BUDGET_PER_MIN} verified calls / min\n`);
const w = (s: string, n: number) => s.padEnd(n);
console.log(`${w('op', 36)}${w('who', 7)}${w('status', 8)}${w('ms', 8)}${w('vault calls', 13)}${w('throttled', 11)}${w('per minute', 12)}tools`);
for (const b of bills) console.log(`${w(b.op, 36)}${w(b.who, 7)}${w(String(b.status), 8)}${w(String(b.ms), 8)}${w(String(b.vaultCalls), 13)}${w(String(b.throttled), 11)}${w(b.vaultCalls ? String(Math.floor(BUDGET_PER_MIN / b.vaultCalls)) : '∞', 12)}${b.tools}${b.note ? `  (${b.note})` : ''}`);
console.log(`\na harness run's own bill (a two-turn declaration on alice's agent, off its record): ${runBill ? `${runBill.vaultCalls} vault call(s) over ${runBill.doRequests} DO request(s) · ${JSON.stringify(runBill.byStep)}` : 'no record'}`);
const listBill = bills.find((b) => b.op === 'endeavor.list (steward)')!;
console.log(`\nendeavor.list costs ${listBill.vaultCalls} vault calls for ${endeavors.length} endeavors (${(listBill.vaultCalls / Math.max(1, endeavors.length)).toFixed(2)} per endeavor): ${Math.floor(BUDGET_PER_MIN / Math.max(1, listBill.vaultCalls))} listings a minute before the organization's vault says "auth failed".`);
