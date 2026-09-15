// Pack @agenticprimitives/runtime-member and the CLOSURE of its workspace dependencies (deps + peers, transitively)
// into ./tarballs for the Container image (spec 400 W1c). `pnpm pack` rewrites `workspace:*` to real versions, so
// the image installs the tarballs with npm like any consumer would — the Container is a consumer of the kit, not a
// checkout of the monorepo. Run: `node runtime-container/build.mjs` (from apps/agent-runtime) after the workspace is built.
import { readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const byName = new Map();
for (const d of readdirSync(join(root, 'packages'))) {
  try { const pj = JSON.parse(readFileSync(join(root, 'packages', d, 'package.json'), 'utf8')); byName.set(pj.name, { dir: join(root, 'packages', d), pj }); } catch { /* not a package */ }
}
const want = new Set(); const queue = ['@agenticprimitives/runtime-member'];
while (queue.length) {
  const n = queue.shift(); if (want.has(n)) continue;
  const p = byName.get(n); if (!p) throw new Error(`${n} is not a workspace package`);
  want.add(n);
  for (const dep of Object.keys({ ...(p.pj.dependencies ?? {}), ...(p.pj.peerDependencies ?? {}), ...(p.pj.optionalDependencies ?? {}) })) if (dep.startsWith('@agenticprimitives/')) queue.push(dep);
}
const out = join(here, 'tarballs');
rmSync(out, { recursive: true, force: true }); mkdirSync(out);
const names = [...want].sort();
for (const n of names) execSync(`pnpm pack --pack-destination "${out}"`, { cwd: byName.get(n).dir, stdio: 'ignore' });
writeFileSync(join(out, 'MANIFEST'), `${names.join('\n')}\n`);
console.log(`packed ${names.length} packages into ${out}: ${names.map((n) => n.replace('@agenticprimitives/', '')).join(' ')}`);
