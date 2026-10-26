// Friendship by email invitation (spec 401 C1): the inviter signs their half when they send; accepting with the token
// completes it once — and both people are friends after the invitee's single act.
import { describe, it, expect, beforeEach } from 'vitest';
import { encodeAbiParameters, type Address, type Hex } from 'viem';
import { InputRequired } from '@agenticprimitives/orchestration';
import { friendAddInvoker, friendRemoveInvoker, friendOfferRecordType, type FriendDeps, type FriendOfferRecordV1 } from '../src/friend-offers.js';
import { friendsOf } from '../src/friends.js';
import { invitationRecordType, prepareInvitationOffer, redeemInvitation, storeInvitationOffer, type FriendInvitationOfferV1, type InvitedFriendOfferV1 } from '../src/friend-invitations.js';

const ANN = '0x00000000000000000000000000000000000000a1' as Address; // the inviter
const BEN = '0x00000000000000000000000000000000000000b1' as Address; // accepts
const CAL = '0x00000000000000000000000000000000000000c1' as Address; // someone else with the link
const SVC = '0x00000000000000000000000000000000000000d1' as Address;
const HARNESS = '0x00000000000000000000000000000000000000ee' as Address;
const TOKEN = 'ab'.repeat(24);
const DAY = 24 * 3600 * 1000;
const T0 = 1_800_000_000_000;

let vaults: Map<string, Map<string, unknown>>;
beforeEach(() => { vaults = new Map(); });
const vault = (s: string) => { const k = s.toLowerCase(); if (!vaults.has(k)) vaults.set(k, new Map()); return vaults.get(k)!; };

const deps = (over: Partial<FriendDeps & { signAsHarness: (d: Hex) => Promise<Hex> }> = {}) => ({
  env: { CHAIN_ID: '34348', DELEGATION_MANAGER: '0x00000000000000000000000000000000000000dd', HARNESS_AGENT_SA: HARNESS },
  enforcers: { timestamp: '0x00000000000000000000000000000000000000e1' as Address, value: '0x00000000000000000000000000000000000000e2' as Address, digestBinding: '0x00000000000000000000000000000000000000e3' as Address },
  vaultServerId: 'demo-mcp',
  readSubjectRecord: async (s: string, t: string) => vault(s).get(t) ?? null,
  writeSubjectRecord: async (s: string, t: string, r: unknown) => { if (r === null) vault(s).delete(t); else vault(s).set(t, r); return { ok: true }; },
  survey: async (s: string) => [...vault(s).keys()].map((recordType) => ({ recordType })),
  readRecords: async (s: string, keys: string[]) => Object.fromEntries(keys.map((k) => [k, vault(s).get(k)])),
  agentTypeOf: async (a: string) => (a === SVC ? 'service' : 'person'),
  // ANN's account accepts ANN's signature; the harness account accepts the harness's
  readContract: async (a: { address: Address; args: readonly unknown[] }) => ((a.address === ANN && a.args[1] === '0xaa01') || (a.address === HARNESS && a.args[1] === '0xee01') ? '0x1626ba7e' : '0xffffffff'),
  signAsHarness: async () => '0xee01' as Hex,
  executeAsServiceSa: async () => ({ txHash: '0xtx' }),
  digestBindingArgsFor: () => '0x' as Hex, stepDigests: (_a: unknown, intent: Hex) => ({ intent }),
  ...over,
}) as FriendDeps & { signAsHarness: (d: Hex) => Promise<Hex> };

async function send(d = deps(), expiresAt = T0 + 14 * DAY) {
  const p = prepareInvitationOffer(d, ANN, TOKEN, expiresAt, T0);
  if (!p.ok) throw new Error(p.error);
  const out = await storeInvitationOffer(d, ANN, { token: TOKEN, expiresAt, signature: "0xaa01" }, T0);
  if (!out.ok) throw new Error(out.error);
  return out;
}
const wire = (delegator: Address) => ({ ref: '0xref', wire: { delegator, delegate: HARNESS, authority: `0x${'0'.repeat(64)}`, caveats: [{ enforcer: '0x00000000000000000000000000000000000000e1', terms: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [1000n, 2000n]), args: '0x' }], salt: 1n, signature: '0xsig' } });
const ctx = (supplied: unknown[] = []) => ({ step: { id: 's0' }, index: 0, intent: { goal: 'add ann', context: {} }, supplied } as never);
/** BEN accepts: his own add of ANN, carrying the invitation — signing his own grant when asked. */
async function accept(d: FriendDeps, who: Address = BEN) {
  const inv = friendAddInvoker(d, wire(who), who, 'sess');
  const args = { friend: ANN, invitation: TOKEN };
  const asked = await inv('person.friend.add', args, ctx()).catch((e: unknown) => e);
  if (!(asked instanceof InputRequired)) return asked as Record<string, unknown>;
  const digest = String((asked as unknown as { request?: { digest?: string }; digest?: string }).request?.digest ?? (asked as unknown as { digest?: string }).digest);
  return (await inv('person.friend.add', args, ctx([{ stepRef: 's0', signature: { digest, signature: '0xbe01' } }]))) as Record<string, unknown>;
}

