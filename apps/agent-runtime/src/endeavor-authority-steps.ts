// WHEN A WORK STEP NEEDS AUTHORITY — spec 350 W3 / spec 334 §6, the binding between coordination and
// the harness.
//
// The auto-work turn's own comment states the boundary it could not cross: "doing work composes no MCP
// tools and grants nothing (ADR-0041) — the deliverable is a text artifact the agent authored, recorded
// as evidence; any real-world effect still flows through an explicit, separately-authorized capability,
// never inferred from this note." So a plan step that says "charter the corridor team" was satisfied by
// a paragraph SAYING it, and the endeavor read as complete with nothing chartered.
//
// The fix is not to let the work turn act. It is to notice that this step is not writing work at all:
//
//   a step that names a CAPABILITY this substrate can exercise is AUTHORITY-BEARING. It cannot be
//   satisfied by prose, and it must not be executed by an agent nobody authorized. It becomes WORK
//   WAITING ON A PERSON — a durable run (W3), checkpointed under the endeavor, that a steward finishes
//   by granting the mandate in their Ask.
//
// That is what a work item is for. The endeavor records what is owed and to whom; the run carries the
// question; the mandate is the authorization; and when it completes, the step's evidence is the RECEIPT —
// the run, the mandate and (when the effect was on chain) the transaction — instead of a note claiming
// it happened. A reader of the endeavor can tell the difference, which is the whole point.
import type { HarnessRunCheckpointV1 } from './harness-runs.js';
import type { Address } from 'viem';
import { selectedProviderClause, type SelectedOfferBindingV1 } from './engagement-campaign.js';

/**
 * The capability ids a PLAN STEP may be taken to exercise. Kept as a list rather than derived from the
 * tool set so the coordination side names what it means, and an unrelated tool appearing in the harness
 * never silently changes what a plan step is taken to be.
 *
 * IT IS DELIBERATELY NARROWER than the set of capabilities that require a mandate. `treasury.fund`,
 * `messaging.direct.send` and `resolution.invitation.request` all need one in the harness and are all
 * absent here — because an endeavor step is a unit of WORK someone is accountable for finishing, and
 * those three are things an agent does in passing while doing the work rather than milestones a plan is
 * built out of. Sending a message is not a deliverable.
 *
 * The omissions being intentional is exactly why they need a guard: a renamed capability, or one dropped
 * from the harness, would leave a dead string here and nobody would notice. `check:authority-capabilities`
 * asserts every id is still a real mandate-bearing capability, and that each absence is named above.
 */
export const AUTHORITY_BEARING_CAPABILITIES: readonly string[] = [
  'organization.team.create',
  'organization.create',
  // A household is an organization of kin (spec 368 — HouseholdAgent ⊑ OrganizationAgent): chartering one
  // is the same class of step as chartering an organization or a team.
  'household.create',
  // Spec 372 S3 — a service agent (the identity an outside runtime acts as) is chartered the same way.
  'service.create',
  'organization.membership.invite',
  'treasury.create',
  'treasury.payment.execute',
];

/** The mandate-bearing capabilities this list deliberately does NOT treat as plan steps. Named, so the
 *  guard can tell a considered omission from one that happened by accident. */
export const NOT_PLAN_STEPS: readonly string[] = [
  // Spec 370 P4 — the coordination plane's OWN commands (request, propose, allocate, satisfy) are how a
  // plan comes to exist and moves; a plan step that allocated or closed an endeavor would be coordination
  // coordinating itself. They are Ask capabilities, never assignable work.
  'coordination.endeavor.request',
  'coordination.contribution.propose',
  'coordination.contribution.allocate',
  'coordination.endeavor.satisfy',
  'coordination.milestone.achieve',
  'treasury.fund',
  'messaging.direct.send',
  'resolution.invitation.request',
  // A PREFERENCE IS NOT WORK. "Payments to me come here" is a standing statement its owner makes about
  // their own tree — nobody assigns it, nothing waits on it, and putting it in a plan would invite an
  // endeavor to decide where someone else's money should land.
  'treasury.primary.declare',
  // Revoking access is HYGIENE, not assignable work. A plan that could revoke someone's access as one
  // of its steps is a plan that can quietly cut a person off from what they were doing.
  'access.grant.revoke',
  // A person's own contact details are not assignable work either — and this one needs no mandate at
  // all, so a plan step for it would be a step with nothing to authorize.
  'profile.contact.update',
  // Nor is recording who you live with: it needs no mandate at all, so a plan step for it would be a
  // step with nothing to authorize.
  'household.member.record',
];

/** A plan step as the work loop sees it. */
export interface WorkStep {
  stepId: string;
  kind: string;
  description: string;
  capabilityRequirements?: Array<{ capabilityIri: string }>;
}

