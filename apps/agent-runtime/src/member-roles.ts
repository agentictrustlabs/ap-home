// THE ROLES A PERSON HOLDS, AND A STEWARD CHANGING ONE — spec 427, as two capabilities.
//
//   person.roles.list              a READ, at the person's own agent: what each organization they belong to records
//                                  of THEM — the role, the offer it came from (its skill packs), whether the
//                                  membership has ended. It is how their Home knows which role packs their playbook
//                                  should hold (§5.3), and it answers "what's my role at the Weld team" in a plain Ask.
//   organization.member.role.set   an ACT, at the organization's agent, under the ORGANIZATION's mandate: a steward
//                                  changes what a member does there (§3.3).
//
// WHY CAPABILITIES AND NOT TWO ROUTES. They were, for an afternoon: `GET /connect/org-membership/mine` and
// `POST /connect/org-member-role` on the Home, each a session RPC into the organization's object. The Home's bridge
// count is a ratchet that only goes down (ADR-0044; spec 341) — a new first-party surface is an INTENT, asked of the
// agent whose act it is, with a supplied plan when a screen already knows which. So the read is the person's agent
// asking each organization's object in-Worker about its own person, and the act is the organization's agent writing
// its own record under its own mandate.
//
// TWO MODULES, because they have two SUBJECTS (spec 366 R3): this one is the READ — the person's own agent, reading its
// own person's relationships and asking each organization about that same person; `member-role-set.ts` is the ACT,
// whose subject is the organization. A module that declares an organization as its subject and also reads records
// is exactly what `no-cross-subject-vault-reads` exists to stop, and it stopped this when the two shared a file.
//
// NEITHER IS AUTHORITY. A role is a word on a membership (324: "does not authorize execution"); no gate reads what
// these return or write. The access a role needs is its own ceremony, and the pack a role offers is the member's to
// accept — nothing here reaches a playbook.
import type { ToolSpec, ToolInvoker } from '@agenticprimitives/orchestration';
import { relationshipRows } from '@agenticprimitives/context';
import { PLAIN_MEMBER, type RoleOfferV1, type AssignedRoleFields } from './org-role.js';

export const PERSON_ROLES_CAPABILITY = 'person.roles.list' as const;

export const PERSON_ROLES_TOOL: ToolSpec = {
  id: PERSON_ROLES_CAPABILITY,
  answers: ['my roles', 'what is my role', 'what roles do i hold', 'what do i do at', 'my role at', 'which roles'],
  description:
    'THE ROLES THE PERSON HOLDS — what each organization, team or circle they belong to records them as (field worker, '
    + 'team lead, coach…), with the role\'s description and the skill packs it offers their agent, and which memberships '
    + 'have ended. Each organization answers for ITS OWN record of the person asking; nobody else\'s membership is read. '
    + 'A role is what they do there — it grants nothing by itself. Use it for "what is my role at the Weld team", "what '
    + 'roles do I hold". Args: org (optional — one organization, as the ask names it; without it, every organization they '
    + 'belong to).',
  inputSchema: { type: 'object', properties: { org: { type: 'string', description: 'Optional — one organization or team, as the ask names it (a name or an address)' } } },
  establishes: 'lookup',
};

/** What one organization answers about a member (`internal.member.role` on its object). */
export interface OrgMembershipAnswer {
  membership: { displayName?: string; admittedAt?: string; endedAt?: string; roleAssignment?: Partial<AssignedRoleFields> & Record<string, unknown> } | null;
  ended?: boolean;
  offer?: RoleOfferV1 | null;
  governedBy?: string;
}

export interface MemberRolesDeps {
  readSubjectRecord?: (subject: string, recordType: string) => Promise<unknown>;
  nameOf?: (address: string) => Promise<string | null>;
  /** The organization's own object, asked in-Worker for ITS record of `member`. Null = could not be asked. */
  membershipAt: (org: string, member: string) => Promise<OrgMembershipAnswer | null>;
}

/** One organization the person belongs (or belonged) to, as that organization records it. */
export interface HeldRoleV1 {
  org: string;
  name: string | null;
  /** The organization that was asked first when it was a workspace — its members are its governor's (`org`). */
  askedOf?: string;
  assignedRole: string;
  roleName?: string;
  roleDefinitionId?: string;
  description?: string;
  scope?: 'organization' | 'team';
  accessRole?: string;
  skillPackRefs: Array<{ context: string; archetype: string; version?: string }>;
  assignedBy?: string;
  assignedAt?: string;
  ended: boolean;
}

