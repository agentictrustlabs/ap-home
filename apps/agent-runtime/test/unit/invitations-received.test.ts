// The bell's invitations read (2026-10-04): the person's inbox and relationships in ONE round trip when the deps can
// batch, side by side otherwise; names resolved together. Behaviour unchanged: an org she already belongs to is `joined`.
import { describe, it, expect } from 'vitest';
import { invitationsOf } from '../../src/invitations-received.js';

const ME = '0x1111111111111111111111111111111111111111';
const ORG_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ORG_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const STEWARD = '0x2222222222222222222222222222222222222222';
const inbox = { envelopes: [
  { from: `eip155:34348:${STEWARD}`, contextRefs: [{ kind: 'org-channels', id: ORG_A, label: 'A' }], createdAt: '2026-10-01T00:00:00Z' },
  { from: `eip155:34348:${STEWARD}`, contextRefs: [{ kind: 'org-channels', id: ORG_B }], createdAt: '2026-10-02T00:00:00Z' },
] };
const relationships = { orgs: { [ORG_B]: { relationship: 'member' } } };

describe('invitationsOf', () => {
  it('batches the two records into ONE call and resolves names together', async () => {
    const calls: string[][] = [];
    const out = await invitationsOf({
      readSubjectRecord: async () => { throw new Error('the batched path must not read one by one'); },
      readRecords: async (_s, types) => { calls.push(types); return { 'inbox.data': inbox, 'relationships.data': relationships }; },
      nameOf: async (a) => (a === ORG_A ? 'alpha.org' : 'beta.org'),
    }, ME);
    expect(calls).toEqual([['inbox.data', 'relationships.data']]);
    expect(out.messages).toBe(2);
    expect(out.invitations.map((i) => [i.org, i.name, i.joined])).toEqual([[ORG_A, 'alpha.org', false], [ORG_B, 'beta.org', true]]);
    expect(out.invitations[0]!.from).toEqual([STEWARD]);
  });
  it('without a batch, reads both records (side by side) with the same answer', async () => {
    const read: string[] = [];
    const out = await invitationsOf({ readSubjectRecord: async (_s, t) => { read.push(t); return t === 'inbox.data' ? inbox : relationships; } }, ME);
    expect(read.sort()).toEqual(['inbox.data', 'relationships.data']);
    expect(out.invitations.map((i) => i.joined)).toEqual([false, true]);
  });
});
