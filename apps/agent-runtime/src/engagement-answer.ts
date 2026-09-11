// ANSWERING A PROBE — spec 384 W2 (336 §3.5, §3.7). An agent served here is asked: "will you fulfil this
// intent (capability X) on these terms?" The answer is one of the six kinds and is DECIDED from facts, never
// composed: what its own harness would offer (its compiled playbook, else the bare harness's action set —
// the same set `scopedActionTools` gives the Ask), what kind of agent it is on chain, and whether this
// runtime can sign as it. A firm offer is signed as the provider under its own session leaf; a person's
// agent never commits its person from a server — it says a human channel is required.
import type { Address, Hex } from 'viem';
import { offerDigest, type EngagementProbeV1, type EngagementResponseV1, type FulfillmentOfferV1, type EngagementResponseContentV1 } from '@agenticprimitives/intent-engagement';
import { scopedActionTools, REQUIREMENT_TYPE_FOR } from './harness-run.js';
import { loadPlaybook } from '@agenticprimitives/harness';

export interface AnswerProbeDeps {
  /** The agent's on-chain kind: person | org | service (ADR-0046), or null when unreadable. */
  agentTypeOf?: (agent: string) => Promise<string | null>;
  /** The agent's own records (its playbook lives there). */
  readSubjectRecord?: (subject: string, recordType: string) => Promise<unknown>;
  /** Sign a digest AS the agent (its session leaf); null when this runtime cannot. */
  signAsAgent: (agent: Address, digest: Hex) => Promise<Hex | null>;
  now?: () => number;
}

const uuid = () => crypto.randomUUID();

/** The capability the probe asks for, read from the projection's own fields. */
export function probedCapability(probe: Pick<EngagementProbeV1, 'projection'>): string {
  const f = probe.projection.fields as Record<string, unknown>;
  return String(f.capability ?? '').trim();
}

export async function answerProbe(deps: AnswerProbeDeps, agent: Address, probe: EngagementProbeV1): Promise<EngagementResponseV1> {
  const nowMs = (deps.now ?? Date.now)();
  const base = { type: 'ap.engagement-response.v1' as const, responseId: `resp_${uuid()}`, inReplyTo: probe.probeId, engagementId: probe.engagementId, provider: agent, probeNonce: probe.probeNonce, issuedAt: new Date(nowMs).toISOString(), idempotencyKey: `${probe.probeId}:${agent.toLowerCase()}` };
  const reply = (content: EngagementResponseContentV1): EngagementResponseV1 => ({ ...base, content });
  const capability = probedCapability(probe);
  if (!capability) return reply({ kind: 'decline', reason: 'unsupported-intent-type', detail: 'the projection names no capability' });
  // WHAT THIS AGENT WOULD OFFER — its playbook narrows the bare harness (spec 354 §4.4); the same set the Ask sees.
  const playbook = await loadPlaybook(deps.readSubjectRecord, agent, console.log).catch(() => null);
  const offered = new Set(scopedActionTools(undefined, playbook).map((t) => t.capability?.id ?? t.id));
  if (!offered.has(capability)) return reply({ kind: 'decline', reason: 'unsupported-intent-type', detail: `${capability} is not something this agent does` });
  // A PERSON'S AGENT NEVER COMMITS ITS PERSON FROM A SERVER: the answer must arrive through them.
  const kind = (await deps.agentTypeOf?.(agent).catch(() => null)) ?? null;
  if (kind === 'person' || kind === null) {
    return reply({ kind: 'human-ux-required', request: { type: 'ap.human-interaction.v1', channel: 'external-url', handle: `hx_${uuid()}`, expiresAt: new Date(nowMs + 24 * 3600_000).toISOString() } });
  }
  // A FIRM OFFER, signed as the provider. Terms are the projection's own words; the requirement is what the
  // work will need (RFC 9396 shape), bound to the intent and the projection the provider reviewed.
  const words = String((probe.projection.fields as Record<string, unknown>).words ?? '').trim();
  const limits = (probe.projection.fields as Record<string, unknown>).limits;
  const unsigned: Omit<FulfillmentOfferV1, 'signature'> = {
    type: 'ap.fulfillment-offer.v1', offerId: `off_${uuid()}`, revision: 1, engagementId: probe.engagementId, provider: agent, requester: probe.requester,
    basisOfOffer: probe.projectionDigest, intentDigest: probe.intentDigest,
    terms: { scopeAccepted: words || capability, requiredInputs: [], expectedArtifacts: ['a receipt naming the run, the mandate and the transaction'] },
    requirement: { type: REQUIREMENT_TYPE_FOR(capability), actions: [capability], intentDigest: probe.intentDigest, projectionDigest: probe.projectionDigest, ...(limits && typeof limits === 'object' ? { limits: limits as Record<string, string | number> } : {}), validUntil: Math.floor(nowMs / 1000) + 3600 },
    expiresAt: new Date(nowMs + 3600_000).toISOString(), issuedAt: new Date(nowMs).toISOString(),
  };
  const digest = offerDigest({ ...unsigned, signature: '0x' });
  const signature = await deps.signAsAgent(agent, digest);
  if (!signature) {
    return reply({ kind: 'human-ux-required', request: { type: 'ap.human-interaction.v1', channel: 'external-url', handle: `hx_${uuid()}`, expiresAt: new Date(nowMs + 24 * 3600_000).toISOString() } });
  }
  return reply({ kind: 'offer', offer: { ...unsigned, signature } });
}
