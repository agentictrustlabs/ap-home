// Friendship offers (spec 401 §10) — one person's half of a friendship: their own act, their own record, their grant.
import { describe, it, expect, beforeEach } from 'vitest';
import { encodeAbiParameters, type Address, type Hex } from 'viem';
import { InputRequired } from '@agenticprimitives/orchestration';
import { friendGrantFor, friendAddInvoker, friendRemoveInvoker, friendOfferRecordType, legacyOfferRecordType, migrateLegacyOffers, offersOf, FRIEND_GRANT_SCOPE, type FriendDeps, type FriendOfferRecordV1 } from '../src/friend-offers.js';
import { withCapabilityAliases, canonicalArgs, canonicalCapabilityId } from '../src/playbook-aliases.js';

const ALICE = '0x00000000000000000000000000000000000000a1' as Address;
const BOB = '0x00000000000000000000000000000000000000b1' as Address;
const GOOSE = '0x00000000000000000000000000000000000000d1' as Address;
const ORG = '0x00000000000000000000000000000000000000c1' as Address;
const TS = '0x00000000000000000000000000000000000000e1' as Address;
const VAL = '0x00000000000000000000000000000000000000e2' as Address;
const DB = '0x00000000000000000000000000000000000000e3' as Address;
let store = new Map<string, unknown>();
beforeEach(() => { store = new Map(); });
const deps = (over: Partial<FriendDeps> = {}): FriendDeps => ({
  env: { CHAIN_ID: '34348', DELEGATION_MANAGER: '0x00000000000000000000000000000000000000dd', HARNESS_AGENT_SA: '0x00000000000000000000000000000000000000ee' },
  enforcers: { timestamp: TS, value: VAL, digestBinding: DB }, vaultServerId: 'demo-mcp',
  readSubjectRecord: async (s, t) => (s === ALICE ? store.get(t) ?? null : null),
  writeSubjectRecord: async (s, t, r) => { if (s !== ALICE) return { ok: false, error: 'not yours' }; if (r === null) store.delete(t); else store.set(t, r); return { ok: true }; },
  survey: async (s) => (s === ALICE ? [...store.keys()].map((recordType) => ({ recordType })) : []),
  readRecords: async (s, keys) => (s === ALICE ? Object.fromEntries(keys.map((k) => [k, store.get(k)])) : {}),
  nameOf: async (a) => ({ [BOB]: 'bob.me', [GOOSE]: 'goose-1.svc' } as Record<string, string>)[a] ?? null,
  agentTypeOf: async (a) => (a === BOB ? 'person' : a === GOOSE ? 'service' : a === ORG ? 'org' : null),
  sendDirectMessage: async () => ({ ok: true, messageId: 'm1' }),
  executeAsServiceSa: async () => ({ txHash: '0xtx' }),
  digestBindingArgsFor: () => '0x' as Hex, stepDigests: (_a, intent) => ({ intent }),
  ...over,
});
const wire = (delegator: Address) => ({ ref: '0xref', wire: { delegator, delegate: '0x00000000000000000000000000000000000000ee', authority: `0x${'0'.repeat(64)}`, caveats: [{ enforcer: TS, terms: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [1000n, 2000n]), args: '0x' }], salt: 1n, signature: '0xsig' } });
const ctx = (supplied: unknown[] = []) => ({ step: { id: 's0' }, index: 0, intent: { goal: 'add bob', context: {} }, supplied } as never);
const digestOf = (asked: unknown) => String((asked as { request?: { digest?: string }; digest?: string }).request?.digest ?? (asked as { digest?: string }).digest);
async function add(d: FriendDeps, who: Address, args: Record<string, unknown> = {}) {
  const inv = friendAddInvoker(d, wire(ALICE), ALICE, 'sess');
  const asked = await inv('person.friend.add', { friend: who, ...args }, ctx()).catch((e: unknown) => e);
  if (!(asked instanceof InputRequired)) return asked as Record<string, unknown>;
  return (await inv('person.friend.add', { friend: who, ...args }, ctx([{ stepRef: 's0', signature: { digest: digestOf(asked), signature: '0xgrant' } }]))) as Record<string, unknown>;
}
const legacy = (who: Address, role: string, status: 'contact' | 'removed' = 'contact') => ({ type: 'ap.contact.v1', contact: who, role, status, grantDigest: '0x' + '7'.repeat(64), createdAt: 1_700_000_000_000, delegation: { delegator: ALICE, delegate: who, authority: `0x${'0'.repeat(64)}`, caveats: [], salt: '1', signature: '0xold' } });

