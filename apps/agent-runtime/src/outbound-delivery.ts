// OUTBOUND A2A DELIVERY — spec 341 §5.1b.
//
// WHY THIS LIVES HERE AND NOT AT THE HOME. Delivery must be performed by whoever holds the signing key.
// The person's messaging wire delegates to the interactions session key, and that key is a viem account
// over `GCP_KMS_INTERACTIONS_KEY_NAME` INSIDE this worker. The Home has the address and nothing more —
// deliberately: the route that once let a caller obtain signatures from a server-held session key was
// deleted as audit finding CRIT-2 ("server-held session key, no principal leaf, forwarded without a
// binding"). Re-adding one to let the Home deliver would recreate that hole to close a different one.
//
// So the topology is: Home --(session auth)--> the sender's OWN agent (here) --(A2A)--> the recipient.
// The Home is the person's control plane asking their agent to act; the agent does the acting, because
// it is the only party that can sign.
//
// TWO IDENTITIES, NEVER COLLAPSED. On the A2A layer the sender is the SESSION KEY — `authorizeA2aMessage`
// requires `delegate === requester === message.sender`, and the wire's delegate is that key. Inside the
// payload, `envelope.from` is the PERSON, and the receiving skill enforces that too: NEW-H1 checks
// `envelope.from === ctx.principal`, which is the wire's DELEGATOR. So the two identities are pinned at
// both ends by different checks — the transport proves who signed, the envelope proves who sent.
//
// THE WIRE IS USED, NEVER MINTED HERE. Minting would need the person's custody credential, which this
// worker does not have and must not have. A wire arrives already signed by the person; this module can
// only spend it, and only within the caveats it carries — named skills, pinned targets, a live window,
// revocable on-chain at any moment.

import { hashA2aMessage, type A2aMessage, type A2aTransport, A2aWireAdapter } from '@agenticprimitives/a2a';
import { decodeAllowedTargetsTerms } from '@agenticprimitives/delegation';
import type { Address, Hex } from '@agenticprimitives/types';
import { keccak256, toBytes } from 'viem';

/** What a wire's `allowedTargets` caveat says, or why it says nothing. */
export type WireTargets =
  | { ok: true; targets: Address[] }
  | { ok: false; reason: 'absent' | 'undecodable' };

/**
 * Read the counterparties a wire authorizes.
 *
 * THE THREE OUTCOMES ARE NOT THE SAME and collapsing them is the bug this shape prevents. "No caveat"
 * means the wire is unbounded — which the gate refuses anyway, so treating it as an empty target list
 * would report "you have not approved anyone" for a wire that is actually malformed. "Undecodable"
 * means the wire is damaged and must be re-signed. Only `ok` with a list is an answer about contacts,
 * and it is the one the UI turns into "approve this person".
 *
 * The DECODE is the source of truth, never a list stored beside the wire: a stored list can disagree
 * with the caveat, and the caveat is what the recipient's gate enforces — so the UI would promise
 * sends that fail.
 */
export function wireTargets(
  wire: { caveats?: readonly { enforcer?: string; terms?: string }[] } | undefined,
  allowedTargetsEnforcer: string | undefined,
): WireTargets {
  const enf = (allowedTargetsEnforcer ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(enf)) return { ok: false, reason: 'undecodable' };
  const cav = (wire?.caveats ?? []).find((c) => (c.enforcer ?? '').toLowerCase() === enf);
  if (!cav?.terms) return { ok: false, reason: 'absent' };
  try {
    return { ok: true, targets: decodeAllowedTargetsTerms(cav.terms as Hex).map((a) => a.toLowerCase() as Address) };
  } catch {
    return { ok: false, reason: 'undecodable' };
  }
}

/**
 * The `messaging.*` skill payload, verbatim as `makeDeliverHandler` parses it.
 *
 * `bodyText` TRAVELS. Every other body in this repo moves by vault reference, so the exception is worth
 * stating: the recipient's own DO is what writes the body into the recipient's vault, and it cannot read
 * a reference into the SENDER's vault — the sender holds no grant that would let it. The body therefore
 * crosses inside the authorized, signed, single-use message, and `bodyHash` on the envelope is what the
 * skill re-verifies before admitting it.
 */
