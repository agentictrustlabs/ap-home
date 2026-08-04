// The MESSAGING SESSION WIRE — spec 341 Wave 4b (ADR-0059).
//
// WHAT THIS REPLACES. The Home reaches a recipient's `InteractionsDO` over a shared-secret HMAC bridge.
// Possession of that secret is the authorization, which is the pattern ADR-0041 names one level down.
//
// WHY A WIRE AND NOT A BROWSER KEY. Spec 341 §5.1 concluded a browser-held session key was forced,
// because the Home may hold no session private key (`demo-sso-next/CLAUDE.md`). §5.1a corrects it: this
// repo already ships the general answer in `demo-a2a/src/session-wire.ts` — "how an agent signs as an
// identity whose key it does not hold". A ceremony mints a NARROW delegation whose delegate is a KMS
// session key, signed by the identity's own custody credential. No raw key rests at the Home, and the
// KMS key signs each digest on demand. The rule is kept without a browser doing per-message work.
//
// SHAPE THE RECIPIENT GATE ENFORCES, so this must match it exactly:
//   · exactly one delegator — the person, verified ERC-1271 against their SA;
//   · delegate — the KMS session key that will sign each message;
//   · `allowedMethods` — named selectors, NEVER `A2A_ANY_SKILL`;
//   · `allowedTargets` — pinned; an array, so one wire covers a set of counterparties;
//   · a live timestamp window;
//   · unrevoked on-chain, so a custodian's revocation kills it at every gate immediately.
//
// NOT A CREDENTIAL STORE. The wire is a delegation, not a key. Holding it lets the runtime ASK the KMS
// key to sign for exactly these methods against exactly these targets until it expires; it confers
// nothing else, and the authority re-check still runs at the moment of acting (ADR-0041).

import {
  buildCaveat,
  encodeAllowedMethodsTerms,
  encodeAllowedTargetsTerms,
  encodeTimestampTerms,
  hashDelegation,
  ROOT_AUTHORITY,
  type Caveat,
  type Delegation,
} from '@agenticprimitives/delegation';
import { skillSelector } from '@agenticprimitives/a2a';
import type { Address } from '@agenticprimitives/types';
import { CHAIN_ID, CONTRACTS } from './chain';
import type { SignHash } from '../home/resolution';

/**
 * The messaging skills a person's wire may authorize.
 *
 * Enumerated, never a wildcard: `checkSessionWireShape` rejects `A2A_ANY_SKILL` outright, and a wire
 * that could invoke every skill on a recipient would be a standing general-purpose authority — the
 * thing the HMAC secret already was.
 */
export const MESSAGING_WIRE_SKILLS = [
  'messaging.deliver',
  'interactions.respond',
  'interactions.deliverCredential',
] as const;

/** Default lifetime. Long enough to span a working session, short enough that expiry is a real bound
 *  rather than a formality — spec 341 §5.1's "session length, lengthen only if it proves annoying". */
export const MESSAGING_WIRE_VALIDITY_SECONDS = 12 * 60 * 60;

export interface MessagingWireInput {
  /** The person the wire speaks for. Delegator, and the account the recipient gate verifies against. */
  personSA: Address;
  /** The KMS session key that will sign each message digest. NOT held by the Home. */
  sessionKey: Address;
  /**
   * The counterparties this wire may deliver to. An ARRAY because `allowedTargets` encodes one, so a
   * single ceremony covers every contact a person already talks to — which is what makes "one prompt
   * per NEW counterparty, never per message" achievable (§5.1).
   */
  recipients: readonly Address[];
  /** Which messaging skills to authorize. Defaults to all three delivery skills. */
  skills?: readonly string[];
  /** The person's custody credential — passkey / wallet / KMS, routed by `signHashFor(via)`. */
  signHash: SignHash;
  validitySeconds?: number;
  /** Injected for deterministic tests. */
  now?: () => number;
  salt?: bigint;
}

function randomSalt(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let salt = 0n;
  for (const b of bytes) salt = (salt << 8n) | BigInt(b);
  return salt;
}

/**
 * Mint + sign a person's messaging wire.
 *
 * Fail-closed on the three shapes the recipient gate would reject anyway — caught here, where the error
 * names the cause, rather than one hop away as an opaque signature failure:
 *  - no recipients: `encodeAllowedTargetsTerms` throws on an empty array, and a wire targeting nobody
 *    authorizes nothing;
 *  - no skills, or a wildcard: a wire that names every skill is the standing authority this replaces;
 *  - an unsigned result: an unsigned delegation is not a weaker wire, it is not a wire.
 */
export async function issueMessagingWire(input: MessagingWireInput): Promise<Delegation> {
  const skills = [...new Set((input.skills ?? MESSAGING_WIRE_SKILLS).map((s) => s.trim()).filter(Boolean))];
  if (skills.length === 0) throw new Error('a messaging wire must name at least one skill');
  if (skills.some((s) => s === '*' || s === '0x00000000')) {
    throw new Error('a messaging wire must NAME its skills — the any-skill sentinel is refused by the gate');
  }
  const recipients = [...new Set(input.recipients.map((r) => r.toLowerCase() as Address))];
  if (recipients.length === 0) throw new Error('a messaging wire must name at least one recipient');

  const nowSec = Math.floor((input.now?.() ?? Date.now()) / 1000);
  const validUntil = nowSec + (input.validitySeconds ?? MESSAGING_WIRE_VALIDITY_SECONDS);

  const caveats: Caveat[] = [
    buildCaveat(CONTRACTS.timestampEnforcer, encodeTimestampTerms(0, validUntil)),
    // The agents this wire may CALL — the A2A reading of allowedTargets, opposite to a
    // "acting for" grant. A wire minted for Bob and Carol cannot deliver to Dave.
    buildCaveat(CONTRACTS.allowedTargetsEnforcer, encodeAllowedTargetsTerms(recipients)),
    buildCaveat(CONTRACTS.allowedMethodsEnforcer, encodeAllowedMethodsTerms(skills.map((s) => skillSelector(s)))),
  ];

  const d: Delegation = {
    delegator: input.personSA,
    delegate: input.sessionKey,
    authority: ROOT_AUTHORITY,
    caveats,
    salt: input.salt ?? randomSalt(),
    signature: '0x',
  };
  const digest = hashDelegation(d, CHAIN_ID, CONTRACTS.delegationManager);
  // The PERSON's custody credential authorizes their agent to speak for them. This is the one signature
  // a human makes, and it happens inside the connect ceremony that already runs.
  d.signature = await input.signHash(digest);
  if (!d.signature || d.signature === '0x') throw new Error('messaging wire was not signed');
  return d;
}
