// GATE — EVERY ESTATE IS THE SAME SHAPE (spec 441 D8, wave W1).
//
// Reads each `estates/*.estate.json`, derives what that estate's deployment should be, and diffs it against what is
// actually deployed: vars from the wrangler.toml the deploy reads, secrets by NAME from `wrangler secret list`, and
// the KMS callers from the CVM when asked. Drift is a FAILURE, because the only reason spec 441 exists is that
// nothing was measuring — the federation record spent a day describing a configuration neither estate had.
//
// W1 is deliberately read-only. It changes nothing and is expected to be RED on first run; what it prints is the
// convergence list of spec 441 §5.
//
//   pnpm check:estate-shape                 # vars + secrets, both estates
//   pnpm check:estate-shape -- --no-secrets # vars only (no wrangler auth needed)
//   pnpm check:estate-shape -- --kms        # also read the callers off the CVM (needs az)
import { execFileSync } from 'node:child_process';
import {
  FORBIDDEN_SECRETS, POSTURE, REQUIRED_KEY_IDS, REQUIRED_SECRETS,
  deriveVars, isTownBaseline, readDeclarations, sameList, wranglerVars,
} from './estate-shape.mts';

const argv = process.argv.slice(2);
const WANT_SECRETS = !argv.includes('--no-secrets');
const WANT_KMS = argv.includes('--kms');
const only = argv.find((a) => !a.startsWith('--'));

type Finding = { estate: string; kind: string; what: string; detail: string };
const findings: Finding[] = [];
const add = (estate: string, kind: string, what: string, detail: string) => findings.push({ estate, kind, what, detail });

const RUNTIME_TOML = 'apps/agent-runtime/wrangler.toml';
const VAULT_TOML = 'apps/vault/wrangler.toml';

const decls = readDeclarations().filter((d) => !only || d.id === only);
if (!decls.length) { console.error(`no estate declaration${only ? ` for ${only}` : 's'} in estates/`); process.exit(2); }
console.log(`spec 441 — ${decls.length} estate(s) declared: ${decls.map((d) => d.id).join(', ')}\n`);

// ── the town's baseline: two estates of one town must agree ───────────────────────────────────────────
const byTown = new Map<string, string[]>();
for (const d of decls) byTown.set(d.town, [...(byTown.get(d.town) ?? []), d.id]);
for (const [town, ids] of byTown) {
  if (ids.length < 2) continue;
  const envs = ids.map((id) => ({ id, vars: wranglerVars(RUNTIME_TOML, id) }));
  // A key an estate DECLARED as an extra is that estate's product choice, never the town's, so it is not
  // compared here even when its name looks baseline-shaped.
  const declaredExtras = new Set(decls.flatMap((x) => Object.keys(x.extras ?? {})));
  const keys = [...new Set(envs.flatMap((e) => Object.keys(e.vars)))].filter((k) => isTownBaseline(k) && !declaredExtras.has(k));
  for (const k of keys) {
    const vals = envs.map((e) => e.vars[k]);
    if (new Set(vals).size > 1) {
      add(town, 'town-baseline', k, envs.map((e, i) => `${e.id}=${vals[i] ?? '<unset>'}`).join(' · '));
    }
  }
  console.log(`✓ town ${town}: ${keys.length} baseline var(s) compared across ${ids.join(', ')}`);
}

