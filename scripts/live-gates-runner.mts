/**
 * Spec 399 §2.3 / §3.3 — THE LIVE GATES, RUN BY THE PACKAGE RUNNER. The same ledger (`scripts/live-gates.json`), the
 * same report (`live-gates-report.json`), the same table — produced by `@agenticprimitives/evaluation`'s
 * `runLiveGates` instead of `scripts/live-gates.mts`, so the two can be run side by side (W0 "done when": the
 * destination command passes against the current monorepo beside the old script for a week). The old script is
 * NOT touched; it is deleted only in the cut PR of the app whose gates it runs.
 *
 *   pnpm check:live-gates:runner                    (every gate, in order, paced for the model plan's meter)
 *   pnpm check:live-gates:runner --only a,b         (a subset by id)
 *   HOME_URL=… pnpm check:live-gates:runner         (another Home)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runLiveGates, formatLiveGatesTable, failedRequiredGates, type LiveGatesLedgerV1 } from '@agenticprimitives/evaluation';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const ledger = JSON.parse(readFileSync(resolve(ROOT, 'scripts/live-gates.json'), 'utf8')) as LiveGatesLedgerV1;
const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length) ?? (process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : undefined);
const report = await runLiveGates(ledger, {
  cwd: ROOT,
  homeUrl: process.env.HOME_URL,
  only: only?.split(',').map((s) => s.trim()).filter(Boolean),
  paceMs: Number(process.env.LIVE_GATES_PACE_MS ?? 20_000),
  log: (l) => process.stdout.write(l.endsWith(' ') ? l : `${l}\n`),
}).catch((e: unknown) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(2); });
console.log(formatLiveGatesTable(report));
writeFileSync(resolve(ROOT, 'live-gates-report.json'), JSON.stringify(report, null, 2));
console.log(' · live-gates-report.json');
const failed = failedRequiredGates(report);
if (failed.length) { console.error(`\n✗ ${failed.length} required gate(s) failed: ${failed.map((r) => r.id).join(', ')}`); process.exit(1); }
console.log(`\n✓ every required live gate holds.`);
