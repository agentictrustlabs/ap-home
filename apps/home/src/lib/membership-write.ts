// spec 324 W3 — write the AUTHORITATIVE OrganizationMembership (a private SituationV2 + its credential
// subject) to the member's InteractionsDO, and return the provenance to stamp on the projections. Membership
// is a Situation, NOT a delegation and NOT a directory listing (ADR-0048 #3/#6): this creates the membership
// FACT. Any authority (stewardship / org-resource / member-profile access) is issued SEPARATELY — holding a
// delegation never makes a member, and this write grants no authority. Best-effort: the authoritative record
// is the goal; a failed write is re-mintable at the next enable ceremony.
import type { Address } from '@agenticprimitives/types';
import {
  buildOrganizationMembership,
  buildOrganizationMembershipCredentialSubject,
  type EnrollmentSource,
  type MembershipClass,
} from '@agenticprimitives/organization';
import { hashSituationV2 } from '@agenticprimitives/situations';
import { toCanonicalAgentId } from '@agenticprimitives/identity-directory-adapters';
import { CHAIN_ID } from './chain';

/** Provenance tags stamped onto the member/org projections so every projection traces to its Situation. */
export interface MembershipProvenance {
  membershipId: string;
  membershipSituationHash: string;
  enrollmentDecisionRef: string;
}

export async function writeOrganizationMembership(args: {
  member: Address;
  org: Address;
  /** How this membership came to be — the enrollment instrument (ADR-0048 #8: the instrument is not the
   *  membership; only the EnrollmentDecision creates one). */
  enrollmentSource: EnrollmentSource;
  /** Ref/hash of the member's signed ACCEPT act. */
  memberAcceptanceRef: string;
  /** Ref/hash of the EnrollmentDecision (the org's decision that created the membership). */
  organizationDecisionRef: string;
  /** The bearer session authorizing the member's own InteractionsDO write (self-gated). */
  bearer: string;
  membershipClass?: MembershipClass;
}): Promise<MembershipProvenance | null> {
  try {
    const rand = crypto.getRandomValues(new Uint8Array(16));
    const membershipId = `sit_mem_${Array.from(rand, (b) => b.toString(16).padStart(2, '0')).join('')}` as `sit_${string}`;
    const membership = buildOrganizationMembership({
      id: membershipId,
      memberAgent: toCanonicalAgentId(CHAIN_ID, args.member),
      organizationAgent: toCanonicalAgentId(CHAIN_ID, args.org),
      body: {
        membershipEpoch: 1,
        status: 'active',
        membershipClass: args.membershipClass ?? 'standard',
        enrollmentSource: args.enrollmentSource,
        memberAcceptanceRef: args.memberAcceptanceRef,
        organizationDecisionRef: args.organizationDecisionRef,
      },
    });
    const membershipSituationHash = hashSituationV2(membership);
    const credential = buildOrganizationMembershipCredentialSubject({
      membership,
      claims: {
        membershipSituationHash,
        memberAcceptanceProof: args.memberAcceptanceRef,
        organizationAdmissionProof: args.organizationDecisionRef,
      },
    });
    const res = await fetch(`/a2a/interactions/${args.member.toLowerCase()}/membership.put`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: args.bearer, org: args.org.toLowerCase(), membership, credential }),
    });
    if (!res.ok) {
      console.warn('[membership] authoritative write failed:', res.status);
      return null;
    }
    return { membershipId, membershipSituationHash, enrollmentDecisionRef: args.organizationDecisionRef };
  } catch (e) {
    console.warn('[membership] write error:', e);
    return null;
  }
}
