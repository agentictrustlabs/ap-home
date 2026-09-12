// User-facing vocabulary for the coordination Work surfaces — ONE term map so
// every screen speaks the same plain language over the spec-332 internals:
//   lifecycle 'satisfied'      → "Completed"     (step-level: "Done")
//   'adopted' (plan pending)   → "Planning"
//   ContributionAllocated      → "Work assigned"
//   commitment                 → "commitment" (kept — it IS a signed act)
// The internal nouns stay on the wire and in provenance tooltips; the labels
// are display-only.
import type { EndeavorLifecycle } from '@agenticprimitives/home';
import { stateOf, type ProjectedRunStateV1 } from '../../../home/run-state';

export const LIFECYCLE_LABEL: Record<EndeavorLifecycle, string> = {
  proposed: 'Requested',
  adopted: 'Planning',
  active: 'In progress',
  suspended: 'Paused',
  satisfied: 'Completed',
  abandoned: 'Closed',
};

/** Spec 398 §5.1 — an endeavor's lifecycle shown through the ONE state vocabulary (`proposed` → drafted, `adopted` →
 *  queued, `active` → running, `suspended` → blocked, `satisfied` → completed, `abandoned` → canceled). The domain's
 *  own word (`LIFECYCLE_LABEL`) is the pill's tooltip, never its text. */
export function lifecycleState(lc: EndeavorLifecycle | string): ProjectedRunStateV1 & { unknownNative?: string } {
  return stateOf({ kind: 'endeavor', lifecycle: String(lc) });
}

export const STEP_KIND_LABEL: Record<string, string> = {
  contribution: 'work',
  interaction: 'coordinate',
  decision: 'decide',
  aggregation: 'combine',
  validation: 'verify',
};

export const EVENT_LABEL: Record<string, string> = {
  EndeavorRequestSubmitted: 'Request submitted',
  EndeavorRequestDeclined: 'Request declined',
  EndeavorAdopted: 'Accepted as an endeavor',
  OutcomeRevised: 'Outcome updated',
  PlanProposed: 'Plan drafted',
  PlanAdopted: 'Plan adopted',
  PlanRejected: 'Plan rejected',
  ParticipationInvited: 'Participant invited',
  ParticipationAsserted: 'Joined as participant',
  ParticipationWithdrawn: 'Participant withdrew',
  ContributionProposed: 'Offered to help',
  ContributionAllocated: 'Work assigned',
  ContributionCommitted: 'Commitment signed',
  CommitmentWithdrawn: 'Commitment withdrawn',
  ContributionReallocated: 'Work reassigned',
  PlanStepSatisfied: 'Step completed',
  MilestoneAchieved: 'Milestone reached',
  EndeavorSatisfied: 'Marked complete',
  EndeavorAbandoned: 'Closed',
};

