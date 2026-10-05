// check:no-vector-over-vault — spec 413 / spec 411 §5, the two-tier rule as a GATE.
//
// A vector index is a projection of the PUBLIC knowledge tier: agent descriptions the A-box already holds and shelf works
// their owners made public and released (ADR-0040, amended 2026-09-24). The day a Vectorize (or AutoRAG / AI Search)
// binding sits in the same Worker as a way into a vault, a private record is one `upsert` away from being embedded into
// a world-readable index — and "we would never do that" is not a control. So the binding is refused structurally: no
// Worker environment may hold both.
//
// "A way into a vault" is any of: a service binding or Durable Object script pointing at the vault Worker (demo-mcp*),
// the per-principal DO classes that construct or front a vault (InteractionsDO, PrincipalGatewayDO), or a binding whose
// NAME says vault. Wrangler bindings are not inherited by `[env.*]` sections, so each environment is judged on its own.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const VECTOR_HEADER = /^\[\[?(?:env\.[\w-]+\.)?(vectorize|ai_search|autorag)\]?\]$/;
const VAULT_LINE = [
  /^\s*(service|script_name)\s*=\s*"demo-mcp[\w-]*"/,
  /^\s*class_name\s*=\s*"(InteractionsDO|PrincipalGatewayDO)"/,
  /^\s*binding\s*=\s*"[\w]*VAULT[\w]*"/i,
  /^\s*name\s*=\s*"[\w]*VAULT[\w]*"/i,
];

interface EnvFacts { vector: string[]; vault: string[] }
const findings: string[] = [];
let checked = 0;

for (const app of readdirSync(join(ROOT, 'apps'))) {
  const file = join(ROOT, 'apps', app, 'wrangler.toml');
  if (!existsSync(file)) continue;
  checked++;
  const envs = new Map<string, EnvFacts>();
  const facts = (env: string): EnvFacts => { let f = envs.get(env); if (!f) { f = { vector: [], vault: [] }; envs.set(env, f); } return f; };
  let env = '(top-level)';
  readFileSync(file, 'utf8').split('\n').forEach((raw, i) => {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) return;
    const header = line.match(/^\[\[?([^\]]+)\]?\]$/);
    if (header) {
      const m = header[1]!.match(/^env\.([\w-]+)/);
      env = m ? m[1]! : '(top-level)';
      if (VECTOR_HEADER.test(line)) facts(env).vector.push(`${line} (line ${i + 1})`);
      return;
    }
    if (VAULT_LINE.some((re) => re.test(line))) facts(env).vault.push(`${line} (line ${i + 1})`);
  });
  for (const [name, f] of envs) {
    if (f.vector.length && f.vault.length) {
      findings.push(`apps/${app}/wrangler.toml [${name}]: binds a vector index (${f.vector.join('; ')}) AND reaches a vault (${f.vault.join('; ')})`);
    }
  }
}

if (findings.length) {
  console.error('✗ check:no-vector-over-vault — a Worker environment holds a vector index and a way into a vault (spec 413 §1.2):');
  for (const f of findings) console.error(`  - ${f}`);
  console.error('  The index is a projection of the PUBLIC tier; bind it only where no vault is reachable (discovery-mcp, the indexer).');
  process.exit(1);
}
console.log(`✓ check:no-vector-over-vault passed (${checked} wrangler configs; no environment binds a vector index beside a vault).`);
