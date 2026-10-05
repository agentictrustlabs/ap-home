// check:interaction-coverage — spec 361 I3, the coverage manifest as a GATE.
//
// The rule (one-capability-model-generates-both) says every capability's UX and Ask surfaces project
// from one contract. This walks every capability the harness OFFERS and asserts each edge of the
// manifest exists:
//
//   capability → SKILL.md contract → plain words → renderable ceremony → interaction binding
//
// A MISSING EDGE IS A FINDING, NOT SILENCE — the review's requirement, and this session's recurring
// bug shape (a promise declared where nothing executes; a surface hidden while another answers). An
// edge that is DELIBERATELY absent is waived here, by name, with the reason — the NOT_PLAN_STEPS
// pattern: an omission someone decided is different from one nobody noticed.
import { parseSkillFrontmatter } from '@agenticprimitives/capability-claims';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { skillsCorpusRoot } from './skills-corpus-root.js';
import { spawnSync } from 'node:child_process';

// Spec 398 §7.2 (4) — `--behaviour` runs the GENERATED parity pairs instead of the edge walk. Dispatched
// before anything below runs, so the default path is exactly what it was (spec 399 §0.1).
if (process.argv.includes('--behaviour')) {
  const run = spawnSync('npx', ['tsx', join(import.meta.dirname, 'check-interaction-coverage-behaviour.mts')], { stdio: 'inherit', env: process.env });
  process.exit(run.status ?? 1);
}

/** Named waivers: capability → { edge → why it is deliberately absent }. */
const WAIVERS: Record<string, Record<string, string>> = {
  'resolution.invitation.request': {
    interaction: 'its outcome is a REQUEST in the counterparty’s queue, not a screen of the asker’s — the notification IS the surface (spec 338 §7)',
  },
  'context.instruction.declare': {
    interaction: 'its outcome is a line in the Ask flyout’s own remembered panel (listed, clearable) — the conversation IS the surface (spec 394)',
  },
};

// The contracts, from the corpus checkout (the gate mirrors check-agent-skills' sourcing).
const CORPUS = skillsCorpusRoot('check:interaction-coverage');
const ROOT = CORPUS.root;
const contracts = new Map<string, Record<string, unknown>>();
console.log(`  corpus: ${CORPUS.note}`);
{
  const walk = (d: string): void => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e === 'SKILL.md') {
        try {
          const fm = parseSkillFrontmatter(readFileSync(p, 'utf8'));
          const cap = fm?.capability;
          if (typeof cap === 'string' && !contracts.has(cap)) contracts.set(cap, fm!);
        } catch { /* a malformed file is check-agent-skills' finding, not this gate's */ }
      }
    }
  };
  for (const dir of ['archetypes', 'skills']) if (existsSync(join(ROOT, dir))) walk(join(ROOT, dir));
}

// The offered capability set + the words edge, read from the harness SOURCE rather than imported:
// harness-run pulls half the workspace, and a coverage gate that needs a bundler is a gate nobody runs.
const src = readFileSync('apps/agent-runtime/src/harness-run.ts', 'utf8')
  + readFileSync('apps/agent-runtime/src/resolution-invitation.ts', 'utf8');
// Ids appear as literals AND as consts (`id: ORG_INVITE_CAPABILITY`) — resolve both, because a
// capability the scan misses is a capability with no coverage anybody notices.
const CONSTS = new Map([...src.matchAll(/const ([A-Z_]+_CAPABILITY)\s*=\s*'([a-z0-9.]+)'/g)].map((m) => [m[1]!, m[2]!]));
const OFFERED = [...new Set([
  ...[...src.matchAll(/capability:\s*\{\s*id:\s*'([a-z0-9.]+)'/g)].map((m) => m[1]!),
  ...[...src.matchAll(/capability:\s*\{\s*id:\s*([A-Z_]+_CAPABILITY)/g)].map((m) => CONSTS.get(m[1]!)).filter((x): x is string => !!x),
  // The child-agent creators declare `capability: { id, … }` SHORTHAND — the id comes from
  // CHILD_AGENT_KINDS, whose rows read `{ id: 'organization.team.create', tld: 'team', … }`.
  ...[...src.matchAll(/capability:\s*'([a-z0-9.]+)',\s*tld:/g)].map((m) => m[1]!),
])];
// A scan that finds fewer than the known floor is a broken scan, not a smaller estate. The floor moves
// only when a capability is genuinely removed — which is a decision, made here.
if (OFFERED.length < 8) {
  console.error(`✗ the capability scan found only ${OFFERED.length} (${OFFERED.join(', ')}) — the extraction regexes have drifted from harness-run's declarations`);
  process.exit(1);
}
const hasWords = (id: string) => new RegExp(`'${id.replace(/\./g, '\\.')}':\\s*'`).test(src);

const findings: string[] = [];
let covered = 0;
for (const id of OFFERED) {
  if (id === 'ask.unsupported') continue;
  const waived = WAIVERS[id] ?? {};
  const contract = contracts.get(id);
  const edges: Array<[string, boolean, string]> = [
    ['contract', !!contract, `no SKILL.md declares capability: ${id} — its behaviour is only the built-in fallback`],
    ['words', hasWords(id), `no plain words (CAPABILITY_WORDS) — the authority card would show the id`],
    ['interaction', !!(contract?.interaction), `no interaction binding — Ask cannot say where the outcome lives`],
  ];
  let ok = true;
  for (const [edge, present, why] of edges) {
    if (present) continue;
    if (waived[edge]) continue; // decided, named, and visible right here
    findings.push(`✗ ${id}: ${why}`);
    ok = false;
  }
  if (ok) covered++;
}

for (const f of findings) console.error(f);
const waivedCount = Object.values(WAIVERS).reduce((n, w) => n + Object.keys(w).length, 0);
if (findings.length) {
  console.error(`\ncheck:interaction-coverage FAILED — ${findings.length} missing edge(s). Declare the edge in the SKILL.md, or waive it BY NAME with a reason.`);
  process.exit(1);
}
console.log(`✓ check:interaction-coverage passed (${covered} capabilities fully edged, ${waivedCount} named waiver(s)).`);
