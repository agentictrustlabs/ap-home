// User-facing vocabulary for the coordination Work surfaces — ONE term map so
// every screen speaks the same plain language over the spec-332 internals:
//   lifecycle 'satisfied'      → "Completed"     (step-level: "Done")
//   'adopted' (plan pending)   → "Planning"
//   ContributionAllocated      → "Work assigned"
//   commitment                 → "commitment" (kept — it IS a signed act)
// The internal nouns stay on the wire and in provenance tooltips; the labels
// are display-only.
import type { CSSProperties } from 'react';
import type { EndeavorLifecycle } from '@agenticprimitives/home';

export const LIFECYCLE_LABEL: Record<EndeavorLifecycle, string> = {
  proposed: 'Requested',
  adopted: 'Planning',
  active: 'In progress',
  suspended: 'Paused',
  satisfied: 'Completed',
  abandoned: 'Closed',
};

/** Status-pill styling per lifecycle — existing design tokens only. */
export const LIFECYCLE_PILL: Record<EndeavorLifecycle, { bg: string; fg: string; border: string }> = {
  proposed: { bg: 'var(--color-surface-sunken, #f4f4f2)', fg: 'var(--color-text-muted, #6b7280)', border: 'var(--color-border)' },
  adopted: { bg: 'var(--color-amber-50, #fffbeb)', fg: 'var(--color-amber-700, #b45309)', border: 'var(--color-amber-400, #fbbf24)' },
  active: { bg: 'var(--color-sage-50, #f0f7f2)', fg: 'var(--color-sage-700, #2f6846)', border: 'var(--color-sage-500, #5f9b76)' },
  suspended: { bg: 'var(--color-surface-sunken, #f4f4f2)', fg: 'var(--color-text-muted, #6b7280)', border: 'var(--color-border)' },
  satisfied: { bg: 'var(--color-sage-100, #dfeee4)', fg: 'var(--color-sage-700, #2f6846)', border: 'var(--color-sage-500, #5f9b76)' },
  abandoned: { bg: 'var(--color-surface-sunken, #f4f4f2)', fg: 'var(--color-text-faint, #9ca3af)', border: 'var(--color-border)' },
};

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

export function StatusPillStyle(lc: EndeavorLifecycle): CSSProperties {
  const p = LIFECYCLE_PILL[lc];
  return {
    display: 'inline-block',
    padding: '0.1rem 0.55rem',
    borderRadius: 999,
    fontSize: '0.7rem',
    fontWeight: 600,
    background: p.bg,
    color: p.fg,
    border: `1px solid ${p.border}`,
    whiteSpace: 'nowrap',
  };
}
