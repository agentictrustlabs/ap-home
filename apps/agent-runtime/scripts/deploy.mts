/**
 * deploy.mts — `wrangler deploy`, after the VAULT PREFLIGHT (docs/design/library-paged-catalog.md).
 *
 * This runtime reads every owner's Library index through the vault's catalog door (`get_catalog_records`). Deployed
 * against a vault that predates it, every Library read and save fails closed ("deploy apps/vault first") — for every
 * owner. So before deploying, ask the vault this environment talks to (`MCP_URL` in wrangler.toml for `--env`, or
 * `VAULT_URL`) for `/health` and refuse unless it says `catalogDoor: ap.catalog.paged.v2`.
 *
 *   pnpm --filter @ap-home/agent-runtime run deploy -- --env faithnet
 *
 * Every argument is passed to `wrangler deploy`. `--skip-vault-preflight` (with VAULT_PREFLIGHT_ACK=deploy-without-catalog-door)
 * skips the check — only for an environment with no vault at all.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export const CATALOG_DOOR = 'ap.catalog.paged.v2';

/** The `--env` named in wrangler's arguments, if any. */
export function envOf(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--env' || a === '-e') return args[i + 1] ?? null;
    if (a.startsWith('--env=')) return a.slice(6);
  }
  return null;
}

/** MCP_URL for an environment, from wrangler.toml ([vars] for none, [env.<name>.vars] otherwise). */
export function mcpUrlOf(toml: string, env: string | null): string | null {
  const want = env ? `[env.${env}.vars]` : '[vars]';
  let inSection = false;
  for (const line of toml.split('\n')) {
    const t = line.trim();
    if (t.startsWith('[')) { inSection = t === want; continue; }
    if (!inSection) continue;
    const m = /^MCP_URL\s*=\s*"([^"]+)"/.exec(t);
    if (m) return m[1]!;
  }
  return null;
}

/** The preflight: the vault's /health must name the catalog door. Returns null when it does, else why not. */
export async function vaultPreflight(vaultUrl: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  let res: Response;
  try { res = await fetchImpl(`${vaultUrl.replace(/\/+$/, '')}/health`); } catch (e) { return `the vault at ${vaultUrl} did not answer (${e instanceof Error ? e.message : String(e)})`; }
  if (!res.ok) return `the vault at ${vaultUrl} answered /health with ${res.status}`;
  const body = (await res.json().catch(() => null)) as { catalogDoor?: string } | null;
  if (body?.catalogDoor !== CATALOG_DOOR) return `the vault at ${vaultUrl} does not serve the paged Library index's door (catalogDoor ${JSON.stringify(body?.catalogDoor ?? null)}, need ${CATALOG_DOOR}) — deploy apps/vault first`;
  return null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const skip = args.includes('--skip-vault-preflight');
  const wranglerArgs = args.filter((a) => a !== '--skip-vault-preflight');
  if (skip && process.env.VAULT_PREFLIGHT_ACK !== 'deploy-without-catalog-door') {
    console.error('--skip-vault-preflight needs VAULT_PREFLIGHT_ACK=deploy-without-catalog-door');
    process.exit(1);
  }
  if (!skip) {
    const env = envOf(wranglerArgs);
    const url = process.env.VAULT_URL ?? mcpUrlOf(readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8'), env);
    if (!url) { console.error(`vault preflight: no MCP_URL for ${env ? `--env ${env}` : 'the top-level env'} in wrangler.toml (set VAULT_URL)`); process.exit(1); }
    const why = await vaultPreflight(url);
    if (why) { console.error(`vault preflight FAILED: ${why}. Not deploying.`); process.exit(1); }
    console.log(`vault preflight ok: ${url} serves ${CATALOG_DOOR}`);
  }
  const r = spawnSync('npx', ['wrangler', 'deploy', ...wranglerArgs], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
