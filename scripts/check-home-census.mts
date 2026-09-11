// check:home-census — spec 398 §1 / §12 G0: THE HOME CENSUS AS A GATE.
//
// The external review of 2026-09-10 marked 25 of 52 Home rows "Unverified" or "Design" because it could
// not see this tree. §1 answered it by hand once; this keeps the answer true. The census is DATA
// (docs/architecture/home-census.json): one row per capability family, its status (shipped | partial |
// absent), and every binding the row claims — Home routes, components, capability ids the runtime
// offers, harness endpoints, unit tests, nightly live gates. This script:
//
//   1. verifies every claimed binding exists in the tree (a row may not claim a route that is not there);
//   2. applies the status rules — `shipped` binds a surface AND evidence; `partial` names its `gaps`;
//      `absent` binds nothing — so a row cannot say "shipped" on a promise;
//   3. reports the CENSUS DIFF: every Home page route, every /harness endpoint and every live gate the
//      tree has that NO row claims. A surface nobody censused is the review's complaint restated, so
//      routes and endpoints are findings; an unclaimed gate is advisory (some gates are not Home's);
//   4. with a live-gates report present (live-gates-report.json or the newest in live-gates-reports/),
//      attaches each claimed gate's last result, so "current test result" is a column, not a memory.
//
//   npx tsx scripts/check-home-census.mts [--json] [--write-md] [--ledger <path>] [--report <path>]
//
// ADDITIVE (spec 399 §0.1): a new script and a new ledger; nothing existing is edited. The ledger's
// `roots` re-point at ap-home's tree (apps/home, apps/agent-runtime) when the census moves at W2.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

type Status = 'shipped' | 'partial' | 'absent';
interface Row {
  id: string; review?: string[]; title: string; priority: 'P0' | 'P1' | 'P2'; status: Status; specs?: number[]; section?: string;
  routes?: string[]; components?: string[]; capabilities?: string[]; endpoints?: string[]; tests?: string[]; gates?: string[]; gaps?: string[];
}
interface Ledger { version: string; roots: Record<string, string> & { capabilitySources?: string[] }; rows: Row[] }

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const JSON_OUT = args.includes('--json');
const WRITE_MD = args.includes('--write-md');
const LEDGER = resolve(flag('--ledger') ?? 'docs/architecture/home-census.json');
const ledger = JSON.parse(readFileSync(LEDGER, 'utf8')) as Ledger;
const R = ledger.roots;
const expand = (p: string): string => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

// ---- what the tree has -------------------------------------------------------------------------------
const pageRoutes = ((): string[] => {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const e of readdirSync(dir).sort()) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) { if (e !== 'node_modules') walk(p, rel ? `${rel}/${e}` : e); }
      else if (e === 'page.tsx') out.push(rel);
    }
  };
  walk(R.homeApp!, '');
  return out;
})();
const runtimeIndex = readFileSync(R.runtimeIndex!, 'utf8');
// Capability ids live in the runtime's src AND in the packages its promoted tools moved to (399 §4).
const capabilitySources = R.capabilitySources ?? [join(R.runtime!, 'src')];
const runtimeSrc = capabilitySources.flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.ts')).map((f) => readFileSync(join(d, f), 'utf8'))).join('\n');
const harnessEndpoints = [...new Set([...runtimeIndex.matchAll(/'(\/harness\/[a-z/-]*)'/g)].map((m) => m[1]!))].sort();
const liveGates = (JSON.parse(readFileSync(R.liveGates!, 'utf8')) as { gates: Array<{ id: string; required?: boolean }> }).gates;
const gateIds = new Set(liveGates.map((g) => g.id));

// The SKILL.md corpus (advisory): which capability ids have a contract. Absent corpus ⇒ column blank.
const corpus = expand(R.skillsCorpus ?? '~/skills');
const contracts = new Set<string>();
if (existsSync(corpus)) {
  const walk = (d: string): void => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) { if (e !== 'node_modules' && e !== '.git') walk(p); }
      else if (e === 'SKILL.md') { const m = /^capability:\s*([a-z0-9.]+)\s*$/m.exec(readFileSync(p, 'utf8')); if (m) contracts.add(m[1]!); }
    }
  };
  for (const dir of ['archetypes', 'skills']) if (existsSync(join(corpus, dir))) walk(join(corpus, dir));
}

