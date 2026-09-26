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

const PLANNER_KINDS = new Set(['supplied', 'compiled', 'rule-based', 'declared']);
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
  // Spec 415 §3a — SKILL SELECTION: the approach that chose (by the planner kind — a compiled shape is the ontology-
  // grounded one, spec 355; a supplied plan made no selection), what it could choose from (the tools the planner was
  // shown) and what it chose (the tools in the plan) — as capability IRIs, never words.
  const approach = SELECTION_APPROACH[plannerKindOf(trace.planner) ?? ''];
  if (approach) {
    const iri = (id: string) => `urn:ap:capability:${id}`;
    const chose = [...new Set((trace.plan ?? []).map((s) => s.toolId))].map(iri);
    const rejected = (trace.selection?.rejected ?? []).map(iri);
    out.push({ capability: approach, effect: chose.length ? 'changed-plan' : 'no-change', offered: [...new Set(trace.toolsExposed ?? [])].map(iri), ...(chose.length ? { chose } : {}), ...(rejected.length ? { rejected } : {}) });
  }
  return out;
}

const SELECTION_APPROACH: Record<string, string> = { model: 'skill-selection/model', compiled: 'skill-selection/ontology', 'rule-based': 'skill-selection/rules', declared: 'skill-selection/rules' };

/**
 * THE VARIANT KNOB — spec 415 A4. A comparison run asks `/harness/ask` to run ONE THING differently: the planner kind,
 * the provider, a harness-capability toggle, a playbook pin, a starting state. Accepted only on an estate that runs
 * comparisons (`EVAL_CAPTURE=on`) and only from the agent itself or its steward — and ONLY these components, each with
 * its known values: a request this runtime does not know is refused by name, never ignored (an ignored knob is a
 * variant that lies about what ran). Behaviour, never authority: no gate reads it.
 */
export interface VariantRequestV1 {
  plannerKind?: 'model' | 'rule-based';
  /** How instruction skills are selected: the model over the descriptions, or the declared utterances (holds on a miss). */
  selection?: 'model' | 'declared';
  provider?: string;
  toggles?: Record<string, string>;
  playbook?: string;
  /** The seeded records the run begins from — identified by their DIGEST (what the record and the graph keep); the domain
   *  and scenario are the comparison's description of it. */
  startingState?: { domain: string; scenarioId: string; digest: string };
}
export const VARIANT_TOGGLES: Record<string, readonly string[]> = { 'retrieval/kb': ['off', 'tool', 'playbook'] };

export function parseVariantRequest(raw: unknown): { ok: true; variant: VariantRequestV1 } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'variant must be an object' };
  const v = raw as Record<string, unknown>;
  const out: VariantRequestV1 = {};
  for (const k of Object.keys(v)) {
    if (k === 'plannerKind') { if (v[k] !== 'model' && v[k] !== 'rule-based') return { ok: false, error: 'plannerKind must be model | rule-based' }; out.plannerKind = v[k] as 'model' | 'rule-based'; }
    else if (k === 'selection') { if (v[k] !== 'model' && v[k] !== 'declared') return { ok: false, error: 'selection must be model | declared' }; out.selection = v[k] as 'model' | 'declared'; }
    else if (k === 'provider') { if (typeof v[k] !== 'string' || !/^[a-z][a-z0-9-]{1,30}$/.test(v[k] as string)) return { ok: false, error: 'provider must be a provider name' }; out.provider = v[k] as string; }
    else if (k === 'playbook') { if (typeof v[k] !== 'string' || !/^(0x[0-9a-fA-F]{64}|sha256:[0-9a-f]{64})$/.test(v[k] as string)) return { ok: false, error: 'playbook must be a definition digest' }; out.playbook = v[k] as string; }
    else if (k === 'toggles') {
      if (!v[k] || typeof v[k] !== 'object' || Array.isArray(v[k])) return { ok: false, error: 'toggles must map a capability notation to a value' };
      out.toggles = {};
      for (const [t, val] of Object.entries(v[k] as Record<string, unknown>)) {
        const known = VARIANT_TOGGLES[t];
        if (!known) return { ok: false, error: `toggles.${t}: this runtime has no such toggle (known: ${Object.keys(VARIANT_TOGGLES).join(', ')})` };
        if (typeof val !== 'string' || !known.includes(val)) return { ok: false, error: `toggles.${t} must be one of ${known.join(' | ')}` };
        out.toggles[t] = val;
      }
    }
    else if (k === 'startingState') {
      const st = v[k] as Record<string, unknown> | null;
      if (!st || typeof st !== 'object' || typeof st['domain'] !== 'string' || typeof st['scenarioId'] !== 'string' || typeof st['digest'] !== 'string' || !/^(sha256:[0-9a-f]{64}|0x[0-9a-fA-F]{64})$/.test(st['digest'])) return { ok: false, error: 'startingState must be { domain, scenarioId, digest } — the digest of the seeded records' };
      out.startingState = { domain: st['domain'], scenarioId: st['scenarioId'], digest: st['digest'] };
    }
    else return { ok: false, error: `${k}: not a variant component (plannerKind, selection, provider, toggles, playbook, startingState)` };
  }
  return { ok: true, variant: out };
}

/** The variant this run ran under: the playbook, the planner kind, the route policy, the build, the toggles — the
 *  deployment's knobs with what a comparison REQUESTED laid over them (a requested toggle is what ran). */
export function variantOf(env: RunTraceEnv, trace: PlannerTraceV1 | undefined, requested?: Pick<VariantRequestV1, 'toggles'>): VariantV1 {
  const toggles: Record<string, string> = {};
  const kb = requested?.toggles?.['retrieval/kb'] ?? (env.KB_RETRIEVAL ?? '').trim().toLowerCase();
  if (kb) toggles['retrieval/kb'] = kb;
  for (const [k, val] of Object.entries(requested?.toggles ?? {})) toggles[k] = val;
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
