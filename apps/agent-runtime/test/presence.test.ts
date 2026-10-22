// Presence — where a person is now, told to their mutual friends: beats lapse, a friend's presence is read only
// through the friends gate, and the Ask's "who is online" answers from the same.
import { describe, it, expect } from 'vitest';
import type { Address, Hex } from 'viem';
import { contactRecordType, type ContactDeps, type ContactRecordV1 } from '../src/contacts.js';
import { beatEntry, friendsPresence, livePresence, presenceListInvoker, type PresenceEntry, type PresencePort } from '../src/presence.js';

const ALICE = '0x00000000000000000000000000000000000000a1' as Address;
const BOB = '0x00000000000000000000000000000000000000b1' as Address;
const DAN = '0x00000000000000000000000000000000000000d2' as Address;
const grant = { delegator: ALICE, delegate: BOB, authority: '0x', caveats: [], salt: '1', signature: '0x' } as unknown as ContactRecordV1['delegation'];
const contact = (who: Address, mutual: boolean): ContactRecordV1 =>
  ({ type: 'ap.contact.v1', contact: who, role: 'friend', delegation: grant, grantDigest: '0xg' as Hex, status: 'contact', createdAt: 1_700_000_000_000, mutual });
const store = new Map<string, unknown>([[contactRecordType(BOB), contact(BOB, true)], [contactRecordType(DAN), contact(DAN, false)]]);
const deps = (): ContactDeps => ({
  env: { CHAIN_ID: '34348', DELEGATION_MANAGER: '0x00000000000000000000000000000000000000dd' },
  enforcers: { timestamp: '0x00000000000000000000000000000000000000e1', value: '0x00000000000000000000000000000000000000e2', digestBinding: '0x00000000000000000000000000000000000000e3' },
  vaultServerId: 'demo-mcp',
  readSubjectRecord: async (s, t) => (s === ALICE ? store.get(t) ?? null : null),
  survey: async (s) => (s === ALICE ? [...store.keys()].map((recordType) => ({ recordType })) : []),
  readRecords: async (s, keys) => (s === ALICE ? Object.fromEntries(keys.map((k) => [k, store.get(k)])) : {}),
  nameOf: async (a) => ({ [BOB]: 'bob.me', [DAN]: 'dan.me' } as Record<string, string>)[a] ?? null,
  digestBindingArgsFor: () => '0x' as Hex, stepDigests: (_a, intent) => ({ intent }),
});
const fakePort = (): PresencePort & { objects: Map<string, PresenceEntry[]> } => {
  const objects = new Map<string, PresenceEntry[]>();
  return {
    objects,
    read: async (a) => objects.get(a.toLowerCase()) ?? [],
    beat: async (a, e) => { objects.set(a.toLowerCase(), [...(objects.get(a.toLowerCase()) ?? []).filter((x) => x.app !== e.app), e]); },
    gone: async (a, app) => { objects.set(a.toLowerCase(), (objects.get(a.toLowerCase()) ?? []).filter((x) => x.app !== app)); },
  };
};
const ctx = () => ({ step: { id: 's0' }, index: 0, intent: { goal: 'who is online', context: {} }, supplied: [] } as never);

describe('presence', () => {
  it('a beat is bounded and lapses; the newest is first', () => {
    const now = 1_000_000;
    const e = beatEntry({ app: 'seed-bible-reader', scope: 'JHN.3', label: 'reading John 3', ttlMs: 999_999_999 }, now);
    expect(e.until - now).toBe(10 * 60_000);
    expect(beatEntry({ app: 'home' }, now).until - now).toBe(90_000);
    const live = livePresence([{ app: 'a', at: now - 100, until: now + 10 }, { app: 'b', at: now - 50, until: now + 10 }, { app: 'old', at: now - 500, until: now - 1 }], now);
    expect(live.map((x) => x.app)).toEqual(['b', 'a']);
  });
  it('friends see each other: a mutual friend who is here, one who is not; a one-way contact is not shown at all', async () => {
    const port = fakePort();
    const now = Date.now();
    await port.beat(BOB, beatEntry({ app: 'seed-bible-reader', scope: 'JHN.3', label: 'reading John 3' }, now));
    await port.beat(DAN, beatEntry({ app: 'seed-bible-reader', label: 'reading Romans 8' }, now)); // Dan never added Alice back
    const rows = await friendsPresence(deps(), port, ALICE, now);
    expect(rows.map((r) => `${r.name}:${r.presence.length}`)).toEqual(['bob.me:1']);
    expect(rows[0]!.presence[0]).toMatchObject({ app: 'seed-bible-reader', scope: 'JHN.3', label: 'reading John 3' });
    // Bob leaves: nothing lingers.
    await port.gone(BOB, 'seed-bible-reader');
    expect((await friendsPresence(deps(), port, ALICE, now))[0]!.presence).toEqual([]);
  });
  it('the Ask answers "who is online" from the same gate, and a deployment without presence says so', async () => {
    const port = fakePort();
    await port.beat(BOB, beatEntry({ app: 'home', label: 'at their Home' }, Date.now()));
    const out = (await presenceListInvoker(deps(), port, ALICE)('person.presence.list', {}, ctx())) as { count: number; here: Array<{ name: string }>; note: string };
    expect(out.count).toBe(1); expect(out.here[0]!.name).toBe('bob.me'); expect(out.note).toMatch(/bob\.me: at their Home/);
    expect((await presenceListInvoker(deps(), null, ALICE)('person.presence.list', {}, ctx())) as { refused?: string }).toHaveProperty('refused');
    expect((await presenceListInvoker(deps(), port, undefined)('person.presence.list', {}, ctx())) as { refused?: string }).toHaveProperty('refused');
  });
});
