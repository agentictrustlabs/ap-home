// THE ESTATE BUILDER — spec 441 W4. Five inputs in, an estate out, the same one every time.
//
// An estate is a repeatable anatomy (spec 436), so building the hundredth should be the same act as building
// the second. Before this, it was a copy-paste of whichever of two estates you happened to open, which is how
// they drifted into 30 differing variables and one of them keeping private keys in Worker secrets (441 §1).
//
// WHAT THIS TOOL IS, AND IS NOT. It is a PLAN RUNNER over an ordered, resumable, idempotent list of steps. It
// is not a one-shot that leaves you guessing which half ran. Each step says what it is about to do, does it,
// and verifies it; a step that cannot be done unattended prints the exact command and stops, because two of
// them cannot honestly be automated:
//
//   · an OPERATOR step runs on the KMS CVM as the operator of record. One holder today, deliberately
//     (ap-federation 440 §A). The builder will run it for you when `az` is logged in as that operator, and
//     print it for a human when it is not.
//   · a SIGNER step charters an agent or rotates custody. That SPENDS AUTHORITY and signs as a custodian,
//     and a tool that charters unattended is a tool that can create an agent nobody decided to create
//     (441 §8). The builder prepares the command; the human runs it.
//
// THE THREE-STEP KEY (441 §7.2) is why this exists as a plan and not a script. An estate's interactions key
// is referenced in two places no variable mentions — the harness agent SA's custody, and every resident's
// DEL-001 session leaf — so provisioning it is create, rotate, re-issue. Doing one of the three leaves an
// estate that answers questions and cannot act, and says so nowhere obvious.
//
//   npx tsx scripts/estate-new.mts --id <id> --home-host www.x.me --zone x.io --town faithchain [--kms-tenant <t>]
//   npx tsx scripts/estate-new.mts --id <id> --plan        # the ordered steps and their state, run nothing
//   npx tsx scripts/estate-new.mts --id <id> --run         # run every auto step; stop at the first that needs a human
//   npx tsx scripts/estate-new.mts --id <id> --run --only <step>
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { deriveVars, POSTURE, readDeclarations, wranglerVars, type EstateDeclaration } from './estate-shape.mts';

const argv = process.argv.slice(2);
const arg = (k: string): string | undefined => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const has = (k: string) => argv.includes(`--${k}`);
const RUN = has('run');
const ONLY = arg('only');
const ID = arg('id');

const RUNTIME_TOML = 'apps/agent-runtime/wrangler.toml';
const VAULT_TOML = 'apps/vault/wrangler.toml';
const DECL = (id: string) => `estates/${id}.estate.json`;
const OPERATOR = 'akcs operator --config /etc/akcs/config.toml';
const ISSUER = 'https://akcs-pilot.faithnet.internal';
const AZ = ['vm', 'run-command', 'invoke', '-g', 'RG-AKCS-PILOT-WESTUS', '-n', 'vm-akcs-pilot-0', '--command-id', 'RunShellScript'];

if (!ID) { console.error('--id is required\n  new:  --id <id> --home-host <host> --zone <zone> --town <town> [--kms-tenant <t>]\n  then: --plan | --run [--only <step>]'); process.exit(2); }

// ── the declaration: written first, because everything else is derived from it ─────────────────────────
const label = (s: string) => `\x1b[1m${s}\x1b[0m`;
const ok = (s: string) => console.log(`  ✓ ${s}`);
const info = (s: string) => console.log(`    ${s}`);

