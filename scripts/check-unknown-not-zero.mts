/**
 * Spec 398 §6.3 / T32 — NEVER RENDER UNKNOWN AS ZERO. The "no organizations of 37" incident: a read that failed was
 * rendered as an empty list, and an empty list reads as "none". A surface that swallows a read failure into `[]` is the
 * pattern this ratchets: the count may go down, never up (the ceiling is the count at introduction). A read that fails
 * must be SAID — which read, and why — with what IS shown marked partial.
 *
 *   npx tsx scripts/check-unknown-not-zero.mts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CEILING = 6;
const ROOTS = ['apps/demo-sso-next/src', 'apps/demo-sso-next/app'];
const PATTERN = /catch\(\(\) => \[\]\)|catch\(\(\) => \{ if \(live\) set[A-Za-z]+\(\[\]\)|catch\(\(\) => set[A-Za-z]+\(\[\]\)\)|catch\(\(\) => \(\{ artifacts: \[\] \}\)\)/g;
const hits: string[] = [];
const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); const st = statSync(p); if (st.isDirectory()) { if (n !== 'node_modules') walk(p); } else if (/\.(ts|tsx)$/.test(n) && !/\.test\./.test(n)) { const src = readFileSync(p, 'utf8'); src.split('\n').forEach((line, i) => { if (PATTERN.test(line)) hits.push(`${p}:${i + 1}`); PATTERN.lastIndex = 0; }); } } };
for (const r of ROOTS) walk(r);
if (hits.length > CEILING) { console.error(`✗ check:unknown-not-zero — ${hits.length} site(s) render a failed read as an empty list, ceiling ${CEILING} (398 §6.3):\n${hits.map((h) => `  · ${h}`).join('\n')}`); process.exit(1); }
console.log(`✓ check:unknown-not-zero passed (${hits.length}/${CEILING} sites still swallow a read failure into []; the ceiling only goes down).`);
if (hits.length) console.log(hits.map((h) => `  · ${h}`).join('\n'));
