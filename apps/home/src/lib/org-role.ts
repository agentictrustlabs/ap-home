// A ROLE ON A MEMBERSHIP, AND THE OFFER THAT CARRIES IT — spec 427 §3.
//
// A role is what somebody DOES in an organization ("field worker", "team lead"). It is a record on the
// membership that points at a role definition the organization owns, and it confers nothing:
//
//   the ROLE is declarative (spec 324: "does not authorize execution") — no gate reads it;
//   the ACCESS it needs is still only the delegation that materializes it;
//   the BEHAVIOUR it offers is still only the playbook the person's own agent holds, which only the
//   person (or the agent's steward) may write.
//
// What crosses the wire and is stored is a SNAPSHOT of the definition (`RoleOfferV1`), so a reader shows
// the role without chasing a pointer into another vault. It carries ids and words ONLY. Every key is
// named here and anything else is refused at the door — a role offer that could smuggle a delegation, a
// caveat or a tool list would be a second road to authority, and there is exactly one (ADR-0041).
//
// Pure: no I/O, no clock unless handed one. The object that records a membership and the Home route that
// stores an invitation both call it, so the two cannot disagree about what an offer is.
//
// ONE FILE IN TWO PLACES: `apps/agent-runtime/src/org-role.ts` and `apps/home/src/lib/org-role.ts` are
// byte-identical (the two apps share no package, and the Home's build does not reach into the runtime's tree).
// `apps/home/src/lib/org-role.parity.test.ts` fails the moment they differ — edit one, copy it to the other.
// In the Home it sits under `src/` because both its server routes and its ceremony pages read an offer.

/** A skill pack in the skills registry — a reference, never content. */
export interface SkillPackRef { context: string; archetype: string; version?: string }

/** The role an organization offers with an invitation: a snapshot of its own role definition. */
export interface RoleOfferV1 {
  type: 'ap.org.role-offer.v1';
  /** `roledef:<org sa>:<slug>@<version>` — the DEFINING organization's own id (a team may offer its governor's). */
  roleDefinitionId: string;
  /** "Field worker". */
  name: string;
  /** One or two sentences a person reads before accepting. */
  description: string;
  scope: 'organization' | 'team';
  /** The access role whose delegations materialize this role, in the issuing app's vocabulary. Explains; never authorizes. */
  accessRole?: string;
  skillPackRefs: SkillPackRef[];
}

