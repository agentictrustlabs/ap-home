// THE CAMPAIGN IN THE HARNESS — spec 384 W3 (appendix M7). An Endeavor step names a capability the organization
// does not do itself: candidates come from the public tier (`discoveryCandidateSource`), each is probed once as
// the organization (W2's probe, bounded by a disclosure budget), the offers are evaluated by ORDERED, NAMED
// rules (`selectOffer`), and the selection is recorded — on the endeavor, in the organization's own words, with
// every loser's reason. What comes out is a BINDING for the parked run: the provider to hand the step to and
// the offer the steward's mandate must name. The mandate is still the only authority; a selection decides who
// is asked to sign for, never that anything may run (336 §3.2; 384 W2 `offer-not-bound`).
import type { Address, Hex } from 'viem';
import type { Plan } from '@agenticprimitives/orchestration';
import { openCampaign, selectOffer, digestOf, type CandidateSource, type CandidateV1, type EngagementCampaignV1, type OfferSelectionV1, type OfferEvaluationV1 } from '@agenticprimitives/intent-engagement';
import { probeCandidates, type ProbeDeps, type ProbeRow } from './engagement-probe.js';

/** What a parked run carries from a campaign: WHO the step is handed to and WHICH offer the mandate must name.
 *  Display and plan-shaping only — no verifier reads it; the verifier reads the mandate's own offer binding. */
export interface SelectedOfferBindingV1 {
  type: 'ap.selected-offer-binding.v1';
  campaignId: string;
  capability: string;
  provider: Address;
  providerName?: string | null;
  offerId: string;
  offerDigest: Hex;
  expiresAt: string;
}

export interface CampaignDeps extends Omit<ProbeDeps, 'requester'> {
  requester: Address;
  source: CandidateSource;
  now?: () => number;
}

export interface CampaignBudget { maxCandidates: number; offersWanted: number; deadlineMs: number }

export interface CampaignOutcome {
  campaign: EngagementCampaignV1;
  candidates: CandidateV1[];
  rows: ProbeRow[];
  evaluations: OfferEvaluationV1[];
  selection: OfferSelectionV1 | null;
  binding: SelectedOfferBindingV1 | null;
}

/** The intent a campaign binds: the step's own words as the organization will ask them. The parked run is
 *  admitted against `{ goal }` of the same sentence, so the offer's `intentDigest` and the run's agree. */
export function campaignIntentOf(words: string): { goal: string } { return { goal: words }; }

export async function runEngagementCampaign(deps: CampaignDeps, input: { campaignId: string; capability: string; words: string; budget: CampaignBudget }): Promise<CampaignOutcome> {
  const nowMs = (deps.now ?? Date.now)();
  const intent = campaignIntentOf(input.words);
  const intentDigest = digestOf(intent);
  const found = await deps.source.candidatesFor({ capability: input.capability, limit: input.budget.maxCandidates });
  const campaign = openCampaign({ campaignId: input.campaignId, intentId: input.campaignId, intentDigest, requester: deps.requester, budget: { maxCandidates: input.budget.maxCandidates, offersWanted: input.budget.offersWanted, deadline: new Date(nowMs + input.budget.deadlineMs).toISOString() }, candidates: found.map((c) => c.agent) });
  const candidates = found.filter((c) => campaign.candidates.some((a) => a.toLowerCase() === c.agent.toLowerCase()));
  const round = await probeCandidates({ ...deps, requester: deps.requester }, { campaignId: campaign.campaignId, intentId: campaign.intentId, intentDigest, capability: input.capability, words: input.words, candidates: campaign.candidates, replyByMs: input.budget.deadlineMs });
  const decided = selectOffer({ campaign: { ...campaign, engagements: round.situations.map((s) => s.engagementId) }, situations: round.situations, candidates, capability: input.capability, now: new Date((deps.now ?? Date.now)()).toISOString() });
  const sel = decided.selection;
  const winnerRow = sel ? round.rows.find((r) => r.agent.toLowerCase() === sel.selected.provider.toLowerCase()) : null;
  const binding: SelectedOfferBindingV1 | null = sel && winnerRow?.offer
    ? { type: 'ap.selected-offer-binding.v1', campaignId: campaign.campaignId, capability: input.capability, provider: sel.selected.provider, providerName: winnerRow.name ?? null, offerId: sel.selected.offerId, offerDigest: sel.selected.offerDigest, expiresAt: winnerRow.offer.expiresAt }
    : null;
  return { campaign: decided.campaign, candidates, rows: round.rows, evaluations: decided.evaluations, selection: sel, binding };
}

