/**
 * Spec 392 W2 — THE RECURRING-FAILURE VIEW: the nightly's reports over time, clustered by gate × failure class.
 *
 *   npx tsx scripts/live-gates-trend.mts [report.json …]        (default: live-gates-reports/*.json + live-gates-report.json)
 *
 * DETERMINISTIC. A failure's class is read off the gate's own last lines by a fixed table of patterns — never a model,
 * never a guess: a line that matches nothing is `unclassified`, which is itself a finding (a new failure shape). The
 * classes are the estate's own failure shapes as the live gates met them: the organization's vault budget, a playbook
 * pinned to an old digest, an authority refusal (the twin working), a conflict, a provider out of credit, the platform,
 * a timeout, an assertion the gate itself made. A (gate, class) seen in two or more reports is RECURRING — the row a
 * developer-tools surface reads first (priorities 1.2 / §3.3 T1). Writes `live-gates-trend.md` for the job summary.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface Result { id: string; spec: string; ok: boolean; required: boolean; ms: number; status: 'passed' | 'failed' | 'timed out'; tail: string[] }
interface Report { at: string; passed: number; failed: number; results: Result[] }

/** The failure classes, first match wins. Order matters: the platform's words before the gate's own ✗. */
const CLASSES: Array<{ id: string; why: string; test: (status: Result['status'], tail: string) => boolean }> = [
  { id: 'timeout', why: 'the gate ran past its ledger timeout', test: (s) => s === 'timed out' },
  { id: 'vault-throttle', why: "the organization's vault budget (120 verified calls/min) or a throttled vault call", test: (_s, t) => /auth failed — mcp|rate-limited|throttled|vault budget/i.test(t) },
  { id: 'playbook-drift', why: 'an archetype republished and an agent still pinned to the old digest', test: (_s, t) => /unknown_tool|not exposed by this agent|assignment digest mismatch/i.test(t) },
  { id: 'model-credit', why: 'a model provider refused for credit or quota', test: (_s, t) => /credit_balance|insufficient credit|out of credit|quota|TPM/i.test(t) },
  { id: 'infra', why: 'the platform: a lost connection, a 5xx, a D1 or fetch failure', test: (_s, t) => /D1_ERROR|Network connection lost|fetch failed|ECONNRESET|ETIMEDOUT|\b50[234]\b/i.test(t) },
  { id: 'grant-scope', why: 'a record type outside a grant (a re-issue is due)', test: (_s, t) => /record_scope_denied|re-issue/i.test(t) },
  { id: 'authority-refused', why: 'a refusal at a gate or a door — check it is the TWIN refusing, not the positive', test: (_s, t) => /\b403\b|not a declared approver|steward standing|only the organization|not yours to|authority_denied|refused/i.test(t) },
  { id: 'conflict', why: 'a 409 — a stale plan hash, an already-decided request, a re-entered run', test: (_s, t) => /\b409\b|already/i.test(t) },
  { id: 'assertion', why: "the gate's own ✗ — the behaviour under test changed", test: (_s, t) => /✗/.test(t) },
];
export function classify(r: Result): string {
  const tail = r.tail.join('\n');
  return CLASSES.find((c) => c.test(r.status, tail))?.id ?? 'unclassified';
}

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const files = args.length ? args : [
  ...(existsSync('live-gates-reports') ? readdirSync('live-gates-reports').filter((f) => f.endsWith('.json')).map((f) => resolve('live-gates-reports', f)) : []),
  ...(existsSync('live-gates-report.json') ? [resolve('live-gates-report.json')] : []),
];
const reports: Report[] = [];
for (const f of files) { try { const r = JSON.parse(readFileSync(f, 'utf8')) as Report; if (Array.isArray(r.results)) reports.push(r); } catch { /* not a report */ } }
reports.sort((a, b) => String(a.at).localeCompare(String(b.at)));
if (reports.length === 0) { console.log('no reports found — run `pnpm check:live-gates`, or download the nightly artifacts into live-gates-reports/'); process.exit(0); }

const cells = new Map<string, { gate: string; cls: string; spec: string; nights: Set<string>; required: boolean; sample: string }>();
const passes = new Map<string, number>();
for (const rep of reports) {
  const night = String(rep.at).slice(0, 10);
  for (const r of rep.results) {
    if (r.ok) { passes.set(r.id, (passes.get(r.id) ?? 0) + 1); continue; }
    const cls = classify(r);
    const key = `${r.id}|${cls}`;
    const cell = cells.get(key) ?? { gate: r.id, cls, spec: r.spec, nights: new Set<string>(), required: r.required, sample: r.tail.filter(Boolean).slice(-1)[0] ?? '' };
    cell.nights.add(night);
    cells.set(key, cell);
  }
}
const rows = [...cells.values()].sort((a, b) => b.nights.size - a.nights.size || a.gate.localeCompare(b.gate));
const recurring = rows.filter((r) => r.nights.size >= 2);
const lines: string[] = [];
lines.push(`## Live gates — recurring failures (${reports.length} report${reports.length === 1 ? '' : 's'}, ${String(reports[0]!.at).slice(0, 10)} → ${String(reports[reports.length - 1]!.at).slice(0, 10)})`, '');
lines.push(`${recurring.length} recurring (gate × class seen on ≥ 2 nights) · ${rows.length - recurring.length} once · gates passing every night: ${[...passes.entries()].filter(([id, n]) => n === reports.length && !rows.some((r) => r.gate === id)).map(([id]) => `\`${id}\``).join(', ') || 'none'}`, '');
lines.push('| gate | spec | class | nights | required | last line |', '| --- | --- | --- | --- | --- | --- |');
for (const r of rows) lines.push(`| ${r.nights.size >= 2 ? '**' + r.gate + '**' : r.gate} | ${r.spec} | \`${r.cls}\` | ${[...r.nights].sort().join(', ')} | ${r.required ? 'yes' : 'advisory'} | ${r.sample.replace(/\|/g, '\\|').slice(0, 110)} |`);
lines.push('', '### The classes', '', ...CLASSES.map((c) => `- \`${c.id}\` — ${c.why}`), '- `unclassified` — a failure shape this table does not know yet: add the pattern, that is the finding');
const md = lines.join('\n');
writeFileSync('live-gates-trend.md', md + '\n');
console.log(md);
