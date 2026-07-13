// spec 321 — client helper: mint + record the membership delegation (member → org) after a join.
// Used by BOTH join surfaces (the invite-redeem page and the org channels join card) so every path
// into an org produces a delegating member. Best-effort by design: the join consent artifact (the
// listing) already landed; a failed grant mint must never strand the join — it can be re-minted.
import type { Address } from '@agenticprimitives/types';
import { writeOrganizationMembership } from './membership-write';
import { issueMemberProfileAccessDelegation, toWire } from './delegation';
import { MCP_SERVER_ID } from './inbox-delivery';

export type SignHash = (h: `0x${string}`) => Promise<`0x${string}`>;

export async function recordOrgMembership(
  member: Address,
  org: string,
  sign: SignHash,
  bearer: string,
  /** spec 321 W2 — a steward-pre-signed org→member access grant (from redeem, or looked up
   *  server-side for in-app invites). Forwarded only when its delegate IS this member. */
  memberAccess?: { delegate?: string } | null,
  /** spec 321 item-2 — the display name the member chose at join; shown on the steward's roster
   *  card (a vault-resident member.profile will replace this once generic owner writes exist). */
  displayName?: string,
): Promise<void> {
  try {
    const d = await issueMemberProfileAccessDelegation(member, org as Address, MCP_SERVER_ID, sign);
    const madMatches = !!memberAccess && (memberAccess.delegate ?? '').toLowerCase() === member.toLowerCase();
    await fetch('/connect/org-membership', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({
        org: org.toLowerCase(),
        delegation: toWire(d),
        ...(madMatches ? { memberAccessDelegation: memberAccess } : {}),
        ...(displayName?.trim() ? { displayName: displayName.trim().slice(0, 80) } : {}),
      }),
    });
    // spec 322 W3d — AUTHORITATIVE person-plane write-through via the member's own InteractionsDO:
    // their relationships doc + the per-org profile card (the server's `related:*` KV is a
    // projection/cache of this). A 409 here (person hasn't enabled interactions yet) is expected —
    // the doc catches up at their enable ceremony; the KV projection covers display meanwhile.
    // HOME-PORT-1 (2026-07-12) — include the member→org membership WIRE in the vault entry, not just the
    // relationship label. Previously the wire lived ONLY in the Home's `delegated-idx`/`related:*` KV, so a
    // second Home could rebuild the member LIST but not the authority wire (steward Members panel /
    // delegated-orgs broker went dark after a Home swap). Storing it in relationships.data makes it portable:
    // related-orgs.ts self-heals `related:*` from `entry.delegations[0]`, so any Home reconstructs it.
    const doBase = `/a2a/interactions/${member.toLowerCase()}`;
    const hdrs = { 'content-type': 'application/json' };
    // spec 324 W3 — the AUTHORITATIVE OrganizationMembership Situation (+ credential) in the member's vault.
    // The org authorized this member (the org→member access grant / listing acceptance is the EnrollmentDecision
    // evidence); membership is the Situation, NOT the memberProfileAccess delegation just minted (ADR-0048 #3).
    const enrollmentSource = madMatches
      ? ({ kind: 'invite-link', inviteLinkId: `mad:${(memberAccess?.delegate ?? '').toLowerCase()}` } as const)
      : ({ kind: 'application', applicationId: `join:${org.toLowerCase()}:${member.toLowerCase()}` } as const);
    const membershipProvenance = await writeOrganizationMembership({
      member,
      org: org as Address,
      enrollmentSource,
      memberAcceptanceRef: `join-accept:${member.toLowerCase()}`,
      organizationDecisionRef: `enroll-decision:${org.toLowerCase()}:${member.toLowerCase()}`,
      bearer,
    });
    await fetch(`${doBase}/relationships.merge`, {
      method: 'POST', headers: hdrs,
      body: JSON.stringify({ session: bearer, entry: { org: org.toLowerCase(), relationship: 'member', delegations: [toWire(d)], ...(membershipProvenance ?? {}) } }),
    }).catch(() => null);
    if (displayName?.trim()) {
      await fetch(`${doBase}/member.profile.put`, {
        method: 'POST', headers: hdrs,
        body: JSON.stringify({ session: bearer, org: org.toLowerCase(), profile: { displayName: displayName.trim().slice(0, 80) } }),
      }).catch(() => null);
    }
  } catch (e) {
    console.warn('[org-membership] membership delegation not recorded (join still succeeded):', e);
  }
}