// The last live-gates report, when one is around: gate id → ok | failed.
const reportPath = ((): string | null => {
  const explicit = flag('--report');
  if (explicit) return resolve(explicit);
  const dir = 'live-gates-reports';
  const dated = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => join(dir, f)) : [];
  if (dated.length) return dated[dated.length - 1]!;
  return existsSync('live-gates-report.json') ? 'live-gates-report.json' : null;
})();
const gateResult = new Map<string, string>();
if (reportPath) {
  try {
    const r = JSON.parse(readFileSync(reportPath, 'utf8')) as { results?: Array<{ id: string; ok?: boolean; status?: string }> };
    for (const x of r.results ?? []) gateResult.set(x.id, x.ok === true || x.status === 'ok' || x.status === 'passed' ? 'pass' : 'fail');
  } catch { /* an unreadable report is not a census finding */ }
}

// ---- verify every row --------------------------------------------------------------------------------
const findings: string[] = [];
const claimedRoutes = new Set<string>();
const claimedEndpoints = new Set<string>();
const claimedGates = new Set<string>();
const rowsOut: Array<Record<string, unknown>> = [];

for (const row of ledger.rows) {
  const missing: string[] = [];
  for (const r of row.routes ?? []) {
    claimedRoutes.add(r);
    if (!existsSync(join(R.homeApp!, r, 'page.tsx')) && !existsSync(join(R.homeApp!, r, 'route.ts'))) missing.push(`route ${r}`);
  }
  for (const c of row.components ?? []) if (!existsSync(join(R.homeSrc!, c))) missing.push(`component ${c}`);
  for (const id of row.capabilities ?? []) if (!runtimeSrc.includes(`'${id}'`)) missing.push(`capability ${id} (not in ${capabilitySources.join(', ')})`);
  for (const ep of row.endpoints ?? []) { claimedEndpoints.add(ep); if (!runtimeIndex.includes(`'${ep}'`)) missing.push(`endpoint ${ep}`); }
  for (const t of row.tests ?? []) if (!existsSync(t)) missing.push(`test ${t}`);
  for (const g of row.gates ?? []) { claimedGates.add(g); if (!gateIds.has(g)) missing.push(`gate ${g} (not in ${R.liveGates})`); }

  const surfaces = (row.routes?.length ?? 0) + (row.components?.length ?? 0) + (row.endpoints?.length ?? 0);
  const evidence = (row.tests?.length ?? 0) + (row.gates?.length ?? 0);
  if (row.status === 'shipped' && surfaces === 0) missing.push('status shipped but the row binds no route, component or endpoint');
  if (row.status === 'shipped' && evidence === 0) missing.push('status shipped but the row binds no test or live gate');
  if (row.status === 'partial' && !(row.gaps?.length)) missing.push('status partial but no gaps named');
  if (row.status === 'absent' && (surfaces + evidence + (row.capabilities?.length ?? 0)) > 0) missing.push('status absent but the row binds something — it is at least partial');
  if (row.status === 'absent' && !row.section) missing.push('status absent but no 398 section builds it');
  for (const m of missing) findings.push(`✗ ${row.id} [${row.priority} ${row.status}]: ${m}`);

  const capsWithoutContract = existsSync(corpus) ? (row.capabilities ?? []).filter((c) => c !== 'ask.unsupported' && !contracts.has(c)) : [];
  rowsOut.push({
    id: row.id, review: row.review ?? [], title: row.title, priority: row.priority, status: row.status, section: row.section ?? '',
    routes: row.routes ?? [], components: row.components ?? [], capabilities: row.capabilities ?? [], endpoints: row.endpoints ?? [],
    tests: row.tests ?? [], gates: (row.gates ?? []).map((g) => ({ id: g, last: gateResult.get(g) ?? 'no report' })),
    contractsMissing: capsWithoutContract, gaps: row.gaps ?? [], findings: missing,
  });
}

// ---- the census diff ---------------------------------------------------------------------------------
const unclaimedRoutes = pageRoutes.filter((r) => !claimedRoutes.has(r));
const unclaimedEndpoints = harnessEndpoints.filter((e) => !claimedEndpoints.has(e));
const unclaimedGates = liveGates.filter((g) => !claimedGates.has(g.id)).map((g) => g.id);
for (const r of unclaimedRoutes) findings.push(`✗ census diff: Home route ${r} is claimed by no row — add it to the row it belongs to, or a new row`);
for (const e of unclaimedEndpoints) findings.push(`✗ census diff: harness endpoint ${e} is claimed by no row`);

