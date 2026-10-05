// Spec 427 — the two capabilities: a person's agent reads what each organization records of ITS person, and an
// organization's agent sets a member's role under the organization's mandate. Neither is authority.
import { describe, it, expect } from 'vitest';
import { InputRequired } from '@agenticprimitives/orchestration';
import { rolesOf, personRolesInvoker, PERSON_ROLES_TOOL, MAX_ORGS_ASKED, type OrgMembershipAnswer } from '../src/member-roles.js';
import { memberRoleSetInvoker, MEMBER_ROLE_SET_TOOL } from '../src/member-role-set.js';

const ME = '0x2222222222222222222222222222222222222222';
const WELD = '0x1111111111111111111111111111111111111111';
const ORG = '0x5555555555555555555555555555555555555555';
const WORKSPACE = '0x6666666666666666666666666666666666666666';
const TREASURY = '0x7777777777777777777777777777777777777777';
const STEWARD = '0x3333333333333333333333333333333333333333';
const lead = { type: 'ap.org.role-offer.v1' as const, roleDefinitionId: `roledef:${ORG}:team-lead@1`, name: 'Team lead', description: 'Leads a team.', scope: 'team' as const, accessRole: 'community-steward', skillPackRefs: [{ context: 'field-operations', archetype: 'role-team-lead' }] };
const PERSONA = '0x8888888888888888888888888888888888888888';
const rels = { orgs: { [WELD]: { relationship: 'member', kind: 'team' }, [WORKSPACE]: { relationship: 'member', kind: 'workspace' }, [TREASURY]: { relationship: 'steward', kind: 'person-treasury' }, [PERSONA]: { relationship: 'self', kind: 'person' } } };
const ctx = { step: { id: 's1' }, index: 0, supplied: [], intent: {} } as never;

function world(answers: Record<string, OrgMembershipAnswer | null | 'throw'>) {
  const asked: Array<[string, string]> = [];
  return {
    asked,
    deps: {
      readSubjectRecord: async (_s: string, rt: string) => (rt === 'relationships.data' ? rels : null),
      nameOf: async (a: string) => ({ [WELD]: 'weld.team', [ORG]: 'field.org' } as Record<string, string>)[a] ?? null,
      membershipAt: async (org: string, member: string) => { asked.push([org, member]); const a = answers[org]; if (a === 'throw') throw new Error('vault slow'); return a === undefined ? { membership: null } : a; },
    },
  };
}

describe('person.roles.list', () => {
  it('asks each organization the person belongs to about THE PERSON, and follows a workspace to its governor', async () => {
    const w = world({
      [WELD]: { membership: { roleAssignment: { assignedRole: 'team-lead', assignedBy: STEWARD, assignedAt: '2026-10-05T00:00:00.000Z' } }, ended: false, offer: lead },
      [WORKSPACE]: { membership: null, governedBy: ORG },
      [ORG]: { membership: { roleAssignment: { assignedRole: 'member' } }, ended: false, offer: null },
    });
    const r = await rolesOf(w.deps, ME);
    expect(w.asked.every(([, m]) => m === ME)).toBe(true);
    expect(r.roles.map((x) => [x.org, x.assignedRole, x.askedOf ?? null])).toEqual([[ORG, 'member', WORKSPACE], [WELD, 'team-lead', null]]);
    const weld = r.roles.find((x) => x.org === WELD)!;
    expect(weld).toMatchObject({ name: 'weld.team', roleName: 'Team lead', roleDefinitionId: lead.roleDefinitionId, accessRole: 'community-steward', skillPackRefs: lead.skillPackRefs, ended: false, assignedBy: STEWARD });
    // A treasury and another name of their own hold no members: they are not even asked.
    expect(w.asked.some(([o]) => o === TREASURY || o === PERSONA)).toBe(false);
    expect(r.roles.some((x) => x.org === TREASURY)).toBe(false);
    expect(r.unread).toEqual([]);
  });

  it('an organization that could not be asked is UNREAD, never "no role"', async () => {
    const w = world({ [WELD]: 'throw', [WORKSPACE]: null });
    const r = await rolesOf(w.deps, ME);
    expect(r.unread.sort()).toEqual([WELD, WORKSPACE].sort());
    const out = (await personRolesInvoker(w.deps, ME)('person.roles.list', {}, ctx)) as { caveat?: string; count: number };
    expect(out.count).toBe(0);
    expect(out.caveat).toMatch(/unknown, not absent/);
  });

  it('an ended membership is reported as ended, so its pack can be dropped', async () => {
    const w = world({ [WELD]: { membership: { endedAt: '2026-10-04T00:00:00.000Z', roleAssignment: { assignedRole: 'team-lead' } }, ended: true, offer: lead } });
    const out = (await personRolesInvoker(w.deps, ME)('person.roles.list', {}, ctx)) as { count: number; ended: string[]; roles: Array<{ ended: boolean }> };
    expect(out.count).toBe(0);
    expect(out.ended).toEqual([WELD]);
  });

  it('one organization can be named; with nobody signed in it refuses', async () => {
    const w = world({ [ORG]: { membership: { roleAssignment: { assignedRole: 'member' } }, ended: false, offer: null } });
    const out = (await personRolesInvoker(w.deps, ME)('person.roles.list', { org: ORG }, ctx)) as { asked: string[]; memberships: number };
    expect(out.asked).toEqual([ORG]);
    expect(out.memberships).toBe(1);
    expect(await personRolesInvoker(w.deps, undefined)('person.roles.list', {}, ctx)).toHaveProperty('refused');
  });

  it('a very large set of organizations is cut and SAID to be cut', async () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i < MAX_ORGS_ASKED + 5; i++) many[`0x${i.toString(16).padStart(40, '0')}`] = { relationship: 'member' };
    const r = await rolesOf({ readSubjectRecord: async () => ({ orgs: many }), membershipAt: async () => ({ membership: null }) }, ME);
    expect(r.asked.length).toBe(MAX_ORGS_ASKED);
    expect(r.truncated).toBe(true);
  });

  it('is a read: a lookup with no capability to authorize', () => {
    expect(PERSON_ROLES_TOOL.establishes).toBe('lookup');
    expect(PERSON_ROLES_TOOL.capability).toBeUndefined();
  });
});

