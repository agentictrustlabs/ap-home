// Spec 384 W2 — a probe is answered from facts: the agent's own offer set, its on-chain kind, and whether this
// runtime can sign as it. A firm offer is signed as the provider; a person's agent never commits its person.
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { offerDigest, projectionDigest, digestOf, type EngagementProbeV1, type IntentProjectionV1 } from '@agenticprimitives/intent-engagement';
import { answerProbe } from '../../src/engagement-answer.js';

const REQ = '0xb0d11ce19b756a682e78b4904cd8d832303b3d11' as const;
const SVC = '0x309b2a566e93cc77aabe895d0ec2702c36856ebd' as const;
const intent = { goal: 'pay nathan.treasury 1 usdc' };
const projectionFor = (capability: string): IntentProjectionV1 => ({ type: 'ap.intent-projection.v1', kind: 'engagement', intentId: 'i', intentVersion: 1, intentDigest: digestOf(intent), audience: SVC, purpose: 'quote', fields: { capability, words: 'pay the venue deposit' } });
const probeFor = (capability: string): EngagementProbeV1 => { const p = projectionFor(capability); return { type: 'ap.engagement-probe.v1', probeId: 'p1', engagementId: 'e1', campaignId: 'c1', requester: REQ, candidate: SVC, projection: p, projectionDigest: projectionDigest(p), intentDigest: digestOf(intent), objective: 'firm-offer', interaction: { clarification: 'structured-only', humanChannels: [], maxRounds: 1 }, processing: 'direct-message', replyBy: '2026-09-08T12:00:00Z', probeNonce: 'n1', issuedAt: '2026-09-08T10:00:00Z' }; };
const SIG = `0x${'ab'.repeat(65)}` as Hex;

describe('answerProbe', () => {
  it('a service that offers the capability answers with a FIRM offer, signed as itself, bound to the probe', async () => {
    let signedDigest: Hex | null = null;
    const r = await answerProbe({ agentTypeOf: async () => 'service', signAsAgent: async (_a, d) => { signedDigest = d; return SIG; }, now: () => Date.parse('2026-09-08T10:00:30Z') }, SVC, probeFor('treasury.payment.execute'));
    expect(r.content.kind).toBe('offer');
    if (r.content.kind !== 'offer' || r.content.offer.type !== 'ap.fulfillment-offer.v1') throw new Error('not a firm offer');
    const o = r.content.offer;
    expect(o.provider).toBe(SVC);
    expect(o.basisOfOffer).toBe(probeFor('treasury.payment.execute').projectionDigest);
    expect(o.requirement.actions).toEqual(['treasury.payment.execute']);
    expect(o.requirement.intentDigest).toBe(digestOf(intent));
    expect(o.signature).toBe(SIG);
    expect(signedDigest).toBe(offerDigest(o));
    expect(r.probeNonce).toBe('n1');
    expect(r.inReplyTo).toBe('p1');
  });
  it('declines a capability it does not do — a business fact, with the reason', async () => {
    const r = await answerProbe({ agentTypeOf: async () => 'service', signAsAgent: async () => SIG }, SVC, probeFor('not.a.capability'));
    expect(r.content.kind).toBe('decline');
    expect(r.content.kind === 'decline' && r.content.reason).toBe('unsupported-intent-type');
  });
  it('a person\'s agent, or an agent this runtime cannot sign for, says a human channel is required', async () => {
    const person = await answerProbe({ agentTypeOf: async () => 'person', signAsAgent: async () => SIG }, SVC, probeFor('treasury.payment.execute'));
    expect(person.content.kind).toBe('human-ux-required');
    const unsignable = await answerProbe({ agentTypeOf: async () => 'org', signAsAgent: async () => null }, SVC, probeFor('treasury.payment.execute'));
    expect(unsignable.content.kind).toBe('human-ux-required');
  });
});
