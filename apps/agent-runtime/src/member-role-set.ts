// A STEWARD SETS WHAT A MEMBER DOES IN THE ORGANIZATION — spec 427 §3.3, capability `organization.member.role.set`.
//
// The ORGANIZATION's act, run at its own agent under its own mandate (the steward's credential signs as the
// organization). It rewrites the role on a membership record that already exists and does nothing else: it makes
// nobody a member, issues no access, and cannot reach the member's playbook — the role's skill pack is offered to
// them and is theirs to accept. A role is a word (324: "does not authorize execution"); no gate reads it.
//
// It reads no records: the organization's own object does the write in-Worker, and says what was there before.
// The read half of spec 427 — a person's agent asking what roles its person holds — is `member-roles.ts`, a
// different subject (spec 366 R3), and so a different module.
import { InputRequired, type ToolSpec, type ToolInvoker } from '@agenticprimitives/orchestration';
import { ADAPTER, CARRIES } from './adapter-declarations.js';
import { parseRoleOffer, roleSlugOf, PLAIN_MEMBER, type RoleOfferV1 } from './org-role.js';

export const MEMBER_ROLE_SET_CAPABILITY = 'organization.member.role.set' as const;

const ADDR = /^0x[0-9a-f]{40}$/;

export const MEMBER_ROLE_SET_TOOL: ToolSpec = {
  id: MEMBER_ROLE_SET_CAPABILITY,
  adapter: ADAPTER.sync,
  carries: CARRIES.memberRole,
  verbs: ['make', 'assign', 'set the role', 'change the role', 'promote', 'appoint'],
  // The organization's own record of its member is rewritten: when this returns, that is what the record says.
  establishes: 'authoritative',
  description:
    'Sets the ROLE a member holds in an organization or team — what they do there (field worker, team lead, coach…). '
    + 'Requires a mandate from the organization. It rewrites the role on the member\'s existing membership record; it '
    + 'does NOT make anybody a member (invite them), grants no access (the role\'s access is its own ceremony) and does not '
    + 'touch the member\'s agent — the role\'s skill pack is offered to them and is theirs to accept. Args: org (the '
    + 'organization or team, as the ask names it — whose authority this needs), member (the member, EXACTLY as the ask '
    + 'names them), role (the role offer from the organization\'s own catalogue — its definition id, name, description, '
    + 'scope, access role and skill packs; or the word "member" to remove a named role).',
  inputSchema: {
    type: 'object',
    properties: {
      org: { type: 'string', description: 'The organization or team, as the ask names it (a name or an address)' },
      member: { type: 'string', description: 'The member whose role changes, as the ask names them (a name, a typed name, or an address)' },
      role: { description: 'The role offer (ap.org.role-offer.v1) from the organization\'s catalogue, or "member" for the plain role' },
    },
    required: ['org', 'member'],
  },
  capability: { id: MEMBER_ROLE_SET_CAPABILITY, action: 'assign', resourceArg: 'org', authorityArg: 'org' },
  risk: 'low',
  // The ORGANIZATION sets it; the act runs at its own agent, under its own mandate (spec 374's rule for org acts).
  subject: 'org',
  interaction: { navigationTarget: 'members' },
};

export interface MemberRoleSetDeps {
  /** The organization's own object, in-Worker: writes the role on `member`'s membership record. */
  setRoleAt: (org: string, input: { member: string; orgRole: RoleOfferV1 | null; by: string }) => Promise<{ status: number; body: Record<string, unknown> }>;
  nameOf?: (address: string) => Promise<string | null>;
}

/**
 * `mandateDelegator` is the delegator of the mandate the run presented — the organization whose act this is. The
 * plan's `org` must be that organization: a mandate from one organization never writes another's roster.
 */
export function memberRoleSetInvoker(deps: MemberRoleSetDeps, mandateDelegator: string, steward: string | undefined): ToolInvoker {
  return async (toolId, args, ctx) => {
    const stepRef = ctx.step.id ?? `s${ctx.index}`;
    const org = String(args.org ?? '').toLowerCase();
    const member = String(args.member ?? '').toLowerCase();
    if (org !== mandateDelegator.toLowerCase()) throw new Error(`a role is set by the mandate's delegator (${mandateDelegator}); the plan named ${org || 'no organization'}`);
    if (!steward) return { refused: 'setting a role is a steward\'s act, and there is no signed-in person on this run' };
    if (!ADDR.test(member)) {
      throw new InputRequired({ kind: 'data', stepRef, toolId, prompt: 'Whose role? Give the member\'s agent address.', fields: [{ name: 'member', label: 'Member', type: 'address', required: true, hint: 'their smart-agent address (0x…), from the roster' }] });
    }
    let offer: RoleOfferV1 | null;
    if (args.role === null || args.role === undefined || (typeof args.role === 'string' && args.role.trim().toLowerCase() === PLAIN_MEMBER)) {
      if (args.role === undefined) {
        // A sentence names a role by a word; the record takes the organization's DEFINITION of it. The catalogue is the
        // organization's app's (spec 427 §3.1), so the surface that asked supplies the offer — never a guess here.
        throw new InputRequired({ kind: 'data', stepRef, toolId, prompt: 'Which role? Pick one from the organization\'s roles — the role\'s definition travels with the change.', fields: [{ name: 'role', label: 'Role', type: 'text', required: true, hint: 'a role from this organization\'s catalogue, or "member" for none' }] });
      }
      offer = null;
    } else {
      const parsed = parseRoleOffer(args.role);
      if (!parsed.ok) return { refused: `that is not a role this organization can record — ${parsed.error}` };
      offer = parsed.offer;
    }
    const r = await deps.setRoleAt(org, { member, orgRole: offer, by: steward.toLowerCase() });
    const name = deps.nameOf ? await deps.nameOf(member).catch(() => null) : null;
    const who = name ?? member;
    if (r.status !== 200 || r.body.ok !== true) {
      const code = typeof r.body.code === 'string' ? r.body.code : undefined;
      return { refused: String(r.body.error ?? `the role was not set (${r.status})`), ...(code ? { code } : {}), member };
    }
    const roleName = offer?.name ?? 'member';
    return {
      set: true, org, member, role: offer ? roleSlugOf(offer.roleDefinitionId) : PLAIN_MEMBER, roleName,
      previous: r.body.previous ?? PLAIN_MEMBER, changed: r.body.changed !== false,
      answer: r.body.changed === false ? `${who} is already ${roleName} there.` : `${who} is now ${roleName}.`,
      note: offer?.skillPackRefs.length
        ? 'The role is recorded. Its skill pack is offered to them — equipping their agent is theirs to do. Access for the role is issued by its own ceremony.'
        : 'The role is recorded. It grants nothing by itself.',
    };
  };
}