describe('person.friend.add — my half', () => {
  it('asks for my grant signature, then records my offer with its type and sends the request', async () => {
    const out = await add(deps(), BOB, { type: 'family' });
    expect(out.added).toBe(true); expect(out.type).toBe('family'); expect(out.friends).toBe(false); expect(String(out.note)).toMatch(/request sent/);
    const rec = store.get(friendOfferRecordType(BOB)) as FriendOfferRecordV1;
    expect(rec.type).toBe('ap.friend-offer.v1'); expect(rec.status).toBe('standing'); expect(rec.offeredTo).toBe(BOB); expect(rec.friendType).toBe('family');
    expect(rec.delegation.delegator).toBe(ALICE); expect(rec.delegation.delegate).toBe(BOB);
  });
  it('a friend is a person: an organization and a service are refused; never under another\'s mandate', async () => {
    await expect(friendAddInvoker(deps(), wire(ALICE), ALICE, 'sess')('person.friend.add', { friend: ORG }, ctx())).rejects.toThrow(/organization is not a friend/);
    await expect(friendAddInvoker(deps(), wire(ALICE), ALICE, 'sess')('person.friend.add', { friend: GOOSE }, ctx())).rejects.toThrow(/service is not a friend/);
    await expect(friendAddInvoker(deps(), wire(BOB), ALICE, 'sess')('person.friend.add', { friend: BOB }, ctx())).rejects.toThrow(/your own mandate/);
  });
  it('is idempotent: offering again changes nothing', async () => {
    await add(deps(), BOB);
    const again = await add(deps(), BOB);
    expect(again.added).toBe(false); expect(again.alreadyOffered).toBe(true);
  });
  it('the grant is scoped to my profile, read-only — the value every existing grant was signed with', () => {
    expect(FRIEND_GRANT_SCOPE).toBe('vault:profile.contact');
  });
  it('a grant that predates vault:friend:* is said in words, not swallowed', async () => {
    const d = deps({ writeSubjectRecord: async (_s, t) => (t.startsWith('friend:') ? { ok: false, error: 'record_scope_denied' } : { ok: true }) });
    await expect(add(d, BOB)).rejects.toThrow(/turn your storage on again/);
  });
});

describe('person.friend.remove — withdrawing my half', () => {
  it('revokes my grant on chain and marks my offer withdrawn; nothing to withdraw twice', async () => {
    await add(deps(), BOB);
    const calls: string[] = [];
    const out = (await friendRemoveInvoker(deps({ executeAsServiceSa: async (sa, data) => { calls.push(`${sa}:${data.slice(0, 10)}`); return { txHash: '0xrevoked' }; } }), wire(ALICE), ALICE)('person.friend.remove', { friend: BOB }, ctx())) as { removed: boolean; txHash: string };
    expect(out.removed).toBe(true); expect(out.txHash).toBe('0xrevoked'); expect(calls).toHaveLength(1);
    const rec = store.get(friendOfferRecordType(BOB)) as FriendOfferRecordV1;
    expect(rec.status).toBe('withdrawn'); expect(typeof rec.withdrawnAt).toBe('number');
    expect((await friendRemoveInvoker(deps(), wire(ALICE), ALICE)('person.friend.remove', { friend: BOB }, ctx())) as { removed: boolean }).toMatchObject({ removed: false });
  });
});

describe('friend requests — not messages, so no messaging wire is needed', () => {
  it('a new friend gets the request even when the message cannot go; offering again re-sends it', async () => {
    const CARA = '0x00000000000000000000000000000000000000c3' as Address;
    const sent: Array<{ sender: string; recipient: string; grantDigest: string }> = [];
    const d = deps({ agentTypeOf: async (a) => (a === CARA ? 'person' : null), sendDirectMessage: async () => ({ ok: false, error: 'messaging is not enabled on your home yet' }), deliverFriendRequest: async (n) => { sent.push(n); return { ok: true }; } });
    const out = await add(d, CARA);
    expect(out.added).toBe(true); expect((out.told as { ok: boolean }).ok).toBe(false); expect(out.requested).toEqual({ ok: true });
    expect(sent).toEqual([{ sender: ALICE, recipient: CARA, grantDigest: out.grantDigest }]);
    const again = await add(d, CARA);
    expect(again.alreadyOffered).toBe(true); expect(sent).toHaveLength(2);
  });
  it('accepting someone who offered first brings their request back to me too, and says we are friends', async () => {
    const FAY = '0x00000000000000000000000000000000000000f7' as Address;
    const sent: Array<{ sender: string; recipient: string }> = [];
    const faysOffer = { type: 'ap.friend-offer.v1', offeredTo: ALICE, friendType: 'friend', status: 'standing', grantDigest: '0x' + '9'.repeat(64), offeredAt: 1, delegation: { delegator: FAY, delegate: ALICE } };
    const d = deps({ agentTypeOf: async () => null, readSubjectRecord: async (s, t) => (s === ALICE ? store.get(t) ?? null : s === FAY && t === friendOfferRecordType(ALICE) ? faysOffer : null), deliverFriendRequest: async (n) => { sent.push({ sender: n.sender, recipient: n.recipient }); return { ok: true }; } });
    const out = await add(d, FAY);
    expect(out.friends).toBe(true);
    expect(sent).toEqual([{ sender: ALICE, recipient: FAY }, { sender: FAY, recipient: ALICE }]);
  });
});

