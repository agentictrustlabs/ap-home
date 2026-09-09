// Spec 384 W3 — the campaign from an Endeavor step: candidates from the public tier as evidence, the selection bound
// onto the parked run, the mandate that must name the offer, the receipt that cites it.
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { offerDigest, projectionDigest, digestOf, type EngagementProbeV1, type FulfillmentOfferV1 } from '@agenticprimitives/intent-engagement';
import { engagementResponseMessage, engagementOf } from '@agenticprimitives/a2a';
import { discoveryCandidateSource } from '../../src/engagement-candidates.js';
import { runEngagementCampaign, bindSelectedOffer, campaignNote, campaignIntentOf, type SelectedOfferBindingV1 } from '../../src/engagement-campaign.js';
import { checkpointForStep, engagesProvider, receiptEvidence } from '../../src/endeavor-authority-steps.js';

const ORG = '0x3b99f2b452766de5df0dbcdfc676f27257151333' as const;
const SVC = '0x309b2a566e93cc77aabe895d0ec2702c36856ebd' as const;
const BOB = '0x8c5cddca27c088a65e58e94403acdc9bc3eb7fe3' as const;
const OTHER = '0x6fece74d0000000000000000000000000000cafe' as const;
const CAP = 'treasury.payment.execute';
const SIG = `0x${'ab'.repeat(65)}` as Hex;

const rows = {
  [SVC]: { smartAgent: SVC, name: 'runtime-c3s0.svc', agentType: 'service', tld: 'svc', capabilityIds: ['messaging.deliver'], registryStatus: 'active', a2aEndpoint: 'https://runtime-c3s0-svc.faithnet.ai' },
  [BOB]: { smartAgent: BOB, name: 'bob.me', agentType: 'person', tld: 'me', capabilityIds: [CAP] },
  [OTHER]: { smartAgent: OTHER, name: 'pay.svc', agentType: 'service', tld: 'svc', capabilityIds: [CAP] },
  [ORG]: { smartAgent: ORG, name: 'missio-nexus.org', agentType: 'org', tld: 'org', capabilityIds: [CAP] },
};
const fakeDiscovery = (byQuery: Record<string, unknown[]>) => async (path: string) => {
  const q = decodeURIComponent(/q=([^&]*)/.exec(path)?.[1] ?? '');
  return new Response(JSON.stringify({ ok: true, results: byQuery[q] ?? [] }), { status: 200, headers: { 'content-type': 'application/json' } });
};

describe('discoveryCandidateSource — two named reads, evidence never a score', () => {
  it('a service that declares the capability is evidence; a service that does not can still be asked; a person and the requester are never candidates', async () => {
    const src = discoveryCandidateSource(fakeDiscovery({ [CAP]: [rows[BOB], rows[OTHER], rows[ORG]], '.svc': [rows[SVC], rows[OTHER]] }), { exclude: [ORG], now: () => Date.parse('2026-09-08T10:00:00Z') });
    const out = await src.candidatesFor({ capability: CAP, limit: 5 });
    expect(out.map((c) => c.agent)).toEqual([OTHER, SVC]); // declared first, then the typed read's
    expect(out[0]!.capabilityEvidence).toEqual([{ capability: CAP, source: 'kb:approf:skills', observedAt: '2026-09-08T10:00:00.000Z' }]);
    expect(out[0]!.reasons).toEqual([`found by the capability read (${CAP})`, `declares ${CAP} in its public profile`, 'found by the typed read (service agents)']);
    expect(out[1]!.capabilityEvidence).toEqual([]);
    expect(out[1]!.reasons[1]).toMatch(/declares nothing about/);
    expect(out[1]!.cardUrl).toBe('https://runtime-c3s0-svc.faithnet.ai/.well-known/agent-card.json');
    expect(JSON.stringify(out)).not.toMatch(/score/i);
  });
  it('an unreachable discovery is an error, never an empty campaign', async () => {
    const src = discoveryCandidateSource(async () => null);
    await expect(src.candidatesFor({ capability: CAP, limit: 5 })).rejects.toThrow(/not reachable/);
  });
});

