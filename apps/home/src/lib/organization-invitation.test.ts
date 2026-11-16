import { it, expect } from 'vitest';
import { hasRecordedFamilyMembership, organizationInvitationReturn } from './organization-invitation';
const org = '0x2222222222222222222222222222222222222222';
it('returns to the exact invited family without claiming the URL grants access', () => {
  const url = new URL(organizationInvitationReturn('https://ap-family.faithnet.io/', org, true));
  expect(url.origin).toBe('https://ap-family.faithnet.io');
  expect(url.searchParams.get('joined_org')).toBe(org);
  expect(organizationInvitationReturn('https://ap-family.faithnet.io/', org, false)).toBe('https://ap-family.faithnet.io/');
});
it('recognizes only an active member or steward of this household', () => {
  const row = { orgAgent: org, kind: 'household', relationship: 'member', status: 'active' };
  expect(hasRecordedFamilyMembership({ orgs: [row] }, org)).toBe(true);
  expect(hasRecordedFamilyMembership({ orgs: [{ ...row, relationship: 'steward' }] }, org)).toBe(true);
  for (const change of [{ status: 'pending' }, { status: 'removed' }, { status: 'inactive' }, { relationship: 'invited' }, { kind: 'org' }, { orgAgent: '0x3333333333333333333333333333333333333333' }]) {
    expect(hasRecordedFamilyMembership({ orgs: [{ ...row, ...change }] }, org)).toBe(false);
  }
  expect(hasRecordedFamilyMembership({ error: 'unavailable' }, org)).toBe(false);
});
