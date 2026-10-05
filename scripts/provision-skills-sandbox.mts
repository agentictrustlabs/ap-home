// Provision the skills shared sandbox org, stewarded by the skills service agent.
// Reuses demo-sso-next's EXACT delegation helpers (identical digests to the portal)
// and demo-a2a's gasless relayer. Held EOA key signs every userOp; no funds needed.
//
//   SVC_KEY_FILE=<{address,privateKey}> SERVICE_SA=0x… BASE_SEPOLIA_RPC=… \
//     pnpm exec tsx scripts/provision-skills-sandbox.mts create-org
import { readFileSync } from 'node:fs';
import { createPublicClient, http, encodeFunctionData, keccak256, toBytes, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { buildApproveHashCall, readApprovalScheme, contractsGenerationOf } from '@agenticprimitives/agent-account';
import { buildApprovedSiteDelegation, buildApprovedInteractionsDelegation, buildApprovedSessionDelegation, buildVaultKeyAuthorization, APPROVED_HASH_SENTINEL, toWire } from '../apps/home/src/lib/delegation';

const DEMO_MCP_URL = process.env.DEMO_MCP_URL ?? 'https://demo-mcp-production.richardpedersen3.workers.dev';

const INTERACTIONS_SERVICE_SA = '0x39508624387fed3b9d6dd15ba86d3ace8a3f0a6a' as Address;
// The vault's server id — the deployment's VAULT_SERVER_ID; Ring 0's estates were provisioned under demo-mcp.
const MCP_SERVER_ID = (process.env.VAULT_SERVER_ID ?? '').trim() || 'demo-mcp';
let ORG_SA = (process.env.ORG_SA ?? '') as Address;

const DEMO_A2A_URL = process.env.DEMO_A2A_URL ?? 'https://demo-a2a-production.richardpedersen3.workers.dev';
const DEMO_ORIGIN = process.env.DEMO_ORIGIN ?? 'https://agenticprimitives-demo-pro.pages.dev';
const RPC = process.env.BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org';
const DELEGATE_SA = '0x89D13c596c45E4eE80Af5ae06C727FE9A820ffD0' as Address; // shared demo site delegate
const APPROVED_HASH_REGISTRY = '0x465f8DCE65aB51A1562CC60E6bc046ca8734D537' as Address;
const ZERO32 = ('0x' + '00'.repeat(32)) as Hex;

const svc = JSON.parse(readFileSync(process.env.SVC_KEY_FILE!, 'utf8'));
const account = privateKeyToAccount(svc.privateKey);
const serviceSA = (process.env.SERVICE_SA ?? '') as Address;
const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });

const EXECUTE_BATCH_ABI = [{ type: 'function', name: 'executeBatch', stateMutability: 'nonpayable', inputs: [{ name: 'calls', type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }] }], outputs: [] }] as const;

