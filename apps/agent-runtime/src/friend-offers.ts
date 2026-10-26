// FRIENDSHIP OFFERS — one person's half of a friendship (spec 401 §10; ontology aporg:FriendshipOffer). A friendship is
// two-way between two PERSONS and is never a record: it holds while each has a standing offer naming the other. This
// module is the offer: the person's own record in their own vault (`friend:<their sa>`), under the access grant they
// signed (the friend may read their private profile — nothing else), written and withdrawn only by them.
//
//   person.friend.add     — make MY offer (accepting a request is the same act). My mandate, my grant, my record.
//   person.friend.remove  — withdraw MY offer: revoke my grant on chain, mark my record withdrawn. The other side sees
//                           the friendship end at once (friends.ts reads their record of me); theirs is theirs to end.
//
// The type (friend · family · coach · other) is declarative and authorizes nothing; the grant is the authority.
//
// LEGACY (until every person's records have moved): offers made before 2026-10-26 were `contact:<sa>` records of type
// `ap.contact.v1`. They are READ as offers (`legacyOffer`) and MOVED on the person's next friend act or friends read
// (`migrateLegacyOffers`): written as `friend:<sa>`, then the old record tombstoned. No grant is re-signed: the grant
// inside is the same grant. Stored playbooks naming `person.contact.*` are read through `playbook-aliases.ts`.
import { ADAPTER, CARRIES } from './adapter-declarations.js';
import { contractsGenerationOf } from '@agenticprimitives/agent-account';
import { encodeFunctionData, keccak256, toBytes, type Address, type Hex } from 'viem';
import { InputRequired, signatureFor, type ToolInvoker, type ToolSpec, type MandatePresentation, type SuppliedInputV1 } from '@agenticprimitives/orchestration';
import { buildCaveat, buildVaultRecordScopeCaveat, encodeTimestampTerms, encodeValueTerms, decodeTimestampTerms, hashDelegation, intentDigest, ROOT_AUTHORITY, type Caveat, type Delegation } from '@agenticprimitives/delegation';
import type { DelegationWireV1 } from '@agenticprimitives/a2a';

export const FRIEND_ADD_CAPABILITY = 'person.friend.add' as const;
export const FRIEND_REMOVE_CAPABILITY = 'person.friend.remove' as const;

/** What a friend is to you (aporg:FriendType). Declarative; none authorizes anything; every one two-way. */
export const FRIEND_TYPES = ['friend', 'family', 'coach', 'other'] as const;
export type FriendType = typeof FRIEND_TYPES[number];

/** What the offer's grant lets the friend read: the offerer's private profile (`vault:impact-profile` is served to a
 *  friend under this resource). The VALUE is signed into every friendship grant ever issued, so it never changes. */
export const FRIEND_GRANT_SCOPE = 'vault:profile.contact';

export const FRIEND_ADD_TOOL: ToolSpec = {
  id: FRIEND_ADD_CAPABILITY,
  adapter: ADAPTER.sync, carries: CARRIES.friend,
  verbs: ['add as a friend', 'add friend', 'add to my friends', 'befriend', 'accept friend request', 'send a friend request', 'add back'],
  establishes: 'submission',
  description:
    'ADD A FRIEND — offer friendship to another PERSON (or accept their request: the same act). Requires your own mandate '
    + '(it is your act, on your own records). Produces your signed grant to them (they may read your private profile) and '
    + 'your own record of the offer. You are friends once they have offered theirs too; until then it is a request. Args: '
    + 'friend (who — EXACTLY as the ask names them: a name, a typed name like bob.me, or an address; the agent resolves '
    + 'it), type (friend | family | coach | other; default friend). NEVER for an organization (one is invited to an '
    + 'organization by organization.membership.invite) or a service (a service is connected, not befriended).',
  inputSchema: {
    type: 'object',
    properties: {
      friend: { type: 'string', description: 'Who to add, as the ask names them (a name, a typed name, or an address)' },
      type: { type: 'string', description: 'friend | family | coach | other (default friend)' },
      person: { type: 'string', description: 'Whose friends — the person asking (their own agent). Omit: it is always the asker.' },
    },
    required: ['friend'],
  },
  // The ACTING party is the person (their own mandate — self). Without an authorityArg the delegator falls through to
  // the RESOURCE (the friend) and the person is asked to sign as someone else.
  capability: { id: FRIEND_ADD_CAPABILITY, action: 'invite', resourceArg: 'friend', authorityArg: 'person' },
  risk: 'medium',
};

