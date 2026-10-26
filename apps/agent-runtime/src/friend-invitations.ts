// FRIENDSHIP BY INVITATION — the inviter's half, signed before the invitee has an agent anyone can name (spec 401 C1).
//
// An email invitation goes to an address, not an agent: when it is sent nobody knows which agent will accept it (a new
// Home, or one the invitee already has under another sign-in). So the inviter's half cannot be the usual grant to the
// friend. Instead the inviter signs, when they send, ONE grant to their own agent (this runtime's harness SA) with the
// friendship's exact scope, and keeps it in their own vault beside the invitation (`friend:invitation:<key>`, the key
// being the keccak of the invitation token — the token itself is never stored):
//
//   D1  inviter → harness SA   vault:profile.contact read · the friendship's window · value 0     (signed at send)
//   D2  harness SA → invitee   the same caveats, authority = hash(D1)                              (signed at accept)
//
// When the invitee accepts with the token (`person.friend.add { friend: <inviter>, invitation }`), their own half is
// made as always, and then the agent redeems the invitation ONCE: it signs D2 to the person who accepted and writes the
// inviter's `friend:<invitee>` offer carrying D2 and its root. The chain grants nothing D1 did not; D1 names this one
// invitation (its salt), and the record that lets the agent use it is single-use and expires with the invitation.
// Removing that friend later revokes D1 — the inviter's own grant — which ends the chain.
import { keccak256, toBytes, type Address, type Hex } from 'viem';
import { buildCaveat, buildVaultRecordScopeCaveat, encodeTimestampTerms, encodeValueTerms, hashDelegation, ROOT_AUTHORITY, type Caveat, type Delegation } from '@agenticprimitives/delegation';
import type { DelegationWireV1 } from '@agenticprimitives/a2a';
import { FRIEND_GRANT_SCOPE, FRIEND_TYPES, friendOfferRecordType, migrateLegacyOffers, readOffer, type FriendDeps, type FriendOfferRecordV1, type FriendType } from './friend-offers.js';

export const FRIEND_INVITATION_PREFIX = 'friend:invitation:';
/** How long a friendship made through an invitation stands before it is renewed — the same year a direct one gets. */
const FRIENDSHIP_SECONDS = 365 * 24 * 3600;
/** An invitation lives two weeks at the Home (friend-invite.ts); a record claiming more is refused. */
const MAX_INVITATION_SECONDS = 30 * 24 * 3600;
const TOKEN_RE = /^[a-f0-9]{40,80}$/;
const ERC1271_ABI = [{ type: 'function', name: 'isValidSignature', stateMutability: 'view', inputs: [{ name: 'hash', type: 'bytes32' }, { name: 'signature', type: 'bytes' }], outputs: [{ type: 'bytes4' }] }] as const;
const ERC1271_MAGIC = '0x1626ba7e';

export const invitationKey = (token: string): Hex => keccak256(toBytes(`friend-invitation:${token.toLowerCase()}`));
export const invitationRecordType = (token: string): string => `${FRIEND_INVITATION_PREFIX}${invitationKey(token)}`;
export const isInvitationToken = (t: unknown): t is string => typeof t === 'string' && TOKEN_RE.test(t.toLowerCase());

/** The inviter's half waiting for whoever accepts (aporg:FriendshipOffer whose friend is not yet known). */
export interface FriendInvitationOfferV1 {
  type: 'ap.friend-invitation-offer.v1';
  invitation: Hex;
  friendType: FriendType;
  /** D1 — the inviter's grant to their own agent, the root of the friendship's grant. */
  delegation: DelegationWireV1;
  grantDigest: Hex;
  status: 'pending' | 'redeemed' | 'withdrawn';
  offeredAt: number;
  /** When the invitation stops being redeemable (ms). */
  expiresAt: number;
  redeemedBy?: Address;
  redeemedAt?: number;
}

