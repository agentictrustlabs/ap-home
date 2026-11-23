#!/usr/bin/env -S npx tsx
/**
 * THE ONE-CLICK WORKSPACE BUILD — an app of an estate's own, from the createestate page's "Add a workspace".
 *
 * A workspace is a repository of its own (written by create-ap-workspace) that already knows how to put itself on its
 * estate: `pnpm estate provision | key | home-client | deploy`. This build writes that repository and runs those
 * commands as the town, reporting each step to the site. It adds no second way of doing any of them.
 *
 *   repo         the starter, in a new private repository (or the existing one, on a retry)
 *   storage      its KV and D1, on the town's Cloudflare
 *   key          its delegate key, in the ESTATE's key-vault tenant (opens and closes the vault's temporary path itself)
 *   home-client  its registration at the estate's Home (this repository's whitelabel config), then the Home redeployed
 *   deploy       its three Workers
 *   handover     where it is, and what the owner does next
 *
 * What it does NOT do, because only the workspace's custodian may: create the workspace agent at the Home, enable its
 * storage, authorize the endpoint, publish its playbook. The site lists those for the owner.
 *
 * The dispatch carries only ids. The request (name, domain, who asked) is fetched from the site, signed, and the site
 * returns one only for a workspace its estate's owner asked for on a ready estate. Running this by hand builds nothing
 * that was not asked for. What the workspace has been given is recorded in ITS repository (workspace.json), so a retry
 * carries on where the last attempt stopped.
 *
 *   npx tsx scripts/workspace-oneclick/run.mts --estate <id> --workspace <name> [--request-id req_…]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { reporter, sign } from '../estate-oneclick/progress.mts';

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const need = (k: string): string => { const v = process.env[k]; if (!v) throw new Error(`${k} is not set`); return v; };
const estate = arg('estate') ?? '';
const name = arg('workspace') ?? '';
if (!/^[a-z][a-z0-9-]{1,30}$/.test(estate)) throw new Error('--estate <id> is required');
if (!/^[a-z][a-z0-9-]{1,28}[a-z0-9]$/.test(name)) throw new Error('--workspace <name> is required');

const AP_HOME = resolve(import.meta.dirname, '../..');
const SITE = need('CREATE_ESTATE_SITE').replace(/\/$/, '');
const SECRET = need('BUILD_CALLBACK_SECRET');
const CLI = resolve(need('WORKSPACE_CLI_DIR'));
const WORK = resolve(need('WORKSPACE_DIR'));
const TOKEN = need('WORKSPACE_REPO_TOKEN');
const OWNER = process.env.WORKSPACE_REPO_OWNER || 'agentictrustlabs';
const REF = process.env.AP_HOME_REF || 'master';
const HOME_REPO = need('GITHUB_REPOSITORY');
const sitePath = `/api/estates/${estate}/workspaces/${name}`;
const report = reporter({ site: SITE, id: estate, secret: SECRET, path: `${sitePath}/progress` });

// ── the request, from the site ───────────────────────────────────────────────────────────────────────────────────
interface Approved { requestId: string; estate: string; name: string; domain: string; github: string | null; requestedBy: string; homeOrigin: string | null }
async function approved(): Promise<Approved> {
  const ts = String(Date.now());
  const path = `${sitePath}/approved`;
  const r = await fetch(`${SITE}${path}`, { headers: { 'x-build-timestamp': ts, 'x-build-signature': sign(SECRET, ts, `GET ${path}`) } });
  if (!r.ok) throw new Error(`the site has no request for ${name} on ${estate} (${r.status}); nothing is built without one`);
  const a = (await r.json()) as Approved;
  if (a.estate !== estate || a.name !== name) throw new Error('the site answered for a different workspace');
  const asked = arg('request-id');
  if (asked && asked !== a.requestId) throw new Error('this run was started for a different request');
  if (!/^[a-z][a-z0-9]{1,30}$/.test(a.domain)) throw new Error('the request carries no usable domain');
  if (!a.homeOrigin || !/^https:\/\//.test(a.homeOrigin)) throw new Error('the estate has no Home yet');
  return a;
}

// ── tools ────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Run a command; its output goes to the log with every secret this build holds struck out. */
const SECRETS = [TOKEN, SECRET, process.env.CLOUDFLARE_API_TOKEN, process.env.VERCEL_TOKEN, process.env.WORKSPACE_DEPLOY_TOKEN].filter((s): s is string => Boolean(s));
const scrub = (s: string) => SECRETS.reduce((t, x) => t.split(x).join('***'), s);
function sh(cmd: string, args: string[], o: { cwd?: string; env?: Record<string, string>; quiet?: boolean } = {}): string {
  const r = spawnSync(cmd, args, { cwd: o.cwd ?? WORK, encoding: 'utf8', env: { ...process.env, ...o.env }, maxBuffer: 64 * 1024 * 1024 });
  const out = scrub(`${r.stdout ?? ''}${r.stderr ?? ''}`);
  if (!o.quiet) process.stdout.write(out);
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} failed: ${out.trim().split('\n').slice(-3).join(' ').slice(-300)}`);
  return out;
}
const github = async (path: string, init: RequestInit = {}) =>
  fetch(`https://api.github.com${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'workspace-oneclick', 'content-type': 'application/json', ...(init.headers ?? {}) } });
