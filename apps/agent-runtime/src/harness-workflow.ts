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

/**
 * REFS ONLY — spec 362 §6.1. The first cut persisted the session token, the person's words, the signed
 * wires and the plan args into ENGINE instance storage: retained for days, outside our keys, outside
 * the vault. A session token at rest in an engine log is a bearer; a signed wire is a credential; the
 * goal text is the person's words. The checkpoint law taken literally: the engine holds the HANDLE, and
 * every attempt re-loads the content from `harness:run:<runRef>` on `A2aTaskDO` — already the record,
 * already TTL'd, already ours. `check:workflow-params-are-refs` fails the build if this type ever grows
 * a content-class field.
 */
export interface HarnessWorkflowParams {
  runRef: string;
  /** WHERE the checkpoint lives (the DO is keyed by the addressee). An address is a ref (§6 table). */
  addressee: string;
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