const ADDR = /^0x[0-9a-f]{40}$/;
/** How many organizations one read asks. A person in more than this is told the read was cut, never shown a partial list as whole. */
export const MAX_ORGS_ASKED = 40;

/**
 * Ask every organization the person belongs to what it records of them. `only` narrows to one. A workspace answers
 * with the organization that governs it, which is then asked instead (one hop, de-duplicated). An organization that
 * could not be asked is reported in `unread` — "no answer" must never read as "no role", or a pack would be dropped
 * from a playbook because a vault was slow.
 */
export async function rolesOf(deps: MemberRolesDeps, person: string, only?: string): Promise<{ roles: HeldRoleV1[]; asked: string[]; unread: string[]; truncated: boolean }> {
  const me = person.toLowerCase();
  let orgs: string[];
  if (only) orgs = [only.toLowerCase()];
  else {
    const rels = deps.readSubjectRecord ? await deps.readSubjectRecord(me, 'relationships.data').catch(() => null) : null;
    orgs = [...new Set(relationshipRows(rels).map((r) => String(r.agent ?? '').toLowerCase()).filter((a) => ADDR.test(a) && a !== me))];
  }
  const truncated = orgs.length > MAX_ORGS_ASKED;
  orgs = orgs.slice(0, MAX_ORGS_ASKED);
  const asked = new Set<string>();
  const unread: string[] = [];
  const held = new Map<string, HeldRoleV1>();
  const ask = async (org: string, askedOf?: string): Promise<void> => {
    if (asked.has(org)) return;
    asked.add(org);
    const a = await deps.membershipAt(org, me).catch(() => null);
    if (!a) { unread.push(org); return; }
    if (!a.membership) {
      const governor = String(a.governedBy ?? '').toLowerCase();
      if (!askedOf && ADDR.test(governor) && governor !== org) await ask(governor, org);
      return; // linked, but this organization records no membership of them (a steward's link, a service, a treasury)
    }
    const ra = a.membership.roleAssignment ?? {};
    held.set(org, {
      org, name: null, ...(askedOf ? { askedOf } : {}),
      assignedRole: String(ra.assignedRole ?? PLAIN_MEMBER),
      ...(a.offer ? { roleName: a.offer.name, roleDefinitionId: a.offer.roleDefinitionId, ...(a.offer.description ? { description: a.offer.description } : {}), scope: a.offer.scope, ...(a.offer.accessRole ? { accessRole: a.offer.accessRole } : {}) } : {}),
      skillPackRefs: a.offer?.skillPackRefs ?? [],
      ...(typeof ra.assignedBy === 'string' ? { assignedBy: ra.assignedBy } : {}),
      ...(typeof ra.assignedAt === 'string' ? { assignedAt: ra.assignedAt } : {}),
      ended: a.ended === true,
    });
  };
  await Promise.all(orgs.map((o) => ask(o)));
  const roles = [...held.values()];
  if (deps.nameOf) await Promise.all(roles.map(async (r) => { r.name = await deps.nameOf!(r.org).catch(() => null); }));
  roles.sort((x, y) => (x.name ?? x.org).localeCompare(y.name ?? y.org));
  return { roles, asked: [...asked], unread, truncated };
}

export function personRolesInvoker(deps: MemberRolesDeps, person: string | undefined): ToolInvoker {
  return async (_toolId, args) => {
    if (!person) return { refused: 'a person\'s roles are read from the organizations they belong to, and there is no signed-in person on this run' };
    const only = String(args.org ?? '').toLowerCase();
    if (!only && !deps.readSubjectRecord) return { refused: 'this agent cannot read its person\'s relationships here' };
    if (only && !ADDR.test(only)) return { refused: 'which organization? name one you belong to' };
    const { roles, asked, unread, truncated } = await rolesOf(deps, person, only || undefined);
    const live = roles.filter((r) => !r.ended);
    const named = live.filter((r) => r.assignedRole !== PLAIN_MEMBER);
    return {
      count: named.length,
      roles,
      memberships: live.length,
      ended: roles.filter((r) => r.ended).map((r) => r.org),
      asked, unread, ...(truncated ? { truncated: true } : {}),
      interpretation: `asked ${asked.length} organization(s) what each records of the person`,
      note: named.length
        ? 'Each role is what that organization records the person as — it grants nothing by itself. A role may offer skill packs for their agent; equipping is theirs to do, on their Playbook page.'
        : live.length ? 'They belong to these organizations as a member; none has named a role for them.' : 'No organization records a membership of them.',
      ...(unread.length ? { caveat: `${unread.length} organization(s) could not be asked just now — their roles are unknown, not absent.` } : {}),
    };
  };
}