export interface MessagingDeliverPayload {
  envelope: Record<string, unknown> & { id: string; from: string; to: string[] };
  bodyText: string;
  conversation?: unknown;
}

/** The a2a runtime's body-integrity hash — stable JSON keccak. MUST equal `a2a-task-do.ts`'s `hashBody`,
 *  because the runtime rejects the task when `hashBody(input) !== message.bodyHash`. */
export const hashDeliveryBody = (data: unknown): Hex => keccak256(toBytes(JSON.stringify(data ?? null)));

export interface OutboundDeliveryInput {
  /** The PERSON the message is from — the wire's delegator, and `envelope.from`. */
  personSA: Address;
  /** The recipient AGENT being called. Must be inside the wire's `allowedTargets`. */
  recipientSA: Address;
  /** The person's messaging wire, already signed by their custody credential. Spent, never minted. */
  wire: unknown;
  /** The wire's delegate — this worker's interactions session key. Signs the message. */
  sessionKey: Address;
  /** Signs a digest with the session key (the KMS-backed viem account). */
  signWithSessionKey: (digest: Hex) => Promise<Hex>;
  /** The skill payload. `envelope.from` must be the person; the receiving skill re-checks it. */
  payload: MessagingDeliverPayload;
  /** Which messaging skill. Must be named in the wire's `allowedMethods`. */
  skill?: string;
  transport: A2aTransport;
  nowMs?: number;
}

export interface OutboundDeliveryResult {
  taskId: Hex;
  state: string;
}

const randomMessageId = (): Hex => {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}` as Hex;
};

/**
 * Deliver one message to one recipient, signing as the session key under the person's wire.
 *
 * Fail-closed: an unsigned message throws here, and a recipient rejection propagates as an RPC error.
 * A caller MUST NOT catch either and fall back to a shared-secret write — one mechanism per operation
 * (ADR-0013), and the fallback would restore precisely the authority this replaces.
 */
export async function deliverOutbound(input: OutboundDeliveryInput): Promise<OutboundDeliveryResult> {
  const skill = input.skill ?? 'messaging.deliver';
  const nowMs = input.nowMs ?? Date.now();
  const messageId = randomMessageId();

  // The envelope must already name the person. Checking here means a mis-built envelope fails before a
  // signature is spent and a message id is burned, rather than at the recipient's NEW-H1 gate.
  const addrOf = (caip: string): string => (caip.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase();
  if (addrOf(input.payload.envelope.from) !== input.personSA.toLowerCase()) {
    throw new Error('envelope.from must be the person this wire speaks for');
  }
  if (!input.payload.envelope.to.some((t) => addrOf(t) === input.recipientSA.toLowerCase())) {
    throw new Error('envelope is not addressed to the recipient being called');
  }

  const unsigned = {
    messageId,
    // The SESSION KEY, not the person: the gate requires delegate === requester === message.sender, and
    // the wire's delegate is this key. The person is named on the envelope inside, which is where
    // "who sent this" belongs.
    sender: input.sessionKey,
    skill,
    bodyHash: hashDeliveryBody(input.payload),
    createdAt: Math.floor(nowMs / 1000),
  };
  const signature = await input.signWithSessionKey(hashA2aMessage(unsigned));
  if (!signature || signature === '0x') {
    throw new Error('outbound delivery message was not signed by the session key');
  }

  const message: A2aMessage = {
    ...unsigned,
    // A PLACEHOLDER, and every other sender in this Worker passes the same one: the runtime writes the
    // input into the RECIPIENT's vault and overwrites this ref with where it actually landed. What binds
    // the body is `bodyHash`, which is signed; this field is not.
    bodyRef: { owner: input.recipientSA, recordType: 'pending' },
    signature,
  };

  const client = new A2aWireAdapter(input.transport);
  const { taskId, state } = await client.submitTask(input.recipientSA, {
    // Spent as-is, and NOT re-serialized into a `Delegation`: the wire's `salt` is a decimal STRING on
    // the wire and a bigint in the type, and `JSON.stringify` throws on bigint. Every other sender here
    // passes the received shape straight through for the same reason.
    delegation: input.wire as never,
    requester: input.sessionKey,
    message,
    input: input.payload,
  });

  return { taskId, state };
}