export const FRIEND_REMOVE_TOOL: ToolSpec = {
  id: FRIEND_REMOVE_CAPABILITY,
  adapter: ADAPTER.chain,
  verbs: ['remove friend', 'remove as a friend', 'remove from my friends', 'unfriend', 'cancel friend request', 'end friendship'],
  establishes: 'submission',
  description:
    'REMOVE A FRIEND (or cancel a request you sent) — withdraws your offer: revokes the grant you gave them on chain (they '
    + 'stop being able to read your profile at the next gate) and marks your offer withdrawn. They see the friendship end '
    + 'at once. Requires your own mandate. Args: friend (who, as the ask names them).',
  inputSchema: { type: 'object', properties: { friend: { type: 'string', description: 'Who to remove, as the ask names them' }, person: { type: 'string', description: 'Whose friends — the person asking. Omit.' }, manager: { type: 'string', description: 'The delegation manager the revocation is a call to — filled by the agent, never by the planner.' } }, required: ['friend'] },
  // Remove IS a revocation: a call to the DelegationManager (the RESOURCE, as access.grant.revoke declares it); which grant
  // dies travels in the calldata — the friend is resolved as a party but is not the caveat's location.
  capability: { id: FRIEND_REMOVE_CAPABILITY, action: 'revoke', resourceArg: 'manager', authorityArg: 'person', redeemsOnChain: true }, // spec 408 §2.2: redeemed through the DM
  risk: 'medium',
};

/** A person's half of a friendship — `friend:<their sa>` in their own vault (aporg:FriendshipOffer; the ontology binds
 *  each field: offeredTo · friendType · delegation (offerGrant) · status (offerStatus) · withdrawnAt). */
export interface FriendOfferRecordV1 {
  type: 'ap.friend-offer.v1';
  offeredTo: Address;
  friendType: FriendType;
  /** The person → friend access grant (what the friend may read). */
  delegation: DelegationWireV1;
  grantDigest: Hex;
  status: 'standing' | 'withdrawn';
  offeredAt: number;
  withdrawnAt?: number;
  /** Evidence carried from a legacy record: the other person had already offered theirs when this one was made. Used
   *  only when their own record cannot be read; their record, when read, decides. */
  mutual?: true;
}

export const FRIEND_OFFER_PREFIX = 'friend:';
export const friendOfferRecordType = (them: string): string => `${FRIEND_OFFER_PREFIX}${them.toLowerCase()}`;

/** The pre-2026-10-26 shape, read only to move it (see the header). */
export const LEGACY_OFFER_PREFIX = 'contact:';
export const legacyOfferRecordType = (them: string): string => `${LEGACY_OFFER_PREFIX}${them.toLowerCase()}`;
interface LegacyOfferRecord { type: 'ap.contact.v1'; contact: Address; role: string; delegation: DelegationWireV1; grantDigest: Hex; status: 'contact' | 'removed'; createdAt: number; removedAt?: number; mutual?: boolean }

const asFriendType = (raw: unknown): FriendType => {
  const r = String(raw ?? '').trim().toLowerCase();
  return (FRIEND_TYPES as readonly string[]).includes(r) ? (r as FriendType) : 'friend';
};

