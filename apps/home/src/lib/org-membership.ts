// spec 321 — client helper: mint + record the membership delegation (member → org) after a join.
// Used by BOTH join surfaces (the invite-redeem page and the org channels join card) so every path
// into an org produces a delegating member. Best-effort by design: the join consent artifact (the
// listing) already landed; a failed grant mint must never strand the join — it can be re-minted.
import type { Address } from '@agenticprimitives/types';
import { writeOrganizationMembership } from './membership-write';
import { issueMemberProfileAccessDelegation, toWire } from './delegation';
import { MCP_SERVER_ID } from './inbox-delivery';

export type SignHash = (h: `0x${string}`) => Promise<`0x${string}`>;

/**
 * The invitation was issued to one agent and accepted by another.
 *
 * Carries both addresses because the resolution depends on which is which: the invitee can accept
 * as the invited home, or the steward can re-invite THIS agent directly (the in-app invite path,
 * `/connect/org-invite/agent`, mints the grant against a known address rather than a predicted one).
 */
export class WrongHomeForInviteError extends Error {
  constructor(
    readonly signedInAs: Address,
    readonly invitedAgent: Address,
  ) {
    super(
      `this invitation was issued to ${invitedAgent} and you are signed in as ${signedInAs}. ` +
        'Its access grant is bound to the invited address and is never re-targeted, so accepting it here ' +
        'would join you without access. Accept as the invited home, or ask a steward to invite this agent directly.',
    );
    this.name = 'WrongHomeForInviteError';
  }
}

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
  const t0 = Date.now();
  const lap = (what: string) => console.info(`[org-membership] ${what} +${Date.now() - t0}ms`);
  try {
    const d = await issueMemberProfileAccessDelegation(member, org as Address, MCP_SERVER_ID, sign);
    lap('delegation signed');
    const madMatches = !!memberAccess && (memberAccess.delegate ?? '').toLowerCase() === member.toLowerCase();

    /*
      A PRESENT-BUT-MISMATCHED GRANT IS THE WRONG-HOME REDEMPTION, AND IT MUST SAY SO.

      An email invitation's grant is pre-signed against the address derived from the INVITED EMAIL
      (`/org-invite/predict`). Redeeming it while signed in as a DIFFERENT home — which the invite
      page offers, "Already have a home? Use a passkey, wallet, or Google" — leaves that grant inert
      by design: it is never re-targeted, because re-targeting a steward's signature at whoever
      happened to click would be the opposite of a grant.

      What followed was the problem. The mismatch was dropped silently, a membership was written
      WITHOUT the access grant, and the org then refused with "this organization has not authorized
      you to join" — at a later screen, with no mention of the address, to somebody who had just
      been told they were joining. The join looked like it worked.

      Throwing here moves the refusal to the moment it becomes true and names both agents, so the
      answer ("ask the steward to invite this agent directly") is derivable from what is on screen.
      The membership write is deliberately NOT attempted: recording one that the org will reject is
      how a roster fills with people who cannot get in.
    */
    if (memberAccess && !madMatches) {
      throw new WrongHomeForInviteError(member, (memberAccess.delegate ?? '') as Address);
    }
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
    lap('org-membership recorded');
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
    lap('membership situation written');
    // THE TWO WRITES THAT REMAIN ARE INDEPENDENT of each other — the member's relationships doc and their
    // per-org profile card — and each is a vault operation of its own. Sequential, a join spent their sum
    // while the person watched "telling the workspace you joined…"; together they cost the longer one.
    // spec 322 W3d — AUTHORITATIVE person-plane write-through via the member's own InteractionsDO:
    // their relationships doc + the per-org profile card (the server's `related:*` KV is a
    // projection/cache of this). A 409 here (person hasn't enabled interactions yet) is expected —
    // the doc catches up at their enable ceremony; the KV projection covers display meanwhile.
    // HOME-PORT-1 (2026-07-12) — include the member→org membership WIRE in the vault entry, not just the
    // relationship label, so any Home reconstructs the authority wire from the person's own doc.
    await Promise.all([
      fetch(`${doBase}/relationships.merge`, {
        method: 'POST', headers: hdrs,
        body: JSON.stringify({ session: bearer, entry: { org: org.toLowerCase(), relationship: 'member', delegations: [toWire(d)], ...(membershipProvenance ?? {}) } }),
      }).catch(() => null),
      displayName?.trim()
        ? fetch(`${doBase}/member.profile.put`, {
            method: 'POST', headers: hdrs,
            body: JSON.stringify({ session: bearer, org: org.toLowerCase(), profile: { displayName: displayName.trim().slice(0, 80) } }),
          }).catch(() => null)
        : Promise.resolve(null),
    ]);
    lap('relationships + profile written');
  } catch (e) {
    console.warn('[org-membership] membership delegation not recorded (join still succeeded):', e);
  }
}
