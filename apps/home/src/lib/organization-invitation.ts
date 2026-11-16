/** Completion is a navigation hint; the receiving app must read its own access. */
export function organizationInvitationReturn(returnTo: string, org: string, join: boolean): string {
  const url = new URL(returnTo);
  if (join) url.searchParams.set('joined_org', org.toLowerCase());
  return url.href;
}

/** A pending invitation, inactive relationship, or unrelated org is not membership. */
export function hasRecordedFamilyMembership(value: unknown, org: string): boolean {
  if (!value || typeof value !== 'object' || !('orgs' in value) || !Array.isArray(value.orgs)) return false;
  return value.orgs.some((row: Record<string, unknown> | null) => row &&
    typeof row.orgAgent === 'string' && row.orgAgent.toLowerCase() === org.toLowerCase() &&
    row.kind === 'household' && ['member', 'steward'].includes(String(row.relationship)) &&
    (row.status == null || row.status === 'active'));
}
