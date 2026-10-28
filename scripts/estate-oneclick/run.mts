#!/usr/bin/env -S npx tsx
// THE ONE-CLICK ESTATE BUILD — everything after "Approve", unattended.
//
// spec 441's builder (`scripts/estate-new.mts`) stops at two kinds of step because a human must decide them: OPERATOR
// steps on the KMS, and SIGNER steps that charter agents. The one-click flow moves that decision to ONE place — a town
// operator pressing Approve on the town's createestate site — and then runs every step, including those, as that
// decision. Nothing here charters an agent nobody decided to create: the request it builds is FETCHED from the site
// (signed), which returns one only for an estate a town operator approved — whatever the workflow was dispatched with.
//
// Two ways to host an estate (plan.mts):
//   HOSTED  --part all      one build in the town's GitHub, on the town's accounts
//   OWN     --part town     the town's GitHub: key vault tenant + caller tokens + chain token, sealed to the build key
//           --part estate   the OWNER's GitHub, on the owner's Cloudflare and Vercel: everything else
//           --part finish   the town's GitHub: the .estate name, the town listing, the naming gate
//
//   npx tsx scripts/estate-oneclick/run.mts --estate <id> [--request-id <req>] [--part all|town|estate|finish]
//   npx tsx scripts/estate-oneclick/run.mts --request request.json [--part …] --dry-run    (tests and local runs)
//
// Everything about the TOWN comes from towns/<town>.json (town.mts) — nothing here names faithnet.town.
//
// Resumable and idempotent like estate-new: progress is kept in `.estate-oneclick-<id>.json` (gitignored), a step
// that is done is skipped, and re-running the same request resumes where it stopped.
//
// It DRIVES the existing tools rather than restating them: bootstrap-estate.mts for the custody root and service
// agents; set-estate-secrets.sh for the secrets; rotate-custodian.mts for the harness agent's custody;
// add-estate-agent.mts for the estate agent; check-estate-shape.mts last. The key-vault ceremonies are kms.mts — the
// same commands estate-new runs, held to them by test/kms.test.mts.
//
// --dry-run runs every step against a RECORDING shell and HTTP client: files are written exactly as for real, cloud
// commands are recorded instead of run, and the plan they make is printed. It is how the build is tested.

import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes, createHash, generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { buildDeclaration, workerNames, type Hosts } from './declaration.mts';
import { stampEnvBlock, appendBlock, fillPlaceholders, TOML_PATHS, commonRuntimeKeys, type App } from './env-blocks.mts';
import { townRow, addEstateRow } from './town-row.mts';
import { sealForOwner, openSealedWith, keyFingerprint } from './custody.mts';
import { reporter, type StepState } from './progress.mts';
import { sealState, openState, fetchCheckpoint, fetchApproved, signedGet, signedPost } from './checkpoint.mts';
import { ID_RE, RESERVED_IDS } from './declaration.mts';
import { deriveVars, readDeclarations, wranglerVars } from '../estate-shape.mts';
import { loadTown } from './town.mts';
import { azArgs, ensureKeyVault, mintToken, type CvmRun } from './kms.mts';
import { ecSigner, parseBuildKey, type Signer } from './signer.mts';
import { stepsFor, type Hosting, type Part } from './plan.mts';

// ── inputs ──────────────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const DRY = argv.includes('--dry-run');
const ONLY = arg('only');
const PART = (arg('part') ?? 'all') as Part;
if (!['all', 'town', 'estate', 'finish'].includes(PART)) { console.error(`--part must be all, town, estate or finish (not "${PART}")`); process.exit(2); }
const TOWN = loadTown();
const SITE = process.env.CREATE_ESTATE_SITE || (DRY ? undefined : TOWN.site);
const CALLBACK = process.env.BUILD_CALLBACK_SECRET;

// The owner's build signs with its BUILD KEY (made in the owner's browser, kept in their GitHub secret); the town's
// parts sign with the town's shared callback secret.
const BUILD_KEY = PART === 'estate' ? parseBuildKey(process.env.ESTATE_BUILD_KEY ?? '') : undefined;
const AUTH: string | Signer | undefined = BUILD_KEY ? await ecSigner(BUILD_KEY.sig) : CALLBACK;

type Result = { homeOrigin: string; hosts: Record<string, string>; agents: Record<string, string> };
type Request = {
  requestId: string; id: string; name: string; requestedBy: string; ownerKey: JsonWebKey;
  hosting: Hosting; repo?: string; workersSubdomain?: string; buildKey?: { enc: JsonWebKey; sig: JsonWebKey };
  /** Finish only: what the owner's build reported at its handover. */
  result?: Result;
  /** Set once the town has delivered the sealed town package. */
  townPackage?: { gatewayTokenHash?: string } | null;
};

async function loadRequest(): Promise<Request> {
  const file = arg('request');
  if (file) { const r = JSON.parse(readFileSync(file, 'utf8')) as Request; return { ...r, hosting: r.hosting ?? 'town' }; }
  const id = arg('estate');
  const requestId = arg('request-id');
  if (!id || !SITE || !AUTH) {
    console.error('--estate <id> [--request-id <req>], with the site and a signing key (BUILD_CALLBACK_SECRET, or ESTATE_BUILD_KEY for --part estate) — or --request <file>');
    process.exit(2);
  }
  if (!ID_RE.test(id)) { console.error(`"${id}" is not an estate id`); process.exit(2); }
  const a = await fetchApproved(SITE, id, AUTH) as unknown as Request & { approvedBy: { name: string; address: string }; estateName?: string };
  if (a.id !== id || (requestId && a.requestId !== requestId)) throw new Error(`the site's approved request is ${a.id}/${a.requestId}, not ${id}/${requestId}`);
  console.log(`approved by ${a.approvedBy.name} (${a.approvedBy.address})`);
  if (a.estateName && a.estateName !== `${a.id}.${TOWN.estateNameRoot}`) throw new Error(`the site's estate name ${a.estateName} does not match its short name ${a.id}`);
  return { ...a, hosting: a.hosting ?? 'town' };
}

const request = await loadRequest();
// Checked BEFORE anything uses it: the id becomes file names, Worker and Vercel names, and words in a script run on the
// KMS machine. A request that is not exactly this shape is not built.
const die = (msg: string): never => { console.error(msg); process.exit(2); };
if (!ID_RE.test(request.id) || RESERVED_IDS.has(request.id)) die(`"${request.id}" is not a usable estate id`);
if (!/^0x[0-9a-f]{40}$/.test(String(request.requestedBy))) die('requestedBy must be a lowercased Smart Agent address');
if (!/^req_[A-Za-z0-9]{6,40}$/.test(String(request.requestId))) die('requestId is malformed');
if (request.ownerKey?.kty !== 'RSA' || !request.ownerKey.n || (request.ownerKey as { d?: string }).d) die('ownerKey must be an RSA public key');
const OWN = request.hosting === 'own';
if (!['town', 'own'].includes(request.hosting)) die(`hosting must be town or own, not ${request.hosting}`);
if (OWN && PART === 'all') die('this estate is on its owner\'s own accounts: run --part town, estate or finish');
if (!OWN && PART !== 'all') die('this estate is hosted by the town: run --part all');
if (OWN) {
  if (!/^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(String(request.repo))) die('repo must be owner/name');
  if (!/^[a-z0-9-]{1,63}$/.test(String(request.workersSubdomain))) die('workersSubdomain must be a workers.dev subdomain');
  const bk = request.buildKey;
  if (bk?.enc?.kty !== 'RSA' || (bk.enc as { d?: string }).d || bk?.sig?.kty !== 'EC' || (bk.sig as { d?: string }).d) die('buildKey must be the two PUBLIC halves');
}
if (BUILD_KEY) {
  // The key in this GitHub must be the one the owner made for THIS estate.
  const same = (await keyFingerprint(BUILD_KEY.enc)) === (await keyFingerprint(request.buildKey!.enc)) && BUILD_KEY.sig.x === request.buildKey!.sig.x && BUILD_KEY.sig.y === request.buildKey!.sig.y;
  if (!same) die(`ESTATE_BUILD_KEY is not the build key of ${request.id} — paste ${request.id}-build-key.json from when you created it`);
}