/** The inviter's offer once redeemed: an ordinary friend offer whose grant is D2, with D1 kept as its root. */
export type InvitedFriendOfferV1 = FriendOfferRecordV1 & { viaInvitation: { invitation: Hex; root: DelegationWireV1 } };

export type InvitationDeps = Pick<FriendDeps, 'env' | 'enforcers' | 'vaultServerId' | 'readSubjectRecord' | 'writeSubjectRecord' | 'survey' | 'readRecords' | 'readContract' | 'agentTypeOf'> & {
  /** The harness SA signs a raw delegation digest (its custodian, the interactions-session key). */
  signAsHarness?: (digest: Hex) => Promise<Hex>;
};

const harnessSa = (deps: Pick<FriendDeps, 'env'>): Address => {
  const sa = (deps.env.HARNESS_AGENT_SA ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(sa)) throw new Error('this agent has no harness account to hold an invitation');
  return sa as Address;
};
const chainOf = (deps: Pick<FriendDeps, 'env'>) => ({ chainId: Number(deps.env.CHAIN_ID), dm: deps.env.DELEGATION_MANAGER as Address });
const toWire = (d: Delegation): DelegationWireV1 => ({ ...d, salt: d.salt.toString() }) as unknown as DelegationWireV1;
const fromWire = (w: DelegationWireV1): Delegation => ({ ...(w as unknown as Delegation), salt: BigInt(String(w.salt)), caveats: w.caveats.map((c) => ({ enforcer: c.enforcer as Address, terms: c.terms as Hex, args: (c.args ?? '0x') as Hex })) });

function friendshipCaveats(deps: Pick<FriendDeps, 'enforcers' | 'vaultServerId'>, validUntil: number): Caveat[] {
  return [
    buildVaultRecordScopeCaveat([{ server: deps.vaultServerId, resources: [FRIEND_GRANT_SCOPE], ops: ['read'] }]),
    buildCaveat(deps.enforcers.timestamp, encodeTimestampTerms(0, validUntil)),
    buildCaveat(deps.enforcers.value, encodeValueTerms(0n)),
  ];
}

/** D1 for one invitation — fixed by the inviter, the token and the invitation's expiry, so the grant the inviter is
 *  shown to sign is the grant that is stored. */
export function invitationGrantFor(deps: Pick<FriendDeps, 'env' | 'enforcers' | 'vaultServerId'>, inviter: Address, token: string, expiresAt: number): { grant: Delegation; digest: Hex; validUntil: number } {
  const validUntil = Math.floor(expiresAt / 1000) + FRIENDSHIP_SECONDS;
  const salt = BigInt(invitationKey(token));
  const grant: Delegation = { delegator: inviter.toLowerCase() as Address, delegate: harnessSa(deps), authority: ROOT_AUTHORITY, caveats: friendshipCaveats(deps, validUntil), salt, signature: '0x' };
  const { chainId, dm } = chainOf(deps);
  return { grant, digest: hashDelegation(grant, chainId, dm), validUntil };
}

function checkExpiry(expiresAt: number, now: number): string | null {
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return 'this invitation has already expired';
  if (expiresAt - now > MAX_INVITATION_SECONDS * 1000) return 'an invitation cannot run that long';
  return null;
}

/** What the inviter signs, for the Home's window to show and sign. */
export function prepareInvitationOffer(deps: Pick<FriendDeps, 'env' | 'enforcers' | 'vaultServerId'>, inviter: Address, token: string, expiresAt: number, now = Date.now()): { ok: true; digest: Hex; grant: DelegationWireV1 } | { ok: false; error: string } {
  if (!isInvitationToken(token)) return { ok: false, error: 'that is not an invitation' };
  const late = checkExpiry(expiresAt, now);
  if (late) return { ok: false, error: late };
  const { grant, digest } = invitationGrantFor(deps, inviter, token, expiresAt);
  return { ok: true, digest, grant: toWire(grant) };
}

