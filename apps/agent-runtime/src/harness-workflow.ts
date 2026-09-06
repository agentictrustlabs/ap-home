// THE FIRST DURABLE-EXECUTOR BINDING — spec 362 §3: Cloudflare Workflows advancing a harness run.
//
// A THIN ADAPTER by construction: the flow's meaning lives in harness-workflow-core.ts (engine-free,
// unit-tested against the four gates); this class only maps the Ring-0 DurableStepPort onto Cloudflare's
// WorkflowStep and TerminalDenial onto NonRetryableError. `A2aTaskDO` keeps the canonical run — this
// instance's id IS the runRef — and receipts/artifacts go where they always go; engine history is a
// 3–30-day operational log, never provenance (ADR-0055).
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { TerminalDenial, type DurableStepPort } from '@agenticprimitives/orchestration';
import { driveApprovalFlow, type AttemptOutcome, type AttemptFn } from './harness-workflow-core.js';
import type { DelegationWireV1 } from '@agenticprimitives/a2a';

/** INPUTS, never conclusions — the checkpoint law applied to workflow params: enough to re-enter the
 *  run from nothing, re-planned and re-verified per attempt. */
export interface HarnessWorkflowParams {
  runRef: string;
  addressee: string;
  person: string;
  session: string;
  intent: { goal: string; constraints?: Record<string, unknown>; context?: Record<string, unknown> };
  presented: DelegationWireV1 | DelegationWireV1[] | null;
  plan?: { steps: Array<{ toolId: string; args: Record<string, unknown>; id?: string }> };
  approvalTimeoutMs?: number;
}

/** Bound by index.ts at module load — the Worker-side executor (harnessDeps + runUnderMandate). The
 *  indirection exists because harnessDeps lives with the routes and importing it here would be a cycle. */
export type HarnessAttemptRunner = (env: unknown, params: HarnessWorkflowParams, approvals: Array<{ approvalRef: string }>) => Promise<AttemptOutcome>;
let runner: HarnessAttemptRunner | null = null;
export function bindHarnessAttempt(fn: HarnessAttemptRunner): void { runner = fn; }

/** Cloudflare's WorkflowStep, seen through the Ring-0 port. */
function portOf(step: WorkflowStep): DurableStepPort {
  return {
    attempt: <T>(name: string, fn: () => Promise<T>): Promise<T> =>
      // The generic squeezes through Rpc.Serializable by cast: every value this flow persists is a plain
      // AttemptOutcome, and the PORT stays honest-generic so Ring 0 never learns Cloudflare's constraint.
      step.do(
        name,
        { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '5 minutes' },
        (async () => {
          try {
            return await fn();
          } catch (e) {
            // A denial is terminal, not weather — stop the engine's retry machinery.
            if (e instanceof TerminalDenial) throw new NonRetryableError(e.message);
            throw e;
          }
        }) as never,
      ) as unknown as Promise<T>,
    waitForEvent: async <T>(name: string, opts: { type: string; timeoutMs: number }): Promise<T> => {
      const evt = (await step.waitForEvent(name, { type: opts.type, timeout: `${Math.ceil(opts.timeoutMs / 1000)} seconds` })) as unknown as { payload: T };
      return evt.payload;
    },
    sleepUntil: (name: string, at: Date) => step.sleepUntil(name, at),
  };
}

export class HarnessApprovalWorkflow extends WorkflowEntrypoint<unknown, HarnessWorkflowParams> {
  override async run(event: WorkflowEvent<HarnessWorkflowParams>, step: WorkflowStep): Promise<AttemptOutcome> {
    const p = event.payload;
    if (!runner) throw new NonRetryableError('harness attempt runner not bound');
    const attempt: AttemptFn = (approvals) => runner!(this.env, p, approvals);
    return driveApprovalFlow(portOf(step), attempt, { approvalTimeoutMs: p.approvalTimeoutMs ?? 24 * 60 * 60 * 1000 });
  }
}
