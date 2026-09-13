// THE PRODUCT'S OWN RECORD NAMESPACES on the interactions grant — one source for the two apps that mint it.
//
// The grant's CORE is `@agenticprimitives/fabric/interactions` (INTERACTIONS_GRANT_CORE_SCOPES — the platform's
// records). What THIS product appends is its relying apps' namespaces: the Home's enable ceremony and the runtime's
// genesis-folded planes must mean the same records by "the interactions grant", or a resume re-derives a different
// wire than the one that was signed and an enabled-looking organization 409s on its first new-record write. Until
// 2026-09-13 each app kept its own copy and a test across apps pinned them equal; now there is one list and the test
// guards the genesis fold only. Vertical names (uupg, newcity, family, field, cardroom) belong here, in an APP module,
// never in a package (ADR-0021).
import type { RecordScopeSpec } from '@agenticprimitives/fabric/interactions';

/** spec 334 §6 — the org's OWN app-coordination records the org agent may READ (read-only) while it works an
 *  endeavor, so its deliverables are grounded in what the org has actually recorded rather than invented. These
 *  are relying-app record types (the UUPG engagement app), listed here because the interactions grant is minted at
 *  the Home; the coordination plane reads them owner-self through that grant. READ-ONLY and ADDITIVE (same
 *  re-enable precedent as coordination.*): a grant lacking them denies per-record at the vault, surfaced as
 *  "re-enable storage". The private companion (`uupg:attestation-private`) is deliberately EXCLUDED — the agent
 *  reasons over public-tier claims, never the sensitive record. */
export const APP_COORDINATION_READ_SCOPES = [
  'vault:uupg:attestation', 'vault:uupg:attestations', 'vault:uupg:assessed',
  'vault:uupg:coalition', 'vault:uupg:segment-def', 'vault:uupg:org-profile', 'vault:uupg:strategy',
  // The HOTSPOT TRACKER's own record set (same relying-app family, same public tier). Its ✦ Ask turn is grounded
  // in exactly these: the minted people-group identities, the tracked bodies and their delineations, and what was
  // observed happening. Their absence is why that feature answered "no reference facts reached me" for every
  // question — the gather turn asked for `uupg:identity` and `uupg:community` and got `record_scope_denied`.
  'vault:uupg:identity', 'vault:uupg:community', 'vault:uupg:observations',
] as const;

/** The org's OWN app-record NAMESPACE, READ-only. Where APP_COORDINATION_READ_SCOPES enumerates the uupg app's
 *  individual public-claim record types, a relying app whose ontology decomposes ALL of a principal's data into ONE
 *  vault namespace root (newcitycase doc 10 §1: `vault:newcity:*`) grants the org's own agent read over that ROOT —
 *  a namespace WILDCARD, never per-record. The platform therefore never names a single domain record: which records
 *  the agent actually reads is decided by the org's PLAYBOOK at turn time (spec 327 §4b), read owner-self through
 *  this grant. READ-ONLY and ADDITIVE. `vault:family:*` is the skills-app family-office namespace; `vault:field:*`
 *  the field workspace's. */
export const APP_OWN_NAMESPACE_READ_SCOPES = ['vault:newcity:*', 'vault:family:*', 'vault:field:*'] as const;

/** SEEDING scope — the same namespaces, read+WRITE, for provisioning a demo/sandbox org whose vault starts empty,
 *  plus the person's own card-room study records (hands recorded by their own agent, style, reads, the coach's
 *  notes). Deliberately narrow and deliberately separate from the read scope above: the read-only rule exists so an
 *  agent cannot manufacture the evidence it later cites, and it is NOT relaxed here — the write is reachable only
 *  through a STEWARD-GATED op (`channels.assistantSkill.put` → isSteward), never from an agent turn. A production
 *  org should not need this; a shared sandbox has no owner to author records, and an empty vault makes every
 *  grounded answer impossible to demonstrate. */
export const APP_OWN_NAMESPACE_SEED_SCOPES = ['vault:family:*', 'vault:field:*', 'vault:cardroom.*'] as const;

/** The extension both apps append to the core, as the grant builder takes it — the ONE list. */
export const INTERACTIONS_APP_SCOPES: ReadonlyArray<RecordScopeSpec> = [
  { resources: [...APP_COORDINATION_READ_SCOPES, ...APP_OWN_NAMESPACE_READ_SCOPES], ops: ['read'] },
  { resources: [...APP_OWN_NAMESPACE_SEED_SCOPES], ops: ['read', 'write'] },
];