/** The role fields of `ap.org.membership.v1` `roleAssignment` (the delegation and the household facets ride beside them). */
export interface AssignedRoleFields {
  assignedRole: string;
  roleDefinitionId?: string;
  roleName?: string;
  roleDescription?: string;
  scope?: 'organization' | 'team';
  accessRole?: string;
  skillPackRefs?: SkillPackRef[];
  /** The steward who offered it (the invitation's `invitedBy`) or set it (`org.setMemberRole`). */
  assignedBy?: string;
  assignedAt?: string;
  /** Present when a steward set the role AFTER admission: that standing role outlives a re-run of the join. */
  roleSetAt?: string;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ROLE_DEF_ID = /^roledef:(0x[0-9a-f]{40}):([a-z0-9][a-z0-9-]{0,39})@([0-9a-z][0-9a-z.-]{0,19})$/;
const VERSION = /^[0-9a-z][0-9a-z.-]{0,19}$/;
const OFFER_KEYS = new Set(['type', 'roleDefinitionId', 'name', 'description', 'scope', 'accessRole', 'skillPackRefs']);
const PACK_KEYS = new Set(['context', 'archetype', 'version']);
export const MAX_SKILL_PACKS = 4;

/** The plain role every member holds when no role was offered. */
export const PLAIN_MEMBER = 'member';

/** The slug a role definition id names (`roledef:<org>:<slug>@<v>` → `<slug>`), or '' when it is not one. */
export const roleSlugOf = (roleDefinitionId: string): string => ROLE_DEF_ID.exec(String(roleDefinitionId ?? '').toLowerCase())?.[2] ?? '';

/** The organization that DEFINES a role (`roledef:<org>:…`), or ''. */
export const roleDefinerOf = (roleDefinitionId: string): string => ROLE_DEF_ID.exec(String(roleDefinitionId ?? '').toLowerCase())?.[1] ?? '';

export type ParsedRoleOffer = { ok: true; offer: RoleOfferV1 } | { ok: false; error: string };

/**
 * Read an untrusted value as a role offer. STRICT: an unknown key is an error, not something to drop — an
 * offer is stored in an organization's vault and shown to the person being invited, and "we ignored the part
 * we did not understand" is how a field that looks like authority ends up on a record somebody later trusts.
 * The returned offer is rebuilt from the checked parts, normalised (lower-case ids, trimmed words).
 */
export function parseRoleOffer(input: unknown): ParsedRoleOffer {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'a role offer is an object' };
  const o = input as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!OFFER_KEYS.has(k)) return { ok: false, error: `a role offer carries ids and words only — "${k.slice(0, 40)}" is not part of one` };
  if (o.type !== 'ap.org.role-offer.v1') return { ok: false, error: 'role offer type must be ap.org.role-offer.v1' };
  const roleDefinitionId = String(o.roleDefinitionId ?? '').trim().toLowerCase();
  if (!ROLE_DEF_ID.test(roleDefinitionId)) return { ok: false, error: 'roleDefinitionId must read roledef:<organization address>:<slug>@<version>' };
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  if (!name || name.length > 60) return { ok: false, error: 'a role needs a name of at most 60 characters' };
  const description = typeof o.description === 'string' ? o.description.trim() : '';
  if (description.length > 400) return { ok: false, error: 'a role description is at most 400 characters' };
  if (o.scope !== 'organization' && o.scope !== 'team') return { ok: false, error: 'role scope is "organization" or "team"' };
  let accessRole: string | undefined;
  if (o.accessRole !== undefined && o.accessRole !== null && o.accessRole !== '') {
    accessRole = String(o.accessRole).trim().toLowerCase();
    if (!SLUG.test(accessRole)) return { ok: false, error: 'accessRole is a role name (lower-case letters, digits and dashes)' };
  }
  const rawPacks = o.skillPackRefs === undefined ? [] : o.skillPackRefs;
  if (!Array.isArray(rawPacks)) return { ok: false, error: 'skillPackRefs is a list of registry references' };
  if (rawPacks.length > MAX_SKILL_PACKS) return { ok: false, error: `a role offers at most ${MAX_SKILL_PACKS} skill packs` };
  const skillPackRefs: SkillPackRef[] = [];
  const seen = new Set<string>();
  for (const p of rawPacks) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, error: 'a skill pack reference is { context, archetype, version? }' };
    const r = p as Record<string, unknown>;
    for (const k of Object.keys(r)) if (!PACK_KEYS.has(k)) return { ok: false, error: `a skill pack reference names a registry entry only — "${k.slice(0, 40)}" is not part of one` };
    const context = String(r.context ?? '').trim().toLowerCase();
    const archetype = String(r.archetype ?? '').trim().toLowerCase();
    if (!SLUG.test(context) || !SLUG.test(archetype)) return { ok: false, error: 'a skill pack reference needs a registry context and an archetype id' };
    let version: string | undefined;
    if (r.version !== undefined && r.version !== null && r.version !== '') {
      version = String(r.version).trim().toLowerCase();
      if (!VERSION.test(version)) return { ok: false, error: 'a skill pack version is a short version string' };
    }
    const key = `${context}/${archetype}`;
    if (seen.has(key)) continue;
    seen.add(key);
    skillPackRefs.push({ context, archetype, ...(version ? { version } : {}) });
  }
  return {
    ok: true,
    offer: { type: 'ap.org.role-offer.v1', roleDefinitionId, name, description, scope: o.scope, ...(accessRole ? { accessRole } : {}), skillPackRefs },
  };
}

/** The membership's role fields for an offer. `by` is who offered or set it; `at` when. */
export function roleFieldsFromOffer(offer: RoleOfferV1, by?: string, at?: string): AssignedRoleFields {
  const who = /^0x[0-9a-fA-F]{40}$/.test(String(by ?? '')) ? String(by).toLowerCase() : '';
  return {
    assignedRole: roleSlugOf(offer.roleDefinitionId),
    roleDefinitionId: offer.roleDefinitionId,
    roleName: offer.name,
    ...(offer.description ? { roleDescription: offer.description } : {}),
    scope: offer.scope,
    ...(offer.accessRole ? { accessRole: offer.accessRole } : {}),
    ...(offer.skillPackRefs.length ? { skillPackRefs: offer.skillPackRefs } : {}),
    ...(who ? { assignedBy: who } : {}),
    ...(at ? { assignedAt: at } : {}),
  };
}

