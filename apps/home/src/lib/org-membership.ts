// spec 321 — client helper: mint + record the membership delegation (member → org) after a join.
// Used by BOTH join surfaces (the invite-redeem page and the org channels join card) so every path
// into an org produces a delegating member. Best-effort by design: the join consent artifact (the
// listing) already landed; a failed grant mint must never strand the join — it can be re-minted.
import type { Address } from '@agenticprimitives/types';
import { issueMembershipDelegation, toWire } from './delegation';
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
): Promise<void> {
  try {
    const d = await issueMembershipDelegation(member, org as Address, MCP_SERVER_ID, sign);
    const madMatches = !!memberAccess && (memberAccess.delegate ?? '').toLowerCase() === member.toLowerCase();
    await fetch('/connect/org-membership', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ org: org.toLowerCase(), delegation: toWire(d), ...(madMatches ? { memberAccessDelegation: memberAccess } : {}) }),
    });
  } catch (e) {
    console.warn('[org-membership] membership delegation not recorded (join still succeeded):', e);
  }
}
