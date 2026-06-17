// Deploy-target secret writers (upstream backlog B6). Programmatic, no-echo, fail-closed
// writers for the two deploy targets this repo uses, so the managed-KMS / spec-278 go-live can
// "write the runtime config" instead of manual `wrangler secret put` / Vercel dashboard.
//
// PLACEMENT (doctrine): this is repo deploy/ops tooling — it lives in scripts/ alongside
// deploy-cloudflare.ts + set-cloudflare-secrets.sh, NOT in packages/. A deploy-platform secret
// writer is not a generic trust primitive (ADR-0021), and the managed-KMS ORCHESTRATOR that
// composes these writers is an external concern (ADR-0037, backlog C1). The functions are pure +
// injectable (fetch / spawn) so an external orchestrator can port or import them.
//
// SECURITY: the secret VALUE is never logged and never read from argv (which leaks via shell
// history / process listings) — it comes from an env var or stdin. Failures throw (fail-closed).
//
//   tsx scripts/deploy-secrets.ts cloudflare --worker demo-mcp --env production --name GCP_SERVICE_ACCOUNT_JSON
//   tsx scripts/deploy-secrets.ts vercel --project demo-sso-next --name DEMO_MCP_URL --target production
//   # value piped on stdin (default) or from --value-env <ENV_VAR>; never on the command line.

import { spawn } from 'node:child_process';

// ─── value sourcing (never argv) ───────────────────────────────────────────

/** Read the secret value from `--value-env <VAR>` if given, else from stdin. Never from argv. */
export async function readSecretValue(valueEnvVar: string | undefined): Promise<string> {
  if (valueEnvVar) {
    const v = process.env[valueEnvVar];
    if (v === undefined || v === '') throw new Error(`deploy-secrets: env var ${valueEnvVar} is empty/unset`);
    return v;
  }
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const v = Buffer.concat(chunks).toString('utf8').replace(/\n$/, '');
  if (!v) throw new Error('deploy-secrets: no value on stdin (pipe the secret, or pass --value-env)');
  return v;
}

// ─── Cloudflare Worker secret (via wrangler, value on stdin — no echo) ──────

export interface CloudflareSecretTarget {
  /** Worker app directory (so wrangler.toml resolves), e.g. apps/demo-mcp. */
  cwd: string;
  /** wrangler --env (e.g. production). */
  env?: string;
  name: string;
}

/** Pipe the value into `wrangler secret put NAME` (stdin), so it never appears in argv/logs.
 *  Injectable runner for testing; defaults to spawning wrangler. */
export async function writeCloudflareWorkerSecret(
  target: CloudflareSecretTarget,
  value: string,
  run: (argv: string[], opts: { cwd: string; stdin: string }) => Promise<{ code: number; stderr: string }> = defaultSpawn,
): Promise<void> {
  const argv = ['wrangler', 'secret', 'put', target.name, ...(target.env ? ['--env', target.env] : [])];
  const { code, stderr } = await run(argv, { cwd: target.cwd, stdin: value });
  if (code !== 0) throw new Error(`deploy-secrets: wrangler secret put ${target.name} failed (exit ${code})${stderr ? `: ${stderr.slice(0, 300)}` : ''}`);
}

function defaultSpawn(argv: string[], opts: { cwd: string; stdin: string }): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn('npx', argv, { cwd: opts.cwd, stdio: ['pipe', 'inherit', 'pipe'] });
    let stderr = '';
    p.stderr?.on('data', (d) => { stderr += String(d); });
    p.on('error', reject);
    p.on('close', (code) => resolve({ code: code ?? 1, stderr }));
    p.stdin!.write(opts.stdin);
    p.stdin!.end();
  });
}

// ─── Vercel project env var (via REST API — NOT `vercel env add`) ───────────

// ⚠ `vercel env add` from stdin stores an EMPTY value (observed downstream) — never use it. The
// REST API is the only reliable path: resolve the project id (+ team) then upsert the env var.