/** A record of either shape, as an offer — or null when it is neither (or is a legacy record for a service). */
export function asOffer(rec: unknown): FriendOfferRecordV1 | null {
  const n = rec as Partial<FriendOfferRecordV1> | null;
  if (n?.type === 'ap.friend-offer.v1' && n.offeredTo && n.delegation) return n as FriendOfferRecordV1;
  const r = rec as Partial<LegacyOfferRecord> | null;
  if (r?.type === 'ap.contact.v1' && r.contact && r.delegation) {
    // runtimes and assistants were "contacts"; they are not friends, and nothing is moved for them.
    if (r.role === 'runtime' || r.role === 'assistant') return null;
    return {
      type: 'ap.friend-offer.v1', offeredTo: r.contact.toLowerCase() as Address, friendType: asFriendType(r.role), delegation: r.delegation,
      grantDigest: r.grantDigest as Hex, status: r.status === 'removed' ? 'withdrawn' : 'standing', offeredAt: r.createdAt ?? Date.now(),
      ...(r.removedAt ? { withdrawnAt: r.removedAt } : {}),
      ...(r.mutual === true ? { mutual: true as const } : {}),
    };
  }
  return null;
}

/** A friend request, told in the friend's own vault (spec 401): who offered, and the grant that did. Kept in the inbox
 *  record (`friendRequests`, beside the envelopes — never one of them), which every interactions grant already covers.
 *  Not a message: no text, no conversation; one per sender, capped. */
export const FRIEND_REQUESTS_CAP = 200;
export interface FriendRequestNoticeV1 { from: string; at: string; grantDigest: string }

export interface FriendDeps {
  env: { CHAIN_ID?: string; DELEGATION_MANAGER?: string; HARNESS_AGENT_SA?: string; VAULT_SERVER_ID?: string; TIMESTAMP_ENFORCER?: string; VALUE_ENFORCER?: string; DIGEST_BINDING_ENFORCER?: string; CONTRACTS_GENERATION?: string };
  enforcers: { timestamp: Address; value: Address; digestBinding: Address };
  vaultServerId: string;
  readSubjectRecord?: (subject: string, recordType: string) => Promise<unknown>;
  /** `record: null` is a tombstone (the legacy record, once moved). */
  writeSubjectRecord?: (subject: string, recordType: string, record: unknown, operationId?: string) => Promise<{ ok: boolean; error?: string }>;
  survey?: (subject: string) => Promise<Array<{ recordType: string }>>;
  readRecords?: (subject: string, recordTypes: string[]) => Promise<Record<string, unknown>>;
  nameOf?: (address: string) => Promise<string | null>;
  agentTypeOf?: (address: string) => Promise<string | null>;
  sendDirectMessage?: (input: { sender: Address; recipient: Address; bodyText: string; session: string; contextRefs?: Array<{ kind: string; id: string; label?: string }> }) => Promise<{ ok: boolean; error?: string; messageId?: string }>;
  /** Put a friend request in the other person's own vault (their DO, in-Worker): who offered, and the grant that did. */
  deliverFriendRequest?: (input: { sender: Address; recipient: Address; grantDigest: string }) => Promise<{ ok: boolean; error?: string }>;
  /** A view call on chain — whether the person's account already approved the grant (the one-prompt path). */
  readContract?: (args: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[] }) => Promise<unknown>;
  /** The person's SA executes a call under their redeemed mandate (the revoke) — the same path access.grant.revoke uses. */
  executeAsServiceSa?: (serviceSa: Address, callData: Hex) => Promise<{ txHash: string }>;
  /** The mandate's digest-binding caveat argued for THIS step (the harness's own helper, injected). */
  digestBindingArgsFor: (caveat: Caveat, digests: { intent: Hex; offer?: Hex; projection?: Hex; plan?: Hex; stepNonce: Hex; generation?: 1 | 2 | 3 }) => Hex;
  /** Spec 408 §1.4/§2.3 — the digests a step presents at redemption. */
  stepDigests: (args: Record<string, unknown>, intent: Hex, stepRef: string, plan?: Hex, generation?: 1 | 2 | 3) => { intent: Hex; offer?: Hex; projection?: Hex; plan?: Hex; stepNonce: Hex; generation: 1 | 2 | 3 };
}