function offerFor(probe: EngagementProbeV1, provider: `0x${string}`): FulfillmentOfferV1 {
  const unsigned: Omit<FulfillmentOfferV1, 'signature'> = {
    type: 'ap.fulfillment-offer.v1', offerId: `off_${provider.slice(2, 6)}`, revision: 1, engagementId: probe.engagementId, provider, requester: probe.requester, basisOfOffer: probe.projectionDigest, intentDigest: probe.intentDigest,
    terms: { scopeAccepted: 'the step', requiredInputs: [], expectedArtifacts: [] }, requirement: { type: 'urn:ap:rar:treasury.payment.execute', actions: [CAP], intentDigest: probe.intentDigest, projectionDigest: probe.projectionDigest, validUntil: 1_900_000_000 },
    expiresAt: '2026-09-08T13:00:00Z', issuedAt: '2026-09-08T10:01:00Z',
  };
  return { ...unsigned, signature: SIG };
}
const answer = (provider: `0x${string}`, content: (probe: EngagementProbeV1) => Record<string, unknown>) => (probe: EngagementProbeV1) =>
  engagementResponseMessage({ type: 'ap.engagement-response.v1', responseId: `resp_${provider.slice(2, 6)}`, inReplyTo: probe.probeId, engagementId: probe.engagementId, provider, probeNonce: probe.probeNonce, content: content(probe), issuedAt: '2026-09-08T10:01:00Z', idempotencyKey: `${probe.probeId}:${provider}` } as never);

describe('runEngagementCampaign', () => {
  it('finds two candidates, probes each once as the organization, selects the firm offer, records the loser, and binds the run to the provider + offer', async () => {
    const sent: string[] = [];
    const answers: Record<string, (p: EngagementProbeV1) => unknown> = {
      [SVC]: answer(SVC, (p) => ({ kind: 'offer', offer: offerFor(p, SVC) })),
      [OTHER]: answer(OTHER, () => ({ kind: 'decline', reason: 'unsupported-intent-type', detail: 'not this week' })),
    };
    const out = await runEngagementCampaign({
      requester: ORG, source: discoveryCandidateSource(fakeDiscovery({ '.svc': [rows[SVC], rows[OTHER]] }), { exclude: [ORG] }),
      nameOf: async (a) => (a === SVC ? 'runtime-c3s0.svc' : a === OTHER ? 'pay.svc' : null),
      sendProbe: async (candidate, message) => {
        const doc = engagementOf(message);
        if (!doc || 'errors' in doc || !('probe' in doc)) throw new Error('not a probe');
        const probe = doc.probe as unknown as EngagementProbeV1;
        expect(probe.requester).toBe(ORG);
        expect(probe.projection.fields).toEqual({ capability: CAP, words: 'Pay 1 USDC to nathan.treasury' });
        expect(JSON.stringify(probe)).not.toMatch(/withholds/);
        sent.push(candidate);
        return { ok: true, message: answers[candidate]!(probe) as never };
      },
      now: () => Date.parse('2026-09-08T10:00:00Z'),
    }, { campaignId: 'camp_1', capability: CAP, words: 'Pay 1 USDC to nathan.treasury', budget: { maxCandidates: 5, offersWanted: 1, deadlineMs: 600_000 } });
    expect(sent).toEqual([OTHER, SVC]); // the one declaring the capability is asked first
    expect(out.campaign.candidates).toEqual([OTHER, SVC]);
    expect(out.campaign.intentDigest).toBe(digestOf(campaignIntentOf('Pay 1 USDC to nathan.treasury')));
    expect(out.selection?.selected.provider).toBe(SVC);
    expect(out.selection?.because).toEqual(['the only firm offer received']);
    expect(out.selection?.notSelected).toEqual([{ offerId: '', provider: OTHER, because: 'declined: unsupported-intent-type — not this week' }]);
    expect(out.binding).toEqual({ type: 'ap.selected-offer-binding.v1', campaignId: 'camp_1', capability: CAP, provider: SVC, providerName: 'runtime-c3s0.svc', offerId: 'off_309b', offerDigest: out.rows[1]!.offer!.offerDigest, expiresAt: '2026-09-08T13:00:00Z' });
    expect(out.campaign.state).toBe('selected');
  });

  it('the disclosure budget bounds how many are asked', async () => {
    const asked: string[] = [];
    const out = await runEngagementCampaign({
      requester: ORG, source: { candidatesFor: async () => [SVC, OTHER, BOB].map((agent) => ({ agent, capabilityEvidence: [], reasons: [] })) },
      sendProbe: async (c) => { asked.push(c); return { ok: false, refused: 'quiet' }; },
    }, { campaignId: 'camp_2', capability: CAP, words: 'x', budget: { maxCandidates: 2, offersWanted: 1, deadlineMs: 1000 } });
    expect(asked).toEqual([SVC, OTHER]);
    expect(out.selection).toBeNull();
    expect(out.binding).toBeNull();
    expect(out.rows.map((r) => r.refused)).toEqual(['quiet', 'quiet']);
  });
});

