/**
 * provision-demo-personas-local.ts — the demo people (Alice, Nathan, …) on a LOCAL chain.
 *
 * `demo/personas.json` is the roster the deployed Home uses: each person is a real Smart Agent on
 * Base Sepolia whose custodian is a seeded (public, demo-only) EOA. Those SA addresses are CREATE2
 * results of the Base Sepolia factory, so on a local chain (anvil / faithnet) the same keys derive
 * DIFFERENT addresses — and the accounts don't exist until someone deploys them.
 *
 * This script makes the roster real locally, idempotently:
 *   1. derive each persona's SA from the local factory ({ mode 0, custodians [eoa], salt 0 } — the
 *      exact spec the Home's SIWE bootstrap uses, so "sign in with that wallet" lands on the same SA)
 *   2. deploy it (gas paid by anvil[0]) when it has no code yet
 *   3. claim `<handle>.impact` FROM the SA (register + setPrimaryName in one paymaster-sponsored
 *      userOp, custodian-signed — the Home's own name-claim shape) so reverse resolution shows the name
 *   4. run the spec-278 vault-key ceremony at demo-mcp (provision + bind), signed by the custodian —
 *      what onboarding does for a real member; without it every vault read is vault_key_unauthorized
 *   5. write `demo/personas.local.json` (gitignored) — the roster shape with local SAs — which
 *      scripts/gen-dev-vars.ts turns into the local Home's DEMO_PERSONA_KEYS.
 *
 * Usage (after `pnpm dev:contracts` / deploy:anvil, with demo-mcp running for step 4):
 *   pnpm --filter @agenticprimitives-demo/sso-next exec tsx scripts/provision-demo-personas-local.ts
 *   LOCAL_RPC_URL=… DEMO_MCP_URL=… DEPLOY_NETWORK=anvil  (defaults: 127.0.0.1:8545 / 127.0.0.1:8788)
 *
 * Lives in the Home app (not scripts/) so it resolves the same packages + src/lib/delegation.ts the
 * Home's ceremonies use. Orgs a persona `custodies` on Base Sepolia are NOT recreated here.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, createWalletClient, http, keccak256, toBytes, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { AgentAccountClient, buildExecuteBatchCallData, type ContractCall } from '@agenticprimitives/agent-account';
import { agentNameRegistryAbi, buildSetPrimaryNameCall, buildSubregistryRegisterCall, namehash } from '@agenticprimitives/agent-naming';

const APP_ROOT = join(import.meta.dirname ?? __dirname, '..');
const REPO_ROOT = join(APP_ROOT, '..', '..');
const NETWORK = process.env.DEPLOY_NETWORK ?? 'anvil';
const RPC_URL = process.env.LOCAL_RPC_URL ?? 'http://127.0.0.1:8545';
const MCP_URL = (process.env.DEMO_MCP_URL ?? 'http://127.0.0.1:8788').replace(/\/$/, '');
// ROSTER / LOCAL_ROSTER / AGENT_NAME_PARENT are parameters (2026-09-12): a SECOND roster — new people for a shadow
// deployment — provisions the same way, under the parent the deployment claims names in (`me` on faithnet).
const ROSTER = process.env.ROSTER ?? join(REPO_ROOT, 'demo', 'personas.json');
const LOCAL_ROSTER = process.env.LOCAL_ROSTER ?? join(REPO_ROOT, 'demo', 'personas.local.json');
const DEPLOYMENTS = join(REPO_ROOT, 'packages', 'contracts', `deployments-${NETWORK}.json`);
// anvil[0] — pays gas for deploys + name registrations. Public dev key; local chains only.
const GAS_PAYER: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

type RosterEntry = { name?: string; blurb?: string; sa?: string; eoaPrivateKey?: string; privateKey?: string; custodies?: unknown };

if (!existsSync(ROSTER)) throw new Error(`${ROSTER} not found`);
if (!existsSync(DEPLOYMENTS)) throw new Error(`${DEPLOYMENTS} not found — deploy the contracts first (pnpm dev:contracts)`);
const roster = JSON.parse(readFileSync(ROSTER, 'utf8')) as Record<string, RosterEntry>;
const d = JSON.parse(readFileSync(DEPLOYMENTS, 'utf8')) as {
  chainId: number; entryPoint: Address; agentAccountFactory: Address; permissionlessSubregistry?: Address; permissionlessSubregistries?: Record<string, Address>;
  agentNameRegistry?: Address; smartAgentPaymaster?: Address;
};
/** The TLD names are claimed under (src/lib/domain.ts AGENT_NAME_PARENT — the `.impact` subregistry). */
const NAME_PARENT = process.env.AGENT_NAME_PARENT ?? 'impact';

