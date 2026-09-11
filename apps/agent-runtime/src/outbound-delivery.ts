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
// THE SENDER IS AN AGENT, NEVER A KEY. An earlier version made `message.sender` the KMS session key and
// signed plainly. It failed at every recipient, because the gate verifies the sender's signature with
// `r.valid && r.deployed` and a bare key has no contract (`eth_getCode` returns `0x`). That check is the
// design, not an obstacle: under ADR-0010 an agent IS its Smart Agent address, so a message authored by
// a key would be authored by nobody. The e2e found this; no unit test could, because both sides of the
// seam agreed with each other.
//
// So the sender is the PERSON's SA, and the signature is SESSION-WRAPPED (`0x51`) — the shipped
// mechanism for "how an agent signs as an identity whose key it does not hold" (`session-wire.ts`). The
// recipient unwraps it and checks, per message: the wire's delegator IS the claimed sender, the raw
// ECDSA recovers to the wire's delegate, the wire ERC-1271-verifies against the sender, and the wire is
// unrevoked on-chain.
//
// TWO DELEGATIONS, ANSWERING TWO QUESTIONS.
//   · the TRANSPORT grant (person → person, self)  — may this agent invoke this skill on that recipient?
//     It is what `authorizeA2aMessage` reads, and its delegator is what the receiving skill checks
//     `envelope.from` against (NEW-H1). Self-delegation confers nothing new; it CARRIES THE CAVEATS.
//   · the SIGNING wire (person → session key)      — may this key produce signatures that count as the
//     person's? It never travels as `delegation`; it travels INSIDE the signature.
//
// NEITHER IS MINTED HERE. Minting needs the person's custody credential, which this worker does not have
// and must not have. Both arrive already signed; this module can only spend them, inside the caveats
// they carry — named skills, pinned targets, a live window, revocable on-chain at any moment.

import { hashA2aMessage, type A2aMessage, type A2aTransport, A2aWireAdapter } from '@agenticprimitives/a2a';
import { decodeAllowedTargetsTerms } from '@agenticprimitives/delegation';
import { SESSION_WRAPPED_SIG_TYPE } from '@agenticprimitives/a2a';
import type { Address, Hex } from '@agenticprimitives/types';
import { keccak256, toBytes } from 'viem';

/** What a delegation's `allowedTargets` caveat says, or why it says nothing. */
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

/**
 * A payload for a skill that is NOT a message.
 *
 * `org.apply` was the first (spec 341 §5.5a): an application rides the same authorized rail as a message
 * but is not an envelope, so there is nothing to build and nothing to record in the sender's own inbox.
 * The org's gate admits it and the org's grant writes it.
 *
 * IT NEEDS ITS OWN TYPE because the envelope checks below cannot run on it — and the first version of this
 * module did not have one, so the `org.apply` call site passed `payload: {...} as never` to get past the
 * compiler, and `input.payload.envelope.from` threw `Cannot read properties of undefined (reading 'from')`
 * at the org. The cast is what let a shape mismatch reach production looking like a rejection by the
 * organization. A union is the honest description: some payloads are envelopes and some are not.
 */
export type NonEnvelopePayload = Record<string, unknown> & { envelope?: undefined };

export type DeliveryPayload = MessagingDeliverPayload | NonEnvelopePayload;

/** The a2a runtime's body-integrity hash — stable JSON keccak. MUST equal `a2a-task-do.ts`'s `hashBody`,
 *  because the runtime rejects the task when `hashBody(input) !== message.bodyHash`. */
export const hashDeliveryBody = (data: unknown): Hex => keccak256(toBytes(JSON.stringify(data ?? null)));

export interface OutboundDeliveryInput {
  /** The PERSON. The A2A sender, the transport grant's delegator+delegate, and `envelope.from`. */
  personSA: Address;
  /** The recipient AGENT being called. Must be inside the transport grant's `allowedTargets`. */
  recipientSA: Address;
  /** The TRANSPORT grant (person → person), already signed. Travels as `delegation`; spent, never minted. */
  transportGrant: unknown;
  /**
   * Produces the SESSION-WRAPPED signature over a digest: the session key signs, and the signing wire
   * that authorizes it is wrapped in alongside. Injected rather than assembled here so this module
   * never touches a key or a wire it does not need to see.
   */
  signAsPerson: (digest: Hex) => Promise<Hex>;
  /** The skill payload. When it carries an `envelope`, `envelope.from` must be the person and the
   *  receiving skill re-checks it. A non-envelope payload (e.g. `org.apply`) is bound by the transport
   *  grant's `allowedTargets` + `allowedMethods` and by the receiving skill's own addressee check. */
  payload: DeliveryPayload;
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
  //
  // ONLY WHEN THERE IS AN ENVELOPE. A non-envelope payload is not exempt from authorization — it is bound
  // by the transport grant's `allowedTargets`/`allowedMethods`, re-verified on-chain at the recipient's
  // gate, and re-checked against the addressee by the receiving skill. What it is exempt from is a check
  // on a field it does not have.
  const addrOf = (caip: string): string => (caip.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase();
  const envelope = (input.payload as Partial<MessagingDeliverPayload>).envelope;
  if (envelope) {
    if (addrOf(envelope.from) !== input.personSA.toLowerCase()) {
      throw new Error('envelope.from must be the person this wire speaks for');
    }
    if (!envelope.to.some((t) => addrOf(t) === input.recipientSA.toLowerCase())) {
      throw new Error('envelope is not addressed to the recipient being called');
    }
  }

  const unsigned = {
    messageId,
    // THE PERSON'S AGENT. The gate requires delegate === requester === message.sender, which is why the
    // transport grant is a self-delegation, and why a key cannot appear here: the recipient verifies
    // this address with a check that demands deployed code.
    sender: input.personSA,
    skill,
    bodyHash: hashDeliveryBody(input.payload),
    createdAt: Math.floor(nowMs / 1000),
  };
  const signature = await input.signAsPerson(hashA2aMessage(unsigned));
  if (!signature || signature === '0x') {
    throw new Error('outbound delivery message was not signed');
  }
  if (!signature.startsWith(SESSION_WRAPPED_SIG_TYPE)) {
    // A PLAIN signature here is the failure that already happened once. It would be produced by the
    // right key over the right digest and still be refused at every recipient, because nothing in it
    // says which identity the key is allowed to speak for.
    throw new Error('outbound delivery must be session-wrapped — a plain signature cannot speak for an agent');
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
    // Spent as-is, and NOT re-serialized into a `Delegation`: the grant's `salt` is a decimal STRING on
    // the wire and a bigint in the type, and `JSON.stringify` throws on bigint. Every other sender here
    // passes the received shape straight through for the same reason.
    delegation: input.transportGrant as never,
    requester: input.personSA,
    message,
    input: input.payload,
  });

  return { taskId, state };
}