const vercel = (path: string, init: RequestInit = {}) => {
  const team = process.env.VERCEL_TEAM_ID;
  return fetch(`https://api.vercel.com${path}${team ? `${path.includes('?') ? '&' : '?'}teamId=${team}` : ''}`, { ...init, headers: { authorization: `Bearer ${need('VERCEL_TOKEN')}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
};
const AUTHOR = { GIT_AUTHOR_NAME: 'workspace-oneclick', GIT_AUTHOR_EMAIL: 'workspace-oneclick@users.noreply.github.com', GIT_COMMITTER_NAME: 'workspace-oneclick', GIT_COMMITTER_EMAIL: 'workspace-oneclick@users.noreply.github.com' };
const remote = `https://x-access-token:${TOKEN}@github.com/${OWNER}/${name}.git`;
const estateCmd = (...a: string[]) => sh('pnpm', ['-s', 'estate', ...a]);
const wsJson = () => JSON.parse(readFileSync(join(WORK, 'workspace.json'), 'utf8')) as { name: string; domain: string; estate: string; estates?: Record<string, { delegate?: { address?: string }; kvId?: string; d1Id?: string }> };
/** Save what the workspace has been given, in its own repository. */
function push(message: string) {
  sh('git', ['add', '-A'], { quiet: true });
  if (!sh('git', ['status', '--porcelain'], { quiet: true }).trim()) return;
  sh('git', ['commit', '-q', '-m', message], { env: AUTHOR, quiet: true });
  sh('git', ['push', '-q', remote, 'HEAD:main'], { quiet: true });
}

// ── the steps ────────────────────────────────────────────────────────────────────────────────────────────────────
const steps: Array<[string, (a: Approved) => Promise<string | void>]> = [
  ['repo', async (a) => {
    const had = await github(`/repos/${OWNER}/${name}`);
    if (had.status === 200) {
      // A retry: the repository holds what earlier attempts recorded. Anything else of that name is not ours to touch.
      sh('git', ['clone', '-q', remote, WORK], { cwd: AP_HOME, quiet: true });
      if (!existsSync(join(WORK, 'workspace.json'))) throw new Error(`${OWNER}/${name} already exists and is not a workspace; choose another name`);
      const w = wsJson();
      if (w.name !== name || w.estate !== estate) throw new Error(`${OWNER}/${name} already exists and belongs to another workspace; choose another name`);
      sh('pnpm', ['install', '--frozen-lockfile=false'], { quiet: true });
      return 'carrying on in the existing repository';
    }
    if (had.status !== 404) throw new Error(`GitHub would not say whether ${OWNER}/${name} exists (${had.status})`);
    sh(process.execPath, [join(CLI, 'bin/create-ap-workspace.mjs'), name, '--domain', a.domain, '--estate', estate, '--home', a.homeOrigin!, '--dir', WORK, '--no-install'], { cwd: AP_HOME, quiet: true });
    sh('pnpm', ['install', '--frozen-lockfile=false'], { quiet: true });
    // The estate's own Home and key-vault tenant, from its declaration in this repository.
    estateCmd('import', '--estate', estate, '--declaration', join(AP_HOME, 'estates', `${estate}.estate.json`));
    sh('pnpm', ['-s', 'gen', '--check'], { quiet: true });
    const body = JSON.stringify({ name, private: true, description: `The ${name} workspace on the ${estate} estate (create-ap-workspace).` });
    // An organization's repositories, or (when the owner is a person's own account) theirs.
    let made = await github(`/orgs/${OWNER}/repos`, { method: 'POST', body });
    if (made.status === 404) made = await github('/user/repos', { method: 'POST', body });
    if (made.status !== 201) throw new Error(`GitHub would not create ${OWNER}/${name} (${made.status}): ${(await made.text()).slice(0, 200)}`);
    sh('git', ['init', '-q', '-b', 'main'], { quiet: true });
    push(`${name}: a workspace on ${estate}, from create-ap-workspace`);
    return `${OWNER}/${name}`;
  }],
  ['storage', async () => {
    estateCmd('provision');
    push('storage: KV and D1');
  }],
  ['key', async () => {
    estateCmd('key');
    push('the delegate key\'s address');
    return wsJson().estates?.[estate]?.delegate?.address;
  }],
  ['home-client', async () => {
    // The Home's clients are this repository's whitelabel config. Written on a branch off the default branch by the
    // workspace's own command, pushed to the default branch, and the estate's Home rebuilt from it.
    const client = name;
    const file = 'apps/home/src/whitelabel/config.ts';
    sh('git', ['fetch', '-q', 'origin', REF], { cwd: AP_HOME, quiet: true });
    const onMaster = sh('git', ['show', `origin/${REF}:${file}`], { cwd: AP_HOME, quiet: true });
    if (!onMaster.includes(`client_id: '${client}'`)) {
      // Someone else may push to the default branch between our fetch and our push: start again from the new tip.
      for (let attempt = 1; ; attempt++) {
        sh('git', ['checkout', '-q', '--detach', `origin/${REF}`], { cwd: AP_HOME, quiet: true });
        spawnSync('git', ['branch', '-D', `workspace-client-${client}`], { cwd: AP_HOME });
        sh('pnpm', ['-s', 'estate', 'home-client', '--repo', AP_HOME], { env: AUTHOR });
        try {
          sh('git', ['push', '-q', 'origin', `HEAD:refs/heads/${REF}`], { cwd: AP_HOME, quiet: true });
          break;
        } catch (e) {
          if (attempt >= 3) throw e;
        }
      }
      push('the Home registration');
    }
    const [org, repo] = HOME_REPO.split('/');
    const project = `${estate}-home`;
    const dep = (await (await vercel('/v13/deployments', { method: 'POST', body: JSON.stringify({ name: project, project, target: 'production', gitSource: { type: 'github', org, repo, ref: REF } }) })).json()) as { id?: string; error?: { message?: string } };
    if (!dep.id) throw new Error(`Vercel would not rebuild the Home: ${dep.error?.message ?? 'no deployment id'}`);
    for (let i = 0; i < 120; i++) {
      const st = (await (await vercel(`/v13/deployments/${dep.id}`)).json()) as { readyState?: string };
      if (st.readyState === 'READY') return `the Home knows '${client}'`;
      if (st.readyState === 'ERROR' || st.readyState === 'CANCELED') throw new Error(`the Home's build ${st.readyState.toLowerCase()}`);
      await new Promise((ok) => setTimeout(ok, 10_000));
    }
    throw new Error('the Home did not finish building in 20 minutes');
  }],
  ['deploy', async () => {
    estateCmd('deploy');
    push('deployed');
  }],
];

// ── run ──────────────────────────────────────────────────────────────────────────────────────────────────────────
let at = 'repo';
try {
  const a = await approved();
  for (const [step, run] of steps) {
    at = step;
    await report({ step, state: 'running' });
    const detail = await run(a);
    await report({ step, state: 'done', ...(detail ? { detail } : {}) });
  }
  at = 'handover';
  const notes: string[] = [];
  // Who may open the code. Without a GitHub name the repository is the town's alone until an operator adds them.
  if (a.github) {
    const r = await github(`/repos/${OWNER}/${name}/collaborators/${a.github}`, { method: 'PUT', body: JSON.stringify({ permission: 'push' }) });
    notes.push(r.status === 201 || r.status === 204 ? `GitHub has invited ${a.github} to the code: accept the invitation in your GitHub notifications.` : `GitHub would not invite ${a.github} (${r.status}); ask a town operator to add you to ${OWNER}/${name}.`);
  } else notes.push(`Ask a town operator to add you to ${OWNER}/${name} on GitHub.`);
  // Deploy on push needs a Cloudflare token in the workspace's repository. Only a token made for that is ever copied.
  if (process.env.WORKSPACE_DEPLOY_TOKEN) {
    sh('gh', ['secret', 'set', 'CLOUDFLARE_API_TOKEN', '-R', `${OWNER}/${name}`, '--body', process.env.WORKSPACE_DEPLOY_TOKEN], { env: { GH_TOKEN: TOKEN }, quiet: true });
    notes.push('Every push to main deploys it.');
  } else notes.push('Deploying a change needs the town\'s Cloudflare access for now: push your change and ask a town operator to deploy it.');
  const urls = /web (https:\/\/\S+?)\/?\s[\s\S]*?a2a (https:\/\/\S+)/.exec(sh('pnpm', ['-s', 'estate', 'status'], { quiet: true }));
  if (!urls) throw new Error('the workspace did not say where it is deployed');
  await report({ step: 'handover', state: 'done', result: { web: urls[1], a2a: urls[2], repo: `https://github.com/${OWNER}/${name}`, notes } }, { retries: 4 });
} catch (e) {
  const message = scrub(e instanceof Error ? e.message : String(e)).slice(0, 400);
  await report({ step: at, state: 'failed', detail: message }, { retries: 2 });
  console.error(`\n✗ ${at}: ${message}`);
  process.exit(1);
}