// src/lib/chain.ts (which the delegation builders read) takes the chain + contracts from NEXT_PUBLIC_*;
// Next loads .env.local for the app, tsx does not — so load it here, before the dynamic import.
const envLocal = join(APP_ROOT, '.env.local');
if (existsSync(envLocal)) {
  for (const line of readFileSync(envLocal, 'utf8').split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
process.env.NEXT_PUBLIC_CHAIN_ID ??= String(d.chainId);
process.env.NEXT_PUBLIC_RPC_URL ??= RPC_URL;
process.env.NEXT_PUBLIC_CONTRACTS_JSON ??= JSON.stringify(d);
const { buildVaultKeyAuthorization, toWire } = await import('../src/lib/delegation');

const pub = createPublicClient({ transport: http(RPC_URL) });
const chainId = Number(await pub.getChainId());
if (chainId !== d.chainId) throw new Error(`RPC chain ${chainId} ≠ deployments-${NETWORK}.json chain ${d.chainId}`);
const payer = privateKeyToAccount(GAS_PAYER);
const wallet = createWalletClient({ account: payer, transport: http(RPC_URL) });
const accounts = new AgentAccountClient({ rpcUrl: RPC_URL, chainId, entryPoint: d.entryPoint, factory: d.agentAccountFactory });

const mcpUp = await fetch(`${MCP_URL}/health`).then((r) => r.ok).catch(() => false);
if (!mcpUp) console.warn(`  demo-mcp not reachable at ${MCP_URL} — vault-key ceremony skipped (reads will be vault_key_unauthorized)`);

/** The spec-278 ceremony as onboarding.ts runs it (activateVault): provision (owner-control proof) + bind
 *  (custodian-signed VaultKeyAuthorization). Idempotent: skipped when a current binding covers `vault:*`. */
async function activateVault(sa: Address, pk: Hex): Promise<string> {
  const custodian = privateKeyToAccount(pk);
  const sign = (digest: Hex) => custodian.signMessage({ message: { raw: digest } }); // EIP-191 over the digest, as the wallet rail
  const status = (await fetch(`${MCP_URL}/custody/vault-key/is-bound?owner=${sa}`).then((r) => r.json())) as { bound?: boolean; allowedResources?: string[] };
  if (status.bound && status.allowedResources?.includes('vault:*')) return 'vault bound';
  const info = (await fetch(`${MCP_URL}/custody/vault-key/server-info?owner=${sa.toLowerCase()}`).then((r) => r.json())) as {
    serverId?: string; serverKey?: string; kmsKeyRef?: string | null; defaultResources?: string[]; classificationCeiling?: string; ops?: ('read' | 'write')[];
  };
  if (!info.kmsKeyRef) return 'vault: no kmsKeyRef (set DEMO_VAULT_LOCAL_KEK_SECRET on demo-mcp)';
  const issuedAt = Math.floor(Date.now() / 1000);
  const challenge = keccak256(toBytes(['demo-mcp:vault-key-provision:v1', sa.toLowerCase(), String(issuedAt)].join('\n')));
  const prov = (await fetch(`${MCP_URL}/custody/vault-key/provision`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ owner: sa.toLowerCase(), issuedAt, proof: await sign(challenge) }),
  }).then((r) => r.json())) as { ok?: boolean; kmsKeyRef?: string; error_description?: string; detail?: string };
  if (!prov.ok || !prov.kmsKeyRef) return `vault provision failed: ${prov.error_description ?? prov.detail ?? 'unknown'}`;
  const params = {
    vaultId: String(info.serverId ?? '').trim() || 'demo-mcp',
    kmsKeyRef: prov.kmsKeyRef,
    serverKey: (info.serverKey ?? '0x0000000000000000000000000000000000000001') as Address,
    allowedResources: info.defaultResources ?? ['person-pii', 'org-sensitive', 'profile', 'vault:*'],
    classificationCeiling: info.classificationCeiling ?? 'regulated.high',
    ops: info.ops ?? (['read', 'write'] as ('read' | 'write')[]),
  };
  const { delegation, digest, expiresAt } = buildVaultKeyAuthorization(sa, params);
  delegation.signature = await sign(digest);
  const bind = (await fetch(`${MCP_URL}/custody/vault-key/bind`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ owner: sa, ...params, expiresAt, authorization: toWire(delegation) }),
  }).then((r) => r.json())) as { ok?: boolean; reason?: string; error?: string };
  return bind.ok ? 'vault ACTIVATED' : `vault bind failed: ${bind.reason ?? bind.error ?? 'unknown'}`;
}

