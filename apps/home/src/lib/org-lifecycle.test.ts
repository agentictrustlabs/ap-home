// spec 342 — the visibility rules, which are the whole point of the feature: get these wrong and
// either a retired org keeps haunting every dropdown, or a deactivated one becomes unreachable.
import { describe, it, expect } from 'vitest';
import {
  orgStatusOf,
  isVisibleOn,
  isHiddenOrg,
  filterByLifecycle,
  filterMyOrgsByLifecycle,
} from './org-lifecycle';

describe('orgStatusOf', () => {
  it('reads an absent status as active', () => {
    expect(orgStatusOf(undefined)).toBe('active');
    expect(orgStatusOf(null)).toBe('active');
    expect(orgStatusOf({})).toBe('active');
    expect(orgStatusOf({ status: null })).toBe('active');
  });

  it('reads an unrecognised status as active rather than hiding the org', () => {
    expect(orgStatusOf({ status: 'archived' })).toBe('active');
    expect(orgStatusOf({ status: 'DELETED' })).toBe('active');
  });

  it('reads the three known values', () => {
    expect(orgStatusOf({ status: 'active' })).toBe('active');
    expect(orgStatusOf({ status: 'inactive' })).toBe('inactive');
    expect(orgStatusOf({ status: 'deleted' })).toBe('deleted');
  });
});

describe('isVisibleOn', () => {
  it('shows only active orgs on working surfaces', () => {
    expect(isVisibleOn('active', 'working')).toBe(true);
    expect(isVisibleOn('inactive', 'working')).toBe(false);
    expect(isVisibleOn('deleted', 'working')).toBe(false);
  });

  it('shows inactive orgs on the roster, so they can be reactivated', () => {
    expect(isVisibleOn('inactive', 'roster')).toBe(true);
    expect(isVisibleOn('deleted', 'roster')).toBe(false);
  });

  it('shows everything on a surface addressed by SA', () => {
    expect(isVisibleOn('deleted', 'any')).toBe(true);
  });
});

describe('filterByLifecycle', () => {
  const rows = [
    { agent: '0xAAA', parent: '0xPERSON' },
    { agent: '0xBBB', parent: '0xPERSON', status: 'inactive' },
    { agent: '0xCCC', parent: '0xPERSON', status: 'deleted' },
    { agent: '0xTREASB', parent: '0xBBB' },
    { agent: '0xTREASA', parent: '0xAAA' },
  ];

  it('drops hidden orgs AND the agents parented to them', () => {
    const out = filterByLifecycle(rows, 'working').map((r) => r.agent);
    expect(out).toEqual(['0xAAA', '0xTREASA']);
  });

  it('keeps an inactive org and its treasury on the roster', () => {
    const out = filterByLifecycle(rows, 'roster').map((r) => r.agent);
    expect(out).toEqual(['0xAAA', '0xBBB', '0xTREASB', '0xTREASA']);
  });

  it('matches parents case-insensitively', () => {
    const out = filterByLifecycle(
      [{ agent: '0xAbC', status: 'deleted' }, { agent: '0xkid', parent: '0xABC' }],
      'working',
    );
    expect(out).toEqual([]);
  });

  it('filters nothing on "any"', () => {
    expect(filterByLifecycle(rows, 'any')).toHaveLength(rows.length);
  });
});

describe('filterMyOrgsByLifecycle', () => {
  const orgs = [
    { orgAgent: '0x1' },
    { orgAgent: '0x2', status: 'inactive' },
    { orgAgent: '0x3', status: 'deleted' },
  ];

  it('hides inactive + deleted by default, keeps inactive on the roster', () => {
    expect(filterMyOrgsByLifecycle(orgs, 'working').map((o) => o.orgAgent)).toEqual(['0x1']);
    expect(filterMyOrgsByLifecycle(orgs, 'roster').map((o) => o.orgAgent)).toEqual(['0x1', '0x2']);
    expect(filterMyOrgsByLifecycle(orgs, 'any')).toHaveLength(3);
  });
});

describe('isHiddenOrg', () => {
  it('is the working-surface question, asked directly', () => {
    expect(isHiddenOrg({})).toBe(false);
    expect(isHiddenOrg({ status: 'inactive' })).toBe(true);
    expect(isHiddenOrg({ status: 'deleted' })).toBe(true);
  });
});
