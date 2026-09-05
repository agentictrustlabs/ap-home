/**
 * THE ROSTER, AND WHO MAY SEE IT.
 *
 * "Who are the members" was answered from the PUBLIC directory, which has never held membership
 * (ADR-0025: a person↔org link is a private vault credential; ADR-0040: the KB holds only what the chain
 * could reproduce). The reply — "the directory does not list any members" — was true and useless, and read
 * as "this organization has nobody in it", which is a different and false statement.
 */
import { describe, it, expect, vi } from 'vitest';
import { membershipListInvoker } from '../src/membership-read.js';
import type { Address } from 'viem';

const ALICE = '0x00000000000000000000000000000000000000a1' as Address;
const ORG = '0x00000000000000000000000000000000000000c1' as Address;
const BOB = '0x00000000000000000000000000000000000000b2';
const ctx = {} as never;

const tier = (opts: { linked?: boolean; listings?: unknown[]; rosterThrows?: boolean }) => ({
  readSubjectRecord: vi.fn(async (subject: string, type: string) => {
    if (type === 'relationships.data') return opts.linked ? { orgs: { [ORG]: { org: ORG, orgName: 'Calvary', relationship: 'member' } } } : { orgs: {} };
    if (type === 'directory.data') {
      if (opts.rosterThrows) throw new Error('vault down');
      return { listings: opts.listings ?? [] };
    }
    return null;
  }),
});

describe('organization.membership.list', () => {
  it('lists the members of an organization the asker belongs to', async () => {
    const out = await membershipListInvoker(tier({ linked: true, listings: [{ smartAgent: BOB, name: 'bob.me', role: 'member' }] }), ORG, ALICE)('organization.membership.list', {}, ctx) as { members: unknown[]; count: number; yourStanding: string };
    expect(out.count).toBe(1);
    expect(out.members[0]).toMatchObject({ agent: BOB, name: 'bob.me', role: 'member' });
    expect(out.yourStanding).toBe('member');
  });

  it('REFUSES someone with no standing — and says why, rather than returning an empty list', async () => {
    const out = await membershipListInvoker(tier({ linked: false }), ORG, ALICE)('organization.membership.list', {}, ctx) as { refused?: string; members: unknown[] };
    expect(out.members).toEqual([]);
    expect(out.refused, 'an empty list would read as "this org has nobody in it"').toMatch(/private/);
  });

  it('"never enabled" is a different answer from "could not be read"', async () => {
    // Permanent and actionable versus transient. Reporting the first as the second sent people to retry
    // something that will never start working on its own.
    const deps = {
      ...tier({ linked: true }),
      readSubjectRecordStatus: vi.fn(async () => ({ ok: false, needsEnable: true, data: null })),
    };
    const out = await membershipListInvoker(deps, ORG, ALICE)('organization.membership.list', {}, ctx) as { refused?: string };
    expect(out.refused).toMatch(/does not keep its roster in its own vault yet/);
    expect(out.refused).toMatch(/steward can turn on storage/);
  });

  it('an unreadable roster is not an empty one', async () => {
    const out = await membershipListInvoker(tier({ linked: true, rosterThrows: true }), ORG, ALICE)('organization.membership.list', {}, ctx) as { refused?: string };
    expect(out.refused).toMatch(/could not be read/);
  });

  it('does not answer when it does not know who is asking', async () => {
    const out = await membershipListInvoker(tier({ linked: true, listings: [{ smartAgent: BOB }] }), ORG)('organization.membership.list', {}, ctx) as { refused?: string; count: number };
    expect(out.count).toBe(0);
    expect(out.refused).toBeTruthy();
  });

  it('reads the ORG named in the args, not only the agent being asked', async () => {
    const OTHER = '0x00000000000000000000000000000000000000c2';
    const deps = { ...tier({ linked: true }), resolveName: vi.fn(async () => OTHER) };
    await membershipListInvoker(deps, ORG, ALICE)('organization.membership.list', { org: 'other.org' }, ctx);
    expect(deps.resolveName).toHaveBeenCalledWith('other.org');
  });

  it('an empty roster says WHY it may be incomplete, instead of "no members"', async () => {
    const out = await membershipListInvoker(tier({ linked: true, listings: [] }), ORG, ALICE)('organization.membership.list', {}, ctx) as { count: number; note?: string };
    expect(out.count).toBe(0);
    // The Home shows the union of published listings and invite-joined members; this read sees only the
    // first. Reporting the half we can reach as the whole is the failure to avoid.
    expect(out.note).toMatch(/joined by invitation/);
  });

  it('never reaches a public search — the private read is the only mechanism', async () => {
    const deps = tier({ linked: true, listings: [] });
    const out = await membershipListInvoker(deps, ORG, ALICE)('organization.membership.list', {}, ctx) as { count: number };
    expect(out.count).toBe(0);
    // Two reads: the asker's links, then the roster. Nothing else was consulted.
    expect(deps.readSubjectRecord).toHaveBeenCalledTimes(2);
  });
});
