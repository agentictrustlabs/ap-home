// DEMO PEOPLE FOR AN ESTATE'S HOME — a few ready-made people to sign in as, so a new estate can be tried before
// Google or email sign-in is set up for it.
//
// Each demo person is a real Smart Agent on the chain whose custodian is a fresh key made here. The keys go straight
// into the Home's DEMO_PERSONA_KEYS secret (sensitive on Vercel: it cannot be read back) and nowhere else: never a
// file, never the log. The Home signs for them (apps/home/server/_lib/demo-custody.ts) and shows them under
// "Demo people" on its front door (NEXT_PUBLIC_ENABLE_DEMO_PEOPLE=true). Demo keys only: a real person's custody
// never lives in a Home secret.
//
// It also hides "Continue with Google" while the Home has no Google client (NEXT_PUBLIC_CREDENTIAL_METHODS=email):
// Google refuses a Home it does not know, so the button only led to an error page.
//
// Idempotent: a Home that already has DEMO_PERSONA_KEYS keeps its people (the secret cannot be read back, so
// making new ones would orphan the old). Called by the one-click build's Home step, and on its own for an estate
// built before demo people existed (.github/workflows/estate-demo-people.yml):
//
//   RPC_URL=<gateway url with a write token> FUNDER_PRIVATE_KEY=… VERCEL_TOKEN=… VERCEL_TEAM_ID=… \
//     npx tsx scripts/estate-oneclick/demo-people.mts --estate <id> [--project <id>-home] [--redeploy] [--repo org/repo]
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { AgentAccountClient } from '@agenticprimitives/agent-account';

export const DEMO_PEOPLE = [
  { handle: 'maya', name: 'Maya Chen', blurb: 'Demo person' },
  { handle: 'samuel', name: 'Samuel Okafor', blurb: 'Demo person' },
  { handle: 'grace', name: 'Grace Lee', blurb: 'Demo person' },
  { handle: 'daniel', name: 'Daniel Ruiz', blurb: 'Demo person' },
] as const;

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const need = (k: string): string => { const v = process.env[k]; if (!v) { console.error(`${k} is required`); process.exit(2); } return v; };

const estate = arg('estate') ?? '';
if (!/^[a-z][a-z0-9-]{1,30}$/.test(estate)) { console.error('usage: demo-people.mts --estate <id> [--project <name>] [--redeploy] [--repo org/repo]'); process.exit(2); }
const project = arg('project') ?? `${estate}-home`;
const redeploy = process.argv.includes('--redeploy');
const repo = arg('repo') ?? 'agentictrustlabs/ap-home';
const RPC = need('RPC_URL');
const funder = need('FUNDER_PRIVATE_KEY') as Hex;
const token = need('VERCEL_TOKEN');
const team = process.env.VERCEL_TEAM_ID ?? '';

const vercel = async (path: string, init?: RequestInit) => {
  const url = `https://api.vercel.com${path}${team ? `${path.includes('?') ? '&' : '?'}teamId=${team}` : ''}`;
  return fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init?.headers ?? {}) } });
};

// What the Home already has (names only; Vercel never returns a sensitive value).
const listed = await vercel(`/v9/projects/${project}/env`);
if (!listed.ok) { console.error(`Vercel would not list ${project}'s settings (${listed.status})`); process.exit(1); }
const have = new Set(((await listed.json()) as { envs?: { key: string }[] }).envs?.map((e) => e.key) ?? []);

const vars: { key: string; value: string; type: 'sensitive' | 'plain'; target: string[] }[] = [];
const target = ['production', 'preview'];

if (have.has('DEMO_PERSONA_KEYS')) {
  console.log(`${project} already has demo people — kept`);
} else {
  const dep = JSON.parse(readFileSync(createRequire(import.meta.url).resolve(`@agenticprimitives/contracts/deployments-json/${process.env.DEPLOYMENT ?? 'faithchain'}`), 'utf8')) as {
    chainId: number; entryPoint: Address; agentAccountFactory: Address;
  };
  const client = new AgentAccountClient({ rpcUrl: RPC, chainId: dep.chainId, entryPoint: dep.entryPoint, factory: dep.agentAccountFactory });
  const roster: Record<string, { sa: string; eoaPrivateKey: Hex; name: string; blurb: string }> = {};
  for (const p of DEMO_PEOPLE) {
    const key = generatePrivateKey();
    const spec = { custodians: [privateKeyToAccount(key).address] as readonly Address[], salt: 0n };
    const sa = await client.getAddressForAgentAccount(spec);
    await client.createAgentAccountFromPrivateKey(spec, funder);
    let ok = false;
    for (let i = 0; i < 10 && !ok; i++) { ok = await client.isDeployed(sa).catch(() => false); if (!ok) await new Promise((r) => setTimeout(r, 1500)); }
    if (!ok) { console.error(`${p.handle}: the account was not visible on chain after creating it`); process.exit(1); }
    console.log(`${p.name.padEnd(14)} ${sa}`);
    roster[p.handle] = { sa: sa.toLowerCase(), eoaPrivateKey: key, name: p.name, blurb: p.blurb };
  }
  vars.push({ key: 'DEMO_PERSONA_KEYS', value: JSON.stringify(roster), type: 'sensitive', target });
}
vars.push({ key: 'NEXT_PUBLIC_ENABLE_DEMO_PEOPLE', value: 'true', type: 'plain', target });
if (!have.has('GOOGLE_CLIENT_ID')) vars.push({ key: 'NEXT_PUBLIC_CREDENTIAL_METHODS', value: 'email', type: 'plain', target });

const put = await vercel(`/v10/projects/${project}/env?upsert=true`, { method: 'POST', body: JSON.stringify(vars) });
if (put.status >= 300) { console.error(`Vercel refused the demo-people settings (${put.status})`); process.exit(1); }
console.log(`set on ${project}: ${vars.map((v) => v.key).join(', ')}`);

if (redeploy) {
  const [org, name] = repo.split('/');
  const dep = (await (await vercel('/v13/deployments', { method: 'POST', body: JSON.stringify({ name: project, project, target: 'production', gitSource: { type: 'github', org, repo: name, ref: process.env.AP_HOME_REF || 'master' } }) })).json()) as { id?: string; error?: { message?: string } };
  if (!dep.id) { console.error(`Vercel would not start the Home's build: ${dep.error?.message ?? 'no deployment id'}`); process.exit(1); }
  for (let i = 0; i < 120; i++) {
    const st = (await (await vercel(`/v13/deployments/${dep.id}`)).json()) as { readyState?: string };
    if (st.readyState === 'READY') { console.log(`${project} rebuilt`); process.exit(0); }
    if (st.readyState === 'ERROR' || st.readyState === 'CANCELED') { console.error(`the Home's build ${st.readyState.toLowerCase()}`); process.exit(1); }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  console.error('the Home did not finish building in 20 minutes'); process.exit(1);
}