const env = (k: string, required = !DRY): string => {
  const v = process.env[k] ?? '';
  if (!v && required) throw new Error(`${k} is not set — see oneclick/README.md "One-time setup"`);
  return v;
};

const AP_TOWN = process.env.AP_TOWN_DIR || '../ap-town';
const STATE_FILE = PART === 'all' || PART === 'estate' ? `.estate-oneclick-${request.id}.json` : `.estate-oneclick-${request.id}-${PART}.json`;
const LOCAL = `.estate-${request.id}.local`;
const GATEWAY = process.env.CHAIN_GATEWAY_URL || TOWN.chain.gateway;
const WORKERS_SUBDOMAIN = OWN ? request.workersSubdomain! : (process.env.WORKERS_SUBDOMAIN || TOWN.hosted.workersSubdomain);
const REPO = OWN ? request.repo! : (process.env.AP_HOME_REPO || TOWN.hosted.repo);

// ── the shell and HTTP the steps use: real, or recording ────────────────────────────────────────────────────
export interface Ctx {
  sh: (cmd: string, args: string[], o?: { cwd?: string; input?: string; env?: Record<string, string>; secret?: boolean }) => string;
  http: (url: string, init?: RequestInit) => Promise<{ status: number; ok?: boolean; json: () => Promise<any> }>;
  recorded: string[];
}

const fakeUuid = (seed: string) => { const h = createHash('sha256').update(seed).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`; };
const fakeAddr = (seed: string) => `0x${createHash('sha256').update(seed).digest('hex').slice(0, 40)}`;

function makeCtx(): Ctx {
  const recorded: string[] = [];
  if (!DRY) {
    return {
      recorded,
      sh: (cmd, args, o = {}) => execFileSync(cmd, args, { cwd: o.cwd, input: o.input, env: { ...process.env, ...(o.env ?? {}) }, encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['pipe', 'pipe', o.secret ? 'pipe' : 'inherit'] }),
      http: async (url, init) => { const r = await fetch(url, init); return { status: r.status, ok: r.ok, json: () => r.json() }; },
    };
  }
  // A key custody that remembers what the dry run created, so a re-status sees it.
  const kms = { tenant: false, callers: new Set<string>(), keys: {} as Record<string, string> };
  const cvmOut = (s: string) => `Enable succeeded: \n[stdout]\n${s}\n\n[stderr]\n`;
  return {
    recorded,
    sh: (cmd, args, o = {}) => {
      const line = `${o.cwd ? `(cd ${o.cwd}) ` : ''}${cmd} ${args.join(' ')}${o.input !== undefined ? '  <<< [stdin]' : ''}`;
      recorded.push(line);
      const joined = args.join(' ');
      if (cmd === 'az') {
        const script = args[args.indexOf('--scripts') + 1] ?? '';
        if (/ status 2>/.test(script)) return cvmOut(`KMS ${JSON.stringify({ tenant: kms.tenant, callers: [...kms.callers], keys: kms.keys })}`);
        if (script.includes('create-tenant')) kms.tenant = true;
        for (const m of script.matchAll(/bind-caller .*?--subject (\S+)/g)) kms.callers.add(m[1]);
        if (script.includes('create-key')) {
          kms.keys[`${request.id}-relay`] = fakeUuid('relay');
          kms.keys[`${request.id}-interactions-session`] = fakeUuid('interactions');
          return cvmOut(`relay ${fakeUuid('relay')}\ninteractions-session ${fakeUuid('interactions')}`);
        }
        if (script.includes('mint-token')) return cvmOut('eyJhbGciOiJkcnkifQ.e30.dry');
        return cvmOut('');
      }
      if (cmd === 'npx' && joined.includes('d1 create')) return `{"uuid": "${fakeUuid(joined)}"}\n database_id = "${fakeUuid(joined)}"`;
      if (cmd === 'npx' && joined.includes('kv namespace create')) return `id = "${createHash('sha256').update(joined).digest('hex').slice(0, 32)}"`;
      if (cmd === 'npx' && joined.includes('bootstrap-estate.mts')) {
        writeFileSync(LOCAL, [`ESTATE=${request.id}`, `RPC_URL=${GATEWAY}/?k=dry`, `A2A_MASTER_PRIVATE_KEY=0x${'1'.repeat(64)}`, `A2A_INTERACTIONS_SESSION_PRIVATE_KEY=0x${'2'.repeat(64)}`, `A2A_CUSTODY_ROOT_KEY=0x${'3'.repeat(64)}`, `INTERACTIONS_SERVICE_SA=${fakeAddr('i' + request.id)}`, `HARNESS_AGENT_SA=${fakeAddr('h' + request.id)}`].join('\n') + '\n', { mode: 0o600 });
      }
      if (cmd === 'npx' && joined.includes('add-estate-agent.mts')) return `estate:        ${request.id}\nestate agent:  ${fakeAddr('estate' + request.id)}   (salt 2 over the estate's interactions key)\n`;
      if (cmd === 'git' && joined.startsWith('diff --name-only')) return OWN ? '' : 'apps/town-agent/wrangler.toml\napps/registry/wrangler.toml\n';
      return '';
    },
    http: async (url, init) => {
      recorded.push(`HTTP ${init?.method ?? 'GET'} ${url}`);
      // The Home's settings: their NAMES and types only, never a value.
      if (url.includes('api.vercel.com') && url.includes('/env')) recorded.push(`  home env: ${JSON.parse(String(init?.body ?? '[]')).map((e: { key: string; type: string }) => `${e.key}(${e.type})`).join(' ')}`);
      if (url.includes('api.vercel.com') && url.includes('/projects') && init?.method === 'POST') return { status: 200, json: async () => ({ id: 'prj_dry', name: workerNames(request.id).home }) };
      if (url.includes('api.vercel.com') && url.includes('/domains')) return { status: 200, json: async () => ({ domains: [{ name: `${workerNames(request.id).home}.vercel.app` }] }) };
      if (url.includes('api.vercel.com') && url.includes('/deployments') && init?.method === 'POST') return { status: 200, json: async () => ({ id: 'dpl_dry', readyState: 'READY' }) };
      if (url.includes('api.vercel.com') && url.includes('/deployments/')) return { status: 200, json: async () => ({ readyState: 'READY' }) };
      if (url.includes('api.upstash.com')) return { status: 200, json: async () => ({ database_id: 'db_dry', endpoint: 'dry.upstash.io', rest_token: 'dry' }) };
      if (url.includes('interactions-session-key')) return { status: 200, json: async () => ({ address: fakeAddr('kms-interactions' + request.id) }) };
      return { status: 200, json: async () => ({}) };
    },
  };
}