async function csrf() {
  const res = await fetch(`${DEMO_A2A_URL}/auth/csrf`, { headers: { Origin: DEMO_ORIGIN } });
  const body = (await res.json()) as { token?: string; csrf?: string };
  const m = /agentic-csrf=([^;]+)/.exec(res.headers.get('set-cookie') ?? '');
  if (!m || !(body.token ?? body.csrf)) throw new Error('csrf failed');
  return { token: (body.token ?? body.csrf)!, cookie: `agentic-csrf=${m[1]}` };
}
async function post(path: string, body: unknown, s: { token: string; cookie: string }) {
  const res = await fetch(`${DEMO_A2A_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: DEMO_ORIGIN, 'X-CSRF-Token': s.token, Cookie: s.cookie },
    body: JSON.stringify(body),
  });
  let json: Record<string, unknown>; const t = await res.text();
  try { json = JSON.parse(t); } catch { json = { raw: t }; }
  return { status: res.status, json };
}

async function createOrg() {
  if (!serviceSA) throw new Error('SERVICE_SA required');
  console.log('service EOA/custodian:', account.address, '\nservice SA (steward):', serviceSA);
  const s = await csrf();

  // 1) deploy the org SA (EOA-custodied by the service key)
  const salt = String(Date.now());
  const dep = await post('/session/direct-deploy', {
    mode: 0, custodians: [account.address], trustees: [],
    initialPasskeyCredentialIdDigest: ZERO32, initialPasskeyX: '0', initialPasskeyY: '0',
    timelockOverrides: [0, 0, 0, 0, 0, 0, 0], salt,
  }, s);
  if (dep.status !== 200 || dep.json.ok !== true) throw new Error('org deploy failed: ' + JSON.stringify(dep.json).slice(0, 300));
  const orgSA = dep.json.deployedAddress as Address;
  console.log('org SA:', orgSA, ' tx:', dep.json.transactionHash);
  for (let i = 0; i < 20; i++) { const code = await pub.getBytecode({ address: orgSA }); if (code && code !== '0x') break; await new Promise((r) => setTimeout(r, 1500)); }

  // 2) build the org's outbound grants (identical digests to the portal)
  const site = buildApprovedSiteDelegation(orgSA, DELEGATE_SA);
  const steward = buildApprovedSiteDelegation(orgSA, serviceSA);
  console.log('site grant digest:', site.digest, '\nsteward grant digest:', steward.digest);

  // 3) approveHash both digests under the org (one executeBatch userOp) — R917-C-2: the EPOCH-BOUND key,
  //    under the org's current custody epoch (0 for an account with no code yet).
  const orgScheme = await readApprovalScheme(pub, orgSA, contractsGenerationOf({ contractsGeneration: process.env.CONTRACTS_GENERATION }));
  const calls = [site.digest, steward.digest].map((d) => { const c = buildApproveHashCall(APPROVED_HASH_REGISTRY, d, orgScheme); return { target: c.to, value: c.value, data: c.data }; });
  const callData = encodeFunctionData({ abi: EXECUTE_BATCH_ABI, functionName: 'executeBatch', args: [calls] });
  const build = await post('/account/build-call-userop', { sender: orgSA, callData }, s);
  if (build.status !== 200 || build.json.ok !== true) throw new Error('build-call-userop failed: ' + JSON.stringify(build.json).slice(0, 300));
  const userOpHash = build.json.userOpHash as Hex;
  const userOp = build.json.userOp as Record<string, unknown>;
  const signature = await account.sign({ hash: userOpHash });
  let ok = false;
  for (let a = 0; a < 6 && !ok; a++) {
    const sub = await post('/account/submit-call-userop', { userOp: { ...userOp, signature } }, s);
    if (sub.status === 200 && sub.json.ok === true) { ok = true; console.log('grants approved. tx:', sub.json.transactionHash ?? sub.json.userOpHash); break; }
    const detail = String(sub.json.detail ?? sub.json.error ?? '');
    if (/AA2[05]|not deployed|nonce/i.test(detail)) { await new Promise((r) => setTimeout(r, 3000)); continue; }
    throw new Error('submit failed: ' + JSON.stringify(sub.json).slice(0, 300));
  }
  if (!ok) throw new Error('grant approve did not confirm');
  console.log('org grants approved.');
  return { orgSA, stewardWire: toWire(steward.delegation) };
}

// executeBatch a set of approveHash(digest) calls on `sender`, gasless via the relayer.
async function approveHashes(sender: Address, digests: Hex[], s: { token: string; cookie: string }) {
  const scheme = await readApprovalScheme(pub, sender, contractsGenerationOf({ contractsGeneration: process.env.CONTRACTS_GENERATION })); // R917-C-2: the epoch-bound key on generation 2
  const calls = digests.map((d) => { const c = buildApproveHashCall(APPROVED_HASH_REGISTRY, d, scheme); return { target: c.to, value: c.value, data: c.data }; }); // generation 3: a self-call (spec 410 §1)
  const callData = encodeFunctionData({ abi: EXECUTE_BATCH_ABI, functionName: 'executeBatch', args: [calls] });
  const build = await post('/account/build-call-userop', { sender, callData }, s);
  if (build.status !== 200 || build.json.ok !== true) throw new Error('build-call-userop: ' + JSON.stringify(build.json).slice(0, 300));
  const signature = await account.sign({ hash: build.json.userOpHash as Hex });
  for (let a = 0; a < 12; a++) {
    const sub = await post('/account/submit-call-userop', { userOp: { ...(build.json.userOp as Record<string, unknown>), signature } }, s);
    if (sub.status === 200 && sub.json.ok === true) return sub.json;
    if (!/AA2[05]|not deployed|nonce/i.test(String(sub.json.detail ?? sub.json.error ?? ''))) throw new Error('submit: ' + JSON.stringify(sub.json).slice(0, 300));
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error('approveHashes did not confirm');
}

async function enableStorage() {
  if (!ORG_SA) throw new Error('ORG_SA required');
  console.log('enabling discussion storage for org', ORG_SA);
  const s = await csrf();
  // 0) the DO's DEL-001 session key (needed so the DO can client-mint, else session_leaf_required)
  const skRes = await fetch(`${DEMO_A2A_URL}/agent/interactions-session-key`, { headers: { Origin: DEMO_ORIGIN } });
  const sk = (await skRes.json()) as { ok?: boolean; address?: string };
  if (!sk.address) throw new Error('interactions-session-key unavailable: ' + JSON.stringify(sk));
  console.log('DO session key:', sk.address);
  // 1) the org's interactions grant + the session leaf (both approved-hash)
  const ix = buildApprovedInteractionsDelegation(ORG_SA, INTERACTIONS_SERVICE_SA, MCP_SERVER_ID);
  const leaf = buildApprovedSessionDelegation(ORG_SA, sk.address as Address, [INTERACTIONS_SERVICE_SA]); // spec 408 §2.1
  console.log('interactions digest:', ix.digest, '\nsession leaf digest:', leaf.digest);
  // 2) approveHash both on the org
  await approveHashes(ORG_SA, [ix.digest, leaf.digest], s);
  console.log('interactions + session-leaf digests approved on-chain');
  // 3) install the grant (+ session leaf) in the org's InteractionsDO.
  //    Retry: the just-approved hash can be stale at the DO's verification RPC for a few seconds.
  let g: { status: number; json: Record<string, unknown> } | null = null;
  for (let a = 0; a < 8; a++) {
    g = await post(`/interactions/${ORG_SA.toLowerCase()}/grant`, { delegation: toWire(ix.delegation), sessionLeaf: toWire(leaf.delegation) }, s);
    if (g.status === 200 && g.json.ok !== false) break;
    console.log(`  grant attempt ${a + 1}: ${g.status} ${JSON.stringify(g.json).slice(0, 120)}`);
    if (!/verification|approved|not.*found|stale|409/i.test(JSON.stringify(g.json))) break;
    await new Promise((r) => setTimeout(r, 4000));
  }
  if (!g || g.status !== 200 || g.json.ok === false) throw new Error('grant install failed: ' + JSON.stringify(g?.json).slice(0, 300));
  console.log('\n=== DISCUSSION STORAGE ENABLED ===', JSON.stringify(g.json).slice(0, 200));
}

const HOME = process.env.HOME_URL ?? 'https://www.impact-agent.me';

// Mint an impact-agent.me AgentSession for the SERVICE agent via SIWE (held key,
// server-side). This is what skills-a2a will do to drive the sandbox as the steward.
async function siwe() {
  const nonceRes = await fetch(`${HOME}/connect/nonce`);
  const { nonce } = (await nonceRes.json()) as { nonce: string };
  const domain = new URL(HOME).host;
  const issuedAt = new Date().toISOString();
  const message =
    `${domain} wants you to sign in with your Ethereum account:\n${account.address}\n\n` +
    `Sign in to Skills.\n\nURI: ${HOME}\nVersion: 1\nChain ID: 84532\nNonce: ${nonce}\nIssued At: ${issuedAt}`;
  const signature = await account.signMessage({ message });
  const res = await fetch(`${HOME}/connect/siwe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, signature, aud: 'skills-app' }),
  });
  const body = (await res.json()) as { status?: string; token?: string; agent?: string; error?: string };
  console.log('siwe:', res.status, JSON.stringify({ status: body.status, agent: body.agent, error: body.error }));
  if (body.status === 'issued' && body.token) {
    const claims = JSON.parse(Buffer.from(body.token.split('.')[1]!, 'base64').toString());
    console.log('  session sub:', claims.sub, 'aud:', claims.aud);
    console.log('  ✓ service session minted — sub resolves to the service SA', body.agent);
  }
}

