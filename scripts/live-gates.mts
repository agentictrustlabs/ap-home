/**
 * Spec 392 — THE LIVE GATES, RUN AS ONE JOB. Every wave shipped with a live verify script and, beside its
 * positive, an authority twin — the forged child, the revoked grant, the expired window, the span that must
 * not carry the payee. They were run by hand, once, the day the wave shipped. This runs the ledger
 * (`scripts/live-gates.json`) end to end against the deployed estate and says, per gate: passed or failed,
 * how long, and the last lines it printed — so a regression is a red line in the morning, not a discovery
 * during the next wave.
 *
 *   pnpm check:live-gates                    (every gate, in order, paced for the model plan's meter)
 *   pnpm check:live-gates --only a,b         (a subset by id)
 *   HOME_URL=… pnpm check:live-gates         (another Home)
 *
 * Deterministic judge: each script decides its own pass/fail (exit code); this never re-reads a reply. A
 * gate that times out is a failure with that word. The report (`live-gates-report.json`) is what the nightly
 * uploads; the table is what a person reads.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface Gate { id: string; script: string; spec: string; proves: string; twin: string; required: boolean; paced?: boolean; timeoutSec?: number; env?: Record<string, string> }
interface Ledger { home: string; gates: Gate[] }
interface Result { id: string; spec: string; ok: boolean; required: boolean; ms: number; status: 'passed' | 'failed' | 'timed out'; tail: string[] }

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const ledger = JSON.parse(readFileSync(resolve(ROOT, 'scripts/live-gates.json'), 'utf8')) as Ledger;
const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length) ?? (process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : undefined);
const wanted = only ? new Set(only.split(',').map((s) => s.trim()).filter(Boolean)) : null;
const gates = ledger.gates.filter((g) => !wanted || wanted.has(g.id));
if (!gates.length) { console.error(`no gates match ${only}`); process.exit(2); }
const PACE_MS = Number(process.env.LIVE_GATES_PACE_MS ?? 20_000);
const HOME = process.env.HOME_URL ?? ledger.home;

const results: Result[] = [];
console.log(`live gates · ${gates.length} of ${ledger.gates.length} · ${HOME}\n`);
for (const [i, g] of gates.entries()) {
  if (i > 0 && g.paced && PACE_MS > 0) await new Promise((r) => setTimeout(r, PACE_MS));
  const t0 = Date.now();
  process.stdout.write(`▶ ${g.id.padEnd(26)} ${g.spec.padEnd(20)} `);
  const run = spawnSync('npx', ['tsx', g.script], { cwd: ROOT, env: { ...process.env, HOME_URL: HOME, ...(g.env ?? {}) }, encoding: 'utf8', timeout: (g.timeoutSec ?? 300) * 1000, maxBuffer: 16 * 1024 * 1024 });
  const ms = Date.now() - t0;
  const timedOut = run.error?.name === 'Error' && /ETIMEDOUT|TIMEOUT/i.test(String(run.error?.message ?? run.signal ?? ''));
  const status: Result['status'] = timedOut || run.signal === 'SIGTERM' ? 'timed out' : run.status === 0 ? 'passed' : 'failed';
  const out = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l && !/^npm warn/.test(l));
  const tail = out.slice(-8);
  results.push({ id: g.id, spec: g.spec, ok: status === 'passed', required: g.required, ms, status, tail });
  console.log(`${status === 'passed' ? '✓' : '✗'} ${status} in ${(ms / 1000).toFixed(1)}s`);
  if (status !== 'passed') for (const l of tail) console.log(`    │ ${l.slice(0, 200)}`);
}

const failedRequired = results.filter((r) => !r.ok && r.required);
const failedOptional = results.filter((r) => !r.ok && !r.required);
console.log(`\n── live gates ──`);
console.log(`| gate | spec | result | time |\n| --- | --- | --- | --- |`);
for (const r of results) console.log(`| ${r.id} | ${r.spec} | ${r.ok ? '✓ passed' : `✗ ${r.status}${r.required ? '' : ' (advisory)'}`} | ${(r.ms / 1000).toFixed(1)}s |`);
const report = { at: new Date().toISOString(), home: HOME, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results, ledger: gates.map((g) => ({ id: g.id, spec: g.spec, proves: g.proves, twin: g.twin, required: g.required })) };
writeFileSync(resolve(ROOT, 'live-gates-report.json'), JSON.stringify(report, null, 2));
console.log(`\n${report.passed} passed, ${report.failed} failed${failedOptional.length ? ` (${failedOptional.length} advisory)` : ''} · live-gates-report.json`);
if (failedRequired.length) { console.error(`\n✗ ${failedRequired.length} required gate(s) failed: ${failedRequired.map((r) => r.id).join(', ')}`); process.exit(1); }
console.log(`\n✓ every required live gate holds.`);