// ── state ───────────────────────────────────────────────────────────────────────────────────────────────────
type State = { done: string[]; homeHost?: string; vercelProjectId?: string; gatewayTokenHash?: string; nameRegistered?: boolean; notes: string[]; operatorNotes: string[] };
const state: State = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : { done: [], notes: [], operatorNotes: [] };
const save = () => writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);

const DECL = `estates/${request.id}.estate.json`;
const decl = (): any => JSON.parse(readFileSync(DECL, 'utf8'));
const writeDecl = (d: unknown) => writeFileSync(DECL, `${JSON.stringify(d, null, 2)}\n`);
const names = workerNames(request.id);
const localVars = (): Record<string, string> => Object.fromEntries(readFileSync(LOCAL, 'utf8').split('\n').filter((l) => /^[A-Z_0-9]+=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^'(.*)'$/, '$1')]; }));
const ctx = makeCtx();
const wrangler = (args: string[], o: Parameters<Ctx['sh']>[2] = {}) => ctx.sh('npx', ['-y', 'wrangler', ...args], o);
const putSecret = (app: App, name: string, value: string) => wrangler(['secret', 'put', name, '--env', request.id, '-c', TOML_PATHS[app]], { input: value, secret: true });
/** One script on the town's key-custody CVM. */
const cvm: CvmRun = (script, o) => ctx.sh('az', azArgs(TOWN.kms, script), { secret: o?.secret });

/** Set (or replace) one var in this estate's [env.<id>.vars] of a wrangler.toml. */
function setVar(app: App, key: string, value: string) {
  const path = TOML_PATHS[app];
  const s = readFileSync(path, 'utf8');
  const head = `[env.${request.id}.vars]`;
  const at = s.indexOf(head);
  if (at < 0) throw new Error(`no ${head} in ${path}`);
  const end = s.indexOf('\n[', at + head.length);
  const block = s.slice(at, end < 0 ? undefined : end);
  const line = `${key} = "${value}"`;
  const re = new RegExp(`^${key}\\s*=.*$`, 'm');
  const next = re.test(block) ? block.replace(re, line) : block.replace(head, `${head}\n${line}`);
  writeFileSync(path, s.slice(0, at) + next + (end < 0 ? '' : s.slice(end)));
}

/** A resumed build finds what an earlier attempt created instead of failing on "already exists". */
function existingD1(name: string): string | null {
  if (DRY) return null;
  try {
    const list = JSON.parse(wrangler(['d1', 'list', '--json'])) as Array<{ name: string; uuid: string }>;
    const hit = list.find((d) => d.name === name);
    return hit ? hit.uuid : null;
  } catch { return null; }
}
/** A KV namespace's title: `<worker>-<binding, kebab-case>` (`grace-chapel-runtime-bridge-nonces`) — the Worker is in it,
 *  so two Workers with the same binding name never share a namespace. Created WITHOUT --env, because wrangler 4 titles
 *  an env namespace `<env>-<BINDING>`, which has no Worker in it. */
const kvTitle = (app: App, binding: string) => `${names[app]}-${binding.toLowerCase().replace(/_/g, '-')}`;
function existingKv(app: App, binding: string): string | null {
  if (DRY) return null;
  try {
    const list = JSON.parse(wrangler(['kv', 'namespace', 'list'])) as Array<{ id: string; title: string }>;
    const hit = list.find((k) => k.title === kvTitle(app, binding));
    return hit ? `id = "${hit.id}"` : null;
  } catch { return null; }
}

/** Vercel's API, on the town's team (hosted) or on the owner's own account — a team only if they name one. */
const vercel = (path: string, init?: RequestInit) => {
  const team = env('VERCEL_TEAM_ID', !DRY && !OWN);
  const url = `https://api.vercel.com${path}${team ? `${path.includes('?') ? '&' : '?'}teamId=${team}` : ''}`;
  return ctx.http(url, { ...init, headers: { authorization: `Bearer ${env('VERCEL_TOKEN')}`, 'content-type': 'application/json', ...(init?.headers ?? {}) } });
};

/**
 * A chain token for this estate in the town's chain gateway (its TOKENS KV). The token is returned and held in memory;
 * only its hash is ever written down. A token minted by an earlier attempt that never reached bootstrap is revoked.
 */
function mintChainToken(previousHash?: string): { token: string; hash: string } {
  const gw = join(AP_TOWN, TOWN.chainGateway.dir);
  if (previousHash) {
    try { wrangler(['kv', 'key', 'delete', '--binding', 'TOKENS', '--env', TOWN.chainGateway.env, '--remote', `t:${previousHash}`], { cwd: gw }); } catch { /* already gone */ }
  }
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  wrangler(['kv', 'key', 'put', '--binding', 'TOKENS', '--env', TOWN.chainGateway.env, '--remote', `t:${hash}`, JSON.stringify({ app: `${request.id}-runtime`, readRps: 20, writeRps: 20 })], { cwd: gw });
  return { token, hash };
}

/** The town package (OWN, estate part): the key vault's ids and tokens and a chain token, opened with the build key. */
type TownPackage = { v: 1; estate: string; relayKeyId: string; interactionsKeyId: string; vaultToken: string; runtimeToken: string; chainToken: string; chainId: number; gateway: string };
let townPackage: TownPackage | undefined;
const pkg = (): TownPackage => { if (!townPackage) throw new Error('the town has not delivered this estate\'s key vault access yet'); return townPackage; };

/** The facts of an OWN estate, as its owner's build reported them — checked before they go into the town manifest. */
function reportedResult(): Result {
  const r = request.result;
  if (!r) throw new Error('the owner\'s build has not finished — nothing to list yet');
  const sub = WORKERS_SUBDOMAIN.replace(/[.]/g, '\\.');
  const want: Record<string, RegExp> = {
    runtime: new RegExp(`^https://${request.id}-runtime\\.${sub}\\.workers\\.dev$`), vault: new RegExp(`^https://${request.id}-vault\\.${sub}\\.workers\\.dev$`),
    edge: new RegExp(`^https://${request.id}-edge\\.${sub}\\.workers\\.dev$`), homeMcp: new RegExp(`^https://${request.id}-home-mcp\\.${sub}\\.workers\\.dev$`),
  };
  for (const [k, re] of Object.entries(want)) if (!re.test(String(r.hosts?.[k]))) throw new Error(`the reported ${k} host is not this estate's: ${String(r.hosts?.[k]).slice(0, 80)}`);
  if (!/^https:\/\/[a-z0-9-]{1,63}\.vercel\.app$/.test(String(r.homeOrigin))) throw new Error('the reported Home is not a vercel.app address');
  for (const a of Object.values(r.agents ?? {})) if (!/^0x[0-9a-f]{40}$/.test(String(a))) throw new Error('a reported agent is not an address');
  return r;
}

