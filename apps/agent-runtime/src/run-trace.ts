// THE TRACE FROM THE DOOR, AS THIS DEPLOYMENT KNOWS IT — spec 414 A1b.
//
// The package says what a run record carries (`orchestration` trace-facts: door, model calls, variant, engagements);
// this file fills it from what this runtime already holds: the A2A request that arrived, the planner's trace
// (`PlannerTraceV1` — which planner, which model, which route and why), and the deployment's own knobs. Names and
// numbers only. A token count is recorded only when a provider REPORTED one — an estimate is not a measurement, so
// the budget's estimate never lands in `tokensIn`.
//
// Door kinds are decided HERE, server-side, never taken from a body a caller wrote: an in-process hop from the A2A
// door (the in-Worker mark) may name its message ids; anything else is what the route itself can see.
import type { HarnessEngagementV1, ModelCallV1, RunDoorV1, VariantV1 } from '@agenticprimitives/orchestration';
import type { PlannerTraceV1 } from './harness-run.js';

/** The deployment knobs that are harness-capability toggles, by notation. */
export interface RunTraceEnv {
  KB_RETRIEVAL?: string;
  ORCHESTRATION_ROUTE?: string;
  /** The runtime's build (a deployment version id or commit), when the deploy names one. */
  HARNESS_BUILD?: string;
}

/** A route reason is the router's own words about numbers — bounded, so it can never carry a body (shape R6). */
const reason = (s: string | undefined): string | undefined => (s ? s.slice(0, 200) : undefined);

/** The A2A message the run answered: its message, context and task ids. */
export function a2aDoor(message: { messageId?: string; contextId?: string } | undefined, task: { id?: string; contextId?: string } | undefined): RunDoorV1 {
  return {
    kind: 'a2a-message',
    ...(message?.messageId ? { messageId: message.messageId } : {}),
    ...(message?.contextId ?? task?.contextId ? { contextId: (message?.contextId ?? task?.contextId)! } : {}),
    ...(task?.id ? { taskId: task.id } : {}),
  };
}

/** A door named in a request body is believed only when the request is an in-process hop from this Worker's own
 *  A2A door (the in-Worker mark); otherwise the route says what it can see for itself. */
export function doorFromBody(body: unknown, inWorker: boolean): RunDoorV1 | null {
  if (!inWorker || !body || typeof body !== 'object') return null;
  const d = (body as { door?: unknown }).door as Partial<RunDoorV1> | undefined;
  if (!d || d.kind !== 'a2a-message') return null;
  const id = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length <= 128 ? v : undefined);
  return { kind: 'a2a-message', ...(id(d.messageId) ? { messageId: id(d.messageId)! } : {}), ...(id(d.contextId) ? { contextId: id(d.contextId)! } : {}), ...(id(d.taskId) ? { taskId: id(d.taskId)! } : {}) };
}

const PLANNER_KINDS = new Set(['supplied', 'compiled', 'rule-based']);
/** supplied | compiled | rule-based stay what they are; any provider name is a model planner. */
export const plannerKindOf = (planner: string | undefined): string | undefined => (!planner ? undefined : PLANNER_KINDS.has(planner) ? planner : 'model');

/** The model calls the planner trace names: the plan (when a model proposed it), the composer, each structured call. */
export function modelCallsOf(trace: PlannerTraceV1 | undefined, marks?: ReadonlyArray<{ name: string; startMs: number; endMs: number }>): ModelCallV1[] {
  if (!trace) return [];
  const out: ModelCallV1[] = [];
  if (plannerKindOf(trace.planner) === 'model') {
    out.push({
      role: 'plan',
      ...(trace.model ? { model: trace.model } : {}),
      provider: trace.route?.planner?.provider ?? trace.planner,
      ...(trace.promptDigest ? { promptDigest: trace.promptDigest } : {}),
      ...(reason(trace.route?.planner?.because) ? { routeReason: reason(trace.route?.planner?.because)! } : {}),
    });
  }
  const compose = trace.route?.composer;
  if (compose?.provider) {
    const w = marks?.find((m) => m.name === 'reply:compose');
    out.push({ role: 'compose', provider: compose.provider, ...(reason(compose.because) ? { routeReason: reason(compose.because)! } : {}), ...(w ? { startMs: w.startMs, endMs: w.endMs } : {}) });
  }
  for (const s of trace.route?.structured ?? []) if (s.provider) out.push({ role: 'structured', provider: s.provider, ...(reason(s.because) ? { routeReason: reason(s.because)! } : {}) });
  return out;
}

/** Engagements only the planner trace can see (spec 414 §3.2): a binding a STANDING instruction supplied (394), a
 *  binding remembered from a prior CONFIRMATION (385), and an admission that ran and changed nothing (a refusal is
 *  on the record's events and is derived there). Each is run-level: the binding shaped the plan's arguments. */
export function engagedFromTrace(trace: PlannerTraceV1 | undefined): HarnessEngagementV1[] {
  if (!trace) return [];
  const out: HarnessEngagementV1[] = [];
  if (trace.bindings?.some((b) => b.source === 'standing')) out.push({ capability: 'standing-instructions', effect: 'changed-plan' });
  if (trace.bindings?.some((b) => b.source === 'memory')) out.push({ capability: 'confirmation-memory', effect: 'changed-plan' });
  if (trace.admission?.length && trace.admission.every((a) => !a.refused.length)) out.push({ capability: 'plan-admission', effect: 'no-change' });
  return out;
}

/** The variant this run ran under: the playbook, the planner kind, the route policy, the build, the toggles. */
export function variantOf(env: RunTraceEnv, trace: PlannerTraceV1 | undefined): VariantV1 {
  const toggles: Record<string, string> = {};
  const kb = (env.KB_RETRIEVAL ?? '').trim().toLowerCase();
  if (kb) toggles['retrieval/kb'] = kb;
  const policy = trace?.route?.policy ?? ((env.ORCHESTRATION_ROUTE ?? '').trim() || undefined);
  const kind = plannerKindOf(trace?.planner);
  const build = (env.HARNESS_BUILD ?? '').trim();
  return {
    ...(trace?.playbook?.digest ? { playbook: trace.playbook.digest } : {}),
    ...(kind ? { plannerKind: kind } : {}),
    ...(policy ? { routePolicy: String(policy) } : {}),
    ...(build ? { build } : {}),
    ...(Object.keys(toggles).length ? { toggles } : {}),
  };
}