/** Keep the inviter's signed half beside the invitation, in their own vault. The signature is checked against their
 *  account before anything is written. */
export async function storeInvitationOffer(
  deps: InvitationDeps, inviter: Address, input: { token: string; expiresAt: number; signature: Hex; friendType?: unknown }, now = Date.now(),
): Promise<{ ok: true; record: FriendInvitationOfferV1 } | { ok: false; error: string }> {
  const prepared = prepareInvitationOffer(deps, inviter, input.token, input.expiresAt, now);
  if (!prepared.ok) return prepared;
  if (!deps.writeSubjectRecord) return { ok: false, error: 'this agent cannot keep your invitation' };
  if (!/^0x[0-9a-fA-F]+$/.test(input.signature ?? '')) return { ok: false, error: 'the signature is missing' };
  if (deps.readContract) {
    const ok = await deps.readContract({ address: inviter, abi: ERC1271_ABI, functionName: 'isValidSignature', args: [prepared.digest, input.signature] }).catch(() => null);
    if (ok !== ERC1271_MAGIC) return { ok: false, error: 'your signature did not verify against your account — nothing was kept' };
  }
  // Signing again (the invitation resent) keeps what already happened: a used invitation is never made usable again.
  const before = (await deps.readSubjectRecord?.(inviter.toLowerCase(), invitationRecordType(input.token)).catch(() => null)) as FriendInvitationOfferV1 | null;
  if (before?.type === 'ap.friend-invitation-offer.v1' && before.status !== 'pending') return { ok: false, error: before.status === 'redeemed' ? 'this invitation was already accepted — you are friends' : 'this invitation was withdrawn' };
  const friendType = (FRIEND_TYPES as readonly string[]).includes(String(input.friendType)) ? (input.friendType as FriendType) : 'friend';
  const record: FriendInvitationOfferV1 = {
    type: 'ap.friend-invitation-offer.v1', invitation: invitationKey(input.token), friendType,
    delegation: { ...prepared.grant, signature: input.signature }, grantDigest: prepared.digest,
    status: 'pending', offeredAt: now, expiresAt: input.expiresAt,
  };
  const wrote = await deps.writeSubjectRecord(inviter.toLowerCase(), invitationRecordType(input.token), record);
  if (!wrote.ok) return { ok: false, error: /record_scope_denied|scope/i.test(wrote.error ?? '') ? 'your storage permission predates friends — turn your storage on again at your Home, then send the invitation again' : `your invitation could not be kept: ${wrote.error ?? 'write refused'}` };
  return { ok: true, record };
}

export type RedeemResult =
  | { redeemed: true; inviter: Address; grantDigest: Hex }
  | { redeemed: false; already?: true; reason: string };

/**
 * THE INVITEE ACCEPTED: complete the inviter's half, once. Every refusal is a reason in words (ADR-0013) — the
 * invitee's own half stands either way, and the inviter can still add them back by hand.
 */
