import { describe, it, expect, vi } from 'vitest';
import { rosterFromDirectoryResponse, filterRecipients, membersFromReceivedDelegations, mergeRosters, workspaceGovernorOf, fetchWorkspaceRoster } from './recipient-directory';

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

describe('a workspace’s members are its governor’s (2026-10-02)', () => {
  const WS = '0xdddddddddddddddddddddddddddddddddddddddd';
  const ORG = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const ME = '0xffffffffffffffffffffffffffffffffffffffff';
  const rows = [
    { agent: ME, kind: 'person' },
    { agent: ORG, kind: 'org', parent: ME },
    { agent: WS, kind: 'workspace', parent: ORG, relationship: 'member' },
    { agent: '0x1111111111111111111111111111111111111111', kind: 'workspace', parent: ME },
    { agent: '0x2222222222222222222222222222222222222222', kind: 'org-treasury', parent: ORG },
  ];
  it('workspaceGovernorOf: the organization a workspace link hangs under; never a person, a service, or a non-workspace', () => {
    expect(workspaceGovernorOf(rows[2], rows)).toBe(ORG);
    expect(workspaceGovernorOf(rows[3], rows)).toBeNull(); // hung under the person: the person is not its governor
    expect(workspaceGovernorOf(rows[4], rows)).toBeNull(); // a treasury is not a workspace
    expect(workspaceGovernorOf(rows[1], rows)).toBeNull(); // an organization has no governor
    expect(workspaceGovernorOf(undefined, rows)).toBeNull();
    expect(workspaceGovernorOf({ agent: WS, kind: 'workspace', parent: ORG }, [])).toBeNull(); // a parent the viewer cannot see
    expect(workspaceGovernorOf({ agent: WS, kind: 'workspace', parent: ORG.toUpperCase().replace('0X', '0x') }, rows)).toBe(ORG);
  });
  it('fetchWorkspaceRoster reads the governor first and the workspace’s own records only as the legacy fallback', async () => {
    const calls: string[] = [];
    const listing = (addr: string, name: string) => ({ ok: true, listings: [{ listing: { subject: `eip155:84532:${addr}`, displayName: name } }] });
    const serve = (byCommunity: Record<string, { status: number; body: unknown }>) => {
      calls.length = 0;
      vi.stubGlobal('fetch', async (url: string) => {
        if (url.startsWith('/connect/received-delegations')) return new Response(JSON.stringify({ received: [] }), { status: 200 });
        const community = new URL(url, 'https://home.test').searchParams.get('communityId') ?? '';
        calls.push(community);
        const r = byCommunity[community] ?? { status: 404, body: { ok: false, error: 'no such community' } };
        return new Response(JSON.stringify(r.body), { status: r.status });
      });
    };
    try {
      // governed: the governor answers, the workspace is never asked
      serve({ [ORG]: { status: 200, body: listing(A, 'Alice') } });
      let r = await fetchWorkspaceRoster('t', WS, ORG);
      expect(r).toMatchObject({ heldBy: ORG, governedBy: ORG });
      expect(r.members.map((m) => m.displayName)).toEqual(['Alice']);
      expect(calls).toEqual([ORG]);
      // the governor refuses (the viewer is not on its roster) — a legacy workspace's own records still show
      serve({ [ORG]: { status: 403, body: { ok: false, error: 'not a member' } }, [WS]: { status: 200, body: listing(B, 'Bob') } });
      r = await fetchWorkspaceRoster('t', WS, ORG);
      expect(r).toMatchObject({ heldBy: WS, governedBy: ORG });
      expect(r.members.map((m) => m.displayName)).toEqual(['Bob']);
      // the governor answers nobody and the workspace holds nothing either: an empty roster held by the governor
      serve({ [ORG]: { status: 200, body: { ok: true, listings: [] } }, [WS]: { status: 200, body: { ok: true, listings: [] } } });
      r = await fetchWorkspaceRoster('t', WS, ORG);
      expect(r).toMatchObject({ heldBy: ORG, governedBy: ORG, members: [] });
      // no governor: the workspace itself, as before
      serve({ [WS]: { status: 200, body: listing(C, 'Carol') } });
      r = await fetchWorkspaceRoster('t', WS, null);
      expect(r).toMatchObject({ heldBy: WS, governedBy: null });
      expect(calls).toEqual([WS]);
      // both refuse: the refusal is named, not papered over
      serve({ [ORG]: { status: 403, body: { ok: false, error: 'not a member' } }, [WS]: { status: 403, body: { ok: false, error: 'not a member' } } });
      await expect(fetchWorkspaceRoster('t', WS, ORG)).rejects.toThrow('not a member');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
