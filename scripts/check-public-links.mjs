#!/usr/bin/env node
/**
 * check-public-links.mjs — this repository is public; every link in it must resolve for a reader who is not us.
 *
 * The substrate's source monorepo and the skills corpus are private. A link into one renders fine for anyone with
 * access and 404s for everyone else, which is the whole failure: the people it breaks for are exactly the people
 * the public repository exists to serve. A private repository may be NAMED — it is part of an honest picture —
 * but never linked.
 *
 *   node scripts/check-public-links.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const PRIVATE_REPOS = ['agenticprimitives', 'skills', 'engage', 'ap-demos', 'ap-discovery'];
const linkRe = /https?:\/\/github\.com\/agentictrustlabs\/([A-Za-z0-9._-]+)/g;

const files = [];
const walk = (d, depth = 0) => {
  for (const e of readdirSync(d)) {
    if (e === 'node_modules' || e === '.git' || e === 'dist' || e.startsWith('.next')) continue;
    const p = join(d, e);
    if (statSync(p).isDirectory()) { if (depth < 5) walk(p, depth + 1); }
    else if (e.endsWith('.md')) files.push(p);
  }
};
walk('.');

const bad = [];
for (const f of files) {
  for (const [, repo] of readFileSync(f, 'utf8').matchAll(linkRe)) {
    if (PRIVATE_REPOS.includes(repo)) bad.push(`${relative('.', f)} → github.com/agentictrustlabs/${repo}`);
  }
}
if (bad.length) {
  console.error(`✗ check:public-links — ${bad.length} link(s) into a private repository:\n`);
  for (const b of [...new Set(bad)].sort()) console.error(`  ${b}`);
  console.error(`\nA reader without access sees a 404. Link a public destination, or name the repository without linking it.`);
  process.exit(1);
}
console.log(`✓ check:public-links — ${files.length} markdown file(s), no links into ${PRIVATE_REPOS.length} private repositories`);