async function mintSession(): Promise<string> {
  const { nonce } = (await (await fetch(`${HOME}/connect/nonce`)).json()) as { nonce: string };
  const domain = new URL(HOME).host;
  const message = `${domain} wants you to sign in with your Ethereum account:\n${account.address}\n\nSign in to Skills.\n\nURI: ${HOME}\nVersion: 1\nChain ID: 84532\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
  const signature = await account.signMessage({ message });
  const b = (await (await fetch(`${HOME}/connect/siwe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, signature, aud: 'skills-app' }) })).json()) as { token?: string };
  if (!b.token) throw new Error('siwe mint failed');
  return b.token;
}
async function interactions(op: string, args: Record<string, unknown>, token: string, wire: unknown) {
  const res = await fetch(`${DEMO_A2A_URL}/interactions/${ORG_SA.toLowerCase()}/${op}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: token, stewardship: wire, ...args }),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}
// Drive the sandbox board as the service steward — the exact calls skills-a2a will make.
async function drive() {
  if (!ORG_SA) throw new Error('ORG_SA required');
  const cfg = JSON.parse(readFileSync(process.env.SANDBOX_CONFIG!, 'utf8'));
  const wire = cfg.stewardWire;
  const token = await mintSession();
  console.log('session minted.');
  const list = await interactions('channels.list', {}, token, wire);
  console.log('channels.list:', list.status, 'steward=', list.json.steward, 'channels=', (list.json.channels as unknown[] | undefined)?.length ?? 0);
  const created = await interactions('channels.create', { title: 'Skill test', participationPolicy: 'open' }, token, wire);
  console.log('channels.create:', created.status, JSON.stringify(created.json).slice(0, 140));
  const channelId = created.json.channelId as string;
  const put = await interactions('channels.assistantSkill.put', { markdown: '# Test\nYou are a test agent.' }, token, wire);
  console.log('assistantSkill.put:', put.status, JSON.stringify(put.json).slice(0, 100));
  if (channelId) {
    const en = await interactions('channels.assistantEnable', { channelId, trigger: 'mention', displayName: 'Skill Agent' }, token, wire);
    console.log('assistantEnable:', en.status, JSON.stringify(en.json).slice(0, 100));
  }
}

// spec 278 vault-key ceremony (approved-hash fold): provision the org's KEK + bind
// its VaultKeyAuthorization, so the org's discussion vault becomes writable.
async function enableVault() {
  if (!ORG_SA) throw new Error('ORG_SA required');
  const low = ORG_SA.toLowerCase();
  const s = await csrf();
  const info = (await (await fetch(`${DEMO_MCP_URL}/custody/vault-key/server-info?owner=${low}`)).json()) as { serverId?: string; serverKey?: string; kmsKeyRef?: string | null; defaultResources?: string[]; classificationCeiling?: string; ops?: ('read' | 'write')[] };
  console.log('server-info kmsKeyRef:', info.kmsKeyRef, 'serverKey:', info.serverKey);
  if (!info.kmsKeyRef) throw new Error('no kmsKeyRef from server-info (GCP KEK unavailable)');
  const params = {
    vaultId: String(info.serverId ?? '').trim() || 'demo-mcp',
    kmsKeyRef: info.kmsKeyRef,
    serverKey: (info.serverKey ?? '0x0000000000000000000000000000000000000001') as Address,
    allowedResources: info.defaultResources ?? ['person-pii', 'org-sensitive', 'profile', 'vault:*'],
    classificationCeiling: info.classificationCeiling ?? 'regulated.high',
    ops: info.ops ?? (['read', 'write'] as ('read' | 'write')[]),
  };
  const vk = buildVaultKeyAuthorization(ORG_SA, params);
  vk.delegation.signature = APPROVED_HASH_SENTINEL;
  const issuedAt = Math.floor(Date.now() / 1000);
  const provChallenge = keccak256(toBytes(['demo-mcp:vault-key-provision:v1', low, String(issuedAt)].join('\n')));
  console.log('vault auth digest:', vk.digest, '\nprovision challenge:', provChallenge);
  await approveHashes(ORG_SA, [vk.digest, provChallenge], s);
  console.log('vault-auth + provision-challenge approved on-chain');
  let pr!: Response; let pd: Record<string, unknown> = {};
  for (let a = 0; a < 10; a++) {
    pr = await fetch(`${DEMO_MCP_URL}/custody/vault-key/provision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner: low, issuedAt, proof: APPROVED_HASH_SENTINEL }) });
    pd = (await pr.json().catch(() => ({}))) as Record<string, unknown>;
    if (pr.ok && pd.ok === true) break;
    console.log(`  provision attempt ${a + 1}: ${pr.status} ${JSON.stringify(pd).slice(0, 100)}`);
    if (!/proof_invalid|not.*approved|stale/i.test(JSON.stringify(pd))) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log('provision:', pr.status, JSON.stringify(pd).slice(0, 160));
  if (!pr.ok || pd.ok !== true) throw new Error('provision failed');
  const br = await fetch(`${DEMO_MCP_URL}/custody/vault-key/bind`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner: ORG_SA, vaultId: params.vaultId, kmsKeyRef: params.kmsKeyRef, allowedResources: params.allowedResources, classificationCeiling: params.classificationCeiling, ops: params.ops, expiresAt: vk.expiresAt, authorization: toWire(vk.delegation) }) });
  const bd = (await br.json().catch(() => ({}))) as Record<string, unknown>;
  console.log('bind:', br.status, JSON.stringify(bd).slice(0, 160));
  if (!br.ok || bd.ok !== true) throw new Error('bind failed');
  console.log('\n=== VAULT KEY AUTHORIZED ===');
}

// Fully provision one sandbox org (create + storage + vault) and emit its pool entry.
async function provisionAll() {
  const c = await createOrg();
  ORG_SA = c.orgSA; // enableStorage/enableVault read the module ORG_SA
  await enableStorage();
  await enableVault();
  console.log('\n=== POOL ENTRY (add to SANDBOX_POOL) ===');
  console.log(JSON.stringify({ orgSA: c.orgSA, wire: c.stewardWire }));
}

const step = process.argv[2] ?? 'create-org';
if (step === 'create-org') console.log(JSON.stringify(await createOrg()));
else if (step === 'storage') await enableStorage();
else if (step === 'vault') await enableVault();
else if (step === 'all') await provisionAll();
else if (step === 'siwe') await siwe();
else if (step === 'drive') await drive();
else { console.error('unknown step', step); process.exit(1); }
