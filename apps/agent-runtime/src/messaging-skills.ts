// The A2A messaging skill bindings (spec 309 §7 "A2A delivery"; ADR-0044; spec 316 §11a).
//
// These are the app-layer SkillHandlers that let ANY claimed agent deliver mail / interaction responses /
// credentials to a recipient over STANDARD A2A `message/send`. The recipient's `A2aTaskDO` IS the recipient's
// gateway: the a2a runtime + `authorizeA2aMessage` provide delegation-authorized TRANSPORT (allowedTargets =
// this recipient, allowedMethods = the skill, single-use messageId, on-chain isRevoked + ERC-1271).
//
// The skill then admits DIRECTLY into the recipient's VAULT (spec 316 §11a — the vault is the one durable
// inbox substrate): it persists the body under `message.body:<id>` (fabric body store, the SAME format the
// recipient's Home reads) and appends the envelope to the recipient's `inbox.data` record — both written under
// `ctx.delegation` (the recipient's standing inbox-delivery grant, scoped to exactly those records). There is
// NO callback to the recipient's Home (no `HOME_INBOX_URL`); the vault is the meeting point. A message is never
// authority (ADR-0041). Fail-closed throughout (ADR-0013).
import {
  validateMessageEnvelope,
  verifyBodyHash,
  type MessageEnvelopeV1,
  type MessageEventV1,
} from '@agenticprimitives/fabric/messaging';
import type { Address } from 'viem';
import type { SkillContext, SkillHandler, SkillResult } from '@agenticprimitives/a2a';

/** The owner's inbox document (mirrors demo-sso-next `InboxDataV1` — only the fields the skill appends to;
 *  the rest are preserved verbatim across the read-modify-write). */
interface InboxDoc {
  version: 1;
  envelopes: MessageEnvelopeV1[];
  events: MessageEventV1[];
  draftCases: unknown[];
  caseEvents: unknown[];
  cards: Record<string, unknown>;
  conversations?: unknown[];
  [k: string]: unknown;
}
const EMPTY_DOC = (): InboxDoc => ({ version: 1, envelopes: [], events: [], draftCases: [], caseEvents: [], cards: {} });
const INBOX_DATA_RECORD = 'inbox.data';

/** Admits a validated delivery into the recipient's vault via their InteractionsDO (spec 323 W3.2):
 *  the DO writes the body under its own DELIVERY wire (`internal.dm.body.put`) and merges the
 *  envelope into `inbox.data` (`internal.deliver`). No presented `ctx.delegation` carries the
 *  recipient's wire; throws when the recipient hasn't enabled interactions. `stored` is the fabric
 *  StoredBody the recipient's Home reads back verbatim. */
export type DeliverDocFn = (
  recipient: string,
  envelope: MessageEnvelopeV1,
  body: { resource: string; stored: { b64: string; contentType: string; bodyHash: string } },
) => Promise<void>;

interface MessagingDeliverInput {
  envelope: MessageEnvelopeV1;
  bodyText: string;
  conversation?: unknown;
}
function parseInput(input: unknown): MessagingDeliverInput | null {
  if (!input || typeof input !== 'object') return null;
  const i = input as Record<string, unknown>;
  if (!i.envelope || typeof i.envelope !== 'object') return null;
  if (typeof i.bodyText !== 'string') return null;
  return i as unknown as MessagingDeliverInput;
}

/** Shared handler for the three messaging skills — they differ only in the receipt-artifact kind (and which
 *  optional facets the sender carries). `recipientSA` is the SA this DO shard hosts (the addressee
 *  `allowedTargets` named), NOT the delegation delegator. */
function makeDeliverHandler(recipientSA: string, skill: string, receiptKind: string, deliverDoc: DeliverDocFn): SkillHandler {
  const recipient = recipientSA.toLowerCase();
  return {
    skill,
    handle: async (ctx: SkillContext): Promise<SkillResult> => {
      const payload = parseInput(ctx.input);
      if (!payload) return { state: 'failed', error: `${skill} requires input { envelope, bodyText }` };
      const { envelope } = payload;

      const errors = validateMessageEnvelope(envelope);
      if (errors.length > 0) return { state: 'failed', error: `invalid envelope: ${errors.join(', ')}` };
      // NEW-H1 — bind envelope.from to the VERIFIED sender (ctx.principal = delegation.delegator, on whose
      // behalf this delivery is authorized). Without this the sender set `from` to anyone (e.g. Alice), the
      // envelope passed shape + bodyHash, and the recipient saw a forged-author message with a valid receipt.
      // Addresses are CAIP-10 suffixes (`eip155:<chain>:0x…`) — match the trailing 40-hex, exactly.
      const addrOf = (caip: string): string => (caip.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase();
      if (addrOf(envelope.from) !== ctx.principal.toLowerCase()) {
        return { state: 'failed', error: 'envelope.from does not match the authorized sender' };
      }
      // Exact recipient match (was a loose `.includes`, which any substring could satisfy).
      if (!envelope.to.some((t) => addrOf(t) === recipient)) {
        return { state: 'failed', error: 'envelope is not addressed to this recipient' };
      }
      const bytes = new TextEncoder().encode(payload.bodyText);
      if (!(await verifyBodyHash(envelope, bytes))) {
        return { state: 'failed', error: 'bodyHash does not match the transported body' };
      }

      // Admit into the recipient's VAULT via their InteractionsDO (spec 323 W3.2): the DO holds the
      // recipient's write-only delivery wire and does BOTH writes — the body (fabric StoredBody
      // format the recipient's Home reads back) and the `inbox.data` merge. NOTHING here presents the
      // recipient's wire. Fail-closed: a recipient who hasn't enabled interactions cannot receive
      // (the sender sees the error) — never a weaker direct-write path (ADR-0041/0013).
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      await deliverDoc(recipient, envelope, {
        resource: envelope.body.resource,
        stored: { b64: btoa(bin), contentType: envelope.bodyContentType ?? 'text/plain', bodyHash: envelope.bodyHash },
      });

      const receiptId = await ctx.emitArtifact({
        artifactKind: receiptKind,
        body: { messageId: envelope.id, skill, recipient, admittedAt: new Date().toISOString() },
      });
      return { state: 'completed', artifactIds: [receiptId] };
    },
  };
}

/** The three A2A messaging skill handlers (spec 309 §7). Registered in the recipient's `A2aTaskDO` alongside
 *  `echo` + `orchestrate`. `recipientSA` is the SA this DO hosts. */
export function makeMessagingSkills(recipientSA: string, deliverDoc: DeliverDocFn): SkillHandler[] {
  return [
    makeDeliverHandler(recipientSA, 'messaging.deliver', 'messaging.delivery.receipt', deliverDoc),
    makeDeliverHandler(recipientSA, 'interactions.respond', 'interactions.response.receipt', deliverDoc),
    makeDeliverHandler(recipientSA, 'interactions.deliverCredential', 'interactions.credential.receipt', deliverDoc),
  ];
}