describe('one prompt (spec 361 I4) — the friendship grant approved with the mandate', () => {
  const EVE = '0x00000000000000000000000000000000000000e5' as Address;
  it('the grant the step builds is the one named at park time; already approved on chain, nothing more is asked', async () => {
    const { intentDigest } = await import('@agenticprimitives/delegation');
    const c = ctx();
    const expected = friendGrantFor(deps(), ALICE, EVE, { intentDigest: intentDigest((c as { intent: never }).intent), validAfter: 1000 }, 's0');
    const d = deps({ readContract: async (a) => (a.args[0] === expected.digest ? '0x1626ba7e' : '0xffffffff') });
    const out = (await friendAddInvoker(d, wire(ALICE), ALICE, 'sess')('person.friend.add', { friend: EVE }, c)) as { added: boolean; grantDigest: string; delegation: { signature: string } };
    expect(out.added).toBe(true); expect(out.grantDigest).toBe(expected.digest); expect(out.delegation.signature).toBe('0x03');
  });
});

describe('step 3 — legacy contact records move to friend offers', () => {
  it('a person\'s standing and removed records move (type and status mapped); a runtime\'s stays; the old key is gone', async () => {
    store.set(legacyOfferRecordType(BOB), legacy(BOB, 'family'));
    const DAN = '0x00000000000000000000000000000000000000d2' as Address;
    store.set(legacyOfferRecordType(DAN), legacy(DAN, 'friend', 'removed'));
    store.set(legacyOfferRecordType(GOOSE), legacy(GOOSE, 'runtime'));
    const r = await migrateLegacyOffers(deps(), ALICE);
    expect(r).toEqual({ moved: 2 });
    expect(store.has(legacyOfferRecordType(BOB))).toBe(false); expect(store.has(legacyOfferRecordType(DAN))).toBe(false);
    expect(store.has(legacyOfferRecordType(GOOSE))).toBe(true);
    const bob = store.get(friendOfferRecordType(BOB)) as FriendOfferRecordV1;
    expect(bob).toMatchObject({ type: 'ap.friend-offer.v1', offeredTo: BOB, friendType: 'family', status: 'standing', offeredAt: 1_700_000_000_000 });
    expect(bob.delegation.signature).toBe('0xold'); // the same grant, never re-signed
    expect((store.get(friendOfferRecordType(DAN)) as FriendOfferRecordV1).status).toBe('withdrawn');
    expect((await migrateLegacyOffers(deps(), ALICE)).moved).toBe(0);
  });
  it('a grant that predates vault:friend:* moves nothing and says why; the offers still read', async () => {
    store.set(legacyOfferRecordType(BOB), legacy(BOB, 'friend'));
    const d = deps({ writeSubjectRecord: async (_s, t) => (t.startsWith('friend:') ? { ok: false, error: 'record_scope_denied' } : { ok: true }) });
    expect(await migrateLegacyOffers(d, ALICE)).toMatchObject({ moved: 0, error: 'record_scope_denied' });
    expect(store.has(legacyOfferRecordType(BOB))).toBe(true);
    expect((await offersOf(d, ALICE)).get(BOB)?.offer.status).toBe('standing');
  });
  it('removing a friend whose record could not move marks the OLD record removed, and says so', async () => {
    store.set(legacyOfferRecordType(BOB), legacy(BOB, 'friend'));
    const d = deps({ writeSubjectRecord: async (_s, t, r) => { if (t.startsWith('friend:')) return { ok: false, error: 'record_scope_denied' }; store.set(t, r); return { ok: true }; } });
    const out = (await friendRemoveInvoker(d, wire(ALICE), ALICE)('person.friend.remove', { friend: BOB }, ctx())) as { removed: boolean; recorded: boolean; warning?: string };
    expect(out.removed).toBe(true); expect(out.recorded).toBe(true); expect(out.warning).toMatch(/older friend record/);
    expect((store.get(legacyOfferRecordType(BOB)) as { status: string }).status).toBe('removed');
  });
});