export async function redeemInvitation(deps: InvitationDeps, inviter: Address, claimer: Address, token: string, now = Date.now()): Promise<RedeemResult> {
  if (!isInvitationToken(token)) return { redeemed: false, reason: 'that is not an invitation' };
  if (!deps.readSubjectRecord || !deps.writeSubjectRecord) return { redeemed: false, reason: 'this agent cannot reach the inviter\'s records' };
  if (!deps.signAsHarness) return { redeemed: false, reason: 'this agent cannot sign for an invitation here' };
  const from = inviter.toLowerCase() as Address;
  const me = claimer.toLowerCase() as Address;
  if (from === me) return { redeemed: false, reason: 'this is your own invitation' };
  const key = invitationRecordType(token);
  const rec = (await deps.readSubjectRecord(from, key).catch(() => null)) as FriendInvitationOfferV1 | null;
  if (rec?.type !== 'ap.friend-invitation-offer.v1') return { redeemed: false, reason: 'the inviter did not sign their half when they sent this invitation' };
  if (rec.status === 'redeemed') return rec.redeemedBy?.toLowerCase() === me ? { redeemed: false, already: true, reason: 'this invitation already made you friends' } : { redeemed: false, reason: 'this invitation was already accepted by someone else' };
  if (rec.status !== 'pending') return { redeemed: false, reason: 'the inviter withdrew this invitation' };
  if (rec.expiresAt <= now) return { redeemed: false, reason: 'this invitation has expired' };
  const kind = deps.agentTypeOf ? await deps.agentTypeOf(me).catch(() => null) : null;
  if (kind !== null && kind !== 'person' && kind !== 'me') return { redeemed: false, reason: 'an invitation to be friends is accepted by a person' };
  const root = fromWire(rec.delegation);
  const { chainId, dm } = chainOf(deps);
  if (root.delegator.toLowerCase() !== from || root.delegate.toLowerCase() !== harnessSa(deps) || hashDelegation(root, chainId, dm).toLowerCase() !== rec.grantDigest.toLowerCase()) {
    return { redeemed: false, reason: 'the inviter\'s signed half does not match this invitation' };
  }
  // A legacy record of the inviter's moves first, so "already offered" below reads the record that stands.
  await migrateLegacyOffers(deps, from);
  const existing = await readOffer(deps, from, me);
  if (existing?.status === 'standing') {
    await deps.writeSubjectRecord(from, key, { ...rec, status: 'redeemed', redeemedBy: me, redeemedAt: now });
    return { redeemed: false, already: true, reason: 'the inviter had already added you' };
  }
  const tsTerms = root.caveats.find((c) => c.enforcer.toLowerCase() === deps.enforcers.timestamp.toLowerCase());
  if (!tsTerms) return { redeemed: false, reason: 'the inviter\'s signed half carries no window' };
  const child: Delegation = { delegator: harnessSa(deps), delegate: me, authority: rec.grantDigest, caveats: root.caveats, salt: BigInt(keccak256(toBytes(`${rec.invitation}:${me}`))), signature: '0x' };
  const childDigest = hashDelegation(child, chainId, dm);
  let signature: Hex;
  try { signature = await deps.signAsHarness(childDigest); } catch (e) { return { redeemed: false, reason: `your friend's agent could not sign their half: ${e instanceof Error ? e.message : String(e)}` }; }
  if (deps.readContract) {
    const ok = await deps.readContract({ address: harnessSa(deps), abi: ERC1271_ABI, functionName: 'isValidSignature', args: [childDigest, signature] }).catch(() => null);
    if (ok !== ERC1271_MAGIC) return { redeemed: false, reason: 'your friend\'s agent signed their half, but the signature did not verify — nothing was written' };
  }
  const offer: InvitedFriendOfferV1 = {
    type: 'ap.friend-offer.v1', offeredTo: me, friendType: rec.friendType, delegation: toWire({ ...child, signature }), grantDigest: childDigest,
    status: 'standing', offeredAt: now, viaInvitation: { invitation: rec.invitation, root: rec.delegation },
  };
  const wrote = await deps.writeSubjectRecord(from, friendOfferRecordType(me), offer);
  if (!wrote.ok) return { redeemed: false, reason: `the inviter's half could not be recorded: ${wrote.error ?? 'write refused'}` };
  await deps.writeSubjectRecord(from, key, { ...rec, status: 'redeemed', redeemedBy: me, redeemedAt: now }).catch(() => undefined);
  return { redeemed: true, inviter: from, grantDigest: childDigest };
}

/** The grant a removal revokes: the inviter's own root when the offer came through an invitation. */
export const revocableGrantOf = (rec: FriendOfferRecordV1): DelegationWireV1 => (rec as Partial<InvitedFriendOfferV1>).viaInvitation?.root ?? rec.delegation;
