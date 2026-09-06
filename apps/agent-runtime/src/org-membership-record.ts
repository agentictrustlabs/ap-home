// WHAT IT MEANS TO BE A MEMBER — spec 325's shape, written where the organization can read it.
//
// The ontology already models this exactly, and the estate did not:
//
//   aporg:OrganizationMembership          the fact of belonging (a Situation)
//     ├─ memberAgent / organizationAgent  who, and of what
//     └─ hasRoleAssignment → RoleAssignment
//          ├─ assignedRole → OrganizationRoleDefinition   "Declarative — does not authorize execution"
//          ├─ materializedByDelegation → apdel:Delegation  ← the access
//          └─ supportedByEntitlement → apent:AccessEntitlement
//
// Three things kept apart, because collapsing any two is a bug somebody will ship:
//   the INVITATION is an enrollment instrument — the T-box says satisfying one creates no membership;
//   the ROLE is declarative and authorizes nothing on its own;
//   the DELEGATION is the authority, and the role assignment merely records which role it materialises.
//
// WHERE. The ORGANIZATION's own vault, keyed `org.membership:member:<address>` — inside the
// `vault:org.membership:*` scope the DO's grant already carries, so the org's own agent can read its own
// roster without widening anything. Before this, the only complete roster was a Home KV cache
// (`delegated-idx:<org>`) that the Home's own code calls a cache of a record nothing wrote: wipe it and
// membership was a bereavement rather than a rebuild (ADR-0055). Finding ORG-MEM-1.
//
// NOT AUTHORITY. Recording that somebody is a member grants nothing — the delegation named here is the
// authority, verified where it always was (ADR-0041). A reader that treated this record as permission
// would be trusting the org's own note instead of the member's signature.

/** One membership, as the organization records it. Field names follow the T-box properties. */
export interface OrganizationMembershipRecordV1 {
  type: 'ap.org.membership.v1';
  /** The member's SA (aporg:memberAgent). */
  memberAgent: string;
  /** The organization's SA (aporg:organizationAgent). */
  organizationAgent: string;
  /** What this community calls them. Display only. */
  displayName?: string;
  /** How they came to be admitted — the enrollment instrument, kept because provenance is not the fact. */
  admittedVia: 'invitation' | 'application' | 'charter' | 'import';
  admittedAt: string;
  /** aporg:RoleAssignment — the role and what materialises it. A role alone authorizes nothing. */
  roleAssignment?: {
    /** aporg:assignedRole — a role name this organization uses. Declarative. */
    assignedRole?: string;
    /** aporg:materializedByDelegation — the delegation that actually confers the access. */
    materializedByDelegation?: unknown;
  };
  /** Ended memberships stay, with an end date: a roster that forgets cannot answer "who was here then". */
  endedAt?: string;
}

export const MEMBERSHIP_RECORD_PREFIX = 'org.membership:member:';

export const membershipRecordKey = (member: string): string =>
  `${MEMBERSHIP_RECORD_PREFIX}${member.toLowerCase()}`;

/** The member address a membership key names, or '' when the key is not one. */
export function memberFromKey(recordType: string): string {
  if (!recordType.startsWith(MEMBERSHIP_RECORD_PREFIX)) return '';
  const rest = recordType.slice(MEMBERSHIP_RECORD_PREFIX.length);
  return (rest.match(/^0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase();
}

/** Build the record from what admission actually has in hand. */
export function membershipRecord(input: {
  member: string;
  org: string;
  displayName?: string;
  admittedVia?: OrganizationMembershipRecordV1['admittedVia'];
  assignedRole?: string;
  delegation?: unknown;
  now?: () => string;
}): OrganizationMembershipRecordV1 {
  return {
    type: 'ap.org.membership.v1',
    memberAgent: input.member.toLowerCase(),
    organizationAgent: input.org.toLowerCase(),
    ...(input.displayName ? { displayName: input.displayName.slice(0, 80) } : {}),
    admittedVia: input.admittedVia ?? 'invitation',
    admittedAt: (input.now ?? (() => new Date().toISOString()))(),
    ...(input.assignedRole || input.delegation
      ? {
          roleAssignment: {
            ...(input.assignedRole ? { assignedRole: input.assignedRole } : {}),
            ...(input.delegation ? { materializedByDelegation: input.delegation } : {}),
          },
        }
      : {}),
  };
}
