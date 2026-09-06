// THE ENGINE-FREE HALF of the approval workflow — spec 362. This module imports nothing from
// `cloudflare:*`, which is what lets the four gates be unit-tested against a fake DurableStepPort while
// the class in harness-workflow.ts stays a thin adapter. The division IS the design: this file knows the
// flow's meaning; the class knows only how Cloudflare persists it.
import { TerminalDenial, type DurableStepPort, type ApprovalEventV1 } from '@agenticprimitives/orchestration';

export interface AttemptOutcome {
  outcome: string;
  error?: string;
  awaiting?: { kind: string; stepRef: string } | null;
}

/** Runs ONE whole attempt: load the run's CURRENT inputs, re-verify everything, reconcile, act. The
 *  approvals list carries REFERENCES; the attempt's own ports verify the evidence they point at. */
export type AttemptFn = (approvals: Array<{ approvalRef: string }>) => Promise<AttemptOutcome>;

/**
 * The worked flow: attempt → (suspended?) durable wait for the custodian → attempt again.
 *
 * Gate 1 (revoked while waiting): attempt-2 re-verifies mandate CURRENCY — the wake is not the permit.
 * Gate 2 (transient failure then revocation): a retry re-runs the WHOLE attempt; no verdict survives.
 * Gate 3 (acted but checkpoint lost): the attempt reconciles first (intent-derived nonce → already
 *   settled) — recovery finds the outcome instead of repeating it.
 * Gate 4 (resume after completion): a completed attempt's outcome replays from the engine's checkpoint;
 *   its callback — and therefore any act — does not run again.
 *
 * A DENIAL THROWS TerminalDenial: the adapter maps it to the engine's non-retry mechanism. Retrying a
 * revocation as weather is the named anti-pattern.
 */
export async function driveApprovalFlow(
  step: DurableStepPort,
  attempt: AttemptFn,
  opts: { approvalTimeoutMs: number },
): Promise<AttemptOutcome> {
  // A DENIAL IS AN OUTCOME, NOT AN ENGINE ERROR. Returned — and therefore checkpointed — as the fact it
  // is ("this attempt was refused at T"), which also ends retries for free: an engine never retries a
  // result. A re-driven flow replays the denial, correctly: a denial is terminal for THIS run, and a new
  // authorization decision is a new run. `TerminalDenial` remains for an attempt that THROWS one (the
  // runner's own verifier); the adapter maps that to the engine's non-retry path.
  const guarded = (name: string, approvals: Array<{ approvalRef: string }>): Promise<AttemptOutcome> =>
    step.attempt(name, async () => {
      try {
        return await attempt(approvals);
      } catch (e) {
        if (e instanceof TerminalDenial) return { outcome: 'denied', error: e.message };
        throw e;
      }
    });

  const first = await guarded('attempt-1', []);
  if (first.outcome !== 'suspended') return first;

  let evt: ApprovalEventV1;
  try {
    evt = await step.waitForEvent<ApprovalEventV1>('custodian-decision', { type: 'custodian-decision', timeoutMs: opts.approvalTimeoutMs });
  } catch {
    // Expiry is an OUTCOME, not a failure: nothing was acted, and the task should say exactly that.
    return { outcome: 'expired', error: 'the approval window closed with no decision — nothing was acted' };
  }
  return guarded('attempt-2', [{ approvalRef: String(evt?.approvalRef ?? '') }]);
}