const binding: SelectedOfferBindingV1 = { type: 'ap.selected-offer-binding.v1', campaignId: 'camp_1', capability: CAP, provider: SVC, providerName: 'runtime-c3s0.svc', offerId: 'off_1', offerDigest: `0x${'11'.repeat(32)}` as Hex, expiresAt: '2026-09-08T13:00:00Z' };

describe('bindSelectedOffer — the selection shapes the plan, never the gate', () => {
  it('hands the capability\'s step to the provider with the offer digest; leaves other steps and an already-named executor alone', () => {
    const plan = { steps: [{ toolId: 'organization.membership.list', args: {} }, { toolId: CAP, args: { payee: 'nathan.treasury', usdc: '1' } }, { toolId: CAP, args: { payee: 'x' }, executor: BOB }] };
    const bound = bindSelectedOffer(plan, binding);
    expect(bound.steps[0]).toEqual({ toolId: 'organization.membership.list', args: {} });
    expect(bound.steps[1]).toEqual({ toolId: CAP, args: { payee: 'nathan.treasury', usdc: '1', offerDigest: binding.offerDigest }, executor: SVC });
    expect(bound.steps[2]).toEqual({ toolId: CAP, args: { payee: 'x' }, executor: BOB });
    expect(bindSelectedOffer(plan, null)).toBe(plan);
  });
});