/**
 * Does this step exercise a capability, and which? A step names it in `capabilityRequirements`
 * (the plan skill makes the model answer with an explicit "none" rather than omitting the field, so an
 * absent capability is a decision and not a gap). We accept a bare id or an `urn:ap:cap:<id>` IRI, and
 * nothing else: a `urn:skills:cap:*` roster entry routes to a SPECIALIST, which is a different thing.
 */
export function authorityCapabilityOf(step: WorkStep): string | null {
  for (const r of step.capabilityRequirements ?? []) {
    const raw = String(r.capabilityIri ?? '').trim();
    if (!raw || raw === 'none') continue;
    const id = raw.startsWith('urn:ap:cap:') ? raw.slice('urn:ap:cap:'.length) : raw;
    if (AUTHORITY_BEARING_CAPABILITIES.includes(id)) return id;
  }
  return null;
}

/**
 * The ask a steward will be answering. The step's OWN words lead, because the step is what was planned and
 * adopted — restating it in ours would put the harness to work on a question nobody agreed to.
 *
 * But the words alone are not the ask. A plan step is written for people ("Create the corridor
 * organization under the authorized steward"), and handed to the harness as prose it planned a READ and
 * answered the question rather than doing the thing. The step had already declared which capability it
 * needs; dropping that on the way across threw away the only structure we had. So the ask carries both:
 * the sentence that was adopted, and the capability and principal it was adopted as.
 */
export function askForStep(step: WorkStep, goal: string, capability?: string, principal?: Address): string {
  const d = step.description.trim();
  const words = d.length >= 12 ? d : `${d} (for: ${goal})`.trim();
  return capability ? `${words}\n\nDo this by exercising ${capability}${principal ? ` as ${principal}` : ''}.` : words;
}

/** The checkpoint a waiting step becomes. `asker` is the PRINCIPAL, not a person: nobody has picked this
 *  up yet. `openToStewards` says so — see `claimableBy`. */
