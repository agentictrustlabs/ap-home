// Spec 427 §5 — which role packs a playbook should hold. The organization offers; the person equips; a pack whose
// membership ended is dropped; and an organization that could not be asked decides nothing.
import { describe, it, expect } from 'vitest';
import { planRolePacks, mergeRolesReads, packHeading, type ComposedFrom, type ComposedPack, type HeldRole } from './role-playbook';

const WELD = '0x1111111111111111111111111111111111111111';
const ORG = '0x5555555555555555555555555555555555555555';
const ME = '0x2222222222222222222222222222222222222222';
const lead = { context: 'field-operations', archetype: 'role-team-lead' };
const worker = { context: 'field-operations', archetype: 'role-field-worker' };
const coord = { context: 'field-operations', archetype: 'role-coordinator' };
const pack = (org: string, ref: { context: string; archetype: string }, roleName: string): ComposedPack => ({ ...ref, version: '1.0.0', digest: '0xabc', organization: org, organizationName: 'Weld Corridor Team', roleDefinitionId: `roledef:${ORG}:${ref.archetype.replace('role-', '')}@1`, roleName, equippedAt: '2026-10-05T00:00:00.000Z', equippedBy: ME, equippedAs: 'self' });
const role = (org: string, refs: Array<{ context: string; archetype: string }>, over: Partial<HeldRole> = {}): HeldRole => ({ org, name: 'x', assignedRole: 'team-lead', roleName: 'Team lead', roleDefinitionId: `roledef:${ORG}:team-lead@1`, skillPackRefs: refs, ended: false, ...over });
const composed = (packs: ComposedPack[]): ComposedFrom => ({ base: { context: 'agentic-trust', archetype: 'person-steward', version: '1.0.0', digest: '0xbase' }, packs });

describe('planRolePacks', () => {
  it('a held role\'s pack is OFFERED, never planned in', () => {
    const plan = planRolePacks(null, { roles: [role(WELD, [lead])], asked: [WELD], unread: [] });
    expect(plan.offers).toEqual([{ role: role(WELD, [lead]), pack: lead }]);
    expect(plan.equipped).toEqual([]);
    expect(plan.drop).toEqual([]);
  });

  it('an equipped pack whose role still offers it is held, and is not offered again', () => {
    const plan = planRolePacks(composed([pack(WELD, lead, 'Team lead')]), { roles: [role(WELD, [lead])], asked: [WELD], unread: [] });
    expect(plan.equipped.map((e) => e.state)).toEqual(['held']);
    expect(plan.offers).toEqual([]);
    expect(plan.drop).toEqual([]);
  });

  it('a membership that ENDED drops its pack', () => {
    const ended = planRolePacks(composed([pack(WELD, lead, 'Team lead')]), { roles: [role(WELD, [lead], { ended: true })], asked: [WELD], unread: [] });
    expect(ended.equipped[0]!.state).toBe('ended');
    expect(ended.drop).toHaveLength(1);
    expect(ended.offers).toEqual([]);
    // …and so does an organization that answered with no membership of them at all.
    const gone = planRolePacks(composed([pack(WELD, lead, 'Team lead')]), { roles: [], asked: [WELD], unread: [] });
    expect(gone.equipped[0]!.state).toBe('ended');
  });

  it('a role that CHANGED drops the old pack and offers the new one', () => {
    const plan = planRolePacks(composed([pack(WELD, worker, 'Field worker')]), { roles: [role(WELD, [lead])], asked: [WELD], unread: [] });
    expect(plan.equipped[0]!.state).toBe('changed');
    expect(plan.drop.map((p) => p.archetype)).toEqual(['role-field-worker']);
    expect(plan.offers.map((o) => o.pack.archetype)).toEqual(['role-team-lead']);
  });

  it('an organization that could not be asked decides NOTHING — its pack stays', () => {
    const unread = planRolePacks(composed([pack(WELD, lead, 'Team lead')]), { roles: [], asked: [WELD], unread: [WELD] });
    expect(unread.equipped[0]!.state).toBe('unknown');
    expect(unread.drop).toEqual([]);
    const notAsked = planRolePacks(composed([pack(WELD, lead, 'Team lead')]), { roles: [], asked: [], unread: [] });
    expect(notAsked.drop).toEqual([]);
    const noRead = planRolePacks(composed([pack(WELD, lead, 'Team lead')]), null);
    expect(noRead.equipped[0]!.state).toBe('unknown');
    expect(noRead.drop).toEqual([]);
  });

  it('the same pack from two organizations is two packs — losing one membership keeps the other', () => {
    const plan = planRolePacks(composed([pack(WELD, lead, 'Team lead'), pack(ORG, lead, 'Team lead')]), { roles: [role(ORG, [lead])], asked: [WELD, ORG], unread: [] });
    expect(plan.equipped.map((e) => [e.pack.organization, e.state])).toEqual([[WELD, 'ended'], [ORG, 'held']]);
    expect(plan.drop.map((p) => p.organization)).toEqual([WELD]);
  });

  it('a plain member is offered nothing', () => {
    expect(planRolePacks(null, { roles: [role(WELD, [], { assignedRole: 'member', roleName: undefined })], asked: [WELD], unread: [] }).offers).toEqual([]);
  });
});

describe('mergeRolesReads', () => {
  it('a narrower ask about one organization rescues it from "unread"', () => {
    const merged = mergeRolesReads([
      { roles: [role(ORG, [coord])], asked: [ORG, WELD], unread: [WELD] },
      { roles: [role(WELD, [lead])], asked: [WELD], unread: [] },
    ]);
    expect(merged.unread).toEqual([]);
    expect(merged.roles.map((r) => r.org).sort()).toEqual([WELD, ORG].sort());
  });
  it('an organization no ask reached stays unread', () => {
    expect(mergeRolesReads([{ roles: [], asked: [WELD], unread: [WELD] }]).unread).toEqual([WELD]);
  });
});

describe('packHeading', () => {
  it('names the role and where it is held', () => {
    expect(packHeading({ roleName: 'Team lead', organizationName: 'Weld Corridor Team', organization: WELD })).toBe('Team lead at Weld Corridor Team');
    expect(packHeading({ roleName: 'Coach', organization: WELD })).toBe('Coach at 0x1111…1111');
  });
});
