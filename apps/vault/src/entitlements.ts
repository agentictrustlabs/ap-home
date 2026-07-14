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
  type EntitlementAction,
  type EntitlementClassification,
  VerifiedEntitlementResolver,
  InMemoryEntitlementResolver,
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

// ─── Issued-entitlement LEDGER (spec 277 Phase 3, org → member; ported from impact-mcp) ────────────
//
// Cross-principal grants an ORG issues to a MEMBER (a different SA that does NOT custody the org),
// stored in D1 (`entitlements_issued` / `entitlement_groups` — migrations 0013/0014). The ledger IS
// the trusted authority for these grants: the issue path authenticates the org as its own custodian
// (withDelegation recovers token principal == the org) before any row is written, so a granted row is
// a valid grant and the matching engine deliberately checks no signature (InMemoryEntitlementResolver).
// This is a DIFFERENT trust model from the spec-291 VerifiedEntitlementResolver above (which verifies
// externally-sourced credentials cryptographically): ledger credentials are unsigned because this
// server minted them itself under an authenticated session — the write is the authorization. Access to
// the org's data is gated SOLELY by a matching, granted, unexpired row — never custody/stewardship.

/** D2 — the group ids a reading actor belongs to, as `group:<id>` actor keys (matching how group
 *  grants are stored in entitlements_issued.actor). Empty ⇒ the actor is in no groups. */
async function resolveActorGroups(db: D1Database, actor: string): Promise<string[]> {
  const res = await db
    .prepare(`SELECT DISTINCT group_id FROM entitlement_groups WHERE member = ?`)
    .bind(actor.toLowerCase())
    .all<{ group_id: string }>();
  return (res.results ?? []).map((r) => `group:${r.group_id}`);
}

/** Load the granted, unexpired entitlement credentials an OWNER (principal) issued to a GRANTEE — both
 *  DIRECT grants (actor == the reader) and GROUP-conferred grants (actor == `group:<g>` for a group the
 *  reader is in, D2). An empty set ⇒ fail-closed deny. Group credentials carry a `group:` subject
 *  id; we rewrite it to the concrete reader so the matching engine (which compares credentialSubject.id
 *  to query.actor) accepts them — the group membership check IS the authorization. */
async function loadIssuedCredentials(db: D1Database, principal: string, actor: string): Promise<AgenticEntitlementCredentialV1[]> {
  const nowIso = new Date().toISOString();
  const groupKeys = await resolveActorGroups(db, actor);
  const actorKeys = [actor.toLowerCase(), ...groupKeys];
  const placeholders = actorKeys.map(() => '?').join(', ');
  const res = await db
    .prepare(
      `SELECT credential, actor FROM entitlements_issued
        WHERE principal = ? AND actor IN (${placeholders}) AND status = 'granted'
          AND (valid_until IS NULL OR valid_until > ?)`,
    )
    .bind(principal.toLowerCase(), ...actorKeys, nowIso)
    .all<{ credential: string; actor: string }>();
  const out: AgenticEntitlementCredentialV1[] = [];
  for (const row of res.results ?? []) {
    try {
      const cred = JSON.parse(row.credential) as AgenticEntitlementCredentialV1;
      // Group-conferred: rewrite the group subject id to the concrete reader so matching accepts it.
      if (typeof row.actor === 'string' && row.actor.startsWith('group:') && cred.credentialSubject) {
        cred.credentialSubject.id = actor;
      }
      out.push(cred);
    } catch { /* skip a corrupt row */ }
  }
  return out;
}

/** The ledger entitlement resolver: owner-self → full; otherwise consult the org's issued grants in D1. */
export function ledgerEntitlementResolver(env: { DB: D1Database }): EntitlementResolver {
  return {
    async resolve(q: EntitlementQuery): Promise<EntitlementDecision> {
      if (q.principal && q.actor.toLowerCase() === q.principal.toLowerCase()) {
        return { decision: 'allow', reason: 'matched', matchedCredentials: ['owner-self'], allowedFields: q.fields };
      }
      if (!q.principal) {
        return { decision: 'deny', reason: 'principal_mismatch', matchedCredentials: [] };
      }
      const creds = await loadIssuedCredentials(env.DB, q.principal, q.actor);
      return new InMemoryEntitlementResolver(creds).resolve(q);
    },
  };
}

export interface BuildEntitlementInput {
  issuer: string;           // the issuing ORG (also the data principal)
  subject: string;          // the GRANTEE member SA (credentialSubject.id / query.actor)
  audience: string;         // MCP audience
  resource: string;         // vault resource, e.g. vault:impact-profile
  actions: EntitlementAction[];
  fields?: string[];        // undefined ⇒ all fields
  classificationCeiling?: EntitlementClassification;
  purpose?: string;
  validFromIso: string;
  validUntilIso?: string;
  id: string;               // urn:ap:entitlement:<uuid>
}

/** Build an unsigned AgenticEntitlementCredentialV1. The `entitlements_issued` ledger is the trusted
 *  authority (see the trust-model note above), so no on-chain signature is required for the gate;
 *  issuance is authenticated by the org presenting its own authority (token principal == the org). */
export function buildOrgEntitlement(input: BuildEntitlementInput): AgenticEntitlementCredentialV1 {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2', 'https://agenticprimitives.dev/credentials/v1'],
    type: ['VerifiableCredential', 'AgenticEntitlementCredentialV1'],
    id: input.id as `urn:ap:entitlement:${string}`,
    issuer: input.issuer,
    validFrom: input.validFromIso,
    ...(input.validUntilIso ? { validUntil: input.validUntilIso } : {}),
    credentialSubject: {
      id: input.subject,
      principal: input.issuer,
      audience: input.audience,
      resource: input.resource,
      actions: input.actions,
      ...(input.fields ? { fields: input.fields } : {}),
      ...(input.classificationCeiling ? { classificationCeiling: input.classificationCeiling } : {}),
      ...(input.purpose ? { purpose: input.purpose } : {}),
    },
  };
}
