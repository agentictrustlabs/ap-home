/**
 * Spec 387 W2 — BIND A CHARTERED AGENT'S VAULT KEY the way the Home's create ceremony does (spec 278 §3.3), for
 * an agent a script chartered through the Ask: server-info → provision (custodian-signed challenge) → the
 * VaultKeyAuthorization (agent → demo-mcp server key, one non-subdelegable VAULT_KEY_USE caveat) signed by the
 * agent's custodian (persona-sign → ERC-1271) → bind. Without it every vault write at the agent — its playbook
 * assignment included — fails closed `vault_key_unauthorized`.
 *
 *   npx tsx scripts/bind-vault-key.mts <custodian-handle> <agent-address> [more agents…]
 */
import { buildVaultKeyAuthorization, type VaultKeyCeremonyParams } from '../apps/demo-sso-next/src/lib/delegation';
import { keccak256, toBytes, type Address, type Hex } from 'viem';

const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const [handle, ...agents] = process.argv.slice(2);
if (!handle || !agents.length) throw new Error('usage: bind-vault-key.mts <custodian-handle> <agent-address…>');
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 200), _status: r.status }; } };
const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-web' }) }));
if (!si.homeSession) throw new Error(`no session for ${handle}`);
const sign = async (digest: Hex): Promise<Hex> => { const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${si.homeSession}` }, body: JSON.stringify({ digest }) })); if (!b.signature) throw new Error(`persona-sign: ${JSON.stringify(b).slice(0, 160)}`); return b.signature; };
const H = { 'content-type': 'application/json' };
let failed = false;
for (const a of agents) {
  const low = a.toLowerCase() as Address;
  const bound = await j(await fetch(`${HOME}/mcp-bind/custody/vault-key/is-bound?owner=${low}`));
  if (bound.bound === true) { console.log(`· ${low}: already bound`); continue; }
  const info = await j(await fetch(`${HOME}/mcp-bind/custody/vault-key/server-info?owner=${low}`)) as { serverId?: string; serverKey?: string; kmsKeyRef?: string | null; defaultResources?: string[]; classificationCeiling?: string; ops?: ('read' | 'write')[] };
  if (!info?.kmsKeyRef) { console.log(`✗ ${low}: server-info names no kmsKeyRef`); failed = true; continue; }
  const params: VaultKeyCeremonyParams = {
    vaultId: String(info.serverId ?? '').trim() || 'demo-mcp', kmsKeyRef: info.kmsKeyRef, serverKey: (info.serverKey ?? '0x0000000000000000000000000000000000000001') as Address,
    allowedResources: info.defaultResources ?? ['person-pii', 'org-sensitive', 'profile', 'vault:*'], classificationCeiling: info.classificationCeiling ?? 'regulated.high', ops: info.ops ?? ['read', 'write'],
    validitySeconds: 60 * 60 * 24 * 365,
  };
  const issuedAt = Math.floor(Date.now() / 1000);
  const proof = await sign(keccak256(toBytes(['demo-mcp:vault-key-provision:v1', low, String(issuedAt)].join('\n'))));
  const prov = await j(await fetch(`${HOME}/mcp-bind/custody/vault-key/provision`, { method: 'POST', headers: H, body: JSON.stringify({ owner: low, issuedAt, proof }) }));
  if (prov.ok !== true) { console.log(`✗ ${low}: provision ${JSON.stringify(prov).slice(0, 200)}`); failed = true; continue; }
  const vk = buildVaultKeyAuthorization(low, params);
  vk.delegation.signature = await sign(vk.digest);
  const bind = await j(await fetch(`${HOME}/mcp-bind/custody/vault-key/bind`, { method: 'POST', headers: H, body: JSON.stringify({
    owner: low, vaultId: params.vaultId, kmsKeyRef: params.kmsKeyRef, allowedResources: params.allowedResources, classificationCeiling: params.classificationCeiling, ops: params.ops,
    expiresAt: vk.expiresAt, authorization: { ...vk.delegation, salt: vk.delegation.salt.toString() },
  }) }));
  if (bind.ok !== true) { console.log(`✗ ${low}: bind ${JSON.stringify(bind).slice(0, 200)}`); failed = true; continue; }
  console.log(`✓ ${low}: vault key bound (${params.kmsKeyRef}) until ${vk.expiresAt.slice(0, 10)}`);
}
if (failed) process.exit(1);
