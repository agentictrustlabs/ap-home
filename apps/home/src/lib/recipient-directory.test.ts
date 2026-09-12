import { describe, it, expect } from 'vitest';
import { rosterFromDirectoryResponse, filterRecipients, membersFromReceivedDelegations, mergeRosters } from './recipient-directory';

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const C = '0xcccccccccccccccccccccccccccccccccccccccc';

describe('rosterFromDirectoryResponse', () => {
  it('keeps NAMELESS members, preferring the org-local name, and sorts by display name', () => {
    const rows = rosterFromDirectoryResponse({
      ok: true,
      listings: [
        { listing: { subject: `eip155:84532:${B.toUpperCase().replace('0X', '0x')}`, displayName: 'Zed Nameless', orgRole: 'volunteer' }, label: 'zed-nameless' },
        { listing: { subject: `eip155:84532:${A}`, displayName: 'Alice Named', localName: 'Ali', publicName: 'alice.impact' }, label: 'alice' },
        { listing: { displayName: 'No address' } },
        { listing: { subject: `eip155:84532:${C}` }, label: 'label-only' },
      ],
    });
    expect(rows.map((r) => r.displayName)).toEqual(['Ali', 'label-only', 'Zed Nameless']);
    expect(rows[0]).toMatchObject({ address: A, publicName: 'alice.impact' });
    expect(rows[2]).toMatchObject({ address: B, publicName: null, role: 'volunteer' });
  });
  it('dedupes a subject listed twice and falls back to a short address when nothing names them', () => {
    const rows = rosterFromDirectoryResponse({ listings: [{ listing: { subject: A } }, { listing: { subject: A, displayName: 'dup' } }] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.displayName).toBe('0xaaaa…aaaa');
  });
});

describe('filterRecipients', () => {
  const rows = [
    { address: A, title: 'Alice Named', subtitle: 'alice.impact' },
    { address: B, title: 'Zed Nameless' },
  ];
  it('matches title, subtitle or address, case-insensitively; empty returns all', () => {
    expect(filterRecipients(rows, '').map((r) => r.title)).toEqual(['Alice Named', 'Zed Nameless']);
    expect(filterRecipients(rows, 'IMPACT').map((r) => r.title)).toEqual(['Alice Named']);
    expect(filterRecipients(rows, 'zed').map((r) => r.title)).toEqual(['Zed Nameless']);
    expect(filterRecipients(rows, '0xbbbb').map((r) => r.title)).toEqual(['Zed Nameless']);
  });
});

describe('membersFromReceivedDelegations + mergeRosters', () => {
  const ORG = '0x1111111111111111111111111111111111111111';
  it('takes only this org\'s members, keyed by viaOrg, naming them by the join display name', () => {
    const rows = membersFromReceivedDelegations({ received: [
      { viaOrg: ORG.toUpperCase().replace('0X', '0x'), orgAgent: B, displayName: 'Boris (invited)' },
      { viaOrg: '0x2222222222222222222222222222222222222222', orgAgent: C, displayName: 'elsewhere' },
      { viaOrg: ORG, orgAgent: A, orgName: 'Russian Team' },
      { viaOrg: ORG, orgAgent: C, orgName: 'Carol' },
    ] }, ORG);
    // `orgName` never labels a person (it holds the ORG's name for a member who chose none).
    expect(rows.map((r) => [r.address, r.displayName, r.publicName])).toEqual([[B, 'Boris (invited)', null], [A, '0xaaaa…aaaa', null], [C, '0xcccc…cccc', null]]);
  });
  it('unions listings with invited members — a listing wins for someone in both', () => {
    const merged = mergeRosters(
      [{ address: A, displayName: 'Ali', publicName: 'alice.impact', role: 'steward' }],
      [{ address: A, displayName: 'Alice (invited)', publicName: null }, { address: B, displayName: 'Boris', publicName: null }],
    );
    expect(merged).toEqual([
      // 398 §4.5 — the merge also says HOW they were admitted: a listing found with no invite row is 'listing'
      { address: A, displayName: 'Ali', publicName: 'alice.impact', role: 'steward', admittedVia: 'listing' },
      { address: B, displayName: 'Boris', publicName: null },
    ]);
    // someone in BOTH keeps the invitation's provenance under the listing's name
    const both = mergeRosters([{ address: A, displayName: 'Ali', publicName: 'alice.impact', admittedVia: 'listing' }], [{ address: A, displayName: 'x', publicName: null, admittedVia: 'invite' }]);
    expect(both[0]).toMatchObject({ displayName: 'Ali', admittedVia: 'invite' });
  });
});
