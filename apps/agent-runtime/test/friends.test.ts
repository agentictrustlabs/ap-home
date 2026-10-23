// Friends — a view over contacts (spec 401): mutual friend-role contacts are friends; people who added me and whom
// I have not added back are requests; people I added who have not added me back are requested. Own records only.
import { describe, it, expect } from 'vitest';
import type { Address, Hex } from 'viem';
import { contactRecordType, type ContactDeps, type ContactRecordV1 } from '../src/contacts.js';
import { friendListInvoker } from '../src/friends.js';

const ALICE = '0x00000000000000000000000000000000000000a1' as Address;
const BOB = '0x00000000000000000000000000000000000000b1' as Address;
const CARA = '0x00000000000000000000000000000000000000c2' as Address;
const DAN = '0x00000000000000000000000000000000000000d2' as Address;
const EVE = '0x00000000000000000000000000000000000000e5' as Address;
const GOOSE = '0x00000000000000000000000000000000000000d1' as Address;

const grant = { delegator: ALICE, delegate: BOB, authority: '0x', caveats: [], salt: '1', signature: '0x' } as unknown as ContactRecordV1['delegation'];
const contact = (who: Address, role: ContactRecordV1['role'], status: ContactRecordV1['status'] = 'contact', mutual?: boolean): ContactRecordV1 =>
  ({ type: 'ap.contact.v1', contact: who, role, delegation: grant, grantDigest: '0xg' as Hex, status, createdAt: 1_700_000_000_000, ...(mutual !== undefined ? { mutual } : {}) });

const store = new Map<string, unknown>();
store.set(contactRecordType(BOB), contact(BOB, 'friend', 'contact', false)); // Bob added me back (inbox below)
store.set(contactRecordType(CARA), contact(CARA, 'family', 'contact', true)); // mutual on the record itself
store.set(contactRecordType(DAN), contact(DAN, 'friend', 'contact', false)); // never added me back → requested
store.set(contactRecordType(GOOSE), contact(GOOSE, 'runtime')); // a runtime is not a friend
store.set(contactRecordType(EVE), contact(EVE, 'friend', 'removed')); // removed: neither friend nor request
store.set('inbox.data', {
  envelopes: [
    { from: `eip155:34348:${BOB}`, createdAt: '2026-10-20T10:00:00.000Z', contextRefs: [{ kind: 'contact', id: ALICE }] },
    { from: '0x00000000000000000000000000000000000000f1', createdAt: '2026-10-21T09:00:00.000Z', contextRefs: [{ kind: 'contact', id: ALICE }] },
    { from: '0x00000000000000000000000000000000000000f1', createdAt: '2026-10-22T09:00:00.000Z', contextRefs: [{ kind: 'contact', id: ALICE }] },
    { from: EVE, createdAt: '2026-10-19T09:00:00.000Z', contextRefs: [{ kind: 'contact', id: ALICE }] },
    { from: '0x00000000000000000000000000000000000000f2', createdAt: '2026-10-18T09:00:00.000Z', contextRefs: [{ kind: 'contact', id: BOB }] }, // names Bob, not me
  ],
});

const deps = (): ContactDeps => ({
  env: { CHAIN_ID: '34348', DELEGATION_MANAGER: '0x00000000000000000000000000000000000000dd' },
  enforcers: { timestamp: '0x00000000000000000000000000000000000000e1', value: '0x00000000000000000000000000000000000000e2', digestBinding: '0x00000000000000000000000000000000000000e3' },
  vaultServerId: 'demo-mcp',
  readSubjectRecord: async (s, t) => (s === ALICE ? store.get(t) ?? null : null),
  survey: async (s) => (s === ALICE ? [...store.keys()].map((recordType) => ({ recordType })) : []),
  readRecords: async (s, keys) => (s === ALICE ? Object.fromEntries(keys.map((k) => [k, store.get(k)])) : {}),
  nameOf: async (a) => ({ [BOB]: 'bob.me', [CARA]: 'cara.me', [DAN]: 'dan.me', '0x00000000000000000000000000000000000000f1': 'fay.me' } as Record<string, string>)[a] ?? null,
  digestBindingArgsFor: () => '0x' as Hex, stepDigests: (_a, intent) => ({ intent }),
});
const ctx = () => ({ step: { id: 's0' }, index: 0, intent: { goal: 'friends', context: {} }, supplied: [] } as never);