/** One person's offer to another, whichever shape it is stored in (the new key first). */
export async function readOffer(deps: Pick<FriendDeps, 'readSubjectRecord'>, holder: string, them: string): Promise<FriendOfferRecordV1 | null> {
  const h = holder.toLowerCase(); const t = them.toLowerCase();
  const now = asOffer(await deps.readSubjectRecord?.(h, friendOfferRecordType(t)).catch(() => null));
  if (now) return now;
  return asOffer(await deps.readSubjectRecord?.(h, legacyOfferRecordType(t)).catch(() => null));
}

/** Every offer a person holds, keyed by the other person — new records over legacy ones for the same person. */
export async function offersOf(deps: Pick<FriendDeps, 'survey' | 'readRecords'>, holder: string): Promise<Map<string, { offer: FriendOfferRecordV1; legacy: boolean }>> {
  const out = new Map<string, { offer: FriendOfferRecordV1; legacy: boolean }>();
  if (!deps.survey || !deps.readRecords) return out;
  const h = holder.toLowerCase();
  const keys = (await deps.survey(h).catch(() => [])).map((r) => r.recordType).filter((rt) => rt.startsWith(FRIEND_OFFER_PREFIX) || rt.startsWith(LEGACY_OFFER_PREFIX)).slice(0, 400);
  if (!keys.length) return out;
  const bodies = await deps.readRecords(h, keys).catch(() => ({} as Record<string, unknown>));
  for (const k of keys) {
    const offer = asOffer(bodies[k]);
    if (!offer) continue;
    const legacy = k.startsWith(LEGACY_OFFER_PREFIX);
    const them = offer.offeredTo.toLowerCase();
    if (legacy && out.has(them)) continue;
    out.set(them, { offer, legacy });
  }
  return out;
}

/**
 * MOVE a person's legacy offers to `friend:<sa>` (step 3 of spec 401 §10). Writes the new record, then tombstones the old
 * one; never the other way round, so a failure leaves the offer readable where it was. Returns how many moved and the
 * first refusal — a grant signed before `vault:friend:*` existed refuses the write, and that is said, never hidden:
 * the person re-enables their storage once (silent on a KMS home) and the next read finishes the move.
 */
export async function migrateLegacyOffers(deps: Pick<FriendDeps, 'survey' | 'readRecords' | 'writeSubjectRecord'>, holder: string): Promise<{ moved: number; error?: string }> {
  if (!deps.writeSubjectRecord) return { moved: 0 };
  const offers = await offersOf(deps, holder);
  const h = holder.toLowerCase();
  let moved = 0;
  // runtimes and assistants: their legacy records stay as they were (not friends, nothing to move to)
  for (const [them, { offer, legacy }] of offers) {
    if (!legacy) continue;
    const wrote = await deps.writeSubjectRecord(h, friendOfferRecordType(them), offer).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    if (!wrote.ok) return { moved, error: wrote.error ?? 'the friend record could not be written' };
    const gone = await deps.writeSubjectRecord(h, legacyOfferRecordType(them), null).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    if (!gone.ok) return { moved, error: `moved, but the old record could not be removed: ${gone.error ?? 'refused'}` };
    moved++;
  }
  return { moved };
}

/** A notice goes to a person — and to an agent whose type the naming service does not say (most people's). */
const mayBePerson = (kind: string | null): boolean => kind === null || kind === 'person' || kind === 'me';
const ORG_KINDS = new Set(['org', 'team', 'workspace', 'household', 'church', 'circle', 'alliance']);

/** THE OTHER HALF, ALREADY SIGNED: when the person just added had offered first, their request is delivered now too —
 *  it heals pairs who offered before requests were told, and a request lost on the way. */
async function requestBack(deps: FriendDeps, person: Address, them: Address): Promise<void> {
  if (!deps.deliverFriendRequest) return;
  const theirs = await readOffer(deps, them, person);
  if (theirs?.status !== 'standing' || !theirs.grantDigest) return;
  await deps.deliverFriendRequest({ sender: them, recipient: person, grantDigest: theirs.grantDigest }).catch(() => undefined);
}