describe('organization.member.role.set', () => {
  const calls: Array<{ org: string; input: unknown }> = [];
  const deps = (status = 200, body: Record<string, unknown> = { ok: true, previous: 'member', changed: true }) => ({
    setRoleAt: async (org: string, input: unknown) => { calls.push({ org, input }); return { status, body }; },
    nameOf: async () => 'yusuf.me',
  });

  it('is the ORGANIZATION\'s act under its mandate — never self-authorized', () => {
    expect(MEMBER_ROLE_SET_TOOL.capability).toMatchObject({ id: 'organization.member.role.set', authorityArg: 'org' });
    expect((MEMBER_ROLE_SET_TOOL as { selfAuthorized?: boolean }).selfAuthorized).toBeUndefined();
    expect(MEMBER_ROLE_SET_TOOL.subject).toBe('org');
  });

  it('writes the offer on the member\'s record, as the steward whose mandate it is', async () => {
    calls.length = 0;
    const out = (await memberRoleSetInvoker(deps(), WELD, STEWARD)('organization.member.role.set', { org: WELD, member: ME, role: lead }, ctx)) as { set: boolean; role: string; answer: string };
    expect(out).toMatchObject({ set: true, role: 'team-lead', answer: 'yusuf.me is now Team lead.' });
    expect(calls).toEqual([{ org: WELD, input: { member: ME, orgRole: { ...lead }, by: STEWARD } }]);
  });

  it('a mandate from one organization never writes another\'s roster', async () => {
    await expect(memberRoleSetInvoker(deps(), ORG, STEWARD)('organization.member.role.set', { org: WELD, member: ME, role: lead }, ctx)).rejects.toThrow(/mandate's delegator/);
  });

  it('"member" clears a named role; no role at all ASKS which', async () => {
    calls.length = 0;
    const out = (await memberRoleSetInvoker(deps(200, { ok: true, previous: 'team-lead', changed: true }), WELD, STEWARD)('organization.member.role.set', { org: WELD, member: ME, role: 'member' }, ctx)) as { role: string };
    expect(out.role).toBe('member');
    expect((calls[0]!.input as { orgRole: unknown }).orgRole).toBeNull();
    await expect(memberRoleSetInvoker(deps(), WELD, STEWARD)('organization.member.role.set', { org: WELD, member: ME }, ctx)).rejects.toBeInstanceOf(InputRequired);
    await expect(memberRoleSetInvoker(deps(), WELD, STEWARD)('organization.member.role.set', { org: WELD, member: 'yusuf', role: lead }, ctx)).rejects.toBeInstanceOf(InputRequired);
  });

  it('an offer carrying anything but ids and words is refused before the object is asked', async () => {
    calls.length = 0;
    const out = await memberRoleSetInvoker(deps(), WELD, STEWARD)('organization.member.role.set', { org: WELD, member: ME, role: { ...lead, delegation: {} } }, ctx);
    expect(out).toHaveProperty('refused');
    expect(calls).toEqual([]);
  });

  it('the object\'s refusal is the answer (no membership, ended)', async () => {
    const out = (await memberRoleSetInvoker(deps(404, { ok: false, code: 'no_membership', error: 'that agent holds no membership record here' }), WELD, STEWARD)('organization.member.role.set', { org: WELD, member: ME, role: lead }, ctx)) as { refused: string; code: string };
    expect(out.code).toBe('no_membership');
  });
});
