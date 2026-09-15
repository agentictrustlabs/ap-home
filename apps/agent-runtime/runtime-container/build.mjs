// Pack @agenticprimitives/runtime-member and the CLOSURE of its @agenticprimitives dependencies (deps + peers,
// transitively) into ./tarballs for the Container image (spec 400 W1c). The Container is a CONSUMER of the kit, never a
// checkout of the monorepo: in Ring 0 the tarballs come from the workspace (`pnpm pack` rewrites `workspace:*` to real
// versions); in a product repo (spec 399 — no `packages/`, exact published pins) they come from the registry
// (`npm pack name@version`), the version being the one the app pins, and the closure the published manifests declare.
// Run: `node runtime-container/build.mjs` (from the runtime app) after the workspace is built.
import { readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..');
const root = join(app, '..', '..');
const out = join(here, 'tarballs');
rmSync(out, { recursive: true, force: true }); mkdirSync(out);
const ROOT_PKG = '@agenticprimitives/runtime-member';
const isOurs = (n) => n.startsWith('@agenticprimitives/');
const depsOf = (pj) => Object.entries({ ...(pj.dependencies ?? {}), ...(pj.peerDependencies ?? {}), ...(pj.optionalDependencies ?? {}) }).filter(([n]) => isOurs(n));

let names;
if (existsSync(join(root, 'packages'))) {
  // RING 0 — the workspace is the source.
  const byName = new Map();
  for (const d of readdirSync(join(root, 'packages'))) {
    try { const pj = JSON.parse(readFileSync(join(root, 'packages', d, 'package.json'), 'utf8')); byName.set(pj.name, { dir: join(root, 'packages', d), pj }); } catch { /* not a package */ }
  }
  const want = new Set(); const queue = [ROOT_PKG];
  while (queue.length) {
    const n = queue.shift(); if (want.has(n)) continue;
    const p = byName.get(n); if (!p) throw new Error(`${n} is not a workspace package`);
    want.add(n);
    for (const [dep] of depsOf(p.pj)) queue.push(dep);
  }
  names = [...want].sort();
  for (const n of names) execSync(`pnpm pack --pack-destination "${out}"`, { cwd: byName.get(n).dir, stdio: 'ignore' });
} else {
  // A PRODUCT REPO — the registry is the source, at the versions the app pins (exact) and the published manifests declare.
  const appPj = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
  const pinned = { ...(appPj.dependencies ?? {}), ...(appPj.devDependencies ?? {}) };
  const view = (spec) => JSON.parse(execSync(`npm view "${spec}" name version dependencies peerDependencies optionalDependencies --json`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  const versions = new Map(); const queue = [[ROOT_PKG, pinned[ROOT_PKG] ?? 'latest']];
  while (queue.length) {
    const [n, range] = queue.shift(); if (versions.has(n)) continue;
    const pj = view(`${n}@${range}`);
    versions.set(n, pj.version);
    for (const [dep, r] of depsOf(pj)) queue.push([dep, pinned[dep] ?? r]);
  }
  names = [...versions.keys()].sort();
  for (const n of names) execSync(`npm pack "${n}@${versions.get(n)}" --pack-destination "${out}"`, { stdio: 'ignore' });
}
writeFileSync(join(out, 'MANIFEST'), `${names.join('\n')}\n`);
console.log(`packed ${names.length} packages into ${out}: ${names.map((n) => n.replace('@agenticprimitives/', '')).join(' ')}`);
