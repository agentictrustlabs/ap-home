/**
 * THE JUDGE'S SWEEP — spec 438 §5, a MECHANICAL evaluator for people-groups.svc, run from the command line.
 *
 *   npx tsx scripts/judge-sweep.mts [--agent 0x…] [--run <runRef>] [--dry-run]
 *
 * For every run of the agent that has no standing judgment, it reads what the run ASKED and what it SAID
 * (its steps' arguments and result summary), re-asks the SOURCE directly — the people-group MCP the agent's
 * own name record points at, never the agent — and decides each criterion the agent's playbook states. It
 * signs each assessment with the judge's session key under the wire minted by `mint-judge-wire.mts`, and
 * posts it through the two-phase route. The server owns the subject digest and the criteria; this script
 * owns only the verdicts and the evidence behind them.
 *
 * WHO READS AND WHO JUDGES ARE DIFFERENT HERE, AND IT IS SAID. The runs are read under the custodian's
 * session, because the judge has no read wire of its own yet (that is the next piece). The JUDGMENT is the
 * judge's: its Smart Agent is the evaluator, its key signs, its wire proves the key is its delegate, and the
 * implementation digest below is what makes the verdicts reproducible by anyone who re-runs this file.
 *
 * NOTHING HERE IS AUTHORITY. No gate reads a judgment. A failed verdict changes a count on a page; it stops
 * nothing, and it is not meant to.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';

const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const MCP = process.env.PEOPLE_GROUP_MCP ?? 'https://demo-gc-pg.r-pedersen.workers.dev/mcp';
const argv = process.argv.slice(2);
const agent = (argv.includes('--agent') ? argv[argv.indexOf('--agent') + 1]! : '0xba732ef84fd578d5cf6668824e2ba68f59ccecdc').toLowerCase();
const onlyRun = argv.includes('--run') ? argv[argv.indexOf('--run') + 1] : null;
const dryRun = argv.includes('--dry-run');
const CUSTODIAN = process.env.CUSTODIAN_HANDLE ?? 'demo-admin';

// ── the judge's key and wire (a DELEGATE, never an identity) ──
const envLines = readFileSync('.judge.local', 'utf8').split('\n');
const envOf = (k: string): string => (envLines.find((l) => l.startsWith(`${k}=`)) ?? '').slice(k.length + 1).replace(/^'|'$/g, '');
const JUDGE_SA = envOf('JUDGE_SA'); const JUDGE_KEY = envOf('JUDGE_KEY') as Hex; const JUDGE_WIRE = JSON.parse(envOf('JUDGE_WIRE'));
if (!JUDGE_SA || !JUDGE_KEY || !JUDGE_WIRE) throw new Error('.judge.local is missing — run mint-judge-wire.mts first');
const key = privateKeyToAccount(JUDGE_KEY);
/** J5 — the digest of THIS implementation, carried on every assessment it signs. */
const implementation = `sha256:${createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex')}`;

const j = async (r: Response): Promise<Record<string, unknown>> => { const t = await r.text(); try { return JSON.parse(t) as Record<string, unknown>; } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
const signin = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: CUSTODIAN, client_id: 'demo-web' }) }));
const token = signin.homeSession as string | undefined;
if (!token) throw new Error(`no session for ${CUSTODIAN}`);
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' };
const post = (path: string, body: Record<string, unknown>) => fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: H, body: JSON.stringify({ session: token, addressee: agent, ...body }) }).then(j);

