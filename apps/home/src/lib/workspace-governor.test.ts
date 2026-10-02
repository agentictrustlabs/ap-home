/**
 * The governor of a workspace — the pure parts (`lib/workspace-governor.ts`).
 *
 * WHAT THESE PIN. A ceremony finds a workspace's governor from the person's own links before it touches a vault,
 * and the two readings it is allowed must not drift into a third: a written `governor` is believed, a `parent`
 * counts only when the links say that parent is organization-class, and a person-parented workspace is LEGACY.
 * The credential digest pins the a2a worker's contract (`relationshipCredentialDigest` in
 * `@agenticprimitives/agent-relationships`): lowercase addresses, the terms by digest, RFC 8785 over the body.
 */
import { describe, it, expect } from 'vitest';
import {
  governorFromRows, governorOf, governorPointerOf, relationshipCredentialDigest, relationshipOfferOf,
  termsDigestOf, workspaceRecordKey, workspaceRecordOf,
} from './workspace-governor';

const PERSON = '0xeef5ed02e052ee221afcbbd2708919473c4e2b28';
const WS = '0xE26157068Af46629691E2ab19726bF61476E6B6C';
const ORG = '0x1111111111111111111111111111111111111111';
const WIRE = { delegator: ORG, delegate: PERSON, caveats: [] };

describe('governorFromRows', () => {
  it('believes a governor the link was written with', () => {
    const rows = [
      { orgAgent: WS.toLowerCase(), kind: 'workspace', parent: PERSON, governor: ORG },
      { orgAgent: ORG, orgName: 'club.org', kind: 'org', relationship: 'steward', stewardshipDelegation: WIRE },
    ];
    expect(governorFromRows(rows, WS, PERSON)).toEqual({ governor: ORG, governorName: 'club.org', governorStewardship: WIRE });
  });

  it('reads an organization-class parent as the governor', () => {
    const rows = [
      { orgAgent: WS.toLowerCase(), kind: 'workspace', parent: ORG },
      { orgAgent: ORG, orgName: 'club.org', kind: 'org', relationship: 'steward', stewardshipDelegation: WIRE },
    ];
    expect(governorFromRows(rows, WS, PERSON)?.governor).toBe(ORG);
  });

  /* THE LEGACY CASE: every workspace chartered before the rule hangs under its person. That is not a governor. */
  it('answers null for a person-parented workspace', () => {
    expect(governorFromRows([{ orgAgent: WS, kind: 'workspace', parent: PERSON }], WS, PERSON)).toBeNull();
  });

  it('does not take a parent the links do not know as an organization', () => {
    const rows = [{ orgAgent: WS, kind: 'workspace', parent: ORG }, { orgAgent: ORG, kind: 'service' }];
    expect(governorFromRows(rows, WS, PERSON)).toBeNull();
  });

  it('carries no stewardship over a governor the person is only a member of', () => {
    const rows = [
      { orgAgent: WS, kind: 'workspace', parent: ORG },
      { orgAgent: ORG, kind: 'org', relationship: 'member', stewardshipDelegation: WIRE },
    ];
    expect(governorFromRows(rows, WS, PERSON)?.governorStewardship).toBeNull();
  });

  it('answers null when the workspace is not among the links', () => {
    expect(governorFromRows([], WS, PERSON)).toBeNull();
  });
});

describe('the pair of records', () => {
  it('keys the entity by the coordinating agent, lowercased, and both sides name each other', () => {
    expect(workspaceRecordKey(WS)).toBe(`workspace:${WS.toLowerCase()}`);
    const rec = workspaceRecordOf({ governor: ORG, workspace: WS, label: 'club', purpose: 'card-room-club', now: new Date(0) });
    expect(rec).toEqual({ type: 'aporg:Workspace', governedBy: ORG, coordinatedBy: WS.toLowerCase(), label: 'club', purpose: 'card-room-club', createdAt: '1970-01-01T00:00:00.000Z' });
    expect(governorOf(governorPointerOf({ governor: ORG, workspace: WS }))).toBe(ORG);
  });

  it('reads no governor from a malformed or absent pointer', () => {
    expect(governorOf(null)).toBeNull();
    expect(governorOf({ governedBy: 'club.org' })).toBeNull();
    expect(governorOf({})).toBeNull();
  });
});

describe('the relationship credential digest', () => {
  const body = { type: 'ap.relationship-credential.v1' as const, kind: 'has-member' as const, subject: PERSON as `0x${string}`, object: ORG as `0x${string}`, chainId: 34348, issuedAt: '2026-10-02T00:00:00.000Z', termsDigest: termsDigestOf({ role: 'member' }) };

  it('is stable, and the same whichever case the addresses arrive in', () => {
    const d = relationshipCredentialDigest(body);
    expect(d).toMatch(/^0x[0-9a-f]{64}$/);
    expect(relationshipCredentialDigest({ ...body, subject: PERSON.toUpperCase().replace('0X', '0x') as `0x${string}` })).toBe(d);
  });

  it('hashes the terms by digest, and no terms as the zero digest', () => {
    expect(termsDigestOf(undefined)).toBe(`0x${'00'.repeat(32)}`);
    expect(termsDigestOf({})).toBe(`0x${'00'.repeat(32)}`);
    expect(termsDigestOf({ role: 'member' })).not.toBe(termsDigestOf({ role: 'steward' }));
    // Key order is not part of the terms: RFC 8785 sorts.
    expect(termsDigestOf({ a: 1, b: 2 })).toBe(termsDigestOf({ b: 2, a: 1 }));
  });

  it('recognises an offer and nothing else', () => {
    expect(relationshipOfferOf({ ...body, terms: { role: 'member' }, digest: relationshipCredentialDigest(body), signatures: { object: '0x03' } })).not.toBeNull();
    expect(relationshipOfferOf({ ...body, terms: {}, digest: relationshipCredentialDigest(body) })).toBeNull();
    expect(relationshipOfferOf({ kind: 'has-member' })).toBeNull();
    expect(relationshipOfferOf(null)).toBeNull();
  });
});
