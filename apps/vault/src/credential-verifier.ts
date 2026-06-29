// credential-verifier.ts — the concrete `CredentialVerifier` demo-mcp injects into the
// `VerifiedEntitlementResolver` (spec 291 §3 / criterion 1). The entitlements package stays a pure
// leaf: it defines the `CredentialVerifier` seam but never implements verification. Here we wire it to
// `@agenticprimitives/verifiable-credentials.verifyCredential`, whose ERC-1271 round-trip we satisfy
// with the SAME deployed UniversalSignatureValidator demo-mcp uses everywhere else (mirrors
// `buildVaultKeyVerifier`), so an entitlement credential's issuer signature is validated on-chain.
//
// Fail-closed (ADR-0013): a missing validator/RPC, an unresolvable issuer, a bad signature, OR a
// status-bearing credential we cannot resolve (no status resolver wired yet) all → `valid: false`.
// An entitlement credential can therefore NEVER grant access unless its issuer SA cryptographically
// signed it and it is within its validity window.

import { createPublicClient, http, type Address } from 'viem';
import {
  verifyCredential,
  type Erc1271Verifier,
  type VerifiableCredential,
} from '@agenticprimitives/verifiable-credentials';
import type { AgenticEntitlementCredentialV1, CredentialVerifier } from '@agenticprimitives/entitlements';

/** UniversalSignatureValidator `isValidSig` — ERC-1271/6492/ECDSA/WebAuthn over a digest (same ABI as
 *  the vault-key + delegation verifiers; the deployed USV is the one authority for signature validity). */
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

/** The subset of demo-mcp's Env this verifier needs. */
export interface CredentialVerifierEnv {
  RPC_URL: string;
  UNIVERSAL_SIGNATURE_VALIDATOR?: string;
}

/**
 * Build the `CredentialVerifier` for the verified entitlement resolver. Verifies each candidate
 * entitlement credential's structural shape + validity window + issuer ERC-1271 signature (and, when a
 * credential declares a `credentialStatus`, fails closed until a status resolver is wired — see below).
 *
 * Status note (spec 291 §10): BitstringStatus/StatusList2021 revocation is a later sub-wave. Until a
 * resolver is injected, a credential that CARRIES a `credentialStatus` cannot be confirmed un-revoked, so
 * `verifyCredential` fails it closed (we deliberately do NOT pass `allowUnresolvedStatus`). Credentials
 * with no status entry verify on signature + validity alone. This is the safe posture: better to deny a
 * status-bearing credential than to honor a possibly-revoked one.
 */
export function buildCredentialVerifier(env: CredentialVerifierEnv): CredentialVerifier {
  const erc1271: Erc1271Verifier = {
    async verifyHash({ address, hash, signature }) {
      const usv = env.UNIVERSAL_SIGNATURE_VALIDATOR?.trim();
      if (!usv) {
        // Fail-closed: we will not accept an entitlement credential whose signature we cannot verify.
        throw new Error('buildCredentialVerifier: UNIVERSAL_SIGNATURE_VALIDATOR is required to verify credential issuer signatures (fail-closed).');
      }
      const client = createPublicClient({ transport: http(env.RPC_URL) });
      return (await client.readContract({
        address: usv as Address,
        abi: USV_ISVALIDSIG_ABI,
        functionName: 'isValidSig',
        args: [address, hash, signature],
      })) as boolean;
    },
  };

  return async (credential: AgenticEntitlementCredentialV1) => {
    // The entitlement credential envelope is a VC envelope (structurally close); verifyCredential runs
    // the structural + canonical-hash + validity + ERC-1271 checks. A missing/invalid proof or
    // out-of-window credential returns valid:false with its issues.
    const result = await verifyCredential(credential as unknown as VerifiableCredential, erc1271);
    return { valid: result.valid, reason: result.valid ? undefined : result.issues.join('; ') || 'verification_failed' };
  };
}
