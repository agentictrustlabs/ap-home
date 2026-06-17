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
  VAULT_KEY_USE_ENFORCER,
  type Delegation,
} from '@agenticprimitives/delegation';
import { selectVaultKeyProvider } from '@agenticprimitives/key-custody';
import { createDemoVault } from './vault.js';
import { getVaultKeyBindingRow, type VaultKeyBindingRow } from './db.js';

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
    authorization: JSON.parse(row.authorization_json) as Delegation,
    vault: createDemoVault(env.DB, wrapper),
  };
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

      // The person SA must have SIGNED the authorization — ERC-1271 via the USV. Fail-closed
      // on a missing validator (we will not accept a vault-key authorization we can't verify).
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
