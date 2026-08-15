// Email-invite landing: the grant names one home. A session for anyone else must not Accept.

const ADDR = /^0x[0-9a-f]{40}$/;

/** The home this email invitation admits — the grant's delegate, never whoever is signed in. */
export function invitedAgentFromGrant(
  memberAccess: { delegate?: string } | null | undefined,
): `0x${string}` | null {
  const d = (memberAccess?.delegate ?? '').toLowerCase();
  return ADDR.test(d) ? (d as `0x${string}`) : null;
}

/**
 * True when this browser's session must be cleared before the email link can redeem.
 *
 * No session → the magic-link path. Same address as the grant → they are the invitee.
 * Any other signed-in home (or a grant we cannot read) → sign out; do not join as them.
 */
export function emailInviteNeedsSignOut(
  signedInAs: string | null | undefined,
  invitedAgent: string | null | undefined,
): boolean {
  if (!signedInAs) return false;
  if (!invitedAgent) return true;
  return signedInAs.toLowerCase() !== invitedAgent.toLowerCase();
}
