/**
 * Spec 398 §10 / G2 — THE DEVELOPER KIT FROM A CLEAN MACHINE: generate the `home-client` starter into an empty directory,
 * install it from the REGISTRY (exact pins), and run everything the README promises — doctor, typecheck, tests, build,
 * and the two live acts (a read under the person's standing; an act parked for her signature at her Home).
 *
 *   npx tsx scripts/verify-devkit-starter.mts        (CREATE_APP=<bin> to use a published generator; HOME_MCP_URL=… for another estate)
 *
 * The twin is inside the starter's own script: continuing the parked run before she signs parks again; the app held a
 * bearer and nothing else. What this does not claim: the browser round-trip (the Home's authorize page; proven by
 * `verify-home-mcp-browser-path` on the same door).
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture as fx, HOME_MCP } from './fixture.mts';

const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };
const CREATE_APP = process.env.CREATE_APP ?? join(process.cwd(), 'packages/create-app/bin/create-app.mjs');
const PIN = process.env.DEVKIT_PIN ?? (JSON.parse(execSync('npm view @agenticprimitives/devkit version --json', { encoding: 'utf8' })) as string);
const root = mkdtempSync(join(tmpdir(), 'ap-starter-'));
const dir = join(root, 'my-agent-app');
const sh = (cmd: string, cwd = dir): string => { try { return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } }); } catch (e) { const err = e as { stdout?: string; stderr?: string; message: string }; fail(`${cmd}\n${(err.stdout ?? '').slice(-1200)}\n${(err.stderr ?? '').slice(-800)}`); return ''; } };
const t0 = Date.now();
console.log(`── devkit starter · home-client · devkit ${PIN} · ${dir} ──`);
try {
  const gen = sh(`node ${CREATE_APP} my-agent-app --template home-client --pin ${PIN}`, root);
  if (!/agentic\.lock\.json/.test(gen) || !existsSync(join(dir, 'src/lib/home-agent.ts'))) fail(`generation did not write the starter: ${gen.slice(-400)}`);
  console.log(`  generated (${gen.split('\n').filter((l) => /^\s{2}\S/.test(l)).length} files)`);
  sh('pnpm install --silent');
  console.log('  installed from the registry');
  // The projection is re-made by the PINNED devkit (a generator newer than the pin projects a newer corpus; the doctor then says so).
  sh('npx ap doctor --rules --write');
  const doctor = sh('npx ap doctor');
  if (!/12 rule\(s\) clean/.test(doctor)) fail(`ap doctor is not clean:\n${doctor.slice(-1200)}`);
  console.log('  ap doctor: 12 rules clean');
  sh('pnpm typecheck'); console.log('  typecheck clean');
  const tests = sh('pnpm test'); if (!/pass 4/.test(tests) || /fail [1-9]/.test(tests)) fail(`the starter's tests did not pass:\n${tests.slice(-600)}`);
  console.log('  4 unit tests pass');
  writeFileSync(join(dir, '.env.local'), `HOME_MCP_URL=${HOME_MCP}\nAPP_URL=http://localhost:3000\nCOOKIE_SECRET=${Math.random().toString(36).slice(2)}${Date.now().toString(36)}\n`);
  const build = sh('pnpm build'); if (!/api\/ask/.test(build)) fail(`next build did not list the routes:\n${build.slice(-600)}`);
  console.log('  next build: / and /api/{connect,callback,ask,me,disconnect}');
  const verify = execSync('pnpm verify', { cwd: dir, encoding: 'utf8', env: { ...process.env, HOME_MCP_URL: HOME_MCP, DEMO_HANDLE: fx.people.steward, DEMO_ORG: fx.org.name, DEMO_MEMBER: fx.people.member } });
  if (!/two acts: a read answered under her standing; an act parked/.test(verify)) fail(`the two acts did not both land:\n${verify.slice(-800)}`);
  for (const line of verify.split('\n').filter((l) => /^(read|act|continue) /.test(l))) console.log(`  ${line.slice(0, 140)}`);
  const lock = JSON.parse(readFileSync(join(dir, 'agentic.lock.json'), 'utf8')) as { packages: Record<string, string>; template: { name: string } };
  if (lock.template.name !== 'home-client' || lock.packages['@agenticprimitives/devkit'] !== PIN) fail(`the lock does not pin the starter as generated: ${JSON.stringify(lock.packages)}`);
  console.log(`\n✓ spec 398 G2 exit: another developer succeeds from a clean machine — generated, installed from the registry (devkit ${PIN}), doctor clean, typechecked, tested, built, and the two acts landed live in ${Math.round((Date.now() - t0) / 1000)} s.`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