// ── THE SOURCE, asked directly. The agent under test is never consulted. ──
interface Probe { ok: boolean; counts: Record<string, number>; raw: string; digest: string; error?: string }
async function probeSource(args: Record<string, unknown>): Promise<Probe> {
  const r = await fetch(MCP, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'count_people_groups', arguments: args } }) });
  const raw = await r.text();
  const digest = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw) as Record<string, unknown>; } catch { const line = raw.split('\n').find((l) => l.startsWith('data:')); body = line ? (JSON.parse(line.slice(5)) as Record<string, unknown>) : {}; }
  const res = (body.result ?? {}) as { structuredContent?: Record<string, unknown>; content?: Array<{ type: string; text?: string }>; isError?: boolean };
  const sc = (res.structuredContent ?? (() => { try { return JSON.parse(res.content?.find((c) => c.type === 'text')?.text ?? '{}') as Record<string, unknown>; } catch { return {}; } })()) as Record<string, unknown>;
  if (res.isError || sc.error) return { ok: false, counts: {}, raw, digest, error: String(sc.error ?? 'the source answered with an error') };
  const counts: Record<string, number> = {};
  const walk = (o: unknown): void => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { for (const x of o) walk(x); return; }
    const rec = o as Record<string, unknown>;
    if (typeof rec.measure === 'string' && typeof rec.peopleInCountry === 'number') { counts[rec.measure] = rec.peopleInCountry; return; }
    for (const [k, v] of Object.entries(rec)) { if (typeof v === 'number' && /^(jp|imb|uupg)/.test(k)) counts[k] = v; else walk(v); }
  };
  walk(sc);
  return { ok: true, counts, raw, digest };
}

// ── decide the four criteria the playbook states ──
type Outcome = 'passed' | 'failed' | 'cantTell';
interface Verdict { criterionId: string; outcome: Outcome; evidenceRefs: string[]; because: string }
function decide(step: { args?: Record<string, unknown>; output?: Record<string, unknown>; result?: unknown; receiptDigest?: string; risk?: string; capability?: unknown }, probe: Probe, stated: string[]): Verdict[] {
  const refs = [...(step.receiptDigest ? [`urn:ap:receipt:${step.receiptDigest}`] : []), `urn:ap:probe:${probe.digest}`];
  // WHAT THE AGENT SAID: the full result (requested with `full: true`), the same row shape as the source.
  // The summary a person sees collapses the rows to one number and is useless to compare with.
  const full = (step.result ?? {}) as { rows?: Array<{ measure?: string; peopleInCountry?: number }>; source?: Record<string, unknown> };
  const src = (full.source ?? (step.output as { source?: Record<string, unknown> } | undefined)?.source) as Record<string, unknown> | undefined;
  const claimed: Record<string, number> = {};
  for (const r of full.rows ?? []) if (typeof r.measure === 'string' && typeof r.peopleInCountry === 'number') claimed[r.measure] = r.peopleInCountry;
  const v: Verdict[] = [];
  const has = (id: string) => stated.includes(`peoplegroup.count:${id}`);
  if (has('source-named')) {
    const named = !!src && typeof src.catalog === 'string' && typeof src.tool === 'string';
    v.push({ criterionId: 'peoplegroup.count:source-named', outcome: named ? 'passed' : 'failed', evidenceRefs: refs, because: named ? `names ${String(src!.catalog)} via ${String(src!.tool)}` : 'no catalog or tool named on the result' });
  }
  if (has('agrees-with-source')) {
    if (!probe.ok) v.push({ criterionId: 'peoplegroup.count:agrees-with-source', outcome: 'cantTell', evidenceRefs: refs, because: `the source could not be re-asked: ${probe.error}` });
    else {
      const keys = Object.keys(claimed).filter((k) => k in probe.counts);
      const disagree = keys.filter((k) => claimed[k] !== probe.counts[k]);
      if (keys.length === 0) v.push({ criterionId: 'peoplegroup.count:agrees-with-source', outcome: 'cantTell', evidenceRefs: refs, because: 'the run\u2019s result carries no measure the source also reports (was the full result requested?)' });
      else v.push({ criterionId: 'peoplegroup.count:agrees-with-source', outcome: disagree.length === 0 ? 'passed' : 'failed', evidenceRefs: refs, because: disagree.length ? `differs on ${disagree.map((k) => `${k}: said ${claimed[k]}, source ${probe.counts[k]}`).join('; ')}` : `agrees on ${keys.join(', ')}` });
    }
  }
  if (has('no-silent-zero')) {
    const zeros = Object.entries(claimed).filter(([, n]) => n === 0).map(([k]) => k);
    if (zeros.length === 0) v.push({ criterionId: 'peoplegroup.count:no-silent-zero', outcome: 'passed', evidenceRefs: refs, because: 'no zero was reported' });
    else if (!probe.ok) v.push({ criterionId: 'peoplegroup.count:no-silent-zero', outcome: 'failed', evidenceRefs: refs, because: `reported zero for ${zeros.join(', ')} while the source refuses the filter: ${probe.error}` });
    else v.push({ criterionId: 'peoplegroup.count:no-silent-zero', outcome: (probe.counts['jp-entries'] ?? 0) > 0 ? 'passed' : 'failed', evidenceRefs: refs, because: `zero for ${zeros.join(', ')}; the filter matched ${probe.counts['jp-entries'] ?? 0} entries` });
  }
  if (has('no-write')) {
    const wrote = !!step.capability || (step.risk !== undefined && step.risk !== 'informational');
    v.push({ criterionId: 'peoplegroup.count:no-write', outcome: wrote ? 'failed' : 'passed', evidenceRefs: refs, because: wrote ? `the step carried ${step.risk ?? 'a capability'}` : 'informational, no authority stage' });
  }
  return v;
}

