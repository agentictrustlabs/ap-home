// The A2A DELIVERY GRANT — spec 341 Wave 4 (ADR-0059).
//
// WHAT THIS REPLACES. Today the Home writes a message into the RECIPIENT's inbox by reaching their
// `InteractionsDO` over a shared-secret HMAC bridge. Possession of that secret is what authorizes the
// write — which is the pattern ADR-0041 names, one level down: a bearer credential standing in for an
// SA-bound, signature-verified, on-chain-revocable delegation.
//
// WHAT REPLACES IT. The sender mints a delegation scoped to EXACTLY the recipient agent and EXACTLY
// the delivery skill, signs it with their own credential, and presents it on an ordinary A2A
// `message/send`. The recipient's `authorizeA2aMessage` decodes the caveats, verifies the signature
// against the sender's SA, and checks on-chain revocation — the same gate an external peer passes.
// That is the whole point of spec 341: the Home stops being privileged and becomes a client.
//
// THE TARGET IS THE AGENT BEING CALLED. This is the one thing to get right, and it is the opposite of
// the reading used by `discovery-authority.ts`, where `allowedTargets` names the agent being acted FOR.
// Here `authorizeA2aMessage` requires the grant's `allowedTargets` to name the RECEIVING agent, so a
// grant minted for Bob cannot be replayed against Carol. `buildA2aGrantCaveats` owns that encoding —
// this module does not hand-roll caveats, so the two cannot drift.
//
// NOT AUTHORITY TO READ. A delivery grant authorizes ONE skill on ONE agent for a bounded window. It
// does not let the holder read the recipient's inbox, and it is not a standing relationship — a fresh
// grant is minted per send, so revocation and expiry are meaningful rather than nominal.

import { buildA2aGrantCaveats } from '@agenticprimitives/a2a';
import { hashDelegation, ROOT_AUTHORITY, type Delegation } from '@agenticprimitives/delegation';
import type { Address, Hex } from '@agenticprimitives/types';
import { CHAIN_ID, CONTRACTS } from '../lib/chain';

/** The A2A skill a message delivery invokes on the recipient's agent (spec 309 §7). */
export const MESSAGING_DELIVER_SKILL = 'messaging.deliver';

/** The default validity window. Deliberately SHORT: the grant authorizes one delivery that is about to
 *  happen, so a long window buys nothing and widens the replay surface. Callers may narrow it. */
export const DELIVERY_GRANT_WINDOW_SEC = 300;

export interface DeliveryGrantInput {
  /** The sending person's SA — the delegator, and the account the recipient verifies against. */
  senderSA: Address;
  /**
   * WHO may present the grant. Usually the sender's own SA (the Home signs as the person), but a
   * session key works too — `authorizeA2aMessage` requires `delegate === requester === message.sender`,
   * so whatever is named here is what must make the call.
   */
  delegate: Address;
  /** The recipient AGENT being called. Becomes the sole `allowedTargets` entry. */
  recipientAgentSA: Address;
  /** Which skill. Defaults to `messaging.deliver`; `interactions.respond` and
   *  `interactions.deliverCredential` are the other two delivery skills. */
  skill?: string;
  /** Signs the delegation digest with the sender's credential (passkey / KMS / session). */
  sign: (digest: Hex) => Promise<Hex>;
  /** Injected for determinism in tests; seconds. */
  nowSec?: number;
  windowSec?: number;
  /** Injected for determinism in tests. */
  salt?: bigint;
}

export interface DeliveryGrant {
  delegation: Delegation;
  /** The digest that was signed — the caller can log or reference it without re-deriving. */
  digest: Hex;
  skill: string;
}

/**
 * Mint + sign a single-delivery A2A grant.
 *
 * Fail-closed on the two mistakes that would silently widen it:
 *  - a self-addressed grant, which authorizes nothing meaningful and usually means the caller passed
 *    the wrong SA;
 *  - a `*` skill, which would authorize EVERY skill on the recipient. `buildA2aGrantCaveats` supports
 *    the wildcard because some callers legitimately need it; a message delivery never does, and
 *    accepting it here would turn a typo into a blanket grant.
 */
export async function mintDeliveryGrant(input: DeliveryGrantInput): Promise<DeliveryGrant> {
  const skill = input.skill ?? MESSAGING_DELIVER_SKILL;
  if (skill === '*') {
    throw new Error('a delivery grant must name ONE skill — "*" would authorize every skill on the recipient');
  }
  if (input.recipientAgentSA.toLowerCase() === input.senderSA.toLowerCase()) {
    throw new Error('a delivery grant to yourself authorizes nothing — check the recipient address');
  }

  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const windowSec = input.windowSec ?? DELIVERY_GRANT_WINDOW_SEC;
  if (windowSec <= 0) throw new Error('the grant window must be positive');

  const unsigned: Delegation = {
    delegator: input.senderSA,
    delegate: input.delegate,
    authority: ROOT_AUTHORITY,
    caveats: buildA2aGrantCaveats({
      // The agent being CALLED — see the header. A grant minted for one recipient cannot be replayed
      // against another, which is what makes per-send minting safe rather than merely tidy.
      recipientAgentSA: input.recipientAgentSA,
      skill,
      enforcers: {
        allowedTargets: CONTRACTS.allowedTargetsEnforcer,
        allowedMethods: CONTRACTS.allowedMethodsEnforcer,
        timestamp: CONTRACTS.timestampEnforcer,
      },
      // `validAfter` is now, not zero: a grant that was valid before it existed is a grant whose
      // window says nothing.
      window: { validAfter: nowSec, validUntil: nowSec + windowSec },
    }),
    salt: input.salt ?? BigInt(`0x${crypto.randomUUID().replace(/-/g, '')}`),
    signature: '0x',
  };

  const digest = hashDelegation(unsigned, CHAIN_ID, CONTRACTS.delegationManager);
  const signature = await input.sign(digest);
  if (!signature || signature === '0x') {
    // An unsigned delegation is not a weaker grant, it is not a grant. The recipient would reject it;
    // failing here keeps the error next to the cause rather than one network hop away.
    throw new Error('delivery grant was not signed');
  }

  return { delegation: { ...unsigned, signature }, digest, skill };
}