/** Everyone who offered `me` friendship (or answered mine), newest time per sender: the friend requests in my inbox and
 *  the messages that carried them — both my own evidence. */
export async function whoOfferedMe(deps: Pick<FriendDeps, 'readSubjectRecord'>, me: string): Promise<Map<string, string | null>> {
  const offeredMe = new Map<string, string | null>();
  const note = (who: string, at: string | null) => {
    if (!who || who === me) return;
    const prev = offeredMe.get(who);
    if (prev === undefined || (at && (!prev || prev < at))) offeredMe.set(who, at);
  };
  const inbox = (await deps.readSubjectRecord?.(me, 'inbox.data').catch(() => null)) as { envelopes?: Array<{ from?: string; createdAt?: string; contextRefs?: Array<{ kind: string; id: string }> }>; friendRequests?: FriendRequestNoticeV1[]; contactNotices?: FriendRequestNoticeV1[] } | null;
  for (const e of inbox?.envelopes ?? []) {
    // `contact` is the reference kind messages carried before 2026-10-26; `friend-request` after.
    if (!(e.contextRefs ?? []).some((r) => (r.kind === 'friend-request' || r.kind === 'contact') && r.id.toLowerCase() === me)) continue;
    note((String(e.from ?? '').match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase(), typeof e.createdAt === 'string' ? e.createdAt : null);
  }
  for (const n of [...(inbox?.friendRequests ?? []), ...(inbox?.contactNotices ?? [])]) note(String(n.from ?? '').toLowerCase(), typeof n.at === 'string' ? n.at : null);
  return offeredMe;
}

function buildFriendGrant(deps: FriendDeps, person: Address, friend: Address, salt: bigint, validUntil: number): Delegation {
  const caveats: Caveat[] = [
    buildVaultRecordScopeCaveat([{ server: deps.vaultServerId, resources: [FRIEND_GRANT_SCOPE], ops: ['read'] }]),
    buildCaveat(deps.enforcers.timestamp, encodeTimestampTerms(0, validUntil)),
    buildCaveat(deps.enforcers.value, encodeValueTerms(0n)),
  ];
  return { delegator: person, delegate: friend, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
}

/**
 * THE FRIENDSHIP GRANT FOR A MANDATE — fixed by the mandate's intent and window, the step and the friend, so the step
 * that parks and the step that acts derive the SAME grant. That lets the Home approve it in the one prompt that approves
 * the mandate (spec 361 I4): the reply names this digest beside the mandate's, and the act finds it already approved.
 * (The salt's words are unchanged from the contact era so a parked run resumes onto the same grant.)
 */
export function friendGrantFor(
  deps: Pick<FriendDeps, 'env' | 'enforcers' | 'vaultServerId'>,
  person: Address,
  friend: Address,
  mandate: { intentDigest: string; validAfter: number },
  stepRef: string,
): { grant: Delegation; digest: Hex; salt: bigint; validUntil: number } {
  const validUntil = mandate.validAfter + 365 * 24 * 3600;
  const salt = BigInt(keccak256(toBytes(`${mandate.intentDigest}:${stepRef}:contact:${friend.toLowerCase()}`)));
  const grant = buildFriendGrant(deps as FriendDeps, person, friend.toLowerCase() as Address, salt, validUntil);
  return { grant, digest: hashDelegation(grant, Number(deps.env.CHAIN_ID), deps.env.DELEGATION_MANAGER as Address), salt, validUntil };
}

const ERC1271_ABI = [{ type: 'function', name: 'isValidSignature', stateMutability: 'view', inputs: [{ name: 'hash', type: 'bytes32' }, { name: 'signature', type: 'bytes' }], outputs: [{ type: 'bytes4' }] }] as const;

/** The friend argument as the ask named it — `contact` is the argument a run parked before 2026-10-26 carries. */
export const friendArg = (args: Record<string, unknown>): string => String(args.friend ?? args.contact ?? '').toLowerCase();

/** `person.friend.add` — the person's own act, on their own records. */
export function friendAddInvoker(deps: FriendDeps, presented: MandatePresentation, person: Address | undefined, session: string | undefined): ToolInvoker {
  return async (toolId, args, ctx) => {
    const stepRef = ctx.step.id ?? `s${ctx.index}`;
    if (!person) throw new Error('friends are a person\'s own — there is no person on this run');
    const wire = presented.wire as Delegation;
    if (wire.delegator.toLowerCase() !== person.toLowerCase()) throw new Error(`a friend is added under your own mandate (${person}); the mandate is from ${wire.delegator}`);
    const friend = friendArg(args) as Address;
    if (!/^0x[0-9a-f]{40}$/.test(friend)) {
      throw new InputRequired({ kind: 'data', stepRef, toolId, prompt: 'Who should be added as a friend? Give their name or address.', fields: [{ name: 'friend', label: 'Friend', type: 'text', required: true, hint: 'a typed name (bob.me) or an address' }] });
    }
    if (friend === person.toLowerCase()) throw new Error('you cannot be your own friend');
    const kind = deps.agentTypeOf ? await deps.agentTypeOf(friend).catch(() => null) : null;
    if (kind && ORG_KINDS.has(kind)) throw new Error('an organization is not a friend — you belong to it (or not); ask it to invite you');
    if (!mayBePerson(kind)) throw new Error('a service is not a friend — it is connected to you under a grant, from Connected');
    const type = asFriendType(args.type ?? args.role);
    if (!deps.writeSubjectRecord || !deps.readSubjectRecord) throw new Error('this agent cannot keep friends');
    const me = person.toLowerCase();
    await migrateLegacyOffers(deps, me); // an old record for this person moves before it is read as "already offered"
    const existing = await readOffer(deps, me, friend);
    if (existing?.status === 'standing') {
      // Telling them again is harmless and heals a request that never reached them.
      const told = mayBePerson(kind) && deps.deliverFriendRequest && existing.grantDigest
        ? await deps.deliverFriendRequest({ sender: person, recipient: friend, grantDigest: existing.grantDigest }).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
        : undefined;
      if (mayBePerson(kind)) await requestBack(deps, person, friend);
      return { added: false, friend, type: existing.friendType, alreadyOffered: true, grantDigest: existing.grantDigest, ...(told ? { requested: told } : {}), note: 'you have already offered this person friendship — nothing changed' };
    }
    // the grant, signed by the person (folded into the mandate's prompt when the Home approved it in the same batch)
    const digest = intentDigest(ctx.intent);
    const ts = wire.caveats.find((c) => c.enforcer.toLowerCase() === deps.enforcers.timestamp.toLowerCase());
    if (!ts) throw new Error('the mandate carries no timestamp caveat');
    const { grant, digest: grantDigest, salt, validUntil } = friendGrantFor(deps, person, friend, { intentDigest: digest, validAfter: Number(decodeTimestampTerms(ts.terms as Hex).validAfter) }, stepRef);
    let signed: { signature: string } | undefined = signatureFor(ctx.supplied as readonly SuppliedInputV1[] | undefined, stepRef, grantDigest);
    // ONE PROMPT: the person's account answers for the 0x03 approved-hash sentinel; the chain is asked, never a cache.
    if (!signed && deps.readContract) {
      const ok = await deps.readContract({ address: person, abi: ERC1271_ABI, functionName: 'isValidSignature', args: [grantDigest, '0x03'] }).catch(() => null);
      if (ok === '0x1626ba7e') signed = { signature: '0x03' };
    }
    if (!signed) {
      throw new InputRequired({ kind: 'signature', stepRef, toolId, prompt: `Sign your friendship grant to ${friend} — it lets them see your profile.`, digest: grantDigest, signer: person, payload: { friend, type, scope: FRIEND_GRANT_SCOPE, validUntil } });
    }
    const delegation: DelegationWireV1 = { ...grant, salt: salt.toString(), signature: signed.signature as Hex };
    const record: FriendOfferRecordV1 = { type: 'ap.friend-offer.v1', offeredTo: friend, friendType: type, delegation, grantDigest, status: 'standing', offeredAt: Date.now() };
    const wrote = await deps.writeSubjectRecord(me, friendOfferRecordType(friend), record, ctx.operationId);
    if (!wrote.ok) throw new Error(/record_scope_denied|scope/i.test(wrote.error ?? '')
      ? 'your storage permission predates friends — turn your storage on again (one signature; nothing else changes), then add them again'
      : `your friendship offer could not be recorded: ${wrote.error ?? 'write refused'}`);
    const theirs = await readOffer(deps, friend, me);
    const nowFriends = theirs?.status === 'standing' || (await whoOfferedMe(deps, me)).has(friend);
    // WHAT FOLLOWS (spec 360): they are TOLD — a message carrying the reference the Home renders as "accept", and the
    // request itself in their vault (delivered whether or not the message could be: a new friend has no messaging wire).
    let told: { ok: boolean; error?: string } = { ok: false, error: 'they were not messaged — a message is sent as you, which needs your session' };
    if (session && deps.sendDirectMessage) {
      told = await deps.sendDirectMessage({ sender: person, recipient: friend, bodyText: nowFriends ? `I've added you back — we're friends now.` : `I'd like to be friends. Accept and we're friends.`, session, contextRefs: [{ kind: 'friend-request', id: me, label: nowFriends ? 'Friends' : 'Accept' }] }).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    }
    const requested = mayBePerson(kind) && deps.deliverFriendRequest
      ? await deps.deliverFriendRequest({ sender: person, recipient: friend, grantDigest }).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
      : undefined;
    if (mayBePerson(kind)) await requestBack(deps, person, friend);
    return { added: true, friend, type, grantDigest, delegation, told, ...(requested ? { requested } : {}), friends: nowFriends, note: nowFriends ? 'you are friends now — they had already offered theirs' : 'friend request sent; you are friends once they accept' };
  };
}

const REVOKE_BY_OWNER_ABI = [{ type: 'function', name: 'revokeDelegationByOwner', stateMutability: 'nonpayable', inputs: [{ name: 'delegation', type: 'tuple', components: [{ name: 'delegator', type: 'address' }, { name: 'delegate', type: 'address' }, { name: 'authority', type: 'bytes32' }, { name: 'caveats', type: 'tuple[]', components: [{ name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }, { name: 'args', type: 'bytes' }] }, { name: 'salt', type: 'uint256' }, { name: 'signature', type: 'bytes' }] }], outputs: [] }] as const;
const REDEEM_ABI = [{ type: 'function', name: 'redeemDelegation', stateMutability: 'nonpayable', inputs: [{ name: 'delegations', type: 'tuple[]', components: [{ name: 'delegator', type: 'address' }, { name: 'delegate', type: 'address' }, { name: 'authority', type: 'bytes32' }, { name: 'caveats', type: 'tuple[]', components: [{ name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }, { name: 'args', type: 'bytes' }] }, { name: 'salt', type: 'uint256' }, { name: 'signature', type: 'bytes' }] }, { name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }], outputs: [] }] as const;
const EXECUTE_ABI = [{ type: 'function', name: 'execute', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }], outputs: [] }] as const;