// ── per estate ────────────────────────────────────────────────────────────────────────────────────────
for (const d of decls) {
  const runtime = wranglerVars(RUNTIME_TOML, d.id);
  const vault = wranglerVars(VAULT_TOML, d.id);
  if (!Object.keys(runtime).length) { add(d.id, 'not-deployed', `[env.${d.id}.vars]`, `absent from ${RUNTIME_TOML}`); continue; }

  // derived — the shape computed it; the deployment must match
  for (const [k, want] of Object.entries(deriveVars(d))) {
    const got = runtime[k];
    const isList = k === 'ALLOWED_ORIGINS' || k === 'A2A_PUBLIC_BASE_DOMAIN';
    const ok = got !== undefined && (isList ? sameList(got, want) : got === want);
    if (ok) continue;
    if (isList && got !== undefined) {
      // A list mismatch printed as two 300-character strings is unreadable, and unreadable output is how drift
      // survives a gate. Print only what each side has that the other does not.
      const set = (v: string) => new Set(v.split(',').map((x) => x.trim()).filter(Boolean));
      const [w, g] = [set(want), set(got)];
      const missing = [...w].filter((x) => !g.has(x));
      const extra = [...g].filter((x) => !w.has(x));
      add(d.id, 'derived', k, [missing.length ? `deployment is MISSING ${missing.join(' ')}` : '', extra.length ? `deployment has UNDECLARED ${extra.join(' ')}` : ''].filter(Boolean).join(' · '));
    } else {
      add(d.id, 'derived', k, `want ${want.slice(0, 90)}${want.length > 90 ? '…' : ''} · got ${got ?? '<unset>'}`);
    }
  }

  // posture — identical on every estate, and each one a security claim
  for (const [k, { value, why }] of Object.entries(POSTURE)) {
    if (runtime[k] !== value) add(d.id, 'posture', k, `want ${value} · got ${runtime[k] ?? '<unset>'} — ${why}`);
  }
  for (const k of REQUIRED_KEY_IDS) {
    if (!runtime[k]) add(d.id, 'posture', k, 'absent — the estate holds no pointer to this key, so something local is signing (441 D3)');
  }
  // the vault needs the same two AKCS declarations
  for (const k of ['AKCS_TENANT_ID', 'AKCS_ACCEPTED_PROTECTION_LEVELS'] as const) {
    const want = k === 'AKCS_TENANT_ID' ? (d.kmsTenant ?? d.id) : POSTURE.AKCS_ACCEPTED_PROTECTION_LEVELS.value;
    if (vault[k] !== want) add(d.id, 'vault', k, `want ${want} · got ${vault[k] ?? '<unset>'}`);
  }

  // extras — real, kept, and declared. An undeclared extra is a setting nobody classified.
  const known = new Set([...Object.keys(deriveVars(d)), ...Object.keys(POSTURE), ...REQUIRED_KEY_IDS, ...Object.keys(d.extras ?? {})]);
  for (const k of Object.keys(runtime)) {
    if (known.has(k) || isTownBaseline(k)) continue;
    add(d.id, 'unclassified', k, `= ${String(runtime[k]).slice(0, 60)} — neither derived, posture, nor a declared extra (441 D2)`);
  }
  for (const [k, want] of Object.entries(d.extras ?? {})) {
    if (runtime[k] !== want) add(d.id, 'extra', k, `declared ${String(want).slice(0, 60)} · deployed ${runtime[k] ?? '<unset>'}`);
  }

  console.log(`✓ ${d.id}: ${Object.keys(runtime).length} runtime var(s) + ${Object.keys(vault).length} vault var(s) read`);

  // secrets — by NAME only; a value is never read, printed or compared
  if (WANT_SECRETS) {
    let names: string[] | null = null;
    try {
      const out = execFileSync('npx', ['wrangler', 'secret', 'list', '--env', d.id], { cwd: 'apps/agent-runtime', encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      names = (JSON.parse(out) as { name: string }[]).map((x) => x.name);
    } catch {
      // NOT a silent fallback (ADR-0013): a check that could not run says so and fails, rather than passing quietly.
      add(d.id, 'secrets-unreadable', 'wrangler secret list', 'could not be read — this says nothing about the estate; re-run with wrangler auth, or --no-secrets to skip deliberately');
    }
    if (names) {
      for (const [k, why] of Object.entries(FORBIDDEN_SECRETS)) {
        if (names.includes(k)) add(d.id, 'FORBIDDEN-SECRET', k, `present — ${why} (441 D3)`);
      }
      for (const k of REQUIRED_SECRETS) if (!names.includes(k)) add(d.id, 'secret-missing', k, 'every estate holds this one');
      console.log(`  ${names.length} secret(s) present by name`);
    }
  }
}

// ── the KMS callers, when asked ───────────────────────────────────────────────────────────────────────
if (WANT_KMS) {
  // REDUCE ON THE VM, AND REDUCE HARD. `az vm run-command invoke` truncates its message from the FRONT, so even a
  // trimmed copy of the operator's status loses its opening brace and parses as garbage. The VM emits one short
  // line per tenant — the two things this gate judges, already judged.
  // ONE LINE, chr(10) NOT "\n": the script is handed to bash inside double quotes, where a literal backslash-n
  // reaches python as two characters and the reduction dies silently several layers away.
  const PY = 'import json,sys;d=json.load(sys.stdin);D={"key-rotate","key-disable","key-schedule-destruction"};'
    + 'A=lambda t:[c for c in t["callers"] if c["status"]=="ACTIVE"];'
    + 'print(chr(10).join("|".join([t["tenantId"],str(len(A(t))),str(len(t["callers"])),'
    + '",".join(c["subject"] for c in A(t) if "*" in c["operations"]),'
    + '",".join(c["subject"] for c in A(t) if D&set(c["operations"]))]) for t in d["tenants"]))';
  const SCRIPT = `set -a; . /etc/akcs/env 2>/dev/null; set +a\nakcs operator --config /etc/akcs/config.toml status 2>/dev/null | python3 -c ${JSON.stringify(PY)}`;
  let rows: string[] | null = null;
  try {
    const out = execFileSync('az', ['vm', 'run-command', 'invoke', '-g', 'RG-AKCS-PILOT-WESTUS', '-n', 'vm-akcs-pilot-0',
      '--command-id', 'RunShellScript', '--scripts', SCRIPT, '--query', 'value[0].message', '-o', 'tsv'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 24 });
    rows = out.split('\n').map((l) => l.trim()).filter((l) => /^[a-z0-9-]+\|\d+\|\d+\|/.test(l));
    if (!rows.length) throw new Error(`no tenant line in the operator's reply: ${out.trim().slice(-140)}`);
  } catch (e) {
    rows = null; // a half-assigned list is not a read (ADR-0013): the check says it could not run
    const err = (e as { stderr?: string }).stderr?.trim().split('\n')[0] ?? String(e).split('\n')[0];
    add('—', 'kms-unreadable', 'akcs operator status', `${err.slice(0, 160)} — needs az logged in as the operator`);
  }
  if (rows) {
    const byTenant = new Map(rows.map((l) => { const [t, act, all, wild, dest] = l.split('|'); return [t, { act, all, wild, dest }] as const; }));
    for (const d of decls) {
      const tenant = d.kmsTenant ?? d.id;
      const r = byTenant.get(tenant);
      if (!r) { add(d.id, 'kms', 'tenant', `no tenant ${tenant} on the operator`); continue; }
      if (r.wild) add(d.id, 'kms', 'wildcard caller', `${r.wild} holds operations ["*"] — one credential for everything the tenant can do`);
      if (r.dest) add(d.id, 'kms', 'destructive grant', `${r.dest} can rotate, disable or destroy a key (441 §4: no estate profile carries those)`);
      console.log(`✓ ${d.id}: tenant ${tenant}, ${r.act} active caller(s) of ${r.all}`);
    }
  }
}

// ── verdict ───────────────────────────────────────────────────────────────────────────────────────────
if (!findings.length) {
  console.log(`\nESTATE SHAPE GREEN · ${decls.length} estate(s), one shape`);
  process.exit(0);
}
console.log(`\n${findings.length} drift(s) — spec 441 §5 is this list:\n`);
const order = ['FORBIDDEN-SECRET', 'posture', 'vault', 'derived', 'town-baseline', 'secret-missing', 'unclassified', 'extra'];
for (const f of [...findings].sort((a, b) => (order.indexOf(a.kind) + 99 * +(order.indexOf(a.kind) < 0)) - (order.indexOf(b.kind) + 99 * +(order.indexOf(b.kind) < 0)))) {
  console.log(`✗ [${f.estate}] ${f.kind} ${f.what}\n    ${f.detail}`);
}
console.log(`\nESTATE SHAPE RED · ${findings.length} drift(s) across ${decls.length} estate(s)`);
process.exit(1);
