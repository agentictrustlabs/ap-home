// THE FLOW TRACE — spec 387 W2 instrumentation. An outside caller (the AP Gateway, on behalf of an assistant)
// sees ONE task; what happened inside it — which playbook admitted the run, what the planner was offered and
// chose, each tool the run invoked with what it returned, what the composer wrote — was visible only in this
// Worker's logs. This puts that story on the task itself as a `trace` artifact, so the caller (and whoever
// reads the assistant's transcript) can see every hop's output in order.
//
// A trace is EVIDENCE OF WHAT RAN, never authority and never private data: it carries tool ids, arguments,
// outcome flags and SUMMARIES of results (the results themselves ride as the `results` artifact when they
// are the deliverable); it never carries a mandate, a wire, a session or a vault record. The caller's own
// `flowId` (A2A message metadata) is echoed so three Workers' logs can be joined on one string.
import type { RunEvent } from '@agenticprimitives/orchestration';

export interface FlowStepV1 {
  stepRef?: string; toolId: string; ok: boolean; replayed?: boolean; skipped?: string;
  args?: Record<string, unknown>;
  /** What the step returned, summarized: a catalog read's count/total/source, a refusal, an error. */
  output?: Record<string, unknown>;
}
export interface FlowTraceV1 {
  kind: 'ap.flow-trace.v1';
  hop: 'agent';
  flowId: string | null;
  /** Spec 390 W2 — the W3C trace id this run's spans belong to (the caller's `traceparent`), or null when it derived its own. */
  traceId?: string | null;
  runRef: string;
  agent: string;
  asker: string;
  playbook: { archetypeId: string; archetypeVersion: string; digest: string } | null;
  planner: { kind: string; model?: string; toolsExposed: string[]; plan: Array<{ toolId: string; args: Record<string, unknown> }>; admission?: unknown[]; /** Spec 388 — which provider carried the planner and the composer, and why. */ route?: unknown } | null;
  steps: FlowStepV1[];
  reply: { kind: string; chars: number; artifacts: string[] };
  /** Spec 387 W3 — how the caller found this agent: the registry and its receipt, as the caller said it. Evidence, never authority. */
  referral?: ReferralV1;
  /** Spec 387 W3 — this turn continued a parked run rather than starting one. */
  continued?: boolean;
  events: Array<{ type: string; stepRef?: string; toolId?: string; ok?: boolean; because?: string; error?: string }>;
  ms: number;
}

const FLOW_ID = /^[A-Za-z0-9_.:-]{4,64}$/;
export interface ReferralV1 { registry: string; receipt?: string }
/** The caller's referral from the message metadata: which registry pointed it here and the receipt it cites — echoed as
 *  said (short strings only), verified by nobody here: how a caller found an agent grants nothing. */
export function referralOf(message: { metadata?: Record<string, unknown> } | undefined): ReferralV1 | null {
  const r = message?.metadata?.referral as { registry?: unknown; receipt?: unknown } | undefined;
  if (!r || typeof r.registry !== 'string' || !r.registry || r.registry.length > 200) return null;
  return { registry: r.registry, ...(typeof r.receipt === 'string' && r.receipt && r.receipt.length <= 400 ? { receipt: r.receipt } : {}) };
}
/** The caller's flow id from the message metadata, or null — never a value we would not echo verbatim. */
export function flowIdOf(message: { metadata?: Record<string, unknown> } | undefined): string | null {
  const v = message?.metadata?.flowId;
  return typeof v === 'string' && FLOW_ID.test(v) ? v : null;
}

/** A result's summary: numbers, flags and sources, never the rows (those are the `results` artifact's). */
export function summarizeOutput(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== 'object') return typeof result === 'string' ? { text: result.slice(0, 200) } : undefined;
  const r = result as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ['count', 'total', 'found', 'error', 'refused', 'source', 'interpretation', 'filters', 'types'] as const) if (r[k] !== undefined) out[k] = r[k];
  for (const k of ['resources', 'topics', 'members', 'agents', 'rows', 'items'] as const) if (Array.isArray(r[k])) out[`${k}Count`] = (r[k] as unknown[]).length;
  if (typeof out.interpretation === 'string') out.interpretation = (out.interpretation as string).slice(0, 240);
  return Object.keys(out).length ? out : { keys: Object.keys(r).slice(0, 12) };
}

export function buildFlowTrace(input: {
  flowId: string | null; runRef: string; agent: string; asker: string; startedAt: number;
  reply: { kind: string; text?: string; plannerTrace?: { planner?: string; model?: string; toolsExposed?: string[]; plan?: Array<{ toolId: string; args: Record<string, unknown> }>; playbook?: FlowTraceV1['playbook']; admission?: unknown[]; route?: unknown }; results?: Array<{ toolId: string; result: unknown }> };
  events?: RunEvent[]; artifacts: string[]; referral?: ReferralV1; continued?: boolean;
  /** Spec 390 W2 — the W3C trace id the request arrived with (the caller's), when one did. Correlation only. */
  traceId?: string | null;
}): FlowTraceV1 {
  const events = input.events ?? [];
  const byTool = new Map<string, unknown>();
  for (const r of input.reply.results ?? []) byTool.set(r.toolId, r.result);
  const planArgs = new Map<string, Record<string, unknown>>();
  for (const p of input.reply.plannerTrace?.plan ?? []) planArgs.set(p.toolId, p.args);
  const steps: FlowStepV1[] = [];
  for (const e of events) {
    if (e.type === 'ToolInvoked') steps.push({ stepRef: e.stepRef, toolId: e.toolId, ok: e.ok, ...(planArgs.has(e.toolId) ? { args: planArgs.get(e.toolId) } : {}), ...(byTool.has(e.toolId) ? { output: summarizeOutput(byTool.get(e.toolId)) } : {}) });
    else if (e.type === 'StepReplayed') steps.push({ stepRef: e.stepRef, toolId: e.toolId, ok: true, replayed: true });
    else if (e.type === 'StepSkipped') steps.push({ stepRef: e.stepRef, toolId: e.toolId, ok: true, skipped: e.because });
  }
  const pt = input.reply.plannerTrace;
  return {
    kind: 'ap.flow-trace.v1', hop: 'agent', flowId: input.flowId, traceId: input.traceId ?? null, runRef: input.runRef, agent: input.agent, asker: input.asker,
    playbook: pt?.playbook ?? null,
    planner: pt ? { kind: pt.planner ?? 'unknown', ...(pt.model ? { model: pt.model } : {}), toolsExposed: pt.toolsExposed ?? [], plan: pt.plan ?? [], ...(pt.admission?.length ? { admission: pt.admission } : {}), ...(pt.route ? { route: pt.route } : {}) } : null,
    steps,
    reply: { kind: input.reply.kind, chars: (input.reply.text ?? '').length, artifacts: input.artifacts },
    ...(input.referral ? { referral: input.referral } : {}), ...(input.continued ? { continued: true } : {}),
    events: events.map((e) => ({ type: e.type, ...('stepRef' in e ? { stepRef: e.stepRef } : {}), ...('toolId' in e ? { toolId: e.toolId } : {}), ...('ok' in e ? { ok: e.ok } : {}), ...('because' in e ? { because: e.because } : {}), ...('error' in e ? { error: e.error } : {}) })),
    ms: Date.now() - input.startedAt,
  };
}