export type VercelTarget = 'production' | 'preview' | 'development';
const VERCEL_API = 'https://api.vercel.com';

export interface VercelEnvOptions {
  /** Project id or name. */
  project: string;
  name: string;
  targets?: VercelTarget[]; // default ['production']
  token: string;           // VERCEL_TOKEN
  teamId?: string;         // VERCEL_TEAM_ID (or slug); optional for personal projects
}

type Fetch = typeof fetch;

/** Resolve a project name → id (+ accountId) via the Vercel API. */
export async function resolveVercelProjectId(
  opts: { project: string; token: string; teamId?: string },
  f: Fetch = fetch,
): Promise<string> {
  const q = opts.teamId ? `?teamId=${encodeURIComponent(opts.teamId)}` : '';
  const res = await f(`${VERCEL_API}/v9/projects/${encodeURIComponent(opts.project)}${q}`, {
    headers: { authorization: `Bearer ${opts.token}` },
  });
  if (!res.ok) throw new Error(`deploy-secrets: Vercel project lookup "${opts.project}" failed (HTTP ${res.status})`);
  const body = (await res.json()) as { id?: string };
  if (!body.id) throw new Error(`deploy-secrets: Vercel project "${opts.project}" has no id`);
  return body.id;
}

/** Upsert an ENCRYPTED env var on a Vercel project via the REST API. Idempotent (upsert=true).
 *  No-echo (the value is in the JSON body, never logged); fail-closed. */
export async function writeVercelEnvVar(opts: VercelEnvOptions, value: string, f: Fetch = fetch): Promise<void> {
  if (!opts.token) throw new Error('deploy-secrets: VERCEL_TOKEN is required');
  const projectId = await resolveVercelProjectId({ project: opts.project, token: opts.token, teamId: opts.teamId }, f);
  const q = new URLSearchParams({ upsert: 'true', ...(opts.teamId ? { teamId: opts.teamId } : {}) }).toString();
  const res = await f(`${VERCEL_API}/v10/projects/${projectId}/env?${q}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ key: opts.name, value, type: 'encrypted', target: opts.targets ?? ['production'] }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`deploy-secrets: Vercel env upsert ${opts.name} failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(name);
}

async function main(): Promise<void> {
  const target = process.argv[2];
  const name = arg('--name');
  const dryRun = flag('--dry-run');
  if (!target || !name) {
    console.error('usage: deploy-secrets <cloudflare|vercel> --name NAME [--value-env VAR] [--dry-run] …');
    process.exit(2);
  }
  // Source the value FIRST (so --dry-run can confirm it resolved without revealing it).
  const value = dryRun ? '<dry-run>' : await readSecretValue(arg('--value-env'));

  if (target === 'cloudflare') {
    const worker = arg('--worker') ?? 'demo-mcp';
    const env = arg('--env');
    const cwd = arg('--cwd') ?? `apps/${worker}`;
    console.log(`cloudflare: ${name} → worker ${worker}${env ? ` (--env ${env})` : ''}${dryRun ? ' [dry-run]' : ''}`);
    if (dryRun) return;
    await writeCloudflareWorkerSecret({ cwd, env, name }, value);
    console.log(`  ✓ set ${name}`);
  } else if (target === 'vercel') {
    const project = arg('--project');
    if (!project) throw new Error('deploy-secrets vercel: --project required');
    const targets = (arg('--target')?.split(',') as VercelTarget[]) ?? ['production'];
    console.log(`vercel: ${name} → project ${project} (${targets.join(',')})${dryRun ? ' [dry-run]' : ''}`);
    if (dryRun) return;
    await writeVercelEnvVar(
      { project, name, targets, token: process.env.VERCEL_TOKEN ?? '', teamId: process.env.VERCEL_TEAM_ID },
      value,
    );
    console.log(`  ✓ set ${name}`);
  } else {
    throw new Error(`deploy-secrets: unknown target "${target}" (expected cloudflare|vercel)`);
  }
}

// Run only as a CLI (not when imported by deploy-cloudflare.ts / an orchestrator).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
}