/**
 * BIND THE SELECTION ONTO THE PLAN. Every step exercising the campaign's capability that names no executor of
 * its own is handed to the selected provider and carries the offer's digest — which is what makes the harness
 * ask for a requirement naming the offer, and the verifier refuse a mandate that does not (W2). Pure; a plan
 * that names another executor is left alone (the plan author said where it runs).
 */
export function bindSelectedOffer(plan: Plan, binding: SelectedOfferBindingV1 | null | undefined): Plan {
  if (!binding) return plan;
  return {
    ...plan,
    steps: plan.steps.map((st) => {
      if (st.toolId !== binding.capability || typeof st.executor === 'string') return st;
      return { ...st, executor: binding.provider, args: { ...(st.args ?? {}), offerDigest: binding.offerDigest } };
    }),
  };
}

/** The sentence a parked run's ask ends with when a campaign selected a provider. */
export function selectedProviderClause(binding: SelectedOfferBindingV1): string {
  return `Hand it to ${binding.providerName ?? binding.provider} under its offer ${binding.offerId}.`;
}

/** What the endeavor is told: who was asked, what each said, who was selected and why, who was not and why —
 *  and that the organization's steward still signs. The selection travels as a fenced record so a reader (or
 *  a gate) finds the `ap.offer-selection.v1` document, not a paraphrase of it. */
export function campaignNote(input: { capability: string; principal: Address; outcome: CampaignOutcome; runRef: string; stepDescription: string; because: 'interaction-step' | 'not-in-own-offer-set' }): string {
  const { outcome } = input;
  const why = input.because === 'interaction-step' ? 'the plan made this step an interaction with another party' : `${input.principal} does not do ${input.capability} itself`;
  const asked = outcome.rows.length
    ? outcome.rows.map((r) => `- ${r.name ?? r.agent}: ${r.kind ?? r.state}${r.reason ? ` (${r.reason})` : ''}${r.refused ? ` — ${r.refused}` : ''}${r.offer ? ` — offer ${r.offer.offerId}, expires ${r.offer.expiresAt}` : ''}`).join('\n')
    : '- nobody: discovery found no candidate to ask';
  const sel = outcome.selection;
  const decided = sel
    ? [`**Selected ${outcome.binding?.providerName ?? sel.selected.provider}** because: ${sel.because.join('; ')}.`, ...(sel.notSelected.length ? [`Not selected: ${sel.notSelected.map((n) => `${n.provider} — ${n.because}`).join('; ')}.`] : [])]
    : ['**No offer was selected.** The step stays open; a steward can ask this agent to do it another way.'];
  return [
    `This step needs **${input.capability}**, and ${why}. Asked ${outcome.campaign.candidates.length} agent(s) (of at most ${outcome.campaign.maxCandidates}; deadline ${outcome.campaign.deadline}):`,
    asked,
    '',
    `“${input.stepDescription.trim()}”`,
    '',
    ...decided,
    '',
    ...(sel && outcome.binding
      ? [`A steward authorizes it by asking this agent to do it and granting the mandate that NAMES offer ${sel.selected.offerId} (digest ${sel.selected.offerDigest}) — the run is waiting as \`${input.runRef}\`. An offer is the provider's commitment; nothing runs until the organization's mandate binds it.`]
      : [`The run is waiting as \`${input.runRef}\`.`]),
    '',
    '```ap.offer-selection.v1',
    JSON.stringify(sel ?? { type: 'ap.offer-selection.v1', campaignId: outcome.campaign.campaignId, selected: null, because: [], notSelected: outcome.evaluations.map((e) => ({ offerId: e.offerId ?? '', provider: e.provider, because: e.because })), decidedAt: new Date().toISOString() }),
    '```',
  ].join('\n');
}
