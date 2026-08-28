/**
 * link-service-steward-local.ts — make a locally-provisioned SERVICE SA readable from its
 * steward's Home portal, the way a real org-create ceremony would have left it.
 *
 * A ceremony leaves three artifacts this out-of-band provisioning lacks:
 *   1. the spec-278 vault-key binding for the SA (without it every vault read fails closed
 *      with vault_key_unauthorized),
 *   2. the STEWARDSHIP delegation (delegator = the SA, delegate = the person) the portal's
 *      Records/Profile views read the SA's vault over,
 *   3. the related-orgs link in the person's Home carrying that delegation.
 *
 * This mints all three: the custodian key signs the vault-key authorization and the stewardship
 * delegation (raw-or-EIP-191 custodian ECDSA — the SA's ERC-1271 accepts it, same as every
 * persona flow), and the person's demo-signin home session authorizes the link write. Then it
 * VERIFIES by listing the SA's vault over the same demo-a2a rails the portal uses.
 *
 * Usage:
 *   OWNER=0x…(service SA) CUSTODIAN_KEY=0x… ORG_NAME='Gather27 workspace' \
 *   PERSON_HANDLE=david pnpm exec tsx scripts/link-service-steward-local.ts
 *   Optional: LOCAL_RPC_URL, DEMO_MCP_URL (:8788), DEMO_A2A_URL (:8787), HOME_URL (:5373).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { keccak256, toBytes, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const APP_ROOT = join(import.meta.dirname ?? __dirname, '..');
const REPO_ROOT = join(APP_ROOT, '..', '..');
const NETWORK = process.env.DEPLOY_NETWORK ?? 'anvil';
const RPC_URL = process.env.LOCAL_RPC_URL ?? 'http://127.0.0.1:8545';
const MCP_URL = (process.env.DEMO_MCP_URL ?? 'http://127.0.0.1:8788').replace(/\/$/, '');
const A2A_URL = (process.env.DEMO_A2A_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const HOME_URL = (process.env.HOME_URL ?? 'http://localhost:5373').replace(/\/$/, '');
const OWNER = (process.env.OWNER ?? '') as Address;
const CUSTODIAN_KEY = (process.env.CUSTODIAN_KEY ?? '') as Hex;
const PERSON_HANDLE = process.env.PERSON_HANDLE ?? 'david';
const ORG_NAME = process.env.ORG_NAME ?? 'Service workspace';

if (!/^0x[0-9a-fA-F]{40}$/.test(OWNER)) throw new Error('OWNER (the service SA) is required');
if (!/^0x[0-9a-fA-F]{64}$/.test(CUSTODIAN_KEY)) throw new Error('CUSTODIAN_KEY is required');
const DEPLOYMENTS = join(REPO_ROOT, 'packages', 'contracts', `deployments-${NETWORK}.json`);
if (!existsSync(DEPLOYMENTS)) throw new Error(`${DEPLOYMENTS} not found`);
const d = JSON.parse(readFileSync(DEPLOYMENTS, 'utf8')) as Record<string, unknown>;

// src/lib/chain.ts (which the delegation builders read) takes chain + contracts from NEXT_PUBLIC_*.
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
const { buildVaultKeyAuthorization, issueSiteDelegation, toWire } = await import('../src/lib/delegation');

const custodian = privateKeyToAccount(CUSTODIAN_KEY);
const sign = (digest: Hex) => custodian.signMessage({ message: { raw: digest } });

// 1. spec-278 vault-key binding for the service SA (provision + bind) — idempotent.
async function activateVault(): Promise<string> {
  const status = (await fetch(`${MCP_URL}/custody/vault-key/is-bound?owner=${OWNER}`).then((r) => r.json())) as { bound?: boolean; allowedResources?: string[] };
  if (status.bound && status.allowedResources?.includes('vault:*')) return 'vault bound';
  const info = (await fetch(`${MCP_URL}/custody/vault-key/server-info?owner=${OWNER.toLowerCase()}`).then((r) => r.json())) as {
    serverKey?: string; defaultResources?: string[]; classificationCeiling?: string; ops?: ('read' | 'write')[];
  };
  const issuedAt = Math.floor(Date.now() / 1000);
  const challenge = keccak256(toBytes(['demo-mcp:vault-key-provision:v1', OWNER.toLowerCase(), String(issuedAt)].join('\n')));
  const prov = (await fetch(`${MCP_URL}/custody/vault-key/provision`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ owner: OWNER.toLowerCase(), issuedAt, proof: await sign(challenge) }),
  }).then((r) => r.json())) as { ok?: boolean; kmsKeyRef?: string; error_description?: string; detail?: string };
  if (!prov.ok || !prov.kmsKeyRef) return `vault provision failed: ${prov.error_description ?? prov.detail ?? 'unknown'}`;
  const params = {
    vaultId: 'demo-mcp',
    kmsKeyRef: prov.kmsKeyRef,
    serverKey: (info.serverKey ?? '0x0000000000000000000000000000000000000001') as Address,
    allowedResources: info.defaultResources ?? ['person-pii', 'org-sensitive', 'profile', 'vault:*'],
    classificationCeiling: info.classificationCeiling ?? 'regulated.high',
    ops: info.ops ?? (['read', 'write'] as ('read' | 'write')[]),
  };
  const { delegation, digest, expiresAt } = buildVaultKeyAuthorization(OWNER, params);
  delegation.signature = await sign(digest);
  const bind = (await fetch(`${MCP_URL}/custody/vault-key/bind`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ owner: OWNER, ...params, expiresAt, authorization: toWire(delegation) }),
  }).then((r) => r.json())) as { ok?: boolean; reason?: string; error?: string };
  return bind.ok ? 'vault ACTIVATED' : `vault bind failed: ${bind.reason ?? bind.error ?? 'unknown'}`;
}
const vault = await activateVault();

// 2. The person + their home session (demo-signin — the same door every persona flow uses).
const signin = (await fetch(`${HOME_URL}/connect/demo-signin`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ handle: PERSON_HANDLE, client_id: 'gather-app' }),
}).then((r) => r.json())) as { agent?: string; homeSession?: string; error?: string };
if (!signin.agent || !signin.homeSession) throw new Error(`demo-signin failed for ${PERSON_HANDLE}: ${signin.error ?? 'no session'}`);
const person = signin.agent as Address;

// 3. Custodian-signed STEWARDSHIP delegation (SA → person) + the related-orgs link carrying it.
const stewardship = toWire(await issueSiteDelegation(OWNER, person, sign));
const link = (await fetch(`${HOME_URL}/connect/related-orgs`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${signin.homeSession}` },
  body: JSON.stringify({
    person, orgAgent: OWNER, orgName: ORG_NAME, kind: 'org', relationship: 'steward',
    displayName: ORG_NAME, stewardshipDelegation: stewardship,
  }),
}).then((r) => r.json())) as { ok?: boolean; error?: string };

// 4. VERIFY over the portal's own rails: list the SA's vault with the stewardship delegation.
const list = (await fetch(`${A2A_URL}/mcp/vault/list`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ delegation: stewardship, requester: person }),
}).then((r) => r.json()).catch((e) => ({ error: String(e) }))) as { ok?: boolean; records?: unknown[]; error?: string; detail?: string };

console.error(`  ${ORG_NAME}: ${vault} · link ${link.ok ? 'written' : `FAILED (${link.error ?? '?'})`} · vault list ${list.ok ? `OK (${(list.records ?? []).length} records)` : `FAILED (${list.detail ?? list.error ?? '?'})`}`);
console.log(JSON.stringify({ owner: OWNER, person, vault, linked: !!link.ok, records: list.records ?? null }));