/** `person.friend.remove` — withdraw my offer: revoke my grant on chain (my SA, under my mandate) and mark it withdrawn. */
export function friendRemoveInvoker(deps: FriendDeps, presented: MandatePresentation, person: Address | undefined): ToolInvoker {
  return async (_toolId, args, ctx) => {
    if (!person) throw new Error('friends are a person\'s own — there is no person on this run');
    const wire = presented.wire as Delegation;
    if (wire.delegator.toLowerCase() !== person.toLowerCase()) throw new Error(`a friend is removed under your own mandate (${person}); the mandate is from ${wire.delegator}`);
    const friend = friendArg(args) as Address;
    if (!/^0x[0-9a-f]{40}$/.test(friend)) throw new Error(`that did not resolve to a person (${String(args.friend ?? args.contact ?? '')})`);
    if (!deps.readSubjectRecord || !deps.writeSubjectRecord) throw new Error('this agent cannot keep friends');
    const me = person.toLowerCase();
    await migrateLegacyOffers(deps, me);
    const rec = await readOffer(deps, me, friend);
    if (rec?.status !== 'standing') return { removed: false, friend, note: 'you have no friendship offer to this person — nothing to remove' };
    if (!deps.executeAsServiceSa) throw new Error('this agent cannot revoke on chain here');
    const g = rec.delegation;
    const inner = encodeFunctionData({ abi: REVOKE_BY_OWNER_ABI, functionName: 'revokeDelegationByOwner', args: [{ delegator: g.delegator as Address, delegate: g.delegate as Address, authority: g.authority as Hex, caveats: g.caveats.map((c) => ({ enforcer: c.enforcer as Address, terms: c.terms as Hex, args: (c.args ?? '0x') as Hex })), salt: BigInt(g.salt), signature: g.signature as Hex }] });
    const dm = deps.env.DELEGATION_MANAGER as Address;
    const serviceSa = (deps.env.HARNESS_AGENT_SA ?? '').toLowerCase() as Address;
    const digest = intentDigest(ctx.intent);
    const stepRef = ctx.step.idempotencyKey ?? ctx.step.id ?? `s${ctx.index}`; // spec 410 §3 — the nonce's logical identity
    const caveats = wire.caveats.map((c) => (c.enforcer.toLowerCase() === deps.enforcers.digestBinding.toLowerCase()
      ? { enforcer: c.enforcer, terms: c.terms as Hex, args: deps.digestBindingArgsFor(c as Caveat, deps.stepDigests(args, digest, stepRef, ctx.planDigest as Hex | undefined, contractsGenerationOf({ contractsGeneration: deps.env.CONTRACTS_GENERATION }))) }
      : { enforcer: c.enforcer, terms: c.terms as Hex, args: (c.args ?? '0x') as Hex }));
    const redeem = encodeFunctionData({ abi: REDEEM_ABI, functionName: 'redeemDelegation', args: [[{ delegator: wire.delegator, delegate: wire.delegate, authority: wire.authority as Hex, caveats, salt: wire.salt, signature: wire.signature as Hex }], dm, 0n, inner] });
    const callData = encodeFunctionData({ abi: EXECUTE_ABI, functionName: 'execute', args: [dm, 0n, redeem] });
    const { txHash } = await deps.executeAsServiceSa(serviceSa, callData);
    const withdrawnAt = Date.now();
    const next: FriendOfferRecordV1 = { ...rec, status: 'withdrawn', withdrawnAt };
    let wrote = await deps.writeSubjectRecord(me, friendOfferRecordType(friend), next, ctx.operationId);
    // The grant is already revoked; the RECORD must say so wherever the offer is still kept. An offer that could not move
    // (a grant that predates `vault:friend:*`) is still the legacy record — marked withdrawn THERE, and said.
    if (!wrote.ok) {
      const legacy = (await deps.readSubjectRecord(me, legacyOfferRecordType(friend)).catch(() => null)) as LegacyOfferRecord | null;
      if (legacy?.type === 'ap.contact.v1') {
        const kept = await deps.writeSubjectRecord(me, legacyOfferRecordType(friend), { ...legacy, status: 'removed', removedAt: withdrawnAt }, ctx.operationId);
        if (kept.ok) wrote = { ok: true, error: 'recorded on your older friend record; turn your storage on again to move it' };
      }
    }
    return { removed: true, friend, type: rec.friendType, grantDigest: rec.grantDigest, txHash, recorded: wrote.ok, ...(wrote.ok ? (wrote.error ? { warning: wrote.error } : {}) : { error: wrote.error }), note: 'your grant is revoked on chain — they can no longer see your profile, and they see the friendship has ended' };
  };
}
