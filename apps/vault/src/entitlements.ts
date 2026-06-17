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
// When a credential-issuance flow lands, the seeded set is replaced by verified
// AgenticEntitlementCredentialV1s (VC-proof + status-list checked upstream).

import {
  type EntitlementResolver,
  type EntitlementQuery,
  type EntitlementDecision,
  type AgenticEntitlementCredentialV1,
  InMemoryEntitlementResolver,
} from '@agenticprimitives/entitlements';

// Seeded cross-principal grants (illustrative; empty until a demo cross-principal
// flow needs one). Add field/purpose-scoped credentials here to exercise scoping.
const SEEDED: AgenticEntitlementCredentialV1[] = [];

/** The demo entitlement resolver: owner-self → full; otherwise the seeded grants. */
export function demoEntitlementResolver(): EntitlementResolver {
  const inner = new InMemoryEntitlementResolver(SEEDED);
  return {
    async resolve(q: EntitlementQuery): Promise<EntitlementDecision> {
      if (q.principal && q.actor.toLowerCase() === q.principal.toLowerCase()) {
        return { decision: 'allow', reason: 'matched', matchedCredentials: ['owner-self'], allowedFields: q.fields };
      }
      return inner.resolve(q);
    },
  };
}