/** The offer a recorded role came from — what a member is shown, and what equip composes from. Null for a plain member. */
export function offerFromRoleFields(f: Partial<AssignedRoleFields> | null | undefined): RoleOfferV1 | null {
  if (!f || !f.roleDefinitionId) return null;
  const p = parseRoleOffer({
    type: 'ap.org.role-offer.v1', roleDefinitionId: f.roleDefinitionId, name: f.roleName ?? f.assignedRole ?? '',
    description: f.roleDescription ?? '', scope: f.scope ?? 'organization',
    ...(f.accessRole ? { accessRole: f.accessRole } : {}), skillPackRefs: f.skillPackRefs ?? [],
  });
  return p.ok ? p.offer : null;
}

const ROLE_FIELD_KEYS = ['assignedRole', 'roleDefinitionId', 'roleName', 'roleDescription', 'scope', 'accessRole', 'skillPackRefs', 'assignedBy', 'assignedAt', 'roleSetAt'] as const;

/** A role assignment with its role fields removed — the delegation and the household facets, which a role change keeps. */
export function withoutRoleFields<T extends Record<string, unknown>>(roleAssignment: T | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(roleAssignment ?? {}) };
  for (const k of ROLE_FIELD_KEYS) delete out[k];
  return out;
}

/**
 * WHICH ROLE DOES THIS MEMBERSHIP RECORD? (spec 427 invariant 3 — a member cannot record a role they were not
 * offered.) The member writes their own membership record; the role on it is the ORGANIZATION's statement. So the
 * role is never taken from what the member sent: it is read from the organization's own records, and what the
 * member sent is only checked against it.
 *
 *   · a role a steward SET after admission (`roleSetAt` on a live record) stands — a join re-run (an idempotent
 *     ceremony, a re-admission script) must not put the invitation's older role back;
 *   · otherwise the role on the invitation the organization stored for this member;
 *   · otherwise the plain member.
 *
 * A record that CLAIMS a role (anything but the plain member) which is not that one is refused, by name.
 */
export function resolveAssignedRole(input: {
  /** `roleAssignment` as the member's record claims it. */
  claimed?: { assignedRole?: unknown; roleDefinitionId?: unknown } | null;
  /** The organization's `org.invite:agent:<member>` record, when it has one. */
  invite?: { orgRole?: unknown; invitedBy?: unknown; status?: unknown } | null;
  /** The organization's existing membership record for this member, when it has one. */
  existing?: { endedAt?: unknown; roleAssignment?: Partial<AssignedRoleFields> | null } | null;
  now: string;
}): { ok: true; fields: AssignedRoleFields; from: 'steward' | 'invitation' | 'none' } | { ok: false; code: 'role_not_offered'; error: string } {
  let fields: AssignedRoleFields = { assignedRole: PLAIN_MEMBER };
  let from: 'steward' | 'invitation' | 'none' = 'none';
  // What the invitation offers — the role when nothing later replaced it, and always something the member may NAME.
  let invited: AssignedRoleFields | null = null;
  if (input.invite && input.invite.status !== 'removed' && input.invite.status !== 'declined' && input.invite.orgRole !== undefined) {
    const p = parseRoleOffer(input.invite.orgRole);
    // An invitation whose stored offer no longer parses offers no role; the membership still stands as a plain one.
    if (p.ok) invited = roleFieldsFromOffer(p.offer, String(input.invite.invitedBy ?? ''), input.now);
  }
  const standing = input.existing && !input.existing.endedAt && input.existing.roleAssignment?.roleSetAt ? input.existing.roleAssignment : null;
  if (standing) {
    const kept: Record<string, unknown> = {};
    for (const k of ROLE_FIELD_KEYS) if (standing[k] !== undefined) kept[k] = standing[k];
    fields = { assignedRole: PLAIN_MEMBER, ...kept } as AssignedRoleFields;
    from = 'steward';
  } else if (invited) {
    fields = invited;
    from = 'invitation';
  }
  const claimedRole = String(input.claimed?.assignedRole ?? '').trim().toLowerCase();
  const claimedDef = String(input.claimed?.roleDefinitionId ?? '').trim().toLowerCase();
  const claims = (claimedRole && claimedRole !== PLAIN_MEMBER) || !!claimedDef;
  if (claims) {
    // A claim is honest when it names the role being recorded OR the one the invitation offered: a join re-run
    // after a steward changed the role still names the invitation's, and is recorded as the steward's.
    const matches = (f: AssignedRoleFields | null): boolean => !!f && (!claimedRole || claimedRole === f.assignedRole) && (!claimedDef || claimedDef === (f.roleDefinitionId ?? ''));
    if (!matches(fields) && !matches(invited)) {
      return { ok: false, code: 'role_not_offered', error: `this organization did not offer you the role "${(claimedRole || claimedDef).slice(0, 80)}" — a membership records the role on the organization's own invitation` };
    }
  }
  return { ok: true, fields, from };
}
