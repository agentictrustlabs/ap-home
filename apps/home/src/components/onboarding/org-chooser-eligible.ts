/** Which of the person's related orgs may appear on an org-create connect chooser.
 *
 *  The person connects to an organization they belong to — they are a member, or they
 *  steward one created for THIS request's purpose. Stewardship of an unrelated org
 *  (another app, a test SA) is not a reason to offer it here.
 *
 *  `relationship` is a projection label (sticky once `member`). A leftover stewardship
 *  wire still lets them grant as the org; eligibility to *appear* is membership or
 *  matching purpose, not "every SA they ever custodied".
 */

export interface ConnectOrgRow {
  kind: string;
  name: string;
  relationship?: 'steward' | 'member' | string;
  purpose?: string;
  stewardshipDelegation?: unknown;
}

export function canGrantAsOrg(row: Pick<ConnectOrgRow, 'relationship' | 'stewardshipDelegation'>): boolean {
  return row.stewardshipDelegation != null || row.relationship !== 'member';
}

export function eligibleConnectOrgs<T extends ConnectOrgRow>(
  agents: readonly T[],
  opts: { purpose?: string } = {},
): T[] {
  const want = opts.purpose?.trim().toLowerCase();
  return agents
    .filter((a) => a.kind === 'org' && a.name)
    .filter((a) => {
      if (a.relationship === 'member') return true;
      if (!want) return true;
      return (a.purpose ?? '').trim().toLowerCase() === want;
    })
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
}
