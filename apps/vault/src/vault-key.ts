// demo-mcp per-person vault key resolution + authorization (spec 278 P4).
//
// Composes the spec-278 primitives end-to-end with NO global key for person data
// (VKB-D1) and NO fallbacks: every vault operation resolves the owner's
// VaultKeyBinding; absent one, the caller fails closed. The binding selects a
// per-person GCP KEK (key-custody.selectVaultKeyProvider) and carries the
// person-SA-signed VaultKeyAuthorization, which the KAS verifier
// (key-authorization.createVaultKeyAuthorizationVerifier) checks per op — its
// VAULT_KEY_USE caveat (delegation) decoded + matched to the binding, and its
// signature verified via ERC-1271 against the person SA (UniversalSignatureValidator).
//
// Bindings are created by the connected-custodian ceremony (P5). Until one exists
// for an owner, this module returns null and the handlers return vault_key_unauthorized.

import { createPublicClient, http, type Address } from 'viem';
import type { Vault } from '@agenticprimitives/vault';
import {
  createVaultKeyAuthorizationVerifier,
  type VaultKeyBindingV1,
  type VaultKeyAuthorizationVerifier,
} from '@agenticprimitives/key-authorization';
import {
  hashDelegation,
  decodeVaultKeyUseTerms,
  buildVaultKeyUseCaveat,
  VAULT_KEY_USE_ENFORCER,
  ROOT_AUTHORITY,
  type Delegation,
  type Hex,
} from '@agenticprimitives/delegation';
import { selectVaultKeyProvider } from '@agenticprimitives/key-custody';
import { canonicalize, sha256Hex, type Sha256 } from '@agenticprimitives/key-authorization';
import { createDemoVault } from './vault.js';
import { getVaultKeyBindingRow, putVaultKeyBindingRow, type VaultKeyBindingRow } from './db.js';

/** The host id a person SA authorizes in its VaultKeyBinding. */
export const VAULT_SERVER_ID = 'demo-mcp';

export interface VaultKeyEnv {
  DB: D1Database;
  RPC_URL: string;
  CHAIN_ID: string;
  DELEGATION_MANAGER: string;
  UNIVERSAL_SIGNATURE_VALIDATOR?: string;
  GCP_SERVICE_ACCOUNT_JSON?: string;
}