describe('step 2 — a stored playbook\'s older ids read as the friend capabilities', () => {
  it('capability ids, tool contracts (and their argument names), specialists and effects', () => {
    const pb = withCapabilityAliases({
      archetypeId: 'person-steward', archetypeVersion: '1', digest: '0x', instructions: '',
      capabilityIds: new Set(['person.contact.invite', 'person.contact.remove', 'person.contact.list', 'person.friend.list', 'messaging.direct.send']),
      tools: {
        'person.contact.invite': { id: 'person.contact.invite', description: 'add', inputSchema: { type: 'object', properties: { contact: { type: 'string' } }, required: ['contact'] }, carries: { role: ['x'] }, capability: { id: 'person.contact.invite', action: 'invite', resourceArg: 'contact', authorityArg: 'person' } },
        'person.contact.list': { id: 'person.contact.list', description: 'old list' },
        'person.friend.list': { id: 'person.friend.list', description: 'friends' },
      },
      specialists: [{ capability: 'person.contact.invite', executor: 'x' }],
      declaredEffects: { 'person.contact.remove': [] },
    } as never) as unknown as { capabilityIds: Set<string>; tools: Record<string, { id: string; description: string; capability?: { id: string; resourceArg?: string } }>; specialists: Array<{ capability: string }>; declaredEffects: Record<string, unknown> };
    expect([...pb.capabilityIds].sort()).toEqual(['messaging.direct.send', 'person.friend.add', 'person.friend.list', 'person.friend.remove']);
    // an aliased contract keeps its WORDS only: nothing in it that names the old arguments survives (live, 2026-10-26:
    // the Ask asked the person for a "contact" because the old contract's schema required one)
    expect(pb.tools['person.friend.add']).toMatchObject({ id: 'person.friend.add', description: 'add' });
    expect(pb.tools['person.friend.add']?.capability).toBeUndefined();
    expect((pb.tools['person.friend.add'] as Record<string, unknown>).inputSchema).toBeUndefined();
    expect(pb.tools['person.friend.list']?.description).toBe('friends'); // the current id wins over an aliased one
    expect(Object.keys(pb.tools).some((k) => k.includes('contact'))).toBe(false);
    expect(pb.specialists[0]!.capability).toBe('person.friend.add');
    expect(Object.keys(pb.declaredEffects)).toEqual(['person.friend.remove']);
  });
  it('a parked step\'s id and arguments read as today\'s', () => {
    expect(canonicalCapabilityId('person.contact.invite')).toBe('person.friend.add');
    expect(canonicalArgs('person.contact.invite', { contact: BOB, role: 'coach' })).toEqual({ friend: BOB, type: 'coach' });
    expect(canonicalArgs('person.friend.add', { friend: BOB })).toEqual({ friend: BOB });
    expect(canonicalCapabilityId('messaging.direct.send')).toBe('messaging.direct.send');
  });
});

describe('step 2, end to end — what the Ask offers under an old playbook', () => {
  it('person.friend.add asks for `friend`, never `contact`', async () => {
    const { mergeContractTool } = await import('../src/harness-run.js');
    const { FRIEND_ADD_TOOL } = await import('../src/friend-offers.js');
    const pb = withCapabilityAliases({ archetypeId: 'p', archetypeVersion: '1', digest: '0x', instructions: '', capabilityIds: new Set(['person.contact.invite']),
      tools: { 'person.contact.invite': { id: 'person.contact.invite', description: 'add a contact', inputSchema: { type: 'object', properties: { contact: { type: 'string' } }, required: ['contact'] } } } } as never) as unknown as { tools: Record<string, never> };
    const offered = mergeContractTool(FRIEND_ADD_TOOL, pb.tools['person.friend.add']);
    expect((offered.inputSchema as { required?: string[] }).required).toEqual(['friend']);
    expect(Object.keys((offered.inputSchema as { properties: object }).properties)).not.toContain('contact');
  });
});
