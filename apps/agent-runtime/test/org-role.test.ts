// Spec 427 §3 — the role offer is ids and words only, and a member cannot record a role they were not offered.
import { describe, it, expect } from 'vitest';
import { parseRoleOffer, resolveAssignedRole, roleFieldsFromOffer, roleSlugOf, roleDefinerOf, offerFromRoleFields, withoutRoleFields } from '../src/org-role.js';

const ORG = '0x1111111111111111111111111111111111111111';
const STEWARD = '0x3333333333333333333333333333333333333333';
const offer = {
  type: 'ap.org.role-offer.v1', roleDefinitionId: `roledef:${ORG}:field-worker@1`, name: 'Field worker',
  description: 'Records the work among a people and what was seen.', scope: 'team', accessRole: 'field-recorder',
  skillPackRefs: [{ context: 'field-operations', archetype: 'role-field-worker' }],
};
const NOW = '2026-10-05T12:00:00.000Z';

describe('parseRoleOffer', () => {
  it('takes a well-formed offer and normalises it', () => {
    const p = parseRoleOffer({ ...offer, roleDefinitionId: `roledef:${ORG.toUpperCase().replace('0X', '0x')}:field-worker@1`, name: '  Field worker ' });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.offer.roleDefinitionId).toBe(`roledef:${ORG}:field-worker@1`);
    expect(p.offer.name).toBe('Field worker');
    expect(roleSlugOf(p.offer.roleDefinitionId)).toBe('field-worker');
    expect(roleDefinerOf(p.offer.roleDefinitionId)).toBe(ORG);
  });
  it('REFUSES a key that is not part of an offer — nothing that could be read as authority rides one', () => {
    for (const extra of [{ delegation: { delegate: ORG } }, { caveats: [] }, { tools: ['x'] }, { grants: 'all' }]) {
      const p = parseRoleOffer({ ...offer, ...extra });
      expect(p.ok).toBe(false);
    }
    const q = parseRoleOffer({ ...offer, skillPackRefs: [{ context: 'a', archetype: 'b', definition: { tools: [] } }] });
    expect(q.ok).toBe(false);
  });
  it('refuses a malformed id, scope, name, pack or too many packs', () => {
    expect(parseRoleOffer({ ...offer, roleDefinitionId: 'field-worker' }).ok).toBe(false);
    expect(parseRoleOffer({ ...offer, scope: 'world' }).ok).toBe(false);
    expect(parseRoleOffer({ ...offer, name: '' }).ok).toBe(false);
    expect(parseRoleOffer({ ...offer, skillPackRefs: [{ context: 'Bad Context', archetype: 'x' }] }).ok).toBe(false);
    expect(parseRoleOffer({ ...offer, skillPackRefs: Array.from({ length: 5 }, (_, i) => ({ context: 'c', archetype: `a${i}` })) }).ok).toBe(false);
    expect(parseRoleOffer(null).ok).toBe(false);
    expect(parseRoleOffer('field-worker').ok).toBe(false);
  });
  it('a role with no pack is a role', () => {
    const { skillPackRefs: _drop, ...bare } = offer;
    const p = parseRoleOffer(bare);
    expect(p.ok && p.offer.skillPackRefs).toEqual([]);
  });
});

describe('resolveAssignedRole', () => {
  it('no invitation role → the plain member', () => {
    const r = resolveAssignedRole({ claimed: { assignedRole: 'member' }, invite: { status: 'pending' }, now: NOW });
    expect(r).toEqual({ ok: true, fields: { assignedRole: 'member' }, from: 'none' });
  });
  it('the role comes from the organization\'s invitation, whatever the member sent', () => {
    const r = resolveAssignedRole({ claimed: { assignedRole: 'member' }, invite: { orgRole: offer, invitedBy: STEWARD, status: 'pending' }, now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.from).toBe('invitation');
    expect(r.fields).toMatchObject({ assignedRole: 'field-worker', roleName: 'Field worker', scope: 'team', accessRole: 'field-recorder', assignedBy: STEWARD, assignedAt: NOW });
    expect(r.fields.skillPackRefs).toEqual([{ context: 'field-operations', archetype: 'role-field-worker' }]);
  });
  it('REFUSES a role the organization did not offer', () => {
    const none = resolveAssignedRole({ claimed: { assignedRole: 'team-lead' }, invite: { status: 'pending' }, now: NOW });
    expect(none.ok).toBe(false);
    const other = resolveAssignedRole({ claimed: { assignedRole: 'team-lead', roleDefinitionId: `roledef:${ORG}:team-lead@1` }, invite: { orgRole: offer, status: 'pending' }, now: NOW });
    expect(other).toMatchObject({ ok: false, code: 'role_not_offered' });
    const noInvite = resolveAssignedRole({ claimed: { roleDefinitionId: `roledef:${ORG}:field-worker@1` }, invite: null, now: NOW });
    expect(noInvite.ok).toBe(false);
  });
  it('a removed or declined invitation offers nothing', () => {
    const r = resolveAssignedRole({ claimed: {}, invite: { orgRole: offer, status: 'removed' }, now: NOW });
    expect(r.ok && r.fields.assignedRole).toBe('member');
  });
  it('a role a steward set after admission outlives a re-run of the join', () => {
    const lead = { ...roleFieldsFromOffer({ ...(parseRoleOffer({ ...offer, roleDefinitionId: `roledef:${ORG}:team-lead@1`, name: 'Team lead' }) as { ok: true; offer: never }).offer }, STEWARD, NOW), roleSetAt: NOW };
    const r = resolveAssignedRole({ claimed: { assignedRole: 'member' }, invite: { orgRole: offer, status: 'pending' }, existing: { roleAssignment: lead }, now: '2026-10-06T00:00:00.000Z' });
    expect(r.ok && r.from).toBe('steward');
    expect(r.ok && r.fields.assignedRole).toBe('team-lead');
    // A re-run that still NAMES the invitation's role is honest, and is recorded as the steward's.
    const named = resolveAssignedRole({ claimed: { assignedRole: 'field-worker', roleDefinitionId: offer.roleDefinitionId }, invite: { orgRole: offer, status: 'pending' }, existing: { roleAssignment: lead }, now: NOW });
    expect(named.ok && named.fields.assignedRole).toBe('team-lead');
    // …but not past the end of that membership: a person invited back is whoever the new invitation says.
    const back = resolveAssignedRole({ claimed: {}, invite: { orgRole: offer, status: 'pending' }, existing: { endedAt: NOW, roleAssignment: lead }, now: NOW });
    expect(back.ok && back.fields.assignedRole).toBe('field-worker');
  });
});

describe('the fields round-trip', () => {
  it('an offer survives being recorded and read back', () => {
    const p = parseRoleOffer(offer);
    if (!p.ok) throw new Error(p.error);
    const fields = roleFieldsFromOffer(p.offer, STEWARD, NOW);
    expect(offerFromRoleFields(fields)).toEqual(p.offer);
    expect(offerFromRoleFields({ assignedRole: 'member' })).toBeNull();
  });
  it('a role change keeps the delegation and the household facets', () => {
    const kept = withoutRoleFields({ assignedRole: 'x', roleName: 'X', materializedByDelegation: { a: 1 }, householdRole: 'parent', kinRelation: 'spouse' });
    expect(kept).toEqual({ materializedByDelegation: { a: 1 }, householdRole: 'parent', kinRelation: 'spouse' });
  });
});