// ── the steps (ids: plan.mts — the site shows them) ─────────────────────────────────────────────────────────
type Step = { title: string; run: () => Promise<StepState | void> };

/** The chain token lives only in this variable until bootstrap seals it into the custody file. Never in process.env. */
let chainToken: string | undefined;

const steps: Record<string, Step> = {
  'town-access': {
    title: 'Open its key vault and its chain access (the town)',
    run: async () => {
      if (request.townPackage) return 'done'; // delivered already; the owner's build has it
      const ids = ensureKeyVault(cvm, TOWN.kms, request.id);
      const vaultToken = mintToken(cvm, TOWN.kms, request.id, `${request.id}-vault`);
      const runtimeToken = mintToken(cvm, TOWN.kms, request.id, `${request.id}-runtime`);
      const chain = mintChainToken();
      try {
        const p: TownPackage = { v: 1, estate: request.id, relayKeyId: ids.relay, interactionsKeyId: ids.interactions, vaultToken, runtimeToken, chainToken: chain.token, chainId: TOWN.chain.id, gateway: GATEWAY };
        // Sealed to the estate's BUILD key: the site stores it and cannot read it; only the owner's build opens it.
        const sealed = await sealForOwner(JSON.stringify(p), request.buildKey!.enc);
        if (!SITE || !AUTH) return 'done';
        const res = await signedPost(SITE, `/api/estates/${request.id}/town-package`, JSON.stringify({ sealed, gatewayTokenHash: chain.hash }), AUTH);
        if (!res.ok) throw new Error(`the site would not take the town package (${res.status})`);
      } catch (e) {
        // Nobody will ever hold this chain token: revoke it, so a retry does not leave a live one behind.
        try { wrangler(['kv', 'key', 'delete', '--binding', 'TOKENS', '--env', TOWN.chainGateway.env, '--remote', `t:${chain.hash}`], { cwd: join(AP_TOWN, TOWN.chainGateway.dir) }); } catch { /* already gone */ }
        throw e;
      }
    },
  },
  'home-address': {
    title: 'Reserve its Home\'s address',
    run: async () => {
      // The Home's host is the passkey rpId and cannot change later, so it is read from what Vercel ASSIGNED, never assumed.
      const r = await vercel('/v10/projects', { method: 'POST', body: JSON.stringify({ name: names.home, framework: 'nextjs', rootDirectory: 'apps/home', gitRepository: { type: 'github', repo: REPO } }) });
      const p = await r.json();
      if (r.status >= 300 && !(r.status === 409)) throw new Error(`Vercel refused the project: ${JSON.stringify(p).slice(0, 200)}`);
      state.vercelProjectId = p.id ?? names.home;
      const d = await (await vercel(`/v9/projects/${state.vercelProjectId}/domains`)).json();
      const host = (d.domains ?? []).map((x: any) => x.name).find((n: string) => n.endsWith('.vercel.app'));
      if (!host) throw new Error('Vercel assigned the project no .vercel.app host');
      state.homeHost = host;
    },
  },
  declare: {
    title: 'Write its declaration',
    run: async () => {
      for (const d of readDeclarations()) {
        if (d.id === request.id) return 'done';
        if (d.homeHost === state.homeHost) throw new Error(`${d.id} already answers at ${state.homeHost}`);
      }
      writeDecl(buildDeclaration({ name: request.name, id: request.id, requestedBy: request.requestedBy, workersSubdomain: WORKERS_SUBDOMAIN, homeHost: state.homeHost, town: TOWN.town, createdBy: new URL(TOWN.site).host }));
    },
  },
  'workers-config': {
    title: 'Prepare its four services',
    run: async () => {
      const d = decl();
      const extras = Object.keys(JSON.parse(readFileSync(TOWN.sibling.declaration, 'utf8')).extras ?? {});
      const common = commonRuntimeKeys();
      for (const app of Object.keys(TOML_PATHS) as App[]) {
        const path = TOML_PATHS[app];
        const toml = readFileSync(path, 'utf8');
        if (toml.includes(`[env.${request.id}]`)) continue;
        const r = stampEnvBlock(toml, { id: request.id, app, names, hosts: d.hosts as Hosts, homeOrigin: `https://${d.homeHost}`, derived: deriveVars(d), siblingExtras: extras, commonRuntimeKeys: common, extras: d.extras, sibling: TOWN.sibling, crossAccount: OWN });
        writeFileSync(path, appendBlock(toml, r.block));
        state.notes.push(...r.dropped.filter((x) => x.startsWith('REVIEW')).map((x) => `${app}: ${x}`));
        if (OWN) state.notes.push(...r.dropped.filter((x) => x.includes('another Cloudflare account')).map((x) => `${app}: ${x.replace(/^\[[^\]]+\] /, '')} — off until the town offers it over the internet`));
      }
    },
  },
  'cloud-resources': {
    title: 'Create its databases and storage',
    run: async () => {
      for (const app of Object.keys(TOML_PATHS) as App[]) {
        const path = TOML_PATHS[app];
        let toml = readFileSync(path, 'utf8');
        const ids: Record<string, string> = {};
        for (const m of toml.matchAll(/database_name\s*=\s*"([^"]+)"\s*\n\s*database_id\s*=\s*"(__D1_[A-Z_0-9]+__)"/g)) {
          const out = existingD1(m[1]) ?? wrangler(['d1', 'create', m[1]]);
          const uuid = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(out)?.[1];
          if (!uuid) throw new Error(`could not read the id of D1 ${m[1]}`);
          ids[m[2]] = uuid;
        }
        for (const m of toml.matchAll(/binding\s*=\s*"([^"]+)"\s*\n\s*id\s*=\s*"(__KV_[A-Z_0-9]+__)"/g)) {
          const out = existingKv(app, m[1]) ?? wrangler(['kv', 'namespace', 'create', kvTitle(app, m[1]), '-c', path]);
          const id = /id\s*=\s*"?([0-9a-f]{32})"?/.exec(out)?.[1];
          if (!id) throw new Error(`could not read the id of KV ${m[1]}`);
          ids[m[2]] = id;
        }
        if (Object.keys(ids).length) { toml = fillPlaceholders(toml, ids); writeFileSync(path, toml); }
        for (const q of new Set([...toml.matchAll(/queue\s*=\s*"([^"]*)"/g)].map((m) => m[1]).filter((q) => q.endsWith(`-${request.id}`)))) {
          try { wrangler(['queues', 'create', q]); } catch (e) { if (!/already exists/i.test(String(e))) throw e; }
        }
      }
    },
  },
  'key-vault': {
    title: 'Open its own key vault',
    run: async () => {
      // HOSTED: the town's own build runs the ceremonies (kms.mts). OWN: the town already ran them (town-access) and
      // sealed the results to this build. Either way the two key ids go into the runtime's vars, and each Worker gets
      // ITS OWN caller token — read into memory and piped straight into `wrangler secret put`, never printed.
      let ids: { relay: string; interactions: string };
      let tokens: { vault: string; runtime: string };
      if (OWN) {
        const p = pkg();
        ids = { relay: p.relayKeyId, interactions: p.interactionsKeyId };
        tokens = { vault: p.vaultToken, runtime: p.runtimeToken };
      } else {
        ids = ensureKeyVault(cvm, TOWN.kms, request.id);
        tokens = { vault: mintToken(cvm, TOWN.kms, request.id, `${request.id}-vault`), runtime: mintToken(cvm, TOWN.kms, request.id, `${request.id}-runtime`) };
      }
      setVar('runtime', 'AKCS_RELAY_KEY_ID', ids.relay);
      setVar('runtime', 'AKCS_INTERACTIONS_KEY_ID', ids.interactions);
      const rv = wranglerVars(TOML_PATHS.runtime, request.id);
      if (rv.AKCS_RELAY_KEY_ID !== ids.relay || rv.AKCS_INTERACTIONS_KEY_ID !== ids.interactions) throw new Error('the key ids did not land in the runtime\'s settings');
      putSecret('vault', 'AKCS_TOKEN', tokens.vault);
      putSecret('runtime', 'AKCS_TOKEN', tokens.runtime);
    },
  },
  'chain-access': {
    title: `Give it access to ${TOWN.chain.name}`,
    run: async () => {
      if (existsSync(LOCAL)) return 'done';
      if (OWN) { chainToken = pkg().chainToken; return; }
      const t = mintChainToken(state.gatewayTokenHash);
      state.gatewayTokenHash = t.hash; // the hash only — the token is held in memory for the next step and sealed by it
      chainToken = t.token;
    },
  },
  agents: {
    title: `Create its own agents on ${TOWN.chain.name}`,
    run: async () => {
      if (!existsSync(LOCAL)) {
        if (!chainToken && !DRY) throw new Error('no chain token — re-run from chain-access');
        ctx.sh('npx', ['tsx', 'scripts/bootstrap-estate.mts', '--estate', request.id], { env: { CHAIN_APP_TOKEN: chainToken ?? 'dry' } });
        // THE MOMENT THE CUSTODY ROOT EXISTS, it is checkpointed — before anything else in this step can fail, and the
        // build stops if the site does not confirm it. A runner thrown away now would otherwise take the only copy.
        await mustCheckpoint('agents');
      }
      chmodSync(LOCAL, 0o600);
      // THE HOME'S SIGNING KEY. bootstrap-estate does not make one, and the Home throws without it
      // (apps/home/server/_lib/server-broker.ts). Same shape as scripts/gen-dev-vars.ts: an ES256 P-256 private JWK.
      // Kept in the custody file, single-quoted (runbook §2 ⚠), and checkpointed, so a resumed build installs the SAME
      // key: a new one would void every id_token the Home has already signed.
      if (!localVars().BROKER_PRIVATE_JWK) {
        const kid = `${request.id}-broker-1`;
        const jwk = { ...(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' })), alg: 'ES256', use: 'sig', kid };
        writeFileSync(LOCAL, `${readFileSync(LOCAL, 'utf8').replace(/\n?$/, '\n')}# the Home signs its id_tokens with this (ES256)\nBROKER_PRIVATE_JWK='${JSON.stringify(jwk)}'\nBROKER_KID=${kid}\n`, { mode: 0o600 });
        await mustCheckpoint('agents');
      }
      const v = localVars();
      if (!/^0x[0-9a-fA-F]{40}$/.test(v.HARNESS_AGENT_SA ?? '') || !/^0x[0-9a-fA-F]{40}$/.test(v.INTERACTIONS_SERVICE_SA ?? '')) throw new Error('bootstrap-estate wrote no service agents');
      const d = decl();
      d.agents = { harness: v.HARNESS_AGENT_SA, interactions: v.INTERACTIONS_SERVICE_SA };
      writeDecl(d);
      setVar('runtime', 'HARNESS_AGENT_SA', v.HARNESS_AGENT_SA);
      setVar('runtime', 'INTERACTIONS_SERVICE_SA', v.INTERACTIONS_SERVICE_SA);
    },
  },
  secrets: {
    title: 'Install its secrets',
    run: async () => {
      // bootstrap-estate also mints a LOCAL relay and interactions key, which the key vault's keys replace (441 D3 —
      // check:estate-shape names them as FORBIDDEN secrets). They stay in the sealed file; they are never installed.
      const full = readFileSync(LOCAL, 'utf8');
      const forbidden = /^(A2A_MASTER_PRIVATE_KEY|A2A_INTERACTIONS_SESSION_PRIVATE_KEY)=.*$/gm;
      try {
        writeFileSync(LOCAL, full.replace(forbidden, ''), { mode: 0o600 });
        ctx.sh('bash', ['scripts/set-estate-secrets.sh', request.id]);
      } finally {
        writeFileSync(LOCAL, full, { mode: 0o600 });
      }
      // The model keys. HOSTED: the town's. OWN: the owner's own model key; the town's model gateway is optional
      // (the runtime uses it only when ORCHESTRATION_GATEWAY is on AND it has an app key).
      const gemini = env('GEMINI_API_KEY', !DRY && !OWN);
      if (gemini) putSecret('runtime', 'GEMINI_API_KEY', gemini);
      else if (OWN) state.notes.push('No model key: add an ESTATE_GEMINI_API_KEY secret to your GitHub and re-run, or set it on the runtime yourself — until then its agents cannot answer in words.');
      const inference = env('INFERENCE_APP_KEY', !DRY && !OWN);
      if (inference) putSecret('runtime', 'INFERENCE_APP_KEY', inference);
      putSecret('runtime', 'A2A_INTERNAL_MARKER', randomBytes(24).toString('base64url'));
      // Kept with the estate's other secrets (so a resumed build installs the SAME one, and the owner has it).
      let heartbeat = localVars().TOWN_HEARTBEAT_TOKEN;
      if (!heartbeat) {
        heartbeat = randomBytes(24).toString('base64url');
        writeFileSync(LOCAL, `${readFileSync(LOCAL, 'utf8').replace(/\n?$/, '\n')}# the town's Pulse reads this estate's heartbeat with it\nTOWN_HEARTBEAT_TOKEN=${heartbeat}\n`, { mode: 0o600 });
      }
      putSecret('runtime', 'TOWN_HEARTBEAT_TOKEN', heartbeat);
    },
  },
  deploy: {
    title: 'Deploy its services',
    run: async () => {
      // Dependencies were installed by the workflow BEFORE any secret was in the environment, never here.
      wrangler(['deploy', '--env', request.id, '-c', TOML_PATHS.vault]);
      const vaultDb = /database_name\s*=\s*"([^"]+)"/.exec(readFileSync(TOML_PATHS.vault, 'utf8').split(`[env.${request.id}`)[1] ?? '')?.[1];
      if (vaultDb) wrangler(['d1', 'migrations', 'apply', vaultDb, '--remote', '--env', request.id, '-c', TOML_PATHS.vault]);
      for (const app of ['runtime', 'edge', 'homeMcp'] as App[]) wrangler(['deploy', '--env', request.id, '-c', TOML_PATHS[app]]);
    },
  },
  custody: {
    title: 'Hand its working agent to its own key',
    run: async () => {
      // 441 §7.2: the harness agent's custodian must BE the interactions key the runtime signs with — the key-vault
      // key, not the local one bootstrap chartered it under. Read the live key from the runtime and rotate onto it.
      const d = decl();
      const r = await ctx.http(`${d.hosts.runtime}/a2a/agent/interactions-session-key`);
      const kmsKey = String((await r.json()).address ?? '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(kmsKey)) throw new Error('the runtime did not report its interactions key — is it deployed?');
      const v = localVars();
      const localKey = DRY ? fakeAddr('local-interactions') : execFileSync('npx', ['tsx', '-e', `import { privateKeyToAccount } from 'viem/accounts'; console.log(privateKeyToAccount(process.env.K).address)`], { env: { ...process.env, K: v.A2A_INTERACTIONS_SESSION_PRIVATE_KEY }, encoding: 'utf8' }).trim().toLowerCase();
      if (kmsKey === localKey) return 'done';
      ctx.sh('npx', ['tsx', 'scripts/rotate-custodian.mts', '--agent', d.agents.harness, '--add', kmsKey, '--remove', localKey], { env: { RPC_URL: v.RPC_URL, RELAY_PRIVATE_KEY: v.A2A_MASTER_PRIVATE_KEY, CUSTODIAN_PRIVATE_KEY: v.A2A_INTERACTIONS_SESSION_PRIVATE_KEY }, secret: true });
    },
  },
  home: {
    title: 'Launch its Home',
    run: async () => {
      const d = decl();
      const v = localVars();
      const home = `https://${d.homeHost}`;
      // Its OWN, EMPTY key-value store (runbook §5 ⚠: a shared store opens the wrong Home).
      const up = await ctx.http('https://api.upstash.com/v2/redis/database', { method: 'POST', headers: { authorization: `Basic ${Buffer.from(`${env('UPSTASH_EMAIL')}:${env('UPSTASH_API_KEY')}`).toString('base64')}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: `${request.id}-home`, platform: 'aws', primary_region: 'us-east-1', tls: true }) });
      const db = await up.json();
      if (!db.endpoint || !db.rest_token) throw new Error('Upstash did not create the Home\'s store');
      if (!v.BROKER_PRIVATE_JWK || !v.BROKER_KID) throw new Error('the custody file has no Home signing key — re-run from agents');
      const sensitive: Record<string, string> = {
        KV_REST_API_URL: `https://${db.endpoint}`, KV_REST_API_TOKEN: db.rest_token,
        RPC_URL: v.RPC_URL, A2A_CUSTODY_URL: d.hosts.runtime, A2A_CUSTODY_BRIDGE_SECRET: v.A2A_CUSTODY_BRIDGE_SECRET ?? '',
        BROKER_PRIVATE_JWK: v.BROKER_PRIVATE_JWK, ...(v.DEMO_SIGNER_SECRET ? { DEMO_SIGNER_SECRET: v.DEMO_SIGNER_SECRET } : {}),
        DEMO_A2A_URL: d.hosts.runtime, DEMO_EDGE_URL: d.hosts.edge, A2A_VAULT_URL: d.hosts.vault,
      };
      const plain: Record<string, string> = {
        BROKER_KID: v.BROKER_KID,
        NEXT_PUBLIC_HOME_ORIGIN: home, NEXT_PUBLIC_CONNECT_DOMAIN: d.homeHost, NEXT_PUBLIC_BRAND_NAME: d.name, NEXT_PUBLIC_ESTATE_NAME: d.name,
        NEXT_PUBLIC_CHAIN_ID: String(TOWN.chain.id), NEXT_PUBLIC_CHAIN_NAME: TOWN.chain.name, NEXT_PUBLIC_RPC_URL: `${d.hosts.runtime}/rpc`,
        NEXT_PUBLIC_A2A_DOMAIN: new URL(d.hosts.runtime).host, NEXT_PUBLIC_DEMO_EDGE_ORIGIN: d.hosts.edge, NEXT_PUBLIC_HOME_MCP_ORIGIN: d.hosts.homeMcp,
        NEXT_PUBLIC_INTERACTIONS_SERVICE_SA: d.agents.interactions, NEXT_PUBLIC_DISCOVERY_A2A_URL: TOWN.discoveryA2a,
        NEXT_PUBLIC_TOWN_NAMING_ORIGIN: TOWN.naming, NEXT_PUBLIC_AGENT_NAME_PARENTS: TOWN.nameRoots.join(','),
        // runbook §5 ⚠ — every other default is the first estate's; this one strands a person on sign-out if left.
        NEXT_PUBLIC_LOGOUT_RP_APPS: 'none', NEXT_PUBLIC_ENABLE_DEMO_PEOPLE: 'false',
      };
      const vars = [
        ...Object.entries(sensitive).filter(([, val]) => val).map(([key, value]) => ({ key, value, type: 'sensitive', target: ['production', 'preview'] })),
        ...Object.entries(plain).map(([key, value]) => ({ key, value, type: 'plain', target: ['production', 'preview'] })),
      ];
      const r = await vercel(`/v10/projects/${state.vercelProjectId}/env?upsert=true`, { method: 'POST', body: JSON.stringify(vars) });
      if (r.status >= 300) throw new Error(`Vercel refused the Home's settings (${r.status})`);
      const [org, repo] = REPO.split('/');
      const dep = await (await vercel('/v13/deployments', { method: 'POST', body: JSON.stringify({ name: names.home, project: state.vercelProjectId, target: 'production', gitSource: { type: 'github', org, repo, ref: process.env.AP_HOME_REF || 'master' } }) })).json();
      for (let i = 0; i < 120; i++) {
        const st = await (await vercel(`/v13/deployments/${dep.id}`)).json();
        if (st.readyState === 'READY') return;
        if (st.readyState === 'ERROR' || st.readyState === 'CANCELED') throw new Error(`the Home's build ${st.readyState.toLowerCase()}`);
        if (!DRY) await new Promise((ok) => setTimeout(ok, 10_000));
      }
      throw new Error('the Home did not finish building in 20 minutes');
    },
  },
  'estate-name': {
    title: `Register its .${TOWN.estateNameRoot} name on ${TOWN.chain.name}`,
    run: async () => {
      // Two halves (ap-home scripts/add-estate-agent.mts): the ESTATE deploys its own estate agent — salt 2 over its
      // interactions key, beside its two service agents — and points `atl:homepage` at its Home, signed by itself. Then
      // the TOWN registers `<label>.estate` to that agent, which needs the naming root's owner. OWN: the town does its
      // half in the finish part (town-name).
      const d = decl();
      if (!d.agents.estate) {
        const out = ctx.sh('npx', ['tsx', 'scripts/add-estate-agent.mts', '--estate', request.id, '--home', `https://${d.homeHost}`]);
        const agent = /estate agent:\s+(0x[0-9a-fA-F]{40})/.exec(out)?.[1];
        if (!agent) throw new Error('add-estate-agent did not report the estate agent');
        d.agents.estate = agent.toLowerCase();
        writeDecl(d);
      }
      if (OWN) return 'done';
      if (!registerEstateName(d.agents.estate, localVars().RPC_URL)) return 'waiting';
      d.estateNameRegistered = true;
      writeDecl(d);
    },
  },
  'town-name': {
    title: `Register its .${TOWN.estateNameRoot} name on ${TOWN.chain.name} (the town)`,
    run: async () => {
      const agent = reportedResult().agents?.estate;
      if (!agent) throw new Error('the owner\'s build reported no estate agent');
      // The town's own chain access (TOWN_RPC_URL: the gateway with the town's app token) — never the estate's token.
      if (!registerEstateName(agent, process.env.TOWN_RPC_URL ?? '')) return 'waiting';
      state.nameRegistered = true;
    },
  },
  town: {
    title: `List it in ${TOWN.displayName}`,
    run: async () => {
      const facts = OWN
        ? (() => { const r = reportedResult(); return { homeOrigin: r.homeOrigin, hosts: r.hosts as unknown as Hosts, estateName: state.nameRegistered ? `${request.id}.${TOWN.estateNameRoot}` : undefined }; })()
        : (() => { const d = decl(); return { homeOrigin: `https://${d.homeHost}`, hosts: d.hosts as Hosts, estateName: d.estateNameRegistered ? d.estateName : undefined }; })();
      const path = join(AP_TOWN, TOWN.manifest);
      const yaml = readFileSync(path, 'utf8');
      if (!new RegExp(`^  - id: ${request.id}\\s*$`, 'm').test(yaml)) {
        writeFileSync(path, addEstateRow(yaml, townRow({ id: request.id, name: request.name, homeOrigin: facts.homeOrigin, hosts: facts.hosts, workers: names, vercelProject: names.home, repo: REPO, sameAccount: !OWN, townName: TOWN.displayName, nameRoots: TOWN.nameRoots, ...(facts.estateName ? { estateName: facts.estateName } : {}) }), request.id));
      }
      ctx.sh('pnpm', ['gen:town'], { cwd: AP_TOWN });
      ctx.sh('pnpm', ['check'], { cwd: AP_TOWN });
      // The lanes became service bindings in whichever town Workers read them; redeploy exactly those (none, for an
      // estate on another account: it has no lanes).
      const changed = ctx.sh('git', ['diff', '--name-only', '--', 'apps'], { cwd: AP_TOWN }).split('\n').filter((f) => f.endsWith('wrangler.toml'));
      ctx.sh('git', ['add', '-A'], { cwd: AP_TOWN });
      // A re-run finds the row already listed and nothing to commit: that is done, not a failure.
      if (DRY || ctx.sh('git', ['status', '--porcelain'], { cwd: AP_TOWN }).trim()) {
        ctx.sh('git', ['-c', 'user.name=createestate', '-c', `user.email=createestate@${new URL(TOWN.townOrigin).host}`, 'commit', '-m', `town: list the ${request.id} estate (one-click, request ${request.requestId})`], { cwd: AP_TOWN });
        ctx.sh('git', ['push', 'origin', 'HEAD'], { cwd: AP_TOWN });
      }
      const twe = TOWN.hosted.townWorkerEnv;
      for (const f of changed) {
        const dir = join(AP_TOWN, f.replace(/\/wrangler\.toml$/, ''));
        const pkgJson = existsSync(join(dir, 'package.json')) ? JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) : {};
        if (pkgJson.scripts?.[`deploy:${twe}`]) ctx.sh('pnpm', [`deploy:${twe}`], { cwd: dir });
        else ctx.sh('npx', ['-y', 'wrangler', 'deploy', '--env', twe], { cwd: dir });
      }
    },
  },
  names: {
    title: 'Let its people claim names',
    run: async () => {
      // runbook §7. The script that mints the gate and asks naming.svc to allow it is not in this checkout yet.
      if (!existsSync('scripts/add-naming-gate.mts')) {
        state.operatorNotes.push(`Naming gate: run scripts/add-naming-gate.mts --estate ${request.id} (not in the public repo yet), then set NAMING_GATE_PRIVATE_KEY on the ${names.home} Vercel project${OWN ? ' (the owner sets it: it is on their Vercel)' : ''}. Until then its people can use the estate but not buy .me names from its Home.`);
        return 'waiting';
      }
      ctx.sh('npx', ['tsx', 'scripts/add-naming-gate.mts', '--estate', request.id]);
    },
  },
  check: {
    title: 'Check it matches every other estate',
    run: async () => { ctx.sh('npx', ['tsx', 'scripts/check-estate-shape.mts', request.id]); },
  },
  save: {
    title: 'Save its configuration',
    run: async () => {
      const base = process.env.AP_HOME_REF || 'master';
      persist(`estate: ${request.id} — built (one-click, request ${request.requestId})`);
      // The step state belongs to the estate's branch, not to the default branch.
      ctx.sh('git', ['rm', '--cached', '--quiet', '--ignore-unmatch', STATE_FILE]);
      ctx.sh('git', ['-c', 'user.name=createestate', '-c', `user.email=createestate@${new URL(TOWN.townOrigin).host}`, 'commit', '--allow-empty', '-m', `estate: ${request.id} (one-click, request ${request.requestId})`]);
      // The default branch has usually moved since the branch began: replay this estate's commits onto it. A conflict
      // stops the build with the files named, rather than force-pushing over somebody's work.
      ctx.sh('git', ['fetch', 'origin', base]);
      try {
        ctx.sh('git', ['-c', 'user.name=createestate', '-c', `user.email=createestate@${new URL(TOWN.townOrigin).host}`, 'rebase', `origin/${base}`]);
      } catch (e) {
        try { ctx.sh('git', ['rebase', '--abort']); } catch { /* nothing to abort */ }
        throw new Error(`the estate's configuration conflicts with ${base} — merge branch estate/${request.id} by hand (${(e as Error).message.split('\n')[0]})`);
      }
      ctx.sh('git', ['push', 'origin', `HEAD:${base}`]);
    },
  },
};

/** The town's half of `<label>.estate`. False (and an operator note) when the contract script or root key is absent. */
function registerEstateName(agent: string, rpcUrl: string): boolean {
  const label = request.id;
  const contracts = process.env.AGENTIC_CONTRACTS_DIR;
  const rootKey = process.env.ESTATE_ROOT_OWNER_KEY;
  if (!contracts || !rootKey || !rpcUrl || !existsSync(join(contracts, 'script/AddEstateName.s.sol'))) {
    state.operatorNotes.push(`Register ${label}.${TOWN.estateNameRoot}: in agenticprimitives/packages/contracts, as the naming root's owner — ESTATE_LABEL=${label} ESTATE_AGENT=${agent} forge script script/AddEstateName.s.sol:AddEstateName --rpc-url <${TOWN.chain.name} rpc> --broadcast. Until then the estate works; its agent simply has no .${TOWN.estateNameRoot} name.`);
    return false;
  }
  ctx.sh('forge', ['script', 'script/AddEstateName.s.sol:AddEstateName', '--rpc-url', rpcUrl, '--broadcast'], { cwd: contracts, env: { ESTATE_LABEL: label, ESTATE_AGENT: agent, PRIVATE_KEY: rootKey }, secret: true });
  return true;
}

/** Commit what this step changed to the estate's own branch, so a resumed build starts from it. */
function persist(message: string) {
  if (PART !== 'all' && PART !== 'estate') return; // the town's parts change nothing in ap-home
  if (!process.env.ESTATE_BRANCH && !DRY) return; // a local run: the files are simply on disk
  const branch = process.env.ESTATE_BRANCH ?? `estate/${request.id}`;
  const files = [DECL, STATE_FILE, ...Object.values(TOML_PATHS), 'scripts/estate-shape.mts'].filter((f) => existsSync(f));
  ctx.sh('git', ['add', '-f', ...files]);
  ctx.sh('git', ['-c', 'user.name=createestate', '-c', `user.email=createestate@${new URL(TOWN.townOrigin).host}`, 'commit', '--allow-empty', '-m', message]);
  ctx.sh('git', ['push', 'origin', `HEAD:refs/heads/${branch}`]);
}

/** The key a checkpoint is sealed with: the town's BUILD_STATE_SECRET, or — on the owner's accounts — their build key. */
const stateSecret = (): string | undefined => (BUILD_KEY ? `build-key:${BUILD_KEY.enc.d}` : process.env.BUILD_STATE_SECRET);

async function checkpoint(): Promise<string | undefined> {
  const secret = stateSecret();
  if (!secret || !existsSync(LOCAL) || (PART !== 'all' && PART !== 'estate')) return undefined;
  return sealState(readFileSync(LOCAL, 'utf8'), secret, request.id);
}

/** Checkpoint the custody file and REQUIRE the site to confirm it (when there is a site to confirm it). */
async function mustCheckpoint(step: string) {
  const cp = await checkpoint();
  if (!cp || !SITE) return;
  const ok = await report({ step, state: 'running', detail: 'keys saved', checkpoint: cp }, { retries: 4 });
  if (!ok && !DRY) throw new Error('the site did not confirm the custody checkpoint — stopping rather than risk losing the only copy');
}

// ── run ─────────────────────────────────────────────────────────────────────────────────────────────────────
const report = reporter({ site: SITE, id: request.id, ...(typeof AUTH === 'string' ? { secret: AUTH } : AUTH ? { signer: AUTH } : {}) });

async function main() {
  console.log(`one-click estate ${request.id} ("${request.name}") — request ${request.requestId} — ${OWN ? `on its owner's accounts (${request.repo}), part ${PART}` : `on ${TOWN.displayName}'s accounts`}${DRY ? ' — DRY RUN' : ''}\n`);
  // The owner's build opens what the town sealed to it.
  if (PART === 'estate') {
    if (!SITE) throw new Error('the estate part needs the site, to fetch what the town sealed to it');
    const res = await signedGet(SITE, `/api/estates/${request.id}/town-package`, AUTH!);
    if (res.status === 404) throw new Error('the town has not opened your key vault yet — wait for it on the estate\'s page, then run this again');
    if (!res.ok) throw new Error(`the site would not return the town package (${res.status})`);
    townPackage = JSON.parse(await openSealedWith((await res.json()).sealed, BUILD_KEY!.enc)) as TownPackage;
    if (townPackage.estate !== request.id) throw new Error('that town package is for another estate');
  }
  // Resume with the SAME keys: fetch the sealed custody file an earlier attempt checkpointed, before anything runs.
  const secret = stateSecret();
  if ((PART === 'all' || PART === 'estate') && !existsSync(LOCAL) && SITE && AUTH && secret) {
    const sealed = await fetchCheckpoint(SITE, request.id, AUTH);
    if (sealed) {
      writeFileSync(LOCAL, await openState(sealed, secret, request.id), { mode: 0o600 });
      console.log('resumed with the custody file from the last attempt');
    }
  }
  for (const id of stepsFor(PART).filter((s) => s !== 'handover')) {
    const st = steps[id];
    if (!st) throw new Error(`no step ${id}`);
    if (ONLY && id !== ONLY) continue;
    // The chain token lives only in this process until bootstrap seals it into the local file, so chain access is
    // not "done" across a restart unless that file exists.
    const done = state.done.includes(id) && (id !== 'chain-access' || existsSync(LOCAL));
    if (done) { await report({ step: id, state: 'done', detail: 'already done' }); continue; }
    await report({ step: id, state: 'running' });
    try {
      const outcome = (await st.run()) ?? 'done';
      // The checkpoint goes out — and is CONFIRMED — before git is told the step is done. Otherwise a lost report plus
      // a later failure would leave git saying "agents: done" with no custody file anywhere to resume with.
      const cp = await checkpoint();
      // The town's parts carry their operator notes on every report (there is no handover to carry them).
      const notes = PART === 'town' || PART === 'finish' ? { operatorNotes: state.operatorNotes } : {};
      const delivered = await report({ step: id, state: outcome as StepState, checkpoint: cp, ...notes }, { retries: cp ? 4 : 0 });
      if (cp && SITE && !delivered && !DRY) throw new Error('the site did not confirm the custody checkpoint — stopping rather than risk losing the only copy');
      if (outcome === 'done') state.done.push(id);
      save();
      if (id !== 'save') persist(`estate: ${request.id} — ${id}`);
    } catch (e) {
      save();
      await report({ step: id, state: 'failed', detail: (e as Error).message.slice(0, 400), checkpoint: await checkpoint() }, { retries: 4 });
      console.error(`\n✗ ${id} failed. Fix it and run part ${PART} again for request ${request.requestId}; every step is idempotent.`);
      process.exit(1);
    }
  }
  if (ONLY || !stepsFor(PART).includes('handover')) {
    printDry();
    console.log(`\n✓ part ${PART} of ${request.id} is done`);
    return;
  }

  // ── handover: the custody file, sealed to the owner, and nothing else leaves ──
  const d = decl();
  const sealed = await sealForOwner(readFileSync(LOCAL, 'utf8'), request.ownerKey);
  const hb = localVars().TOWN_HEARTBEAT_TOKEN;
  // The town's ESTATE_HEARTBEAT_TOKENS is ONE JSON secret this build cannot read back, so it cannot merge into it.
  // The estate works without it; the town's Pulse simply does not chart it until an operator adds the entry.
  if (hb) state.operatorNotes.push(`Pulse (optional): add "${request.id}": "${hb}" to ESTATE_HEARTBEAT_TOKENS on ${TOWN.town}-town-agent.`);
  const delivered = await report({
    step: 'handover', state: 'done', detail: 'sealed to your key',
    result: { homeOrigin: `https://${d.homeHost}`, hosts: d.hosts, agents: d.agents, custody: sealed, notes: state.notes, operatorNotes: state.operatorNotes },
  }, { retries: 4 });
  if (!delivered && !DRY) {
    console.error('\n✗ the sealed custody file could not be delivered — it is kept here; re-run to retry.');
    process.exit(1);
  }
  printDry();
  if (DRY) console.log(`\nsealed custody bundle: ${JSON.stringify(sealed).length} bytes for key ${sealed.kid}`);
  console.log(`\n✓ ${d.name} is built: Home ${`https://${d.homeHost}`}`);
}

function printDry() {
  if (DRY) console.log(`\nDRY RUN — ${ctx.recorded.length} commands that a real build would run:\n${ctx.recorded.map((l) => `  ${l}`).join('\n')}`);
}

await main();