describe('sending: the inviter signs their half', () => {
  it('keeps the signed half beside the invitation, in the inviter\'s own vault — not the token itself', async () => {
    const out = await send();
    expect(out.ok).toBe(true);
    const rec = vault(ANN).get(invitationRecordType(TOKEN)) as FriendInvitationOfferV1;
    expect(rec.status).toBe('pending'); expect(rec.delegation.delegator).toBe(ANN); expect(rec.delegation.delegate).toBe(HARNESS);
    expect(JSON.stringify(rec)).not.toContain(TOKEN);
  });
  it('a signature that does not verify against the inviter\'s account keeps nothing', async () => {
    const d = deps();
    const out = await storeInvitationOffer(d, ANN, { token: TOKEN, expiresAt: T0 + DAY, signature: '0xf0f0' }, T0);
    expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/did not verify/) });
    expect(vault(ANN).size).toBe(0);
  });
  it('signing again after it was accepted never makes the invitation usable again', async () => {
    await send();
    await accept(deps());
    const again = await storeInvitationOffer(deps(), ANN, { token: TOKEN, expiresAt: T0 + 14 * DAY, signature: '0xaa01' }, T0);
    expect(again).toMatchObject({ ok: false, error: expect.stringMatching(/already accepted/) });
    expect((vault(ANN).get(invitationRecordType(TOKEN)) as FriendInvitationOfferV1).status).toBe('redeemed');
  });
  it('an expired invitation, or one claiming more than a month, is refused', () => {
    expect(prepareInvitationOffer(deps(), ANN, TOKEN, T0 - 1, T0)).toMatchObject({ ok: false });
    expect(prepareInvitationOffer(deps(), ANN, TOKEN, T0 + 60 * DAY, T0)).toMatchObject({ ok: false });
  });
});

describe('accepting with the token: both halves in one act', () => {
  it('the invitee adds the inviter and is friends at once — on both sides', async () => {
    await send();
    const out = await accept(deps());
    expect(out.added).toBe(true); expect(out.friends).toBe(true);
    expect(out.invitation).toMatchObject({ redeemed: true, inviter: ANN });
    const annHalf = vault(ANN).get(friendOfferRecordType(BEN)) as InvitedFriendOfferV1;
    expect(annHalf.status).toBe('standing'); expect(annHalf.offeredTo).toBe(BEN);
    // the grant to BEN is the harness's, hanging from ANN's own root
    expect(annHalf.delegation.delegator).toBe(HARNESS); expect(annHalf.delegation.delegate).toBe(BEN);
    expect(annHalf.delegation.authority).toBe((vault(ANN).get(invitationRecordType(TOKEN)) as FriendInvitationOfferV1).grantDigest);
    expect(annHalf.viaInvitation.root.delegator).toBe(ANN);
    expect((vault(ANN).get(invitationRecordType(TOKEN)) as FriendInvitationOfferV1).status).toBe('redeemed');
    const annView = await friendsOf(deps(), ANN);
    const benView = await friendsOf(deps(), BEN);
    expect(annView.friends.map((f) => f.agent)).toEqual([BEN]);
    expect(benView.friends.map((f) => f.agent)).toEqual([ANN]);
  });
  it('is single-use: a second person with the same link is told, and is only a request', async () => {
    await send();
    await accept(deps());
    const out = await accept(deps(), CAL);
    expect(out.friends).toBe(false);
    expect(out.invitation).toMatchObject({ redeemed: false, reason: expect.stringMatching(/someone else/) });
    expect(vault(ANN).get(friendOfferRecordType(CAL))).toBeUndefined();
  });
  it('an expired invitation, one never signed, and a service are each refused in words — the invitee\'s own half stands', async () => {
    await send(deps(), T0 + DAY);
    expect(await redeemInvitation(deps(), ANN, BEN, TOKEN, T0 + 2 * DAY)).toMatchObject({ redeemed: false, reason: expect.stringMatching(/expired/) });
    vaults = new Map();
    const unsigned = await accept(deps());
    expect(unsigned.added).toBe(true);
    expect(unsigned.invitation).toMatchObject({ redeemed: false, reason: expect.stringMatching(/did not sign their half/) });
    vaults = new Map();
    await send();
    expect(await redeemInvitation(deps(), ANN, SVC, TOKEN, T0)).toMatchObject({ redeemed: false, reason: expect.stringMatching(/accepted by a person/) });
  });
  it('a harness signature that does not verify writes nothing', async () => {
    await send();
    const out = await redeemInvitation(deps({ signAsHarness: async () => '0xbad0' as Hex }), ANN, BEN, TOKEN, T0);
    expect(out).toMatchObject({ redeemed: false, reason: expect.stringMatching(/did not verify/) });
    expect(vault(ANN).get(friendOfferRecordType(BEN))).toBeUndefined();
    expect((vault(ANN).get(invitationRecordType(TOKEN)) as FriendInvitationOfferV1).status).toBe('pending');
  });
});

describe('removing a friend made by invitation', () => {
  it('revokes the inviter\'s own root grant — the one their account can revoke', async () => {
    await send();
    await accept(deps());
    const revoked: string[] = [];
    const d = deps({ executeAsServiceSa: async (_sa, data) => { revoked.push(data); return { txHash: '0xrevoked' }; } });
    const out = (await friendRemoveInvoker(d, wire(ANN), ANN)('person.friend.remove', { friend: BEN }, ctx())) as { removed: boolean };
    expect(out.removed).toBe(true);
    // the revoked tuple is ANN's root (delegator ANN), not the harness's hand-on
    expect(revoked[0]).toContain(ANN.slice(2));
    expect((vault(ANN).get(friendOfferRecordType(BEN)) as FriendOfferRecordV1).status).toBe('withdrawn');
    expect((await friendsOf(deps(), BEN)).ended.map((e) => e.agent)).toEqual([ANN]);
  });
});
