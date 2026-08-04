// SENDING MAIL — the Home page asking the person's OWN agent to send it (spec 341 §5.1b, ADR-0044).
//
// WHAT CHANGED. Sending used to be `POST /connect/inbox { action: 'send' }`: the Home server built the
// envelope and wrote BOTH copies itself — the sender's, and the RECIPIENT's, straight into the
// recipient's vault over a standing grant and a shared HMAC secret. Possession of that secret was the
// authorization, which is the pattern ADR-0041 names one level down.
//
// Now the browser asks the person's own agent, and the agent performs an authorized A2A delivery under
// a wire the person signed. The recipient's gate re-verifies everything — allowedTargets, the skill
// selector, the timestamp window, ERC-1271 against the sender, on-chain `isRevoked`, single-use message
// id — exactly as it would for a stranger. Nothing about being "our own Home" shortens that path.
//
// WHY THE BROWSER AND NOT THE HOME SERVER. Two reasons that point the same way. ADR-0044: a first-party
// UI expresses an intent to an A2A agent rather than driving the substrate through its own backend. And
// spec 341's ratchet: the Home→InteractionsDO private RPC is being removed, so routing a NEW operation
// through it would spend down a budget that exists to reach zero. The browser already reaches
// `/a2a/interactions/<principal>/<op>` for profile and membership writes; this is that same path.
//
// THE HOME NEVER SEES THE BODY. It is not a privacy claim — the body is in the request the browser
// makes to the agent, and the agent stores it in each side's vault. It is simply that the Home has no
// role in the transfer any more.

import type { Address } from '@agenticprimitives/types';
import { ensureCsrfToken, csrfHeaders } from '../csrf';
import { SESSION_KEY } from '../context/session';
import { readSsoCookie } from './sso-cookie';

/** The broker home-session token the InteractionsDO verifies (self-gated ops). */
function homeBearer(): string {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    const t = raw ? (JSON.parse(raw) as { token?: string }).token : undefined;
    if (t) return t;
  } catch { /* fall through */ }
  return readSsoCookie()?.token ?? '';
}

export interface SendMessageInput {
  /** The sender — whose agent performs the send. Their own DO; self-access only. */
  person: Address;
  /**
   * WHO IT IS FOR. Exactly one of these, chosen by the caller — not a chain the agent walks until
   * something answers (ADR-0013):
   *  - `recipient`     an address the caller already holds (a directory listing, an org roster);
   *  - `recipientName` a claimed agent name, resolved on-chain by the agent;
   *  - `conversationId` alone: a REPLY, whose counterparty comes from the sender's OWN descriptor.
   * `conversationId` may also accompany the first two, to continue an existing thread.
   */
  recipient?: Address;
  recipientName?: string;
  conversationId?: string;
  subject?: string;
  bodyText: string;
  title?: string;
  contextRefs?: unknown[];
}

export interface SendMessageResult {
  messageId: string;
  conversationId: string;
  /** The A2A task the recipient's gate opened. Present because the delivery was a real task. */
  taskId: string;
}

/**
 * Thrown when the person has no messaging wire, or has one that does not cover this recipient.
 *
 * This is a DISTINCT error rather than a generic failure because the two are the only cases the UI can
 * actually resolve: both are answered by running the one-prompt ceremony (§5.1 — a prompt per NEW
 * counterparty, never per message). Everything else — a revoked wire, a recipient who has not enabled
 * delivery, a gate rejection — is a plain failure the person cannot fix by signing again.
 */
export class MessagingWireRequiredError extends Error {
  constructor(
    readonly reason: 'wire_absent' | 'recipient_not_in_wire',
    /** The counterparty that needs approving (absent when there is no wire at all). */
    readonly recipient: Address | undefined,
    /** Counterparties the current wire already covers — the new wire must keep them, or sending to
     *  them silently stops working the moment this one is signed. */
    readonly currentRecipients: Address[],
    /** The delegate every wire must name — this deployment's interactions session key. */
    readonly sessionKey: Address | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'MessagingWireRequiredError';
  }
}