describe('person.friend.list', () => {
  it('friends are mutual friend-role contacts; requests and requested are the two pending sides', async () => {
    const out = (await friendListInvoker(deps(), ALICE)('person.friend.list', {}, ctx())) as {
      count: number; friends: Array<{ agent: string; name: string | null; since: string }>;
      requests: Array<{ agent: string; name: string | null; at: string | null }>; requested: Array<{ agent: string }>; note: string;
    };
    expect(out.count).toBe(2);
    expect(out.friends.map((f) => f.name).sort()).toEqual(['bob.me', 'cara.me']);
    expect(out.friends[0]!.since).toBe('2023-11-14T22:13:20.000Z');
    // Fay added me (twice; the newest moment counts) and I never added her; Eve is removed, so she is no request.
    expect(out.requests).toEqual([{ agent: '0x00000000000000000000000000000000000000f1', name: 'fay.me', at: '2026-10-22T09:00:00.000Z' }]);
    expect(out.requested.map((r) => r.agent)).toEqual([DAN]);
    expect(out.note).toMatch(/2 friend/);
  });
  it('is the asker\'s own: another person sees nothing, and a run with no person is refused', async () => {
    expect((await friendListInvoker(deps(), BOB)('person.friend.list', {}, ctx())) as { count: number }).toMatchObject({ count: 0, friends: [], requests: [] });
    expect((await friendListInvoker(deps(), undefined)('person.friend.list', {}, ctx())) as { refused?: string }).toHaveProperty('refused');
  });
});

describe('contact notices (no messaging wire needed)', () => {
  it('a notice is a request, and makes a friend of someone I added; one per sender, the newest', async () => {
    const ZED = '0x00000000000000000000000000000000000000a9' as Address;
    const local = new Map(store);
    local.set('inbox.data', {
      ...(store.get('inbox.data') as object),
      contactNotices: [
        { from: DAN, at: '2026-10-23T08:00:00.000Z', grantDigest: '0x' + '1'.repeat(64) }, // Dan added me back
        { from: ZED, at: '2026-10-23T09:00:00.000Z', grantDigest: '0x' + '2'.repeat(64) }, // a stranger asks
      ],
    });
    const d = { ...deps(), readSubjectRecord: async (s: string, t: string) => (s === ALICE ? local.get(t) ?? null : null) };
    const out = (await friendListInvoker(d, ALICE)('person.friend.list', {}, ctx())) as {
      friends: Array<{ agent: string }>; requests: Array<{ agent: string }>; requested: Array<{ agent: string }>;
    };
    expect(out.friends.map((f) => f.agent)).toContain(DAN);
    expect(out.requested).toEqual([]);
    expect(out.requests.map((r) => r.agent)).toEqual([ZED, '0x00000000000000000000000000000000000000f1']);
  });
});

describe('the other half, already signed', () => {
  it('someone I added who added me too is a friend even with no notice in my inbox', async () => {
    const d = { ...deps(), readSubjectRecord: async (s: string, t: string) => (s === ALICE ? store.get(t) ?? null : s === DAN && t === contactRecordType(ALICE) ? contact(ALICE, 'friend') : null) };
    const out = (await friendListInvoker(d, ALICE)('person.friend.list', {}, ctx())) as { friends: Array<{ agent: string }>; requested: Array<{ agent: string }> };
    expect(out.friends.map((f) => f.agent)).toContain(DAN);
    expect(out.requested).toEqual([]);
  });
});