// ── the sweep ──
const list = await post('/harness/records', {});
const rows = ((list.records ?? list.rows ?? []) as Array<{ runRef: string; outcome: string }>).filter((r) => !onlyRun || r.runRef === onlyRun);
console.log(`${rows.length} run(s) of ${agent}; judge ${JUDGE_SA} signing as ${key.address}; implementation ${implementation.slice(0, 18)}…`);
let judged = 0, skipped = 0;
for (const row of rows) {
  const ev = await post('/harness/evidence', { runRef: row.runRef });
  if ((ev.evidence as { assessment?: { count?: number } } | undefined)?.assessment?.count) { skipped += 1; continue; }
  const prov = await post('/harness/provenance', { runRef: row.runRef, format: 'record', full: true });
  const steps = ((prov.record as { steps?: Array<Record<string, unknown>> } | undefined)?.steps ?? []).filter((s) => s.toolId === 'peoplegroup.count');
  if (!steps.length) { console.log(`  ${row.runRef}: no peoplegroup.count step — not this judge's to judge`); skipped += 1; continue; }
  // Phase one with NO verdicts yet tells us which criteria are stated; a verdict on anything else is refused.
  const probeFor = await probeSource((steps[0]!.args as Record<string, unknown>) ?? {});
  const stated0 = await post('/harness/assess', { runRef: row.runRef, results: [{ criterionId: 'peoplegroup.count:no-write', outcome: 'cantTell', evidenceRefs: [] }], evaluatorKind: 'mechanical', wire: JUDGE_WIRE, implementation });
  const stated = ((stated0.stated as Array<{ id: string }> | undefined) ?? []).map((s) => s.id);
  if (!stated.length) { console.log(`  ${row.runRef}: refused — ${String(stated0.error ?? 'the playbook states no criteria')}`); skipped += 1; continue; }
  const verdicts = decide(steps[0] as never, probeFor, stated);
  console.log(`  ${row.runRef}: ${verdicts.map((x) => `${x.criterionId.split(':')[1]}=${x.outcome} (${x.because})`).join(' · ')}`);
  if (dryRun) continue;
  const results = verdicts.map(({ criterionId, outcome, evidenceRefs }) => ({ criterionId, outcome, evidenceRefs }));
  const prepared = await post('/harness/assess', { runRef: row.runRef, results, evaluatorKind: 'mechanical', wire: JUDGE_WIRE, implementation });
  if (prepared.ok !== true) { console.log(`    prepare refused: ${String(prepared.error)}`); continue; }
  const signature = await key.signMessage({ message: { raw: prepared.signDigest as Hex } });
  const stored = await post('/harness/assess', { runRef: row.runRef, results, evaluatorKind: 'mechanical', wire: JUDGE_WIRE, implementation, signature, at: (prepared.assessment as { at: string }).at });
  if (stored.ok !== true) { console.log(`    commit refused: ${String(stored.error)}`); continue; }
  console.log(`    stored ${String(stored.digest).slice(0, 22)}…`);
  judged += 1;
}
console.log(`judged ${judged}, skipped ${skipped}${dryRun ? ' (dry run — nothing signed)' : ''}`);
