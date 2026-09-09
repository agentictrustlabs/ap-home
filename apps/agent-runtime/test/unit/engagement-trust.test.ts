// Spec 384 W4 — the trust-graph read is EVIDENCE beside an offer, never a score, never a filter.
import { describe, expect, it } from 'vitest';
import { trustGraphRead } from '../../src/engagement-trust.js';

const REQ = '0x3b99f2b452766de5df0dbcdfc676f27257151333' as const;
const SVC = '0x309b2a566e93cc77aabe895d0ec2702c36856ebd' as const;
const STRANGER = '0x6fece74d0000000000000000000000000000cafe' as const;

const fabric = (trust: Record<string, { relationships?: unknown[]; attestations?: unknown[] }>) => async (path: string) => {
  const key = decodeURIComponent(/key=([^&]*)/.exec(path)?.[1] ?? '').toLowerCase();
  const body = trust[key];
  return body ? new Response(JSON.stringify({ ok: true, ...body }), { status: 200 }) : new Response('not found', { status: 404 });
};

describe('trustGraphRead — evidence, never a score', () => {
  it('a provider with an edge to the requester and valid attestations reads them as lines, and never a number over them', async () => {
    const read = await trustGraphRead(fabric({ [SVC]: {
      relationships: [{ edgeId: 'e1', relationshipType: 'RECOMMENDS', counterparty: REQ, direction: 'object', status: 'active' }, { edgeId: 'e2', relationshipType: 'MEMBER_OF', counterparty: '0xother', direction: 'subject', status: 'active' }],
      attestations: [{ uid: 'a1', valid: true }, { uid: 'a2', valid: true }, { uid: 'a3', valid: false }],
    } }), REQ, SVC);
    expect(read.relationship).toEqual({ relationshipType: 'RECOMMENDS', status: 'active', direction: 'object' });
    expect(read.validAttestations).toBe(2);
    expect(read.priorReceipts).toBeNull();
    expect(read.lines).toEqual([
      'holds a RECOMMENDS with the requester (active)',
      '2 valid attestations',
      'no prior receipts recorded between these two parties',
    ]);
    // The whole point: no scalar over the candidate.
    expect(JSON.stringify(read)).not.toMatch(/score|rating|rank|weight/i);
  });

  it('a stranger reads "no relationship, no attestations, no prior receipts" — and is still a read, not a rejection', async () => {
    const read = await trustGraphRead(fabric({ [STRANGER]: { relationships: [], attestations: [] } }), REQ, STRANGER);
    expect(read.relationship).toBeNull();
    expect(read.validAttestations).toBe(0);
    expect(read.lines).toEqual([
      'no relationship with the requester on the public fabric',
      'no valid attestations',
      'no prior receipts recorded between these two parties',
    ]);
  });

  it('an unreachable fabric says so and marks nothing against the provider', async () => {
    const read = await trustGraphRead(async () => null, REQ, SVC);
    expect(read.relationship).toBeNull();
    expect(read.validAttestations).toBe(0);
    expect(read.lines).toEqual(['the public trust fabric could not be read for this provider']);
  });

  it('an edge that is not to the requester is not counted as a relationship with them', async () => {
    const read = await trustGraphRead(fabric({ [SVC]: { relationships: [{ edgeId: 'e1', relationshipType: 'RECOMMENDS', counterparty: '0xsomeoneelse', direction: 'object', status: 'active' }], attestations: [] } }), REQ, SVC);
    expect(read.relationship).toBeNull();
  });
});