export function checkpointForStep(input: {
  runRef: string; principal: Address; endeavorId: string; step: WorkStep; goal: string; now?: number;
  /** Spec 384 W3 — a campaign selected a provider: the step is handed to it and the mandate must name its offer. */
  engagement?: SelectedOfferBindingV1 | null;
}): HarnessRunCheckpointV1 {
  const now = input.now ?? Date.now();
  const ask = askForStep(input.step, input.goal, authorityCapabilityOf(input.step) ?? undefined, input.principal);
  return {
    runRef: input.runRef,
    message: input.engagement ? `${ask} ${selectedProviderClause(input.engagement)}` : ask,
    addressee: input.principal,
    asker: input.principal,
    presented: [],
    supplied: [],
    openToStewards: true,
    origin: { endeavorId: input.endeavorId, stepId: input.step.stepId, principal: input.principal, ...(input.engagement ? { engagement: input.engagement } : {}) },
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Spec 384 W3 — DOES THIS STEP ENGAGE ANOTHER PARTY? Two facts decide it, both modelled, neither guessed:
 *   - the plan made the step an INTERACTION (`kind: 'interaction'` — a p-plan step that is an exchange with
 *     another agent, not a contribution the organization makes itself); or
 *   - the capability is outside the organization's OWN offer set (its compiled playbook, else the bare harness:
 *     the same set the Ask sees and the probe answerer decides from), so it cannot keep the step itself.
 * A `contribution` the organization can do stays its own: parked to its stewards as before.
 */
export function engagesProvider(step: WorkStep, capability: string, ownOffers: ReadonlySet<string>): 'interaction-step' | 'not-in-own-offer-set' | null {
  if (step.kind === 'interaction') return 'interaction-step';
  if (!ownOffers.has(capability)) return 'not-in-own-offer-set';
  return null;
}

/**
 * May this caller resume this run?
 *
 * Ownership here protects a person's HALF-FINISHED ANSWERS — their signatures, the credential they named
 * — from being driven by somebody else. A work item awaiting authority has none of that: nobody has
 * answered anything, and the only way to advance it is to present a mandate, which requires custody of
 * the principal. So an unclaimed work item is claimable by whoever can actually authorize it, and the
 * moment a person answers into it, it is theirs.
 *
 * The gate on ADVANCING a run is always the mandate, never this.
 */
export function claimableBy(checkpoint: Pick<HarnessRunCheckpointV1, 'asker' | 'openToStewards' | 'supplied'>, caller: Address): boolean {
  if (checkpoint.asker.toLowerCase() === caller.toLowerCase()) return true;
  return !!checkpoint.openToStewards && checkpoint.supplied.length === 0;
}

/** What the endeavor is told while the step waits. Names the capability, the principal whose authority is
 *  needed, and the run to resume — a note that says "blocked" without saying by what is a step nobody
 *  can unblock. */
export function awaitingAuthorityNote(input: { capability: string; principal: Address; runRef: string; step: WorkStep }): string {
  return [
    `This step needs authority nobody has granted yet: **${input.capability}** as ${input.principal}.`,
    '',
    `“${input.step.description.trim()}”`,
    '',
    `A steward can authorize it by asking this agent to do it and granting the mandate it asks for — the run is waiting as \`${input.runRef}\`.`,
    'Until then the step stays open: an agent that cannot be authorized to do a thing must not report it done.',
  ].join('\n');
}

/**
 * The evidence a step carries when a capability actually ran. The free-text note keeps the existing
 * display path working; the receipt refs are the part a reader can check — the run it came from, the
 * mandate that authorized it, and the transaction if the effect was on chain.
 *
 * This is the difference the binding exists to make: "the agent says it did it" versus "here is what
 * authorized it and what it did".
 */
export function receiptEvidence(input: {
  capability: string; runRef: string; mandateRef?: string | null; txHash?: string | null; summary: string;
  /** Spec 382 — the signed commitment this run fulfilled, when the step was a participant's. */
  commitmentRef?: string | null;
  /** Spec 384 W3 — the provider's offer the mandate named, when a campaign selected one. */
  offerDigest?: string | null;
  /** Spec 384 W4 — the fulfillment receipt that closes the engagement, by digest. */
  fulfillmentDigest?: string | null;
}): { note: string; refs: string[] } {
  const refs = [
    `urn:ap:receipt:run:${input.runRef}`,
    ...(input.mandateRef ? [`urn:ap:receipt:mandate:${input.mandateRef}`] : []),
    ...(input.txHash ? [`urn:ap:receipt:tx:${input.txHash}`] : []),
    ...(input.commitmentRef ? [`urn:ap:receipt:commitment:${input.commitmentRef}`] : []),
    ...(input.offerDigest ? [`urn:ap:receipt:offer:${input.offerDigest}`] : []),
    ...(input.fulfillmentDigest ? [`urn:ap:receipt:fulfillment:${input.fulfillmentDigest}`] : []),
  ];
  const note = [
    input.summary.trim(),
    `Authorized: ${input.capability}${input.mandateRef ? ` under mandate ${input.mandateRef.slice(0, 18)}…` : ''}${input.txHash ? `, on chain in ${input.txHash.slice(0, 18)}…` : ''}.`,
  ].join(' ');
  return { note, refs };
}

// ── Spec 382 (appendix M6) — A COMMITTED STEP RUNS AT THE PARTICIPANT ────────────────────────────────
//
// A signed ContributionCommitment is a promise, never authority (spec 332 §9 rule 1). So the step a
// participant committed to is not run by the organization: it becomes a run WAITING ON THAT PARTICIPANT,
// on their own agent's task object, finished by them presenting their own mandate — the same shape as a
// step awaiting a steward's authority (`checkpointForStep`), addressed to the person who promised it.

/** The checkpoint a committed step becomes at the participant. `asker` IS the participant: it is theirs
 *  to finish and nobody else's (`claimableBy`); the organization's only part was to record the promise. */
export function checkpointForCommittedStep(input: {
  runRef: string; participant: Address; principal: Address; endeavorId: string; step: WorkStep; goal: string;
  commitmentRef: string; planHash: string; now?: number;
}): HarnessRunCheckpointV1 {
  const now = input.now ?? Date.now();
  const capability = authorityCapabilityOf(input.step) ?? undefined;
  return {
    runRef: input.runRef,
    // The capability is exercised AS THE PARTICIPANT — their treasury, their invitation — never as the
    // organization: that is what "committed to" means, and it is why allocation grants nothing.
    message: askForStep(input.step, input.goal, capability, input.participant),
    addressee: input.participant,
    asker: input.participant,
    presented: [],
    supplied: [],
    openToStewards: false,
    origin: { endeavorId: input.endeavorId, stepId: input.step.stepId, principal: input.principal, commitmentRef: input.commitmentRef, planHash: input.planHash },
    createdAt: now,
    updatedAt: now,
  };
}

/** What the endeavor is told when a committed step is handed to its participant. */
export function committedStepNote(input: { participant: Address; name?: string | null; runRef: string; step: WorkStep; commitmentRef: string }): string {
  const who = input.name ? `${input.name} (${input.participant})` : input.participant;
  return [
    `**${who}** committed to this step (commitment \`${input.commitmentRef}\`) — it now waits on their own agent as \`${input.runRef}\`.`,
    '',
    `“${input.step.description.trim()}”`,
    '',
    'They finish it by asking their agent to do it and granting the mandate it asks for; the step is recorded done from their receipt.',
    'A commitment is a promise, never authority: the organization does not run it for them, and the step stays open until they do.',
  ].join('\n');
}