if (!existsSync(DECL(ID))) {
  const homeHost = arg('home-host'); const zone = arg('zone'); const town = arg('town');
  if (!homeHost || !zone || !town) {
    console.error(`${DECL(ID)} does not exist, so this is a NEW estate and needs its five inputs:\n` +
      '  --home-host <www.x.me>   the rpId of every passkey; it cannot be derived and cannot change later\n' +
      '  --zone <x.io>            where this estate\'s own hosts live (mcp. edge. a2a.)\n' +
      '  --town <faithchain>      whose chain, naming and Pulse it stands in\n' +
      '  [--kms-tenant <t>]       defaults to the id; name it only to match a tenant that already exists');
    process.exit(2);
  }
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(ID)) { console.error(`the id ${ID} must be lowercase letters, digits and hyphens`); process.exit(2); }
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(homeHost) || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(zone)) { console.error('--home-host and --zone are hostnames'); process.exit(2); }
  for (const d of readDeclarations()) {
    if (d.homeHost === homeHost) { console.error(`${d.id} already answers at ${homeHost}; two estates cannot share a Home host (it is the rpId)`); process.exit(2); }
    if (d.zone === zone) { console.error(`${d.id} already owns ${zone}`); process.exit(2); }
    if ((d.kmsTenant ?? d.id) === (arg('kms-tenant') ?? ID)) { console.error(`${d.id} already uses the KMS tenant ${arg('kms-tenant') ?? ID}; a tenant is an estate boundary and is never shared`); process.exit(2); }
  }
  const decl: EstateDeclaration & Record<string, unknown> = {
    _: 'spec 441 — THE ESTATE\'S DECLARATION, written by scripts/estate-new.mts. Five inputs, the agents the build charters, and this estate\'s own extras. Everything else is DERIVED (scripts/estate-shape.mts) or the town\'s, and `pnpm check:estate-shape` fails when the deployment disagrees.',
    id: ID, homeHost, zone, town, kmsTenant: arg('kms-tenant') ?? ID,
    altZones: [], extraOrigins: [],
    _agents: 'OUTPUTS of the build: this estate charters its own. Reusing another estate\'s interactions SA does not make a second estate (439 §7.13).',
    agents: {},
    extras: {},
  };
  writeFileSync(DECL(ID), `${JSON.stringify(decl, null, 2)}\n`);
  console.log(`\n${label(`estate ${ID} declared`)} → ${DECL(ID)}\n`);
}

const decl = JSON.parse(readFileSync(DECL(ID), 'utf8')) as EstateDeclaration;
const tenant = decl.kmsTenant ?? decl.id;
const derived = deriveVars(decl);

// ── the plan ──────────────────────────────────────────────────────────────────────────────────────────
type Step = {
  id: string;
  kind: 'auto' | 'operator' | 'signer';
  title: string;
  /** Already done? Steps are idempotent or skipped, so --run is safe to repeat. */
  done: () => boolean | Promise<boolean>;
  /** What a human must run, when this is not ours to do. */
  command?: string;
  run?: () => void | Promise<void>;
  /** Why this step exists at all, printed when it is the one that stops the run. */
  why?: string;
};

const azRun = (script: string): string =>
  execFileSync('az', [...AZ, '--scripts', script, '--query', 'value[0].message', '-o', 'tsv'], { encoding: 'utf8', maxBuffer: 1 << 24 });
const azAvailable = (): boolean => { try { execFileSync('az', ['account', 'show'], { stdio: 'ignore' }); return true; } catch { return false; } };
const kmsStatus = (): string => { try { return azRun(`set -a; . /etc/akcs/env 2>/dev/null; set +a; ${OPERATOR} status 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(" ".join(t["tenantId"]+":"+",".join(c["subject"] for c in t.get("callers",[]) if c["status"]=="ACTIVE") for t in d.get("tenants",[])))'`); } catch { return ''; } };
let kmsCache: string | undefined;
const kms = (): string => (kmsCache ??= kmsStatus());
/** EXACT, never a substring: `faithnet-vault` matched `demo-mcp-faithnet-vault-5` and the plan reported a
 *  caller that did not exist. A step that lies about being done is worse than a step that asks twice. */
const hasCaller = (subject: string): boolean =>
  kms().split(/\s+/).some((t) => t.split(':')[1]?.split(',').includes(subject));
const hasTenant = (t: string): boolean => kms().split(/\s+/).some((x) => x.split(':')[0] === t);

/**
 * A TOML value, quoted the way TOML needs. A town value like `FEDERATION_DOORS` is JSON and FULL of double
 * quotes: emitting it inside double quotes produced a file wrangler could not parse, which the generator's
 * first run did. A literal (single-quoted) string carries it verbatim.
 */
const tomlValue = (v: string): string => (v.includes('"') ? `'${v}'` : `"${v}"`);