/** Claim `<handle>.impact` FROM THE SMART AGENT and make it the primary (reverse) name — one batched
 *  userOp sponsored by the dev-mode paymaster, signed by the custodian, exactly as the Home's name
 *  claim runs. The permissionless subregistry allows ONE claim per caller, so registering from a
 *  shared payer EOA works once and then reverts AlreadyClaimed; the SA must be the caller. Reverse
 *  resolution (`reverseResolveString`) is what the relying apps display, so setPrimaryName matters. */
async function claimName(handle: string, sa: Address, pk: Hex): Promise<string> {
  // The subregistry of the parent being claimed under: the typed roots (`me`, `org`, …) each have their own
  // (spec 346); `.impact` is the legacy single one.
  const subregistry = d.permissionlessSubregistries?.[NAME_PARENT] ?? (NAME_PARENT === 'impact' ? d.permissionlessSubregistry : undefined);
  if (!subregistry || !d.agentNameRegistry || !d.smartAgentPaymaster) return `name: n/a (no ${NAME_PARENT} subregistry / naming / paymaster deployment)`;
  const name = `${handle}.${NAME_PARENT}`;
  const node = namehash(name) as Hex;
  const read = <T>(fn: 'owner' | 'primaryName', args: readonly unknown[]) =>
    pub.readContract({ address: d.agentNameRegistry!, abi: agentNameRegistryAbi, functionName: fn, args } as never).catch(() => null) as Promise<T | null>;
  const owner = ((await read<Address>('owner', [node])) ?? '0x0000000000000000000000000000000000000000').toLowerCase();
  const primary = ((await read<Hex>('primaryName', [sa])) ?? '0x').toLowerCase();
  if (primary === node.toLowerCase()) return `${name} (primary)`;
  const calls: ContractCall[] = [];
  if (owner === '0x0000000000000000000000000000000000000000') {
    calls.push(buildSubregistryRegisterCall({ subregistry, label: handle, newOwner: sa }));
  } else if (owner !== sa.toLowerCase()) {
    return `name: ${name} is owned by ${owner.slice(0, 10)}… — not claimed`;
  }
  calls.push(buildSetPrimaryNameCall({ registry: d.agentNameRegistry, node }));
  const custodian = privateKeyToAccount(pk);
  const { userOp, userOpHash } = await accounts.buildCallUserOp({
    sender: sa, callData: buildExecuteBatchCallData(calls), paymaster: d.smartAgentPaymaster,
  });
  userOp.signature = await custodian.signMessage({ message: { raw: userOpHash } }); // the wallet rail: EIP-191 over the hash
  await accounts.submitCallUserOp(userOp, payer);
  const after = ((await read<Hex>('primaryName', [sa])) ?? '0x').toLowerCase();
  return after === node.toLowerCase() ? `${name} CLAIMED (primary set)` : `name: userOp landed but primaryName not set (${after.slice(0, 10)}…)`;
}

const out: Record<string, { name: string; blurb?: string; sa: string; eoaPrivateKey: Hex; eoaAddress: Address }> = {};
for (const [handle, p] of Object.entries(roster)) {
  const pk = (p.eoaPrivateKey ?? p.privateKey ?? '') as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) { console.warn(`  ${handle}: no key in roster — skipped`); continue; }
  const eoa = privateKeyToAccount(pk).address;
  const spec = { mode: 0, custodians: [eoa] as const, salt: 0n };
  const sa = await accounts.getAddressForAgentAccount(spec);
  const deployed = await accounts.isDeployed(sa);
  if (!deployed) await accounts.createAgentAccountFromAccount(spec, payer);

  const named = await claimName(handle, sa, pk).catch((e) => `name error: ${String(e).split('\n')[0].slice(0, 100)}`);
  const vault = mcpUp ? await activateVault(sa, pk).catch((e) => `vault error: ${e instanceof Error ? e.message : String(e)}`) : 'vault skipped';
  out[handle] = { name: p.name ?? handle, ...(p.blurb ? { blurb: p.blurb } : {}), sa: sa.toLowerCase(), eoaPrivateKey: pk, eoaAddress: eoa };
  console.log(`  ${handle.padEnd(8)} ${sa}  ${deployed ? 'exists' : 'DEPLOYED'}  ${named}  ${vault}`);
}

writeFileSync(LOCAL_ROSTER, JSON.stringify(out, null, 2) + '\n');
console.log(`provision-demo-personas-local: ${Object.keys(out).length} personas on chain ${chainId} → ${LOCAL_ROSTER}`);
