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
  createVaultMessageBodyStore,
  validateMessageEnvelope,
  verifyBodyHash,
  type MessageEnvelopeV1,
  type MessageEventV1,
} from '@agenticprimitives/fabric/messaging';
import type { Vault, VaultObject } from '@agenticprimitives/vault';
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

/** Merges a validated envelope into the recipient's `inbox.data` via their InteractionsDO
 *  (spec 322 W3f — the serialized single writer; throws when the recipient hasn't enabled it). */
export type DeliverDocFn = (recipient: string, envelope: MessageEnvelopeV1) => Promise<void>;

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

/** Adapt the a2a `SkillContext.vault` seam (record read/write over a delegation) to the fabric `Vault`
 *  interface, bound to ONE owner + the task's grant. Every read/write rides `ctx.delegation` → demo-mcp keys
 *  by the owner + record-scope-gates it (message.body:* + inbox.data). */
function vaultOverContext(ctx: SkillContext, owner: string): Vault {
  return {
    async read<T = unknown>({ owner: o, resource }: { owner: string; resource: string }): Promise<VaultObject<T> | null> {
      const raw = await ctx.vault.read({ owner: o as Address, recordType: resource }, { delegation: ctx.delegation });
      if (raw == null) return null;
      return { owner: o, resource, classification: 'internal', data: raw as T, updatedAt: new Date().toISOString() };
    },
    async write({ owner: o, resource, data }: { owner: string; resource: string; data: unknown }): Promise<void> {
      await ctx.vault.write({ owner: o as Address, recordType: resource, data, delegation: ctx.delegation });
    },
    async list(): Promise<never[]> {
      return [];
    },
  } as unknown as Vault;
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
      if (!envelope.to.some((t) => t.toLowerCase().includes(recipient))) {
        return { state: 'failed', error: 'envelope is not addressed to this recipient' };
      }
      const bytes = new TextEncoder().encode(payload.bodyText);
      if (!(await verifyBodyHash(envelope, bytes))) {
        return { state: 'failed', error: 'bodyHash does not match the transported body' };
      }

      // Admit into the recipient's VAULT (spec 316 §11a) under the recipient's delivery grant (ctx.delegation).
      const vault = vaultOverContext(ctx, recipient);
      // 1) Body → `message.body:<id>` in the fabric body-store format the recipient's Home reads back.
      await createVaultMessageBodyStore(vault, recipient).putBody({
        messageId: envelope.id,
        bytes,
        contentType: envelope.bodyContentType ?? 'text/plain',
        classification: 'internal',
      });
      // 2) Envelope + a `delivered` event merge via the recipient's InteractionsDO (spec 322 W3f):
      //    the delivery grant is WRITE-ONLY, so the read-modify-write of `inbox.data` moved to the
      //    single serialized writer. Fail-closed: a recipient who hasn't enabled interactions cannot
      //    receive (the sender sees the error) — never a weaker direct-write path (ADR-0013).
      await deliverDoc(recipient, envelope);

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