describe('the parked run and the receipt', () => {
  const step = { stepId: 'step_1', kind: 'interaction', description: 'Pay 1 USDC to nathan.treasury', capabilityRequirements: [{ capabilityIri: `urn:ap:cap:${CAP}` }] };
  it('engagesProvider: an interaction step engages; a contribution outside the offer set engages; a contribution inside does not', () => {
    expect(engagesProvider(step, CAP, new Set([CAP]))).toBe('interaction-step');
    expect(engagesProvider({ ...step, kind: 'contribution' }, 'treasury.create', new Set([CAP]))).toBe('not-in-own-offer-set');
    expect(engagesProvider({ ...step, kind: 'contribution' }, CAP, new Set([CAP]))).toBeNull();
  });
  it('the checkpoint names the provider in the ask, carries the binding on its origin, and stays claimable by stewards', () => {
    const cp = checkpointForStep({ runRef: 'run-1', principal: ORG, endeavorId: 'end_1', step, goal: 'the corridor', engagement: binding, now: 1 });
    expect(cp.message).toBe(`Pay 1 USDC to nathan.treasury\n\nDo this by exercising ${CAP} as ${ORG}. Hand it to runtime-c3s0.svc under its offer off_1.`);
    expect(cp.origin?.engagement).toEqual(binding);
    expect(cp.openToStewards).toBe(true);
    expect(cp.presented).toEqual([]);
    expect(checkpointForStep({ runRef: 'run-2', principal: ORG, endeavorId: 'end_1', step, goal: 'g', now: 1 }).origin?.engagement).toBeUndefined();
  });
  it('the receipt cites the offer beside the run, the mandate and the transaction', () => {
    const ev = receiptEvidence({ capability: CAP, runRef: 'run-1', mandateRef: '0xaa', txHash: '0xbb', summary: 'Done.', offerDigest: binding.offerDigest });
    expect(ev.refs).toEqual(['urn:ap:receipt:run:run-1', 'urn:ap:receipt:mandate:0xaa', 'urn:ap:receipt:tx:0xbb', `urn:ap:receipt:offer:${binding.offerDigest}`]);
  });
  it('the endeavor note names who was asked, what each said, who was selected and why, and carries the selection as a record', () => {
    const probe = { probeId: 'p', engagementId: 'e', campaignId: 'camp_1', requester: ORG, candidate: SVC, projection: { type: 'ap.intent-projection.v1', kind: 'engagement', intentId: 'i', intentVersion: 1, intentDigest: `0x${'22'.repeat(32)}`, audience: SVC, purpose: 'quote', fields: {} }, projectionDigest: `0x${'33'.repeat(32)}`, intentDigest: `0x${'22'.repeat(32)}`, probeNonce: 'n', issuedAt: '', objective: 'firm-offer', interaction: { clarification: 'structured-only', humanChannels: [], maxRounds: 1 }, processing: 'direct-message', replyBy: '', type: 'ap.engagement-probe.v1' } as unknown as EngagementProbeV1;
    const o = offerFor(probe, SVC);
    const note = campaignNote({
      capability: CAP, principal: ORG, runRef: 'run-1', stepDescription: step.description, because: 'interaction-step',
      outcome: {
        campaign: { type: 'ap.engagement-campaign.v1', campaignId: 'camp_1', intentId: 'i', intentVersion: 1, intentDigest: probe.intentDigest, requester: ORG, maxCandidates: 5, offersWanted: 1, deadline: '2026-09-08T10:10:00Z', candidates: [SVC, OTHER], engagements: [], state: 'selected' },
        candidates: [], evaluations: [],
        rows: [{ agent: SVC, name: 'runtime-c3s0.svc', engagementId: 'e', state: 'offer-selected', kind: 'offer', offer: { offerId: o.offerId, offerDigest: offerDigest(o), expiresAt: o.expiresAt, terms: o.terms, requirement: o.requirement, provider: SVC } }, { agent: OTHER, name: 'pay.svc', engagementId: 'e2', state: 'closed-declined', kind: 'decline', reason: 'unsupported-intent-type' }],
        selection: { type: 'ap.offer-selection.v1', campaignId: 'camp_1', selected: { offerId: o.offerId, offerDigest: offerDigest(o), provider: SVC }, because: ['the only firm offer received'], notSelected: [{ offerId: '', provider: OTHER, because: 'declined: unsupported-intent-type' }], decidedAt: '2026-09-08T10:02:00Z' },
        binding: { ...binding, offerId: o.offerId, offerDigest: offerDigest(o) },
      },
    });
    expect(note).toMatch(/the plan made this step an interaction with another party/);
    expect(note).toMatch(/- runtime-c3s0\.svc: offer — offer off_309b/);
    expect(note).toMatch(/- pay\.svc: decline \(unsupported-intent-type\)/);
    expect(note).toMatch(/\*\*Selected runtime-c3s0\.svc\*\* because: the only firm offer received\./);
    expect(note).toMatch(/Not selected: 0x6fece74d0000000000000000000000000000cafe — declined/);
    expect(note).toMatch(/granting the mandate that NAMES offer off_309b/);
    expect(note).toMatch(/`run-1`/);
    const fenced = /```ap\.offer-selection\.v1\n([\s\S]*?)\n```/.exec(note);
    expect(JSON.parse(fenced![1]!).selected.provider).toBe(SVC);
  });
});