// ---- report ------------------------------------------------------------------------------------------
const byStatus = (s: Status) => ledger.rows.filter((r) => r.status === s).length;
const summary = {
  ledger: LEDGER, version: ledger.version, rows: ledger.rows.length, shipped: byStatus('shipped'), partial: byStatus('partial'), absent: byStatus('absent'),
  routesInTree: pageRoutes.length, routesClaimed: pageRoutes.filter((r) => claimedRoutes.has(r)).length, endpointsInTree: harnessEndpoints.length, endpointsClaimed: claimedEndpoints.size,
  gatesInLedger: liveGates.length, gatesClaimed: claimedGates.size, unclaimedGates, corpus: existsSync(corpus) ? corpus : null, report: reportPath, findings: findings.length,
};

if (WRITE_MD) {
  const md: string[] = [];
  md.push('# Home census — generated by `pnpm check:home-census --write-md`', '',
    `Spec 398 §1 / §12 G0. Source of truth: \`docs/architecture/home-census.json\` (version ${ledger.version}). Do not edit this file; edit the ledger and regenerate.`, '',
    `${summary.rows} rows — ${summary.shipped} shipped · ${summary.partial} partial · ${summary.absent} absent. ${summary.routesClaimed}/${summary.routesInTree} Home page routes and ${summary.endpointsClaimed}/${summary.endpointsInTree} harness endpoints claimed. Live-gates report: ${reportPath ?? 'none present'}.`, '',
    '| Row | Review ids | Status | Priority | Routes | Components | Capabilities | Endpoints | Tests | Gates (last) | Gaps |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of rowsOut) {
    const cell = (xs: unknown[]) => (xs.length ? xs.map(String).map((s) => `\`${s}\``).join('<br>') : '—');
    const gates = (r.gates as Array<{ id: string; last: string }>).map((g) => `\`${g.id}\` (${g.last})`).join('<br>') || '—';
    md.push(`| **${r.id}**<br>${r.title} | ${(r.review as string[]).join(', ') || '—'} | ${r.status} | ${r.priority} | ${cell(r.routes as string[])} | ${cell(r.components as string[])} | ${cell(r.capabilities as string[])} | ${cell(r.endpoints as string[])} | ${cell(r.tests as string[])} | ${gates} | ${(r.gaps as string[]).join('<br>') || '—'} |`);
  }
  md.push('', '## Census diff', '', `Unclaimed Home routes: ${unclaimedRoutes.length ? unclaimedRoutes.map((r) => `\`${r}\``).join(', ') : 'none'}.`, '',
    `Unclaimed harness endpoints: ${unclaimedEndpoints.length ? unclaimedEndpoints.map((e) => `\`${e}\``).join(', ') : 'none'}.`, '',
    `Live gates claimed by no Home row (advisory): ${unclaimedGates.length ? unclaimedGates.map((g) => `\`${g}\``).join(', ') : 'none'}.`, '');
  writeFileSync('docs/architecture/home-census.md', md.join('\n'));
}

if (JSON_OUT) {
  console.log(JSON.stringify({ summary, rows: rowsOut, unclaimedRoutes, unclaimedEndpoints, findings }, null, 2));
} else {
  for (const f of findings) console.error(f);
  if (unclaimedGates.length) console.log(`ℹ live gates claimed by no Home row (advisory): ${unclaimedGates.join(', ')}`);
  const contractGaps = rowsOut.flatMap((r) => (r.contractsMissing as string[]).map((c) => `${r.id}:${c}`));
  if (contractGaps.length) console.log(`ℹ capabilities without a SKILL.md contract in ${corpus} (check:interaction-coverage gates the offered acts): ${contractGaps.join(', ')}`);
}
if (findings.length) {
  console.error(`\ncheck:home-census FAILED — ${findings.length} finding(s): a claimed binding is missing, a status is not earned, or the tree has a surface no row censuses.`);
  process.exit(1);
}
if (!JSON_OUT) console.log(`✓ check:home-census passed — ${summary.rows} rows (${summary.shipped} shipped · ${summary.partial} partial · ${summary.absent} absent); ${summary.routesClaimed}/${summary.routesInTree} routes, ${summary.endpointsClaimed}/${summary.endpointsInTree} endpoints, ${summary.gatesClaimed}/${summary.gatesInLedger} gates claimed${reportPath ? `; last report ${reportPath}` : ''}.`);
