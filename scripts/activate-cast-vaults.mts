/**
 * ACTIVATE A PERSONA'S VAULT — the plane a second person agent needs before it can be given a playbook.
 *
 *   npx tsx scripts/activate-cast-vaults.mts                       (every part in demo/cast.faithnet.json)
 *   npx tsx scripts/activate-cast-vaults.mts emile-elena.me elena  (one, by name and custodian)
 *
 * WHY IT IS A SEPARATE ACT FROM THE CHARTER. Chartering mints the agent on chain and names it. A VAULT is a
 * different thing: an owner-scoped key at demo-mcp plus the authorization that lets the vault server use it,
 * and neither exists until somebody with the owner's credential asks for them. The browser's person-create
 * ceremony does this as a REQUIRED step right after the agent lands (`activateVaultIfNeeded`), because a
 * persona with no vault has nowhere to keep what it learns. A script driving `/harness/ask` skips it, and the
 * first thing that notices is the playbook: `archetypeAssignmentPut` writes into the agent's own vault, so it
 * answers `vault_key_unauthorized` for an agent that has none — which reads like a permission problem and is
 * actually an empty room.
 *
 * WHOSE SIGNATURE. The persona's, made by the one credential its account accepts — the custodian's, the same
 * one that chartered it. Two signatures per persona: a freshness-bound control proof so the KEK-provision
 * route will mint a key for this owner at all, and the vault-key AUTHORIZATION itself, which is a delegation
 * from the persona to the vault server's key carrying a single non-subdelegable VAULT_KEY_USE caveat.
 *
 * IDEMPOTENT. An owner already bound over the `vault:*` namespace is skipped, the same test the ceremony makes.
 */
import { buildVaultKeyUseCaveat, hashDelegation, ROOT_AUTHORITY, type Delegation } from '@agenticprimitives/delegation';
import { readFileSync } from 'node:fs';
import { keccak256, toBytes, type Address, type Hex } from 'viem';

const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const CHAIN = 34348;
const DM = '0x710cb1bF08C234Df397e0910331e0A29710EF4F7' as Address;
const NOTE_PATH = process.env.NOTE ?? 'demo/cast.faithnet.json';

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };

const argv = process.argv.slice(2);
const cast: Array<{ name: string; sa: string; custodian: string; character?: string }> = argv.length >= 2
  ? [{ name: argv[0]!, sa: '', custodian: argv[1]! }]
  : (JSON.parse(readFileSync(NOTE_PATH, 'utf8')).cast ?? []);
if (!cast.length) throw new Error(`no cast to activate (${NOTE_PATH} is empty — run charter-cast.mts first)`);

// One sign-in per custodian: Alice holds two of these.
const sessions = new Map<string, string>();
const sessionFor = async (handle: string): Promise<string> => {
  if (!sessions.has(handle)) {
    const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-web' }) }));
    if (!si.homeSession) throw new Error(`no session for ${handle}: ${JSON.stringify(si).slice(0, 200)}`);
    sessions.set(handle, si.homeSession);
  }
  return sessions.get(handle)!;
};

// The vault server's own parameters, asked once — never guessed. `defaultResources` is what decides whether a
// binding covers the `vault:*` namespace, and a binding narrower than the server's default is the stale kind
// the ceremony re-binds to upgrade.
const info = await j(await fetch(`${HOME}/mcp-bind/custody/vault-key/server-info`)) as {
  serverId?: string; serverKey?: string; defaultResources?: string[]; classificationCeiling?: string; ops?: ('read' | 'write')[];
};
if (!info?.serverKey) throw new Error(`vault server-info gave no serverKey: ${JSON.stringify(info).slice(0, 200)}`);

let done = 0; let skipped = 0; let failed = 0;
for (const part of cast) {
  const owner = String(part.sa).toLowerCase() as Address;
  if (!/^0x[0-9a-f]{40}$/.test(owner)) { console.log(`${part.name}: no address in ${NOTE_PATH}`); failed++; continue; }
  const token = await sessionFor(part.custodian);
  const sign = async (digest: Hex): Promise<Hex> => {
    const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ digest }) }));
    if (!b.signature) throw new Error(`persona-sign: ${JSON.stringify(b).slice(0, 160)}`);
    return b.signature as Hex;
  };

  const status = await j(await fetch(`${HOME}/mcp-bind/custody/vault-key/is-bound?owner=${owner}`)) as { bound?: boolean; allowedResources?: string[] };
  if (status?.bound === true && (status.allowedResources ?? []).includes('vault:*')) {
    console.log(`${part.name}: already bound over vault:*`);
    skipped++; continue;
  }

  try {
    // 1 · the per-owner key. The route wields an admin credential, so it wants a control proof over a
    // challenge it re-derives itself — the body's `owner` is never taken on trust.
    const issuedAt = Math.floor(Date.now() / 1000);
    const challenge = keccak256(toBytes(['demo-mcp:vault-key-provision:v1', owner, String(issuedAt)].join('\n')));
    const prov = await j(await fetch(`${HOME}/mcp-bind/custody/vault-key/provision`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner, issuedAt, proof: await sign(challenge) }),
    })) as { ok?: boolean; kmsKeyRef?: string; error_description?: string; detail?: string };
    if (!prov?.ok || !prov.kmsKeyRef) throw new Error(prov?.error_description ?? prov?.detail ?? JSON.stringify(prov).slice(0, 200));

    // 2 · the authorization: persona → the vault server's key, ONE non-subdelegable VAULT_KEY_USE caveat.
    const validUntil = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90;
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    let salt = 0n; for (const b of bytes) salt = (salt << 8n) | BigInt(b);
    const allowedResources = info.defaultResources ?? ['person-pii', 'org-sensitive', 'profile', 'vault:*'];
    const classificationCeiling = info.classificationCeiling ?? 'regulated.high';
    const ops = info.ops ?? ['read', 'write'];
    const vaultId = info.serverId ?? 'demo-mcp';
    const d: Delegation = {
      delegator: owner,
      delegate: info.serverKey as Address,
      authority: ROOT_AUTHORITY,
      caveats: [buildVaultKeyUseCaveat({ vaultId, kmsKeyRef: prov.kmsKeyRef, resources: allowedResources, classificationCeiling, ops, noSubdelegation: true })],
      salt,
      signature: '0x',
    };
    d.signature = await sign(hashDelegation(d, CHAIN, DM));
    const bound = await j(await fetch(`${HOME}/mcp-bind/custody/vault-key/bind`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        owner, vaultId, kmsKeyRef: prov.kmsKeyRef, allowedResources, classificationCeiling, ops,
        expiresAt: new Date(validUntil * 1000).toISOString(),
        authorization: { ...d, salt: d.salt.toString() },
      }),
    })) as { ok?: boolean; reason?: string; error?: string };
    if (bound?.ok !== true) throw new Error(bound?.reason ?? bound?.error ?? JSON.stringify(bound).slice(0, 200));
    console.log(`${part.name}: vault activated (${prov.kmsKeyRef})`);
    done++;
  } catch (e) {
    console.log(`${part.name}: ✗ ${e instanceof Error ? e.message : String(e)}`);
    failed++;
  }
}
console.log(`\n${done} activated · ${skipped} already bound · ${failed} failed`);
if (failed) process.exit(1);
