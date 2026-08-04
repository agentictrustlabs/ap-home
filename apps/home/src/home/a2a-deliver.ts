// Delivering a message over A2A — spec 341 Wave 4 (ADR-0059).
//
// This is the Home acting as an ORDINARY A2A CLIENT of the recipient's agent. Not a privileged writer
// with a shared secret; a peer that mints a scoped grant, signs a message, and calls `message/send`.
// The recipient's `authorizeA2aMessage` applies the same gate it applies to an external agent, which
// is spec 341's success criterion made executable rather than aspirational.
//
// WHAT IS SIGNED, AND WHY TWICE. Two distinct signatures, over two distinct things:
//   · the DELEGATION digest — "I authorize this delegate to invoke this skill on this agent, until T"
//   · the MESSAGE digest — "this specific message, with this body hash, is from me, now"
// Neither substitutes for the other. A grant without a signed message would let anyone holding the
// grant send anything; a signed message without a grant proves origin but authorizes nothing. The
// recipient checks both, and this module refuses to produce one without the other.
//
// BODIES ARE NOT SENT HERE. `bodyRef` + `bodyHash` travel; the bytes live in the vault (ADR-0055). The
// recipient reads them under its own authority and hash-verifies. A delivery that inlined the body
// would make the transport a content store, which is the thing the vault exists to prevent.

import { A2aWireAdapter, hashA2aMessage, type A2aMessage, type A2aTransport } from '@agenticprimitives/a2a';
import type { Address, Hex } from '@agenticprimitives/types';
import type { VaultRef as A2aVaultRef } from '@agenticprimitives/a2a';
import { mintDeliveryGrant, MESSAGING_DELIVER_SKILL } from './delivery-grant';

export interface A2aDeliverInput {
  /** The sending person's SA — delegator, message sender, and the account both signatures verify against. */
  senderSA: Address;
  /** The recipient AGENT. Both the grant's sole allowed target and the RPC destination. */
  recipientSA: Address;
  /**
   * Vault pointer + digest of the body. The bytes stay in the vault.
   *
   * This is A2A's `VaultRef` — `{ owner, recordType }` — and NOT `@agenticprimitives/vault`'s
   * `VaultRef`, which is `{ resource, classification, updatedAt }`. Two different shapes wear the same
   * name in two packages, and they are not interchangeable: A2A names WHOSE vault and WHICH record so
   * the recipient can fetch under its own authority, while the vault type describes a record already
   * resolved. Typed against a2a's here so the wrong one is a compile error rather than a runtime
   * "record not found" at the recipient. (Worth a rename in one of the two packages; noted, not done.)
   */
  bodyRef: A2aVaultRef;
  bodyHash: Hex;
  /** The message id — the fabric envelope's id, so the A2A task and the envelope are correlatable. */
  messageId: Hex;
  /** One of the three delivery skills; defaults to `messaging.deliver`. */
  skill?: string;
  /** Signs a digest with the sender's credential. Used for BOTH signatures — same credential, two
   *  distinct digests, never the same bytes twice. */
  sign: (digest: Hex) => Promise<Hex>;
  /**
   * A PRE-EXISTING messaging wire to deliver under (spec 341 §5.1a), instead of minting a grant here.
   *
   * This is the production path. The wire's delegator is the PERSON and its delegate is a KMS session
   * key, signed once by the person's custody credential at connect — so the Home never needs the
   * person's credential at send time, which is what made the per-send mint impossible server-side.
   *
   * When supplied, `sign` is the SESSION KEY's signer and `requester` MUST be the wire's delegate:
   * `authorizeA2aMessage` requires delegate === requester === message.sender, and with a wire all
   * three are the session key. The fabric envelope's `from` still names the person — the A2A layer
   * carries who SIGNED, the envelope carries who SENT, and conflating them is what the wire exists to
   * avoid.
   */
  wire?: { delegation: unknown; delegate: Address };
  /**
   * How to reach agents. Injected so this module holds no hostnames (ADR-0021) and so tests need no
   * network.
   *
   * NORMATIVE FOR IMPLEMENTERS: `Delegation.salt` is a `bigint`, and `JSON.stringify` THROWS on
   * bigint. A fetch transport MUST serialize with a bigint-aware replacer (or convert via the
   * `DelegationWire` form, where salt travels as a decimal string) — otherwise every delivery fails at
   * serialization, before any network call, with an error that names neither A2A nor delegation. Found
   * by a test that stringified the outgoing request; worth stating here because the failure is
   * mechanical and the message is unhelpful.
   */
  transport: A2aTransport;
  nowMs?: number;
}

export interface A2aDeliverResult {
  taskId: Hex;
  state: string;
  /** The grant digest, for the audit row. The delivery is attributable to a specific, revocable grant
   *  rather than to "the Home did it". */
  grantDigest: Hex;
}

/**
 * Deliver one message to one recipient over A2A.
 *
 * Fail-closed throughout: an unsigned grant throws at the mint, an unsigned message throws here, and a
 * rejected task surfaces as a thrown RPC error rather than a silent non-delivery. The caller MUST NOT
 * treat a failure as "fall back to the bridge" — one mechanism per operation (ADR-0013), and a
 * fallback would restore exactly the authority this replaces.
 */
export async function deliverOverA2a(input: A2aDeliverInput): Promise<A2aDeliverResult> {
  const skill = input.skill ?? MESSAGING_DELIVER_SKILL;
  const nowMs = input.nowMs ?? Date.now();

  // 1. The authority. A supplied wire is used AS IS — re-minting would need the person's credential,
  // which the Home does not hold, and is the whole reason the wire exists.
  const grant = input.wire
    ? { delegation: input.wire.delegation as never, digest: '0x' as Hex, skill }
    : await mintDeliveryGrant({
    senderSA: input.senderSA,
    // The sender presents its own grant. `authorizeA2aMessage` requires
    // delegate === requester === message.sender, so these three are the same account by construction
    // rather than by convention — a mismatch is a rejection at the recipient, not a silent downgrade.
    delegate: input.senderSA,
    recipientAgentSA: input.recipientSA,
    skill,
    sign: input.sign,
    nowSec: Math.floor(nowMs / 1000),
      });

  // 2. The message: bound to the body hash and the clock, signed separately from the grant.
  // With a wire, the SIGNER is the session key (the wire's delegate), not the person — the gate
  // requires delegate === requester === message.sender.
  const signer = input.wire?.delegate ?? input.senderSA;
  const unsigned = {
    messageId: input.messageId,
    sender: signer,
    skill,
    bodyHash: input.bodyHash,
    createdAt: Math.floor(nowMs / 1000),
  };
  const messageSignature = await input.sign(hashA2aMessage(unsigned));
  if (!messageSignature || messageSignature === '0x') {
    throw new Error('a2a delivery message was not signed');
  }
  const message: A2aMessage = {
    ...unsigned,
    bodyRef: input.bodyRef,
    signature: messageSignature,
  };

  // 3. The ordinary call. Same method, same shape an external peer would use.
  const client = new A2aWireAdapter(input.transport);
  const { taskId, state } = await client.submitTask(input.recipientSA, {
    message,
    delegation: grant.delegation,
    requester: signer,
    input: { messageId: input.messageId, bodyRef: input.bodyRef, bodyHash: input.bodyHash },
  });

  return { taskId, state, grantDigest: grant.digest };
}
