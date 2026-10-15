// MOVE AN ESTATE TO ANOTHER TOWN'S CHAIN — spec 441, ap-town's second-town runbook §7.1.
//
// An estate's configuration is five inputs and everything else derived, so moving it between towns should be a
// declaration edit and a redeploy. This is the part that cannot be derived from the five: the TOWN's chain
// addresses, which come from that chain's deployment file.
//
// WHAT THIS DELIBERATELY DOES NOT TOUCH:
//   · the estate's SECRETS — custody root, MAC, session, assertion. They are chain-agnostic, and every vault
//     binding depends on them: minting fresh ones would orphan the estate's own records rather than move them.
//   · its AKCS keys — chain-agnostic too, which is why an estate that moves keeps the same relay and
//     interactions keys, and why its service agents on the new chain are chartered under the SAME custodian
//     and need no custody rotation (441 §7.2 step 2 simply does not arise).
//   · anything outside `[env.<id>.vars]`.
//
// WHAT IT CANNOT DO FOR YOU: a resident's DEL-001 session leaf is chain-scoped and must be re-issued
// (`scripts/reissue-interactions-grants.mts`), and the estate's service agents must already be chartered on
// the new chain (`scripts/bootstrap-estate.mts --agents-only`). Both are printed at the end.
//
//   npx tsx scripts/retarget-estate.mts --id imbnet --deployment-file …/deployments-hopechain.json [--dry-run]
import { readFileSync, writeFileSync } from 'node:fs';
import { readDeclarations, townVarsFromDeployment, wranglerVars } from './estate-shape.mts';

const arg = (k: string): string | undefined => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const DRY = process.argv.includes('--dry-run');
const ID = arg('id');
const FILE = arg('deployment-file');
if (!ID || !FILE) { console.error('usage: retarget-estate.mts --id <estate> --deployment-file <deployments-<town>.json> [--dry-run]'); process.exit(2); }

const decl = readDeclarations().find((d) => d.id === ID);
if (!decl) { console.error(`no estates/${ID}.estate.json`); process.exit(2); }
const dep = JSON.parse(readFileSync(FILE.replace(/^~/, process.env.HOME ?? ''), 'utf8')) as Record<string, unknown>;
const { vars: chainVars, missing } = townVarsFromDeployment(dep);

/** The estate's own agents are OUTPUTS of its build on THIS chain, so they move with it. */
if (decl.agents?.interactions) chainVars.INTERACTIONS_SERVICE_SA = decl.agents.interactions;
if (decl.agents?.harness) chainVars.HARNESS_AGENT_SA = decl.agents.harness;

const TOMLS = ['apps/agent-runtime/wrangler.toml', 'apps/vault/wrangler.toml'];
const tomlValue = (v: string) => (v.includes('"') ? `'${v}'` : `"${v}"`);

let changedTotal = 0;
for (const path of TOMLS) {
  const before = wranglerVars(path, ID);
  if (!Object.keys(before).length) { console.log(`· ${path}: no [env.${ID}.vars] — skipped`); continue; }
  const lines = readFileSync(path, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.trim() === `[env.${ID}.vars]`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (lines[i].trim().startsWith('[')) { end = i; break; }

  const changed: string[] = [];
  const seen = new Set<string>();
  for (let i = start + 1; i < end; i++) {
    const m = /^([A-Z_0-9]+)\s*=\s*(.*)$/.exec(lines[i].trim());
    if (!m) continue;
    const key = m[1];
    // Only a var this chain OWNS is rewritten. An estate's own settings and its extras are not this tool's
    // business, and silently rewriting one would make a retarget indistinguishable from an edit.
    if (!(key in chainVars)) continue;
    seen.add(key);
    const want = `${key} = ${tomlValue(chainVars[key])}`;
    const comment = lines[i].includes(' #') ? lines[i].slice(lines[i].indexOf(' #')) : '';
    if (lines[i].trim() !== want.trim()) { changed.push(`${key}: ${before[key] ?? '<unset>'} → ${chainVars[key]}`); lines[i] = want + comment; }
  }
  // REWRITE WHAT IS THERE; ADD NOTHING. A Worker carries the chain vars it actually reads — the vault reads a
  // handful, the runtime most of them — and a retarget that also ADDED every chain var would hand the vault
  // eighteen addresses it has never used. Config nobody reads is config nobody checks. Giving a new estate its
  // full set is the BUILDER's job (estate-new.mts), where the question is what a Worker needs rather than what
  // changed.
  const notPresent = Object.keys(chainVars).filter((k) => !seen.has(k));
  if (notPresent.length) console.log(`    (not in this Worker, left alone: ${notPresent.length} var(s))`);

  if (changed.length && !DRY) writeFileSync(path, lines.join('\n'));
  changedTotal += changed.length;
  console.log(`${DRY ? '·' : '✓'} ${path}: ${changed.length} var(s)${DRY ? ' would change' : ' rewritten'}`);
  for (const c of changed.slice(0, 40)) console.log(`    ${c}`);
}

console.log();
if (missing.length) console.log(`the town's deployment has no: ${missing.join(', ')} — reported, never written blank, because an address that is present and empty fails at the first call instead of at boot\n`);
console.log(`${DRY ? 'would retarget' : 'retargeted'} ${ID} → chain ${chainVars.CHAIN_ID} (${changedTotal} var(s) across both Workers)`);
console.log('still yours, and neither is derivable from a file:');
console.log(`  1. the service agents on that chain — npx tsx scripts/bootstrap-estate.mts --estate ${ID} --agents-only …`);
console.log(`  2. every resident's DEL-001 session leaf, which is chain-scoped —`);
console.log(`     HOME_URL=https://${decl.homeHost} npx tsx scripts/reissue-interactions-grants.mts ${(decl.residents ?? ['<handle>']).join(' ')}`);
