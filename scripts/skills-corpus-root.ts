/**
 * WHERE THE SKILLS CORPUS IS — one resolver for every gate that reads SKILL.md contracts (R917-A-8, spec 408 §3).
 *
 * The gates used to read `~/skills` and `exit 0` when it was absent — which is every CI runner, so a gate that
 * compares the harness against the contracts passed there without reading one. The corpus is a private sibling
 * repo; CI cannot clone it without a token, and a gate that only runs on one laptop is not a gate.
 *
 * Resolution, in order, and NEVER "absent ⇒ pass":
 *   1. `SKILLS_ROOT` — an explicit checkout (CI with a token, or a developer's own path);
 *   2. `~/skills` — the developer checkout;
 *   3. `test/fixtures/skills-corpus/` — the committed FRONTMATTER-ONLY snapshot (`pnpm sync:skills-fixture`), which
 *      carries every contract's declarations (capability, interaction, effects, utterances…) and none of the prose;
 *      its CORPUS.json names the corpus commit it was taken from and when.
 * None of the three ⇒ the gate FAILS with what to do.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const FIXTURE_ROOT = join(process.cwd(), 'test', 'fixtures', 'skills-corpus');

export interface CorpusRoot { root: string; source: 'SKILLS_ROOT' | 'home' | 'fixture'; note: string }

export function skillsCorpusRoot(gate: string): CorpusRoot {
  const explicit = (process.env.SKILLS_ROOT ?? '').trim();
  if (explicit) {
    if (!existsSync(explicit)) { console.error(`✗ ${gate}: SKILLS_ROOT=${explicit} does not exist`); process.exit(1); }
    return { root: explicit, source: 'SKILLS_ROOT', note: `SKILLS_ROOT=${explicit}` };
  }
  const home = join(homedir(), 'skills');
  if (existsSync(join(home, 'skills')) || existsSync(join(home, 'archetypes'))) return { root: home, source: 'home', note: '~/skills checkout' };
  const manifest = join(FIXTURE_ROOT, 'CORPUS.json');
  if (existsSync(manifest)) {
    const m = JSON.parse(readFileSync(manifest, 'utf8')) as { commit?: string; syncedAt?: string; files?: number };
    const ageDays = m.syncedAt ? Math.floor((Date.now() - Date.parse(m.syncedAt)) / 86_400_000) : NaN;
    if (Number.isFinite(ageDays) && ageDays > 30) console.warn(`⚠ ${gate}: the committed skills fixture is ${ageDays} days old (corpus ${m.commit ?? '?'}); run pnpm sync:skills-fixture`);
    return { root: FIXTURE_ROOT, source: 'fixture', note: `committed fixture from corpus ${(m.commit ?? '?').slice(0, 10)} (${m.files ?? '?'} contracts, ${m.syncedAt?.slice(0, 10) ?? '?'})` };
  }
  console.error(`✗ ${gate}: no skills corpus — set SKILLS_ROOT, check out ~/skills, or commit the fixture with \`pnpm sync:skills-fixture\`. A contract gate does not pass by reading nothing.`);
  process.exit(1);
}
