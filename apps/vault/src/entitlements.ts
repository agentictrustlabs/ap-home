// demo-mcp's entitlement gate (spec 277 Phase 3).
//
// Sensitive reads resolve an entitlement BEFORE the vault decrypts any field, and
// the decision's `allowedFields` scopes the projection. Demo policy (testnet grade):
//
//   - Owner-reads-own (actor == principal) → full access to all requested fields.
//     This covers the current demo flows where withDelegation recovers the
//     DELEGATOR (the data owner) and reads its OWN namespace.
//   - Cross-principal access (a relying party reading another principal's data) →
//     only the seeded, field/purpose-scoped grants below match; everything else
//     is fail-closed denied.
//
// spec 291 §3 / criterion 1: a critical/high entitlement decision must reject an unverified, expired, or
// revoked credential BEFORE any KAS release. The cross-principal (credential) branch now runs through the
// VerifiedEntitlementResolver — every candidate credential is cryptographically verified (issuer ERC-1271
// signature + validity window + status) via the INJECTED verifier before matching. Only verified
// credentials can match (fail-closed). When a credential-issuance flow lands, real signed
// AgenticEntitlementCredentialV1s are added to SEEDED (or sourced per-request) and are enforced here.

import {
  type EntitlementResolver,
  type EntitlementQuery,
  type EntitlementDecision,
  type AgenticEntitlementCredentialV1,
  type CredentialVerifier,
  VerifiedEntitlementResolver,
} from '@agenticprimitives/entitlements';

// Seeded cross-principal grants (illustrative; empty until a demo cross-principal
// flow needs one). Add field/purpose-scoped credentials here to exercise scoping.
const SEEDED: AgenticEntitlementCredentialV1[] = [];

/**
 * The demo entitlement resolver. Owner-self (actor == principal) → full access: the data owner reading
 * its OWN namespace presents NO credential, so there is nothing to verify (this branch is unchanged).
 * Cross-principal access goes through the VerifiedEntitlementResolver, which verifies each candidate
 * credential (via `verify`) before matching — an unverified/revoked credential never grants access.
 */
export function demoEntitlementResolver(verify: CredentialVerifier): EntitlementResolver {
  const inner = new VerifiedEntitlementResolver(SEEDED, verify);
  return {
    async resolve(q: EntitlementQuery): Promise<EntitlementDecision> {
      if (q.principal && q.actor.toLowerCase() === q.principal.toLowerCase()) {
        return { decision: 'allow', reason: 'matched', matchedCredentials: ['owner-self'], allowedFields: q.fields };
      }
      return inner.resolve(q);
    },
  };
}
