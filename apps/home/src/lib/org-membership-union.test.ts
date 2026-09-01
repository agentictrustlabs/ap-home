/**
 * Membership has TWO projections, and reading one is a bug.
 *
 * A member either published their OWN signed directory listing, or joined by invite and never published
 * one (they appear in the steward's received-delegations index instead). Both are the same fact seen from
 * different sides — `mergeRosters` says so explicitly: a union, never a fallback chain (ADR-0013).
 *
 * Discussions read only the directory. So an invited member was invisible there: `Participants · 0` on a
 * topic whose own history said they had joined, and a steward told forever to "add yourself as member"
 * when they were already one. These pin the union, and the specific shape of that bug.
 */
import { describe, it, expect } from 'vitest';
import { membersFromReceivedDelegations, mergeRosters } from './recipient-directory';

const ORG = '0xd6e3e36c8c854b9f4b99f58f782565f4133b20b0';
const NATHAN = '0x1dba4a27c53d7babda99513080223fb3bfc4bad1';
const ALICE = '0xb0d11ce19b756a682e78b4904cd8d832303b3d11';

const received = {
  received: [
    { viaOrg: ORG, orgAgent: NATHAN, displayName: 'Nathan Smith' },
    { viaOrg: '0xother', orgAgent: ALICE, displayName: 'Alice (a different org)' },
  ],
} as never;

describe('members who joined by invite are still members', () => {
  it('finds the member of THIS org from the received-delegations index', () => {
    const out = membersFromReceivedDelegations(received, ORG);
    expect(out.map((m) => m.address)).toEqual([NATHAN]);
    expect(out[0]!.displayName).toBe('Nathan Smith');
  });

  it('does not leak a member of a different org into this roster', () => {
    expect(membersFromReceivedDelegations(received, ORG).some((m) => m.address === ALICE)).toBe(false);
  });

  it('a person present ONLY in received-delegations is in the roster — the exact bug', () => {
    // No directory listings at all: this is the org whose Discussions showed Participants · 0.
    const roster = mergeRosters([], membersFromReceivedDelegations(received, ORG));
    expect(roster.map((m) => m.address)).toEqual([NATHAN]);
  });

  it('a listing WINS on labels but never removes an invited member', () => {
    const listing = { address: NATHAN, displayName: 'Nathan (self-signed)', publicName: 'nathan.me' };
    const roster = mergeRosters([listing], membersFromReceivedDelegations(received, ORG));
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({ address: NATHAN, displayName: 'Nathan (self-signed)', publicName: 'nathan.me' });
  });

  it('both sources together are a union, not one replacing the other', () => {
    const listing = { address: ALICE, displayName: 'Alice Okoro', publicName: 'alice.me' };
    const roster = mergeRosters([listing], membersFromReceivedDelegations(received, ORG));
    expect(roster.map((m) => m.address).sort()).toEqual([NATHAN, ALICE].sort());
  });
});
