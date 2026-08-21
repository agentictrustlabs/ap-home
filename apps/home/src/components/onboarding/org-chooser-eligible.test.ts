import { describe, expect, it } from 'vitest';
import { canGrantAsOrg, eligibleConnectOrgs } from './org-chooser-eligible';

const org = (
  name: string,
  extra: { relationship?: 'steward' | 'member'; purpose?: string; stewardshipDelegation?: unknown } = {},
) => ({ kind: 'org' as const, name, agent: `0x${name.length}`.padEnd(42, '0'), ...extra });

describe('eligibleConnectOrgs', () => {
  const rows = [
    org('colorado-outreach.impact', { relationship: 'member', purpose: 'commons:community' }),
    org('faith.impact', { relationship: 'steward', purpose: 'jp-adopter-org' }),
    org('commons-circle', { relationship: 'steward', purpose: 'commons:community' }),
    { kind: 'person-treasury' as const, name: 'treasury', relationship: 'steward' as const },
  ];

  it('with a purpose, lists only orgs of that purpose — not Field workspaces or other-app members', () => {
    const names = eligibleConnectOrgs(rows, { purpose: 'commons:community' }).map((o) => o.name);
    expect(names).toEqual(['colorado-outreach.impact', 'commons-circle']);
  });

  it('without a purpose, lists every related org (members and stewards)', () => {
    const names = eligibleConnectOrgs(rows).map((o) => o.name);
    expect(names).toEqual(['colorado-outreach.impact', 'commons-circle', 'faith.impact']);
  });

  it('drops unnamed rows and non-orgs', () => {
    expect(eligibleConnectOrgs([
      { kind: 'org', name: '', relationship: 'member' },
      { kind: 'org-treasury', name: 't', relationship: 'steward' },
    ])).toEqual([]);
  });
});

describe('canGrantAsOrg', () => {
  it('is false for a member with no stewardship wire', () => {
    expect(canGrantAsOrg({ relationship: 'member' })).toBe(false);
  });

  it('is true when a stewardship wire is present, even if the label says member', () => {
    expect(canGrantAsOrg({ relationship: 'member', stewardshipDelegation: { delegator: '0xorg' } })).toBe(true);
  });

  it('is true for a steward', () => {
    expect(canGrantAsOrg({ relationship: 'steward' })).toBe(true);
  });
});
