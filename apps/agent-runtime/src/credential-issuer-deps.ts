// THE ISSUER'S SEAMS — spec 444 W3. What `credential.issue` needs from this deployment, built from its environment:
//   · the key service's ISSUING key (purpose `issuer-key:`, P-256), signing `ES256_ISSUE_SHA256` only — faithkms W2;
//   · the runtime's ISSUANCE EVIDENCE key: a short-lived token naming the digest about to be signed, the issuer facet and
//     the credential type, which the key service verifies against the JWKS pinned in its `[authority_evidence]`;
//   · the digests the issuer and holder compute the same way (`credentialDigestOf`, Ring 0 estate-projection).
// Absent configuration ⇒ no issuer on this estate, and the act says so. Nothing here decides who may issue: the mandate
// and the organization's records do (credential-issue.ts).
import { createAkcsEs256Signer, p256JwkThumbprint, type AkcsEs256Signer } from '@agenticprimitives/key-custody';
import { createEs256EvidenceMinter } from '@agenticprimitives/delegation';
import { credentialDigestOf } from '@agenticprimitives/estate-projection';
import { agenticKmsConfig, isAgenticKms, type AkcsEnv } from './akcs.js';
import type { CredentialIssueDeps } from './credential-issue.js';

export interface CredentialIssuerEnv extends AkcsEnv {
  /** The runtime's issuance-evidence key (P-256 private scalar, hex) — a secret; its JWK is in the key service's JWKS. */
  ISSUANCE_EVIDENCE_ES256_KEY?: string;
  /** The `iss` and `aud` the key service's `[authority_evidence]` pins. */
  ISSUANCE_EVIDENCE_ISSUER?: string;
  ISSUANCE_EVIDENCE_AUDIENCE?: string;
}

export function credentialIssuerDeps(env: CredentialIssuerEnv): Pick<CredentialIssueDeps, 'issuingSign' | 'mintIssuanceEvidence' | 'credentialDigestOf' | 'thumbprintOf' | 'sha256Hex'> | null {
  if (!isAgenticKms(env) || !env.ISSUANCE_EVIDENCE_ES256_KEY || !env.ISSUANCE_EVIDENCE_ISSUER || !env.ISSUANCE_EVIDENCE_AUDIENCE) return null;
  // BUILT ON FIRST USE, never with the deps: these deps are assembled for EVERY ask, and a malformed key here once made every
  // ask on the estate answer 500 (2026-10-16, the key id uploaded in the key's place). A bad key now fails the issuing act
  // alone, with its reason.
  const { ISSUANCE_EVIDENCE_ES256_KEY: key, ISSUANCE_EVIDENCE_ISSUER: issuer, ISSUANCE_EVIDENCE_AUDIENCE: audience } = env;
  let minter: ReturnType<typeof createEs256EvidenceMinter> | null = null;
  const minterOf = () => (minter ??= createEs256EvidenceMinter({ privateKeyHex: key, issuer, audience }));
  // One signer per issuing key: its public key is read from the service once and every answer is checked against it.
  const signers = new Map<string, Promise<AkcsEs256Signer>>();
  const signerFor = (keyId: string): Promise<AkcsEs256Signer> => {
    let s = signers.get(keyId);
    if (!s) {
      s = createAkcsEs256Signer(agenticKmsConfig(env), { keyId, signingPurpose: 'ES256_ISSUE_SHA256' });
      s.catch(() => signers.delete(keyId));
      signers.set(keyId, s);
    }
    return s;
  };
  return {
    issuingSign: async (akcsKeyId, message, evidence) => (await signerFor(akcsKeyId)).sign(message, evidence),
    mintIssuanceEvidence: async (subject, claims) => minterOf().mint(subject, claims),
    credentialDigestOf: async (jwt) => credentialDigestOf(jwt),
    thumbprintOf: (jwk) => p256JwkThumbprint(jwk),
    sha256Hex: async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join(''),
  };
}
