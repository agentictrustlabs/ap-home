// Spec 382 (appendix M6 W1) — WHICH COMMITTED STEPS ARE HANDED TO WHICH PARTICIPANT. Pure: the reduced
// state and the events a commit appended in, the runs to park out. The compile is the coordination
// package's (`compilePlanToExecutionIntents`: one intent per active commitment × step, bound to the
// adopted revision hash, fail-closed on a stale commitment) — this file only picks the intents the NEW
// commitments produced, for actors other than the managing principal, on steps not yet satisfied.
import { compilePlanToExecutionIntents, planKey, type CoordinationStateV1 } from '@agenticprimitives/coordination';
import type { Address } from 'viem';
import type { WorkStep } from './endeavor-authority-steps.js';

export interface ParkableCommittedStep {
  participant: Address;
  step: WorkStep;
  commitmentRef: string;
  planHash: string;
  goal: string;
}

export function parkableCommittedSteps(state: CoordinationStateV1, events: ReadonlyArray<{ kind?: string; commitmentId?: string }>, principal: string): { steps: ParkableCommittedStep[]; reason?: string } {
  const committed = new Set(events.filter((e) => e.kind === 'ContributionCommitted' && typeof e.commitmentId === 'string').map((e) => String(e.commitmentId)));
  if (!committed.size) return { steps: [] };
  const endeavor = state.endeavor;
  const ref = endeavor?.adoptedPlanRef;
  if (!endeavor || !ref) return { steps: [], reason: 'no adopted plan' };
  const plan = state.plans[planKey(ref.planId, ref.revision)];
  if (!plan) return { steps: [], reason: `adopted plan revision ${planKey(ref.planId, ref.revision)} not in state` };
  const out = compilePlanToExecutionIntents({ endeavor, plan, commitments: Object.values(state.commitments) });
  if (!out.ok) return { steps: [], reason: out.reason };
  const goal = (state.request?.record.goal ?? endeavor.title ?? '').trim();
  const me = principal.toLowerCase();
  const steps: ParkableCommittedStep[] = [];
  for (const intent of out.intents) {
    const pv = intent.provenance;
    if (!committed.has(pv.commitmentRef)) continue;
    if (pv.actor.toLowerCase() === me) continue; // the organization's own commitment: its work turn runs it
    if (state.satisfiedSteps[pv.stepId]) continue;
    const ps = plan.steps.find((s) => s.stepId === pv.stepId);
    if (!ps) continue;
    steps.push({
      participant: pv.actor.toLowerCase() as Address,
      step: { stepId: ps.stepId, kind: ps.kind, description: ps.description, ...(ps.capabilityRequirements?.length ? { capabilityRequirements: ps.capabilityRequirements.map((c) => ({ capabilityIri: c.capabilityIri })) } : {}) },
      commitmentRef: pv.commitmentRef,
      planHash: pv.planHash,
      goal,
    });
  }
  return { steps };
}