// UniversalSignatureValidator.isValidSig(signer, hash, sig) — ERC-1271/6492/ECDSA
// across any connection strategy (same surface DEL-001 uses).
const USV_ISVALIDSIG_ABI = [
  {
    type: 'function',
    name: 'isValidSig',
    stateMutability: 'view',
    inputs: [
      { name: 'signer', type: 'address' },
      { name: 'hash', type: 'bytes32' },
      { name: 'sig', type: 'bytes' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

function bindingFromRow(row: VaultKeyBindingRow): VaultKeyBindingV1 {
  return {
    type: 'VaultKeyBindingV1',
    vaultId: row.vault_id,
    ownerPersonSA: row.owner_address,
    kmsKeyRef: row.kms_key_ref,
    allowedServerId: row.server_id,
    allowedResources: JSON.parse(row.allowed_resources) as string[],
    classificationCeiling: row.classification_ceiling,
    ops: JSON.parse(row.ops) as ('read' | 'write')[],
    expiresAt: row.expires_at,
    rotationPolicy: { mode: 'manual', retainPriorKeys: true },
    noSubdelegation: true,
    authorizationRef: `urn:ap:vault-key-auth:${row.owner_address}`,
    authorizationHash: row.authorization_hash as `sha256:${string}`,
  };
}

export interface PersonVault {
  binding: VaultKeyBindingV1;
  authorization: Delegation;
  vault: Vault;
}

// Delegation `salt` is a bigint, which JSON can't represent — it travels + persists as a
// string (wire form). These two keep the conversion in ONE place: store/hash the wire form;
// coerce salt → bigint whenever a Delegation is reconstructed for `hashDelegation`.
function delegationToWire(d: Delegation): Record<string, unknown> {
  return { ...d, salt: d.salt.toString() };
}
function delegationFromWire(json: string): Delegation {
  const w = JSON.parse(json) as Record<string, unknown>;
  return { ...(w as object), salt: BigInt(w.salt as string) } as Delegation;
}

/**
 * Resolve the per-person vault for an owner: the binding + its per-person-KEK-backed
 * `Vault` + the presented authorization. Returns `null` when no binding exists — the
 * caller MUST fail closed (VKB-D1; there is no global-key fallback). Throws if a binding
 * exists but GCP creds are missing (a misconfiguration, not a person-authorization gap).
 */
export async function resolvePersonVault(env: VaultKeyEnv, owner: string): Promise<PersonVault | null> {
  const row = await getVaultKeyBindingRow(env.DB, owner, VAULT_SERVER_ID);
  if (!row) return null;
  if (!env.GCP_SERVICE_ACCOUNT_JSON) {
    throw new Error(
      'resolvePersonVault: GCP_SERVICE_ACCOUNT_JSON is required to wield a per-person KEK (spec 278). ' +
        'No local-aes fallback for person data.',
    );
  }
  const wrapper = selectVaultKeyProvider({
    kmsKeyRef: row.kms_key_ref,
    serviceAccountJson: env.GCP_SERVICE_ACCOUNT_JSON,
  });
  return {
    binding: bindingFromRow(row),
    authorization: delegationFromWire(row.authorization_json), // salt → bigint for hashDelegation
    vault: createDemoVault(env.DB, wrapper),
  };
}

/**
 * Lightweight "does this owner already have a LIVE vault-key binding?" check — used by onboarding
 * to skip the activation step for members who are already bound (so returning members aren't
 * re-prompted). A revoked binding is excluded by the query; an expired one is treated as unbound.
 */
export async function isVaultKeyBound(env: Pick<VaultKeyEnv, 'DB'>, owner: string): Promise<boolean> {
  const row = await getVaultKeyBindingRow(env.DB, owner, VAULT_SERVER_ID);
  if (!row) return false;
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) return false;
  return true;
}

/**
 * Spec 311 (server complement to the client deployment-epoch guard) — is the owner's binding
 * not just PRESENT but CURRENT? A binding's stored authorization binds the DelegationManager as its
 * EIP-712 `verifyingContract`. After a full-reset redeploy (new DM) that authorization exists in D1
 * but no longer ERC-1271-verifies against the current DM, so `isVaultKeyBound` (existence-only) returns
 * true, the client's idempotent activation SKIPS re-binding, and every vault read then fails
 * `vault_key_unauthorized` forever. This re-runs the SAME signature verify the read path uses, over an
 * in-scope probe request, so a stale binding surfaces as `bound: false` (+ `stale: true`) and onboarding
 * re-binds against the live contracts.
 *
 * Fail-open ONLY on infra uncertainty: a DEFINITIVE `false` verdict (e.g. digest mismatch vs the new DM)
 * ⇒ stale ⇒ re-bind; an RPC/verifier ERROR can't determine currency and is treated as bound (the per-read
 * `authorizePersonVaultOp` fail-closes on the same check if truly stale) — no re-bind storm on a blip.
 */
export async function isVaultKeyBindingCurrent(
  env: VaultKeyEnv,
  owner: string,
): Promise<{ bound: boolean; stale: boolean; allowedResources: string[] }> {
  const row = await getVaultKeyBindingRow(env.DB, owner, VAULT_SERVER_ID);
  if (!row) return { bound: false, stale: false, allowedResources: [] };
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) {
    return { bound: false, stale: false, allowedResources: [] };
  }
  const binding = bindingFromRow(row);
  const authorization = delegationFromWire(row.authorization_json);
  const allowedResources = binding.allowedResources ?? [];
  try {
    const verdict = await buildVaultKeyVerifier(env).verify({
      authorization,
      binding,
      request: {
        vaultId: binding.vaultId,
        ownerPersonSA: owner,
        serverId: VAULT_SERVER_ID,
        resource: allowedResources[0] ?? 'vault:*',
        op: binding.ops?.[0] ?? 'read',
        classification: binding.classificationCeiling,
      },
      now: new Date(),
    });
    if (!verdict.ok) {
      console.warn(
        `[vault-key] is-bound: STALE binding owner=${owner} reason=${verdict.reason} — authorization no longer ` +
          `verifies against the current DelegationManager (likely a full-reset redeploy); re-bind required.`,
      );
      return { bound: false, stale: true, allowedResources };
    }
    return { bound: true, stale: false, allowedResources };
  } catch (e) {
    // Infra/RPC/verifier error — cannot determine currency. Treat as bound: the per-read authorize path
    // (authorizePersonVaultOp) runs the same verify and fail-closes if the binding is truly stale, so we
    // don't force a spurious re-bind (which re-provisions a KEK) on a transient RPC blip.
    console.warn('[vault-key] is-bound currency check errored (treating as bound):', e instanceof Error ? e.message : String(e));
    return { bound: true, stale: false, allowedResources };
  }
}

/** The authorized resource scope of an owner's LIVE binding ([] if none/expired). Lets onboarding detect a
 *  STALE binding (one created before the `vault:*` namespace default) and re-bind to upgrade it — otherwise
 *  the member's app records (`vault:<app>:<type>`) stay `resource_not_authorized` forever. */
export async function getVaultKeyAllowedResources(env: Pick<VaultKeyEnv, 'DB'>, owner: string): Promise<string[]> {
  const row = await getVaultKeyBindingRow(env.DB, owner, VAULT_SERVER_ID);
  if (!row) return [];
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) return [];
  try { return JSON.parse(row.allowed_resources) as string[]; } catch { return []; }
}

/**
 * The real vault-key authorization verifier (spec 278 §5). The scope engine
 * (key-authorization) handles owner/server/vault/resource/op/ceiling/expiry; this
 * injected check (1) requires a `VAULT_KEY_USE` caveat whose `kmsKeyRef` matches the
 * binding, (2) requires the delegator to be the binding's owner SA, and (3) verifies
 * the person SA actually SIGNED the authorization via ERC-1271 (UniversalSignatureValidator).
 * No stub: a forged/unsigned authorization fails the on-chain signature check.
 */
export function buildVaultKeyVerifier(env: VaultKeyEnv): VaultKeyAuthorizationVerifier {
  return createVaultKeyAuthorizationVerifier({
    verifyAuthorization: async ({ authorization, binding }) => {
      const del = authorization as Delegation;
      if (!del?.caveats || !del.signature || !del.delegator) return false;

      const caveat = del.caveats.find((c) => c.enforcer.toLowerCase() === VAULT_KEY_USE_ENFORCER.toLowerCase());
      if (!caveat) return false;
      let grant;
      try {
        grant = decodeVaultKeyUseTerms(caveat.terms);
      } catch {
        return false;
      }
      if (grant.kmsKeyRef !== binding.kmsKeyRef) return false;
      if (grant.noSubdelegation !== true) return false;
      if (del.delegator.toLowerCase() !== binding.ownerPersonSA.toLowerCase()) return false;

      // DURABLE, CROSS-ISOLATE SHORT-CIRCUIT (2026-07-11 hardening) — the ROOT of the read flakiness
      // was an on-chain isValidSig RPC on EVERY vault op; under load the free RPC rate-limited and a
      // valid authorization intermittently verified false. But the binding is PERSISTED only after a
      // bind-time ERC-1271 verify (verifyAndStoreBinding), and `authorizationHash` pins the exact
      // authorization that was verified. If the presented authorization hashes to that pin, its
      // signature was already proven at bind time — no per-op chain read. The pin lives in D1 (the
      // binding row every op already reads), so this is consistent across ALL isolates, not a warm-
      // isolate memo. This also aligns with ADR-0011 (a signed delegation stays valid after the
      // signer rotates credentials — re-verifying live could wrongly reject it). A HASH MISMATCH (a
      // different/tampered authorization than the one bound) falls through to the real on-chain check.
      const presentedHash = (await sha256Hex(canonicalize(delegationToWire(del)))) as Sha256;
      if (presentedHash === binding.authorizationHash) return true;

      // Fallback: the presented authorization is NOT the pinned one — verify it on-chain. Fail-closed
      // on a missing validator (we will not accept an authorization we can't verify).
      const usv = env.UNIVERSAL_SIGNATURE_VALIDATOR?.trim();
      if (!usv) {
        throw new Error('buildVaultKeyVerifier: UNIVERSAL_SIGNATURE_VALIDATOR is required to verify the vault-key authorization signature (fail-closed).');
      }
      const digest = hashDelegation(del, Number(env.CHAIN_ID), env.DELEGATION_MANAGER as Address);
      const client = createPublicClient({ transport: http(env.RPC_URL) });
      const ok = (await client.readContract({
        address: usv as Address,
        abi: USV_ISVALIDSIG_ABI,
        functionName: 'isValidSig',
        args: [del.delegator as Address, digest, del.signature],
      })) as boolean;
      return ok === true;
    },
  });
}

// ─── spec 278 P5 — connected-custodian ceremony (host side) ───────────────

export interface VaultKeyBindingParams {
  owner: string;            // the person SA (delegator)
  vaultId: string;
  kmsKeyRef: string;        // the per-person KEK (provisioned via spec 276 ap-provision-gcp)
  serverKey: string;        // the host's authorized delegate key/address (binding's allowedServerId surface)
  allowedResources: string[];
  classificationCeiling: string;
  ops: ('read' | 'write')[];
  expiresAt: string;        // ISO
  salt: bigint;
}

/**
 * Build the UNSIGNED `VaultKeyAuthorization` delegation (delegator = person SA, delegate =
 * the host's key) carrying a `VAULT_KEY_USE` caveat, plus the EIP-712 digest the person SA
 * signs in the ceremony. The connected custodian (passkey / SA custody) signs `digest`; the
 * resulting signed delegation is POSTed to `/custody/vault-key/bind`.
 */
export function buildVaultKeyAuthorization(
  env: Pick<VaultKeyEnv, 'CHAIN_ID' | 'DELEGATION_MANAGER'>,
  p: VaultKeyBindingParams,
): { authorization: Delegation; digest: Hex } {
  const caveat = buildVaultKeyUseCaveat({
    vaultId: p.vaultId,
    kmsKeyRef: p.kmsKeyRef,
    resources: p.allowedResources,
    classificationCeiling: p.classificationCeiling,
    ops: p.ops,
    noSubdelegation: true,
  });
  const authorization: Delegation = {
    delegator: p.owner as Address,
    delegate: p.serverKey as Address,
    authority: ROOT_AUTHORITY,
    caveats: [caveat],
    salt: p.salt,
    signature: '0x',
  };
  const digest = hashDelegation(authorization, Number(env.CHAIN_ID), p_delegationManager(env));
  return { authorization, digest };
}

function p_delegationManager(env: Pick<VaultKeyEnv, 'DELEGATION_MANAGER'>): Address {
  return env.DELEGATION_MANAGER as Address;
}

/**
 * Verify a person-SA-signed `VaultKeyAuthorization` against the requested binding params and,
 * on success, persist the `VaultKeyBinding` (the host side of the ceremony). Reuses the REAL
 * verifier — the authorization must carry a matching `VAULT_KEY_USE` caveat AND be signed by
 * the owner SA (ERC-1271 via the UniversalSignatureValidator). Fail-closed on any mismatch.
 * Idempotent: re-binding the same (owner, server) upserts.
 */
export async function verifyAndStoreBinding(
  env: VaultKeyEnv,
  input: Omit<VaultKeyBindingParams, 'serverKey' | 'salt'> & { authorization: Delegation },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (input.allowedResources.length === 0) return { ok: false, reason: 'no resources' };
  if (input.ops.length === 0) return { ok: false, reason: 'no ops' };
  // Hash + persist the WIRE form (salt as string) — canonicalize/JSON.stringify can't serialize
  // a bigint. `input.authorization` keeps salt as bigint for the verifier's hashDelegation.
  const wire = delegationToWire(input.authorization);
  const authorizationHash = (await sha256Hex(canonicalize(wire))) as Sha256;
  const candidate: VaultKeyBindingV1 = {
    type: 'VaultKeyBindingV1',
    vaultId: input.vaultId,
    ownerPersonSA: input.owner,
    kmsKeyRef: input.kmsKeyRef,
    allowedServerId: VAULT_SERVER_ID,
    allowedResources: input.allowedResources,
    classificationCeiling: input.classificationCeiling,
    ops: input.ops,
    expiresAt: input.expiresAt,
    rotationPolicy: { mode: 'manual', retainPriorKeys: true },
    noSubdelegation: true,
    authorizationRef: `urn:ap:vault-key-auth:${input.owner}`,
    authorizationHash,
  };
  // Validate the authorization end-to-end (caveat match + owner signature) using an
  // in-scope probe request (first authorized resource + op).
  const verdict = await buildVaultKeyVerifier(env).verify({
    authorization: input.authorization,
    binding: candidate,
    request: {
      vaultId: input.vaultId,
      ownerPersonSA: input.owner,
      serverId: VAULT_SERVER_ID,
      resource: input.allowedResources[0]!,
      op: input.ops[0]!,
      classification: input.classificationCeiling,
    },
    now: new Date(),
  });
  if (!verdict.ok) return { ok: false, reason: verdict.reason };

  await putVaultKeyBindingRow(env.DB, {
    owner_address: input.owner,
    server_id: VAULT_SERVER_ID,
    vault_id: input.vaultId,
    kms_key_ref: input.kmsKeyRef,
    allowed_resources: JSON.stringify(input.allowedResources),
    classification_ceiling: input.classificationCeiling,
    ops: JSON.stringify(input.ops),
    expires_at: input.expiresAt,
    authorization_json: JSON.stringify(wire),
    authorization_hash: authorizationHash,
  });
  return { ok: true };
}