/** Insert a `[env.<id>]`-shaped block into a wrangler.toml, after the last existing env block. */
const appendEnvBlock = (path: string, body: string) => {
  const s = readFileSync(path, 'utf8');
  writeFileSync(path, `${s.replace(/\s*$/, '')}\n\n${body.trim()}\n`);
};

const steps: Step[] = [
  {
    id: 'declaration',
    kind: 'auto',
    title: `the declaration exists and its five inputs are sane`,
    done: () => existsSync(DECL(ID!)),
    run: () => { /* written above */ },
  },
  {
    id: 'wrangler-env',
    kind: 'auto',
    title: `[env.${ID}.vars] in both wrangler.toml files, with every derived var and the shape's posture`,
    why: 'the derived vars exist in ONE place (estate-shape.mts) and are written from there, never typed per estate — that is how BROKER_ISS could ever have disagreed with the host the passkeys are bound to',
    done: () => Object.keys(wranglerVars(RUNTIME_TOML, ID!)).length > 0 && Object.keys(wranglerVars(VAULT_TOML, ID!)).length > 0,
    run: () => {
      const posture = Object.entries(POSTURE).map(([k, v]) => `${k} = ${tomlValue(v.value)}`).join('\n');
      const town = readDeclarations().find((d) => d.town === decl.town && d.id !== decl.id);
      const townVars = town ? wranglerVars(RUNTIME_TOML, town.id) : {};
      const baseline = Object.entries(townVars)
        .filter(([k]) => !(k in derived) && !(k in POSTURE) && !k.startsWith('AKCS_') && !(k in (town?.extras ?? {})))
        .map(([k, v]) => `${k} = ${tomlValue(v)}`).join('\n');
      if (!town) info(`no other estate in town ${decl.town} to copy the town baseline from — fill it from the town's manifest`);
      appendEnvBlock(RUNTIME_TOML, [
        `# ── ${ID} (spec 441) — generated by scripts/estate-new.mts. The DERIVED vars come from`,
        `# estate-shape.mts; do not hand-edit them. The town baseline below is ${town?.id ?? '<no sibling estate>'}'s,`,
        `# because every estate of ${decl.town} must agree on it, and check:estate-shape fails when two do not.`,
        `[env.${ID}]`,
        `name = "${ID}-runtime"`,
        '',
        `[env.${ID}.vars]`,
        Object.entries(derived).map(([k, v]) => `${k} = ${tomlValue(v)}`).join('\n'),
        posture,
        baseline,
      ].join('\n'));
      appendEnvBlock(VAULT_TOML, [
        `# ── ${ID} (spec 441) — generated. AKCS_TOKEN is a SECRET, never a var.`,
        `[env.${ID}]`,
        `name = "${ID}-vault"`,
        '',
        `[env.${ID}.vars]`,
        `AKCS_TENANT_ID = "${tenant}"`,
        `AKCS_ACCEPTED_PROTECTION_LEVELS = "${POSTURE.AKCS_ACCEPTED_PROTECTION_LEVELS.value}"`,
        `MCP_AUDIENCE = "urn:mcp:server:person"`,
      ].join('\n'));
      ok(`wrote [env.${ID}.vars] to both wrangler.toml files`);
      info('REVIEW IT: the generated block carries a sibling estate\'s town baseline, and a town gains contracts over time');
    },
  },
  {
    id: 'kms-tenant',
    kind: 'operator',
    title: `the KMS tenant ${tenant} exists — one per estate, always`,
    why: 'a tenant is the seed every key of this estate derives from, so sharing one dissolves the estate boundary (ap-federation 440 §A)',
    command: `${OPERATOR} create-tenant --tenant-id ${tenant} --name "${ID}"`,
    done: () => hasTenant(tenant),
    run: () => { azRun(`set -a; . /etc/akcs/env 2>/dev/null; set +a; ${OPERATOR} create-tenant --tenant-id ${tenant} --name "${ID}" 2>&1 | tail -2`); kmsCache = undefined; },
  },
  {
    id: 'kms-callers',
    kind: 'operator',
    title: `two callers by PROFILE — ${decl.callerSubjects?.vault ?? `${ID}-vault`} (estate-vault) and ${decl.callerSubjects?.runtime ?? `${ID}-runtime`} (estate-runtime)`,
    why: 'the profile is the whole point: the hundredth estate\'s callers are the first estate\'s callers, not a fresh guess. Deriving the sets by hand once cost a day (441 D5), because a missing entry fails where nothing names it',
    command: `${OPERATOR} bind-caller --tenant-id ${tenant} --issuer ${ISSUER} --subject ${ID}-vault --name "${ID} vault" --profile estate-vault\n` +
      `  ${OPERATOR} bind-caller --tenant-id ${tenant} --issuer ${ISSUER} --subject ${ID}-runtime --name "${ID} agent-runtime" --profile estate-runtime`,
    // The declaration's recorded subjects when it has them (an estate bound before the convention keeps its
    // names — renaming a caller means re-binding and re-minting for no gain), the convention otherwise.
    done: () => hasCaller(decl.callerSubjects?.vault ?? `${ID}-vault`) && hasCaller(decl.callerSubjects?.runtime ?? `${ID}-runtime`),
    run: () => {
      azRun(`set -a; . /etc/akcs/env 2>/dev/null; set +a\n${OPERATOR} bind-caller --tenant-id ${tenant} --issuer ${ISSUER} --subject ${ID}-vault --name "${ID} vault" --profile estate-vault 2>&1 | tail -1\n${OPERATOR} bind-caller --tenant-id ${tenant} --issuer ${ISSUER} --subject ${ID}-runtime --name "${ID} agent-runtime" --profile estate-runtime 2>&1 | tail -1`);
      kmsCache = undefined;
    },
  },
  {
    id: 'kms-keys',
    kind: 'operator',
    title: `this estate's relay and interactions-session SIGNING keys, in its own tenant`,
    why: 'no estate keeps a private key in a Worker secret (441 D3) — a Worker secret is readable by anyone who can deploy that Worker, and an AKCS key id is a pointer to material that never leaves the CVM',
    command: `${OPERATOR} create-key --tenant-id ${tenant} --name ${ID}-relay --kind SIGNING --purpose relay\n` +
      `  ${OPERATOR} create-key --tenant-id ${tenant} --name ${ID}-interactions-session --kind SIGNING --purpose interactions-session`,
    done: () => {
      const v = wranglerVars(RUNTIME_TOML, ID!);
      return !!v.AKCS_RELAY_KEY_ID && !!v.AKCS_INTERACTIONS_KEY_ID;
    },
    run: () => {
      const out = azRun(`set -a; . /etc/akcs/env 2>/dev/null; set +a\nfor s in relay interactions-session; do ${OPERATOR} create-key --tenant-id ${tenant} --name ${ID}-$s --kind SIGNING --purpose $s 2>&1 | python3 -c 'import json,sys; t=sys.stdin.read(); i=t.find("{"); d=json.loads(t[i:t.rfind("}")+1]); print(d["purpose"],d["keyId"])' ; done`);
      const ids = Object.fromEntries([...out.matchAll(/(relay|interactions-session)\s+([0-9a-f-]{36})/g)].map((m) => [m[1], m[2]]));
      if (!ids.relay || !ids['interactions-session']) throw new Error(`could not read both key ids back:\n${out.trim().slice(-300)}`);
      const s = readFileSync(RUNTIME_TOML, 'utf8');
      const at = s.indexOf(`[env.${ID}.vars]`);
      if (at < 0) throw new Error(`no [env.${ID}.vars] block — run the wrangler-env step first`);
      const nl = s.indexOf('\n', at) + 1;
      writeFileSync(RUNTIME_TOML, s.slice(0, nl) +
        `AKCS_RELAY_KEY_ID = "${ids.relay}"               # ${ID}-relay, SIGNING/secp256k1 in tenant ${tenant}\n` +
        `AKCS_INTERACTIONS_KEY_ID = "${ids['interactions-session']}"        # ${ID}-interactions-session, same tenant\n` +
        s.slice(nl));
      ok(`relay ${ids.relay} · interactions ${ids['interactions-session']} — written into [env.${ID}.vars]`);
    },
  },
  {
    id: 'kms-tokens',
    kind: 'operator',
    title: `mint the two caller tokens and set them as AKCS_TOKEN on each Worker`,
    why: 'one credential per Worker, never shared — the finding that took ap-federation condition 1 a day to close',
    command: `${OPERATOR.replace('operator', 'dev')} mint-token --signing-key /etc/akcs/issuer/issuer-signing-key.pem --kid akcs-pilot-1 --issuer ${ISSUER} --audience akcs-pilot --subject ${ID}-vault --ttl-secs 31536000\n` +
      `  (then: cd apps/vault && npx wrangler secret put AKCS_TOKEN --env ${ID}; same for ${ID}-runtime in apps/agent-runtime)`,
    // A secret's VALUE is never readable back, but its NAME is — which is enough to know whether the step
    // was done, and is all this tool ever asks for.
    done: () => ['apps/vault', 'apps/agent-runtime'].every((d) => {
      try {
        const out = execFileSync('npx', ['wrangler', 'secret', 'list', '--env', ID!], { cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        return (JSON.parse(out) as { name: string }[]).some((x) => x.name === 'AKCS_TOKEN');
      } catch { return false; }
    }),
    run: undefined, // deliberately manual: a token is handed over out of band, never printed into a log
  },
  {
    id: 'charter-agents',
    kind: 'signer',
    title: `charter this estate's harness agent SA and interactions service SA, and write them into the declaration`,
    why: 'chartering spends authority and signs as a custodian (441 §8). An estate that reuses another estate\'s interactions SA is not a second estate (439 §7.13)',
    command: `CHAIN_APP_TOKEN=… npx tsx scripts/bootstrap-estate.mts --estate ${ID}
` +
      `  → writes .estate-${ID}.local (0600) with the secrets and the two SA addresses; put those two under "agents" in ${DECL(ID!)},
` +
      `    then scripts/set-estate-secrets.sh puts the secrets on the Workers.
` +
      `  NOTE: bootstrap-estate also mints a LOCAL relay and interactions key, which the kms-keys step above
` +
      `  replaces (441 D3 — no estate keeps a private key in a Worker secret). Keep its custody root; drop those two.`,
    done: () => !!decl.agents?.harness && !!decl.agents?.interactions,
  },
  {
    id: 'custody-of-the-harness-sa',
    kind: 'signer',
    title: `rotate the harness agent SA's custodian onto this estate's interactions-session key`,
    why: 'THE STEP THAT IS EASY TO MISS (441 §7.2): the harness agent SA\'s sole custodian IS the interactions key, so an estate whose key and custody disagree reverts the WHOLE redemption transaction and reports only "inner userOp reverted"',
    command: `RPC_URL=… CUSTODIAN_PRIVATE_KEY=… npx tsx scripts/rotate-custodian.mts --agent ${decl.agents?.harness ?? '0x<harness sa>'} --add 0x<the interactions key address> --remove 0x<whatever chartered it>`,
    // VERIFIED ON CHAIN, because this is the step whose omission says nothing useful. The live Home reports
    // which key its runtime signs with; the account says who may sign for it. They must be the same address.
    done: async () => {
      try {
        const sa = decl.agents?.harness;
        if (!sa) return false;
        const r = await fetch(`https://${decl.homeHost}/a2a/agent/interactions-session-key`);
        const key = ((await r.json()) as { address?: string }).address;
        if (!key) return false;
        const { createPublicClient, http, parseAbi } = await import('viem');
        const rpc = process.env.RPC_URL ?? process.env.FEDERATION_RPC_URL;
        if (!rpc) { info('set RPC_URL to let this step verify itself on chain'); return false; }
        const pc = createPublicClient({ transport: http(rpc) });
        return (await pc.readContract({ address: sa as `0x${string}`, abi: parseAbi(['function isCustodian(address) view returns (bool)']), functionName: 'isCustodian', args: [key as `0x${string}`] })) as boolean;
      } catch { return false; }
    },
  },
  {
    id: 'session-leaves',
    kind: 'auto',
    title: `re-issue every resident's DEL-001 session leaf under this estate's interactions key`,
    why: 'the leaf names the interactions key as its delegate, so a leaf issued under another key leaves the playbook unreadable — visible ONLY as plannerTrace.playbookUnreadable (441 §7.2)',
    command: `HOME_URL=https://${decl.homeHost} NEXT_PUBLIC_INTERACTIONS_SERVICE_SA=${decl.agents?.interactions ?? '0x…'} npx tsx scripts/reissue-interactions-grants.mts ${(decl.residents ?? ['<handle>']).join(' ')}`,
    // VERIFIED by asking the Home whether the first declared resident's grant is CURRENT — `current: false`
    // is exactly the state a stale leaf leaves behind. A real resident re-issues from their own Home, so this
    // check is only as complete as the demo roster; that is said rather than implied.
    done: async () => {
      const who = decl.residents?.[0];
      if (!who) { info('no `residents` in the declaration, so nothing here can be checked — each resident re-issues from their own Home'); return false; }
      try {
        const si = await (await fetch(`https://${decl.homeHost}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: who, client_id: 'demo-jp' }) })).json() as { agent?: string; homeSession?: string };
        if (!si.agent || !si.homeSession) return false;
        const st = await (await fetch(`https://${decl.homeHost}/a2a/interactions/${si.agent.toLowerCase()}/status`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `https://${decl.homeHost}` }, body: JSON.stringify({ session: si.homeSession }) })).json() as { current?: boolean };
        return st.current === true;
      } catch { return false; }
    },
  },
  {
    id: 'shape',
    kind: 'auto',
    title: 'check:estate-shape agrees this is the same estate as every other',
    why: 'the gate is the definition: an estate that passes it is one shape with the others, and one that does not is drift with a reason attached',
    done: () => { try { execFileSync('npx', ['tsx', 'scripts/check-estate-shape.mts', ID!, '--no-secrets'], { stdio: 'ignore' }); return true; } catch { return false; } },
    run: () => { console.log(execFileSync('npx', ['tsx', 'scripts/check-estate-shape.mts', ID!], { encoding: 'utf8' })); },
  },
];

// ── run it ────────────────────────────────────────────────────────────────────────────────────────────
console.log(`${label(`estate ${ID}`)}  home https://${decl.homeHost} · zone ${decl.zone} · town ${decl.town} · KMS tenant ${tenant}`);
if (decl.agents?.harness) console.log(`  harness ${decl.agents.harness} · interactions ${decl.agents.interactions ?? '—'}`);
console.log();

let stopped = false;
for (const [i, st] of steps.entries()) {
  if (ONLY && st.id !== ONLY) continue;
  const n = `${i + 1}/${steps.length}`;
  let already = false;
  try { already = await st.done(); } catch { already = false; }
  if (already) { console.log(`\x1b[32m✓\x1b[0m ${n} ${st.id} — ${st.title}`); continue; }
  if (stopped) { console.log(`\x1b[90m·\x1b[0m ${n} ${st.id} — ${st.title}`); continue; }

  const runnable = st.run && (st.kind !== 'operator' || azAvailable());
  if (!RUN || !runnable) {
    console.log(`\x1b[33m→\x1b[0m ${n} ${st.id} \x1b[1m[${st.kind}]\x1b[0m — ${st.title}`);
    if (st.why) info(`WHY: ${st.why}`);
    if (st.command) info(`RUN: ${st.command}`);
    if (RUN && st.kind === 'operator' && !azAvailable()) info('(`az account show` fails here, so this one is yours to run as the operator)');
    stopped = true;
    continue;
  }
  console.log(`\x1b[36m▸\x1b[0m ${n} ${st.id} — ${st.title}`);
  try { await st.run!(); } catch (e) { console.error(`  ✗ ${st.id} failed: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); }
}

console.log();
if (stopped) console.log(`${label('stopped at the first step that is not mine to run.')} Do it, then run this again — every step is idempotent.`);
else console.log(`${label(`estate ${ID} is built and matches the shape.`)} Deploy it: cd apps/vault && npx wrangler deploy --env ${ID} (then apps/agent-runtime).`);