/** Ask the person's agent to send one message. Fail-closed: any non-OK response throws. */
export async function sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
  await ensureCsrfToken();
  const session = homeBearer();
  if (!session) throw new Error('no home session');
  const res = await fetch(`/a2a/interactions/${input.person.toLowerCase()}/messaging.send`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify({
      session,
      ...(input.recipient ? { recipient: input.recipient.toLowerCase() } : {}),
      ...(input.recipientName ? { recipientName: input.recipientName } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.subject ? { subject: input.subject } : {}),
      ...(input.title ? { title: input.title } : {}),
      ...(input.contextRefs?.length ? { contextRefs: input.contextRefs } : {}),
      bodyText: input.bodyText,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (body.code === 'wire_absent' || body.code === 'recipient_not_in_wire') {
    throw new MessagingWireRequiredError(
      body.code as 'wire_absent' | 'recipient_not_in_wire',
      typeof body.recipient === 'string' ? (body.recipient as Address) : undefined,
      Array.isArray(body.recipients) ? (body.recipients as Address[]) : [],
      typeof body.sessionKey === 'string' ? (body.sessionKey as Address) : undefined,
      String(body.error ?? 'a messaging wire is required'),
    );
  }
  if (!res.ok || body.ok === false) throw new Error(String(body.error ?? `send failed (${res.status})`));
  return {
    messageId: String(body.messageId ?? ''),
    conversationId: String(body.conversationId ?? ''),
    taskId: String(body.taskId ?? ''),
  };
}

/** What the person's wire currently authorizes — the ceremony reads this before minting, so a new
 *  wire can carry forward every counterparty the old one covered. */
export async function readMessagingWire(person: Address): Promise<{
  sessionKey: Address | null;
  wirePresent: boolean;
  recipients: Address[];
  enabledAt: string | null;
}> {
  await ensureCsrfToken();
  const session = homeBearer();
  if (!session) throw new Error('no home session');
  const res = await fetch(`/a2a/interactions/${person.toLowerCase()}/messaging.wireStatus`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify({ session }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(body.error ?? `wire status failed (${res.status})`));
  return {
    sessionKey: typeof body.sessionKey === 'string' ? (body.sessionKey as Address) : null,
    wirePresent: body.wirePresent === true,
    recipients: Array.isArray(body.recipients) ? (body.recipients as Address[]) : [],
    enabledAt: typeof body.enabledAt === 'string' ? body.enabledAt : null,
  };
}

/**
 * THE CEREMONY: mint a wire that covers `newRecipient` IN ADDITION to everyone the current one covers,
 * sign it with the person's own credential, and install it.
 *
 * THE UNION IS THE POINT. `allowedTargets` is a fixed list, and installing a wire replaces the previous
 * one — so a ceremony that minted a wire for only the new contact would silently stop sends to every
 * existing one. Nothing would error; messages would just start bouncing at gates that used to pass.
 * So the current targets are read first and carried forward, and a read failure aborts rather than
 * proceeding with a narrower set.
 *
 * ONE PROMPT PER NEW COUNTERPARTY, never per message (§5.1). The person signs here; every message the
 * wire then covers is signed by the agent's session key under it.
 */
export async function approveMessagingRecipient(args: {
  person: Address;
  newRecipient: Address;
  /** Mints + signs the delegation. Injected so this module stays free of the credential-routing
   *  machinery (`signHashFor`), and so the ceremony is testable without a signer. */
  mintWire: (input: { person: Address; sessionKey: Address; recipients: Address[] }) => Promise<{ wire: unknown; transport: unknown }>;
}): Promise<void> {
  const current = await readMessagingWire(args.person);
  if (!current.sessionKey) {
    throw new Error('this deployment has no interactions session key — messaging cannot be enabled');
  }
  const recipients = [...new Set([...current.recipients.map((r) => r.toLowerCase() as Address), args.newRecipient.toLowerCase() as Address])];
  const minted = await args.mintWire({ person: args.person, sessionKey: current.sessionKey, recipients });
  await putMessagingWire(args.person, minted.wire, minted.transport);
}

/** Install a wire the PERSON signed. The agent re-checks delegator, delegate, shape, signature and
 *  on-chain revocation before custodying it — this call cannot install authority by asserting it. */
export async function putMessagingWire(person: Address, wire: unknown, transport: unknown): Promise<void> {
  // A freshly minted `Delegation` carries a bigint salt, and `JSON.stringify` throws on one. Left
  // unchecked it surfaces as "Do not know how to serialize a BigInt" from inside the POST below —
  // nowhere near the mint that produced it, and indistinguishable from a network failure to whoever
  // is reading the screen. Named here instead.
  for (const d of [wire, transport]) {
    if (typeof (d as { salt?: unknown } | null)?.salt === 'bigint') {
      throw new Error('the messaging wire must be in its transport form — pass it through toWire() first');
    }
  }
  await ensureCsrfToken();
  const session = homeBearer();
  if (!session) throw new Error('no home session');
  const res = await fetch(`/a2a/interactions/${person.toLowerCase()}/messaging.wireEnable`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify({ session, delegation: wire, transport }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || body.ok === false) throw new Error(String(body.error ?? `wire enable failed (${res.status})`));
}
