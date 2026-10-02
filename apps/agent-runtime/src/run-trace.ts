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
import type { HarnessEngagementV1, ModelCallV1, RunDoorV1, VariantV1, RunOperationalV1 } from '@agenticprimitives/orchestration';
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
/** A provider-REPORTED usage onto a model call (numbers only; absent stays absent — never an estimate). */
const tokensOf = (u: { tokensIn?: number; tokensOut?: number } | undefined): { tokensIn?: number; tokensOut?: number } => (u && typeof u.tokensIn === 'number' ? { tokensIn: u.tokensIn, tokensOut: u.tokensOut ?? 0 } : {});

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

const PLANNER_KINDS = new Set(['supplied', 'compiled', 'rule-based', 'declared', 'ontology', 'judgment', 'ontology+judgment', 'propose+judgment', 'ontology-first', 'framed-judgment', 'outcome', 'outcome-selective']);
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
      ...tokensOf(trace.plannerUsage),
    });
  }
  const compose = trace.route?.composer;
  if (compose?.provider) {
    const w = marks?.find((m) => m.name === 'reply:compose');
    out.push({ role: 'compose', provider: compose.provider, ...(reason(compose.because) ? { routeReason: reason(compose.because)! } : {}), ...(w ? { startMs: w.startMs, endMs: w.endMs } : {}), ...tokensOf(trace.composeUsage) });
  }
  // Every structured call as it ran (spec 415): the selection judge (`judge`), a skill's answer, the KB and vault choosers.
  for (const s of trace.structuredCalls ?? []) out.push({ role: s.role, ...(s.stepRef ? { stepRef: s.stepRef } : {}), ...(s.failed ? { failed: true } : {}), provider: s.provider, model: s.model, ...(reason(s.because) ? { routeReason: reason(s.because)! } : {}), startMs: s.startMs, endMs: s.endMs, ...tokensOf(s) });
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
  // Spec 415 §3a / A4 — SKILL SELECTION, as capability IRIs, never words. A selection ARM on the trace says what it did;
  // otherwise the approach is read from the planner kind (a compiled shape is spec 355's ontology-grounded one; a
  // supplied plan made no selection). The composed arm leaves TWO engagements — the rule's and the judge's — so it stays
  // visible which half made the call.
  const iri = (id: string) => `urn:ap:capability:${id}`;
  const offeredAll = [...new Set(trace.toolsExposed ?? [])].map(iri);
  const planned = [...new Set((trace.plan ?? []).map((s) => s.toolId))].filter((t) => t !== 'ask.unsupported').map(iri);
  const typed = (x?: { requests?: string; about?: string[] }) => (x && (x.requests || x.about?.length) ? { ...(x.requests ? { requests: x.requests === 'outside-domain' ? 'https://agenticprimitives.dev/ns/execution#OutsideDomain' : x.requests } : {}), ...(x.about?.length ? { about: x.about } : {}) } : undefined);
  const sel = trace.selection;
  const push = (capability: string, effect: HarnessEngagementV1['effect'], offered: string[], chose: string[], rejected: string[], intent?: { requests?: string; about?: string[] }) =>
    out.push({ capability, effect, ...(offered.length ? { offered } : {}), ...(chose.length ? { chose } : {}), ...(rejected.length ? { rejected } : {}), ...(intent ? { intent } : {}) });
  if (sel && (sel.approach === 'ontology' || sel.approach === 'ontology+judgment')) {
    const o = sel.approach === 'ontology' ? sel : sel.ontology;
    const grounded = typed({ about: o.grounded.map((g) => g.iri) });
    // The rule: what it could choose from, what it grounded, and — alone — what it chose; composed, the judge's slate.
    // Rejected: the tied survivors (an ambiguous hold) and every skill an adjacent class excluded.
    const ruleRejected = [...new Set([...(o.hold === 'ambiguous' ? o.survivors : []), ...Object.keys(o.excluded ?? {})])].map(iri);
    if (sel.approach === 'ontology') push('skill-selection/ontology', planned.length ? 'changed-plan' : 'no-change', offeredAll, planned, ruleRejected, grounded);
    else {
      push('skill-selection/ontology', o.survivors.length ? 'changed-plan' : 'no-change', offeredAll, [], Object.keys(o.excluded ?? {}).map(iri), grounded);
      if (sel.judgment) push('skill-selection/judgment', planned.length ? 'changed-plan' : 'no-change', sel.judgment.offered.map(iri), planned, sel.judgment.rejected.map(iri), typed(sel.judgment.intent));
    }
  } else if (sel && sel.approach === 'propose+judgment') {
    // Spec 416 W1 — the ontology's engagement: what it could offer, what it grounded, what it VETOED (rejected), and — as
    // its choice — the proposed set; the judge's: its slate (the proposed skills), what it chose, its runner-up.
    push('skill-selection/ontology', sel.proposal.candidates.length ? 'changed-plan' : 'no-change', offeredAll, sel.proposal.candidates.map(iri), Object.keys(sel.proposal.removed).map(iri), typed({ about: sel.grounded.map((g) => g.iri) }));
    if (sel.judgment) push('skill-selection/judgment', planned.length ? 'changed-plan' : 'no-change', sel.judgment.offered.map(iri), planned, sel.judgment.rejected.map(iri), typed(sel.judgment.intent));
  } else if (sel && sel.approach === 'ontology-first') {
    // The ontology's engagement always (it read the request first); the judge's only when the ontology was not decisive.
    push('skill-selection/ontology', sel.decidedBy === 'ontology' ? 'changed-plan' : 'no-change', offeredAll, sel.decidedBy === 'ontology' ? planned : [], Object.keys(sel.ontology.excluded ?? {}).map(iri), typed({ about: sel.ontology.grounded.map((g) => g.iri) }));
    if (sel.judgment) push('skill-selection/judgment', planned.length ? 'changed-plan' : 'no-change', sel.judgment.offered.map(iri), planned, sel.judgment.rejected.map(iri), typed(sel.judgment.intent));
  } else if (sel && sel.approach === 'judgment') {
    push('skill-selection/judgment', planned.length ? 'changed-plan' : 'no-change', offeredAll, planned, sel.rejected.map(iri), typed(sel.intent));
  } else if (sel && (sel.approach === 'outcome' || sel.approach === 'outcome-selective')) {
    // Spec 417 — TWO engagements: the judge chose the OUTCOME (the terminal skill; its runner-up rejected), and the
    // ontology's dataflow rule added the steps that produce what the outcome consumes (none when context held them).
    const runnerUp = Object.entries(sel.distribution).filter(([k]) => k !== 'none' && k !== sel.chose).sort((a, b) => b[1] - a[1])[0];
    push('skill-selection/judgment', planned.length ? 'changed-plan' : 'no-change', offeredAll, sel.chose ? [iri(sel.chose)] : [], runnerUp && runnerUp[1] > 0 ? [iri(runnerUp[0])] : []);
    if (sel.plan) push('skill-selection/ontology', sel.plan.steps.length > 1 ? 'changed-plan' : 'no-change', offeredAll, sel.plan.steps.slice(0, -1).map((x) => iri(x.tool)), [], typed({ about: Object.keys(sel.plan.satisfied) }));
  } else if (sel && sel.approach === 'framed-judgment') {
    push('skill-selection/judgment', planned.length ? 'changed-plan' : 'no-change', offeredAll, planned, sel.rejected.map(iri), typed(sel.intent));
  } else {
    const approach = SELECTION_APPROACH[plannerKindOf(trace.planner) ?? ''];
    if (approach) push(approach, planned.length ? 'changed-plan' : 'no-change', offeredAll, planned, (sel?.rejected ?? []).map(iri));
  }
  return out;
}

const SELECTION_APPROACH: Record<string, string> = { model: 'skill-selection/model', compiled: 'skill-selection/ontology', 'rule-based': 'skill-selection/rules', declared: 'skill-selection/rules', judgment: 'skill-selection/judgment' };

/**
 * THE VARIANT KNOB — spec 415 A4. A comparison run asks `/harness/ask` to run ONE THING differently: the planner kind,
 * the provider, a harness-capability toggle, a playbook pin, a starting state. Accepted only on an estate that runs
 * comparisons (`EVAL_CAPTURE=on`) and only from the agent itself or its steward — and ONLY these components, each with
 * its known values: a request this runtime does not know is refused by name, never ignored (an ignored knob is a
 * variant that lies about what ran). Behaviour, never authority: no gate reads it.
 */
/** Spec 415 A4 — how instruction skills are selected: `model` (the planner over descriptions — the baseline), `declared`
 *  (overlap with declared sentences), the three arms `ontology` · `judgment` · `ontology+judgment`, spec 416's `propose+judgment`, and `framed-judgment`
 *  (the 2026-09-26 shape, kept reproducible). */
export const SELECTION_ARMS = ['model', 'declared', 'ontology', 'judgment', 'ontology+judgment', 'propose+judgment', 'ontology-first', 'framed-judgment', 'outcome', 'outcome-selective'] as const;
export type SelectionArmV1 = (typeof SELECTION_ARMS)[number];

export interface VariantRequestV1 {
  plannerKind?: 'model' | 'rule-based';
  /** How instruction skills are selected: the model over the descriptions, or the declared utterances (holds on a miss). */
  selection?: SelectionArmV1;
  provider?: string;
  /** Per-area providers (2026-10-01): the selector (planner + selection judge), the answer (skill.apply, the pairwise's
   *  second answer) and the judge (quality · outcome · pairwise) may each run on their own provider; each falls back to
   *  `provider`, then the deployment default. Validated against what the deployment offers, like `provider`. */
  selectionProvider?: string;
  answerProvider?: string;
  judgeProvider?: string;
  toggles?: Record<string, string>;
  playbook?: string;
  /** The seeded records the run begins from — identified by their DIGEST (what the record and the graph keep); the domain
   *  and scenario are the comparison's description of it. */
  startingState?: { domain: string; scenarioId: string; digest: string };
  /** Spec 416 W3 — acceptance by a fitted conformal map (the map inline, cited by its digest) instead of floor/margin. */
  acceptance?: { method: 'conformal'; alpha: number; temperature: number; qhat: number; mapDigest: string };
  /** Spec 416 — the judge's profile: `thorough` (v5) or `fast` (one call, one question, the provider's light model). */
  judgeProfile?: 'thorough' | 'fast' | 'logprob';
  /** Spec 416 §4h — a SEEDED asker context (a comparison's starting state, by digest): what the judge is told the asker
   *  used recently and what is remembered of them, in place of reading the asker's live history. */
  askerContext?: { digest: string; recentSkills?: Array<{ id: string; times: number }>; memoryTags?: string[]; heldClasses?: string[] };
}
export const VARIANT_TOGGLES: Record<string, readonly string[]> = { 'retrieval/kb': ['off', 'tool', 'playbook'],
  /** Spec 416 — `off`: the chosen skill is stamped but not RUN (no model call) — a comparison that measures the pick alone. */
  'skill-selection/answer': ['on', 'off'],
  /** Spec 416 §4f — what the judge is told about the asker: nothing, their standing (default), or standing + their recent
   *  skills here + (at their own agent) memory. `full` reads the asker's history, so a comparison uses it only from a
   *  seeded starting state — never over its own test runs. */
  'skill-selection/asker-context': ['off', 'relation', 'full'],
  /** Spec 416 §4f — the fast skill stage before the planner, named per run (default: the deployment's setting). */
  'skill-selection/stage': ['on', 'off'],
  /** Spec 416 §4h — the model an instruction skill ANSWERS with: the deployment's (default) or the provider's light one. */
  'skill-selection/answer-model': ['default', 'light', 'strong', 'minimal'],
  /** Spec 416 §4h — score the answer with the quality rubric (a comparison's instrument; its time is reported apart). */
  'quality/judge': ['off', 'on', 'pairwise', 'outcome'],
  /** Spec 418 §1 — the outcome arm's party-stance rule: `on` (default) decides an arrow whose ends are both qualified by
   *  rule; `off` asks the judge about every arrow (the spec 417 shape) — so the rule's effect is measured in one experiment. */
  'skill-selection/party-rule': ['on', 'off'],
  /** Spec 418 D4 — required vs enriching inputs (`off`: every input treated as required — the pre-D4 rule). */
  'skill-selection/necessity': ['on', 'off'],
  /** Spec 418 D4 — the asker's office (memory grounded in role classes) and its typical capabilities in the reading. */
  'skill-selection/office-prior': ['on', 'off'],
  /** Spec 418 D5 — the asker's own records: read from the vault and written before the reply (`vault`, default), or
   *  served from the colo cache with the conversation write landing after the reply (`cached`). */
  'ops/records': ['vault', 'cached'],
  /** Spec 418 — the fast judge's independent samples: `2` ⇒ agreement is the confidence; disagreement asks which. */
  'skill-selection/samples': ['1', '2'],
  /** Spec 418 — a chain's intermediate step: a full answer (default) or only the typed artifact the next step consumes. */
  'skill-selection/intermediate': ['full', 'brief'],
  /** Spec 418 — selective reading also asks whether the request wants the result of a skill DOWNSTREAM of the pick. */
  'skill-selection/downstream': ['off', 'on'],
  /** Spec 418 — the enriching-input question's wording (v2 also counts "make it as a step first"). */
  'skill-selection/absence': ['v1', 'v2'],
  /** Spec 418 §11 — how selective reading decides the plan around the pick: yes-no dataflow questions, or one choice
   *  among the plans the ontology allows (alone · upstream → pick · pick → downstream). */
  'skill-selection/plan': ['questions', 'choice'],
  /** Spec 418 — a second sample only when the first pick is borderline (top p in [0.35, 0.6]). */
  'skill-selection/borderline': ['off', 'on'],
  /** Spec 418 — the fast judge's question: v2, or v3 (a request missing information a skill needs is still that skill's). */
  'skill-selection/fast-version': ['v2', 'v3'],
  /** Spec 418 — a pick split between two skills: decline (today) or clarify (ask which). */
  'skill-selection/split': ['decline', 'clarify'],
  /** Spec 418 — under quality/judge=pairwise, the tier the run's own answer is compared AGAINST (default: light vs default). */
  'quality/against': ['default', 'light', 'strong', 'minimal'],
  /** Spec 418 A1 — stream the skill answer (drafts to the progress list; first words timed). */
  'answer/stream': ['off', 'on'],
  /** Spec 418 A5 — held inputs from the agent's own record types on a real ask (`records`, default) or never (`off`). */
  'skill-selection/held': ['records', 'off'],
  /** 2026-10-01 — a plan with a REQUIRED input missing: `ask` (default — the skill is told to ask, not invent) or
   *  `skeleton` (the skill runs anyway: full structure, `[MISSING: …]` placeholders, the questions first). Measured
   *  because the outcome check credits a filled-in template and scores a bare question 0 (`skeleton-hold.ts`). */
  'skill-selection/hold': ['ask', 'skeleton'],
  /** 2026-10-02 — a CHAIN's terminal step (a producer's output as its material, nothing missing): `off` (default) or `on`
   *  (the step takes its skill's proceed-anyway path — full output, assumptions on top, [VERIFY: …]/[MISSING: …]
   *  placeholders, never an invented fact). Measured because the grant chain scored 0.35–0.46 in every arm: the drafter
   *  paused at its Stage 1 soft gate though the person asked for the draft in the same sentence (`chain-proceed.ts`). */
  'plan/chain-proceed': ['off', 'on'],
  /** 2026-10-01 — under quality/judge=outcome, judge the same answer N times: score and classes averaged, the spread
   *  (max − min) on the trace. The judge moved 0.025 (Haiku) between repeats on a fixed answer (`outcome-check-repeats.ts`). */
  'quality/judge-repeats': ['1', '2'],
  /** Spec 420 §2 — goal regression over situations: preconditions checked, reads inserted, gaps named before any signature. */
  'plan/regression': ['off', 'on'],
  /** Spec 420 §3 — the offer by standing: acts the asker cannot authorize at the room are marked for the planner, or left out. */
  'offer/standing': ['off', 'annotate', 'prune'],
  /** Spec 420 §10 — a bare name among several resolves to the nearest in context (the room's roster · household · a shared context · dealings) before asking. */
  'resolve/context': ['off', 'on'],
  /** Spec 421 W1 — continue from what was read: the planner may end a plan with `plan.continue` and plan the rest from the reads. */
  'plan/continuation': ['off', 'on'] };

export function parseVariantRequest(raw: unknown): { ok: true; variant: VariantRequestV1 } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'variant must be an object' };
  const v = raw as Record<string, unknown>;
  const out: VariantRequestV1 = {};
  for (const k of Object.keys(v)) {
    if (k === 'plannerKind') { if (v[k] !== 'model' && v[k] !== 'rule-based') return { ok: false, error: 'plannerKind must be model | rule-based' }; out.plannerKind = v[k] as 'model' | 'rule-based'; }
    else if (k === 'selection') { if (!SELECTION_ARMS.includes(v[k] as SelectionArmV1)) return { ok: false, error: `selection must be ${SELECTION_ARMS.join(' | ')}` }; out.selection = v[k] as SelectionArmV1; }
    else if (k === 'provider' || k === 'selectionProvider' || k === 'answerProvider' || k === 'judgeProvider') { if (typeof v[k] !== 'string' || !/^[a-z][a-z0-9-]{1,30}$/.test(v[k] as string)) return { ok: false, error: `${k} must be a provider name` }; out[k] = v[k] as string; }
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
    else if (k === 'acceptance') {
      const a = v[k] as Record<string, unknown> | null;
      const num = (x: unknown, lo: number, hi: number) => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;
      if (!a || typeof a !== 'object' || a['method'] !== 'conformal' || !num(a['alpha'], 0.001, 0.5) || !num(a['temperature'], 0.05, 20) || !num(a['qhat'], 0, 1) || typeof a['mapDigest'] !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(a['mapDigest'])) return { ok: false, error: 'acceptance must be { method: conformal, alpha, temperature, qhat, mapDigest } — a fitted calibration map' };
      out.acceptance = { method: 'conformal', alpha: a['alpha'] as number, temperature: a['temperature'] as number, qhat: a['qhat'] as number, mapDigest: a['mapDigest'] };
    }
    else if (k === 'askerContext') {
      const a = v[k] as Record<string, unknown> | null;
      const rs = a?.['recentSkills'], mt = a?.['memoryTags'], hc = a?.['heldClasses'];
      const okRs = rs === undefined || (Array.isArray(rs) && rs.length <= 8 && rs.every((x) => x && typeof (x as { id?: unknown }).id === 'string' && /^[a-z0-9._-]{1,80}$/i.test((x as { id: string }).id) && Number.isInteger((x as { times?: unknown }).times) && (x as { times: number }).times > 0 && (x as { times: number }).times < 1000));
      const okMt = mt === undefined || (Array.isArray(mt) && mt.length <= 8 && mt.every((x) => typeof x === 'string' && x.length <= 120));
      // Spec 417 — classes the asker holds: IRIs only (never a record).
      const okHc = hc === undefined || (Array.isArray(hc) && hc.length <= 16 && hc.every((x) => typeof x === 'string' && /^(https?|urn):\S{1,200}$/.test(x)));
      if (!a || typeof a !== 'object' || typeof a['digest'] !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(a['digest']) || !okRs || !okMt || !okHc) return { ok: false, error: 'askerContext must be { digest: sha256:…, recentSkills?: [{ id, times }], memoryTags?: [string], heldClasses?: [class IRI] } — a seeded starting state' };
      out.askerContext = { digest: a['digest'], ...(rs ? { recentSkills: (rs as Array<{ id: string; times: number }>).map((x) => ({ id: x.id, times: x.times })) } : {}), ...(mt ? { memoryTags: [...(mt as string[])] } : {}), ...(hc ? { heldClasses: [...(hc as string[])] } : {}) };
    }
    else if (k === 'judgeProfile') { if (v[k] !== 'thorough' && v[k] !== 'fast' && v[k] !== 'logprob') return { ok: false, error: 'judgeProfile must be thorough | fast | logprob' }; out.judgeProfile = v[k] as 'thorough' | 'fast' | 'logprob'; }
    else return { ok: false, error: `${k}: not a variant component (plannerKind, selection, provider, toggles, playbook, startingState, acceptance, judgeProfile, askerContext)` };
  }
  return { ok: true, variant: out };
}

/** The variant this run ran under: the playbook, the planner kind, the route policy, the build, the toggles — the
 *  deployment's knobs with what a comparison REQUESTED laid over them (a requested toggle is what ran). */
export function variantOf(env: RunTraceEnv, trace: PlannerTraceV1 | undefined, requested?: Pick<VariantRequestV1, 'toggles' | 'acceptance' | 'judgeProfile' | 'askerContext'>): VariantV1 {
  const toggles: Record<string, string> = {};
  const kb = requested?.toggles?.['retrieval/kb'] ?? (env.KB_RETRIEVAL ?? '').trim().toLowerCase();
  if (kb) toggles['retrieval/kb'] = kb;
  for (const [k, val] of Object.entries(requested?.toggles ?? {})) toggles[k] = val;
  // The acceptance rule is a harness-capability setting: which map shaped the decision is part of what ran.
  if (requested?.acceptance) toggles['skill-selection/acceptance'] = `conformal:${requested.acceptance.mapDigest}`;
  if (requested?.judgeProfile) toggles['skill-selection/judge-profile'] = requested.judgeProfile;
  if (requested?.askerContext) toggles['skill-selection/asker-context'] = `seeded:${requested.askerContext.digest}`;
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

/** Spec 417 §5 — the turn's operational facts, kept on the record (numbers and ids only): the stage windows summed per
 *  name with the pre-run and run wall phases, and how the skill was chosen (arm, choice or hold, chain, judge, top
 *  probability). The post-run phase is not yet over when the record is written, and is not claimed. */
export function operationalOf(trace: PlannerTraceV1 | undefined, marks: ReadonlyArray<{ name: string; startMs: number; endMs: number }>, w: { receivedAt: number; runStartMs: number; runEndMs: number; contextId?: string }): RunOperationalV1 | null {
  if (!trace) return null;
  const stages: Record<string, number> = {};
  for (const m of marks) stages[m.name] = (stages[m.name] ?? 0) + Math.max(0, m.endMs - m.startMs);
  if (w.runStartMs > 0 && w.receivedAt > 0) stages['phase:pre-run'] = Math.max(0, w.runStartMs - w.receivedAt);
  if (w.runEndMs > 0 && w.runStartMs > 0) stages['phase:run'] = Math.max(0, w.runEndMs - w.runStartMs);
  const s = trace.selection as { approach?: string; chose?: string | null; hold?: string; plan?: { steps?: Array<{ tool: string }>; missing?: string[] }; judge?: { name?: string }; judgment?: { judge?: { name?: string }; distribution?: Record<string, number> }; distribution?: Record<string, number> } | undefined;
  const dist = s?.distribution ?? s?.judgment?.distribution;
  const top = dist ? Math.max(0, ...Object.values(dist).filter((v) => typeof v === 'number')) : undefined;
  const selection = s?.approach ? {
    approach: s.approach, chose: s.chose ?? null, ...(s.hold ? { hold: s.hold } : {}),
    ...(s.plan?.steps?.length ? { chain: s.plan.steps.map((x) => x.tool) } : s.chose ? { chain: [s.chose] } : {}),
    ...(s.plan?.missing?.length ? { missing: [...s.plan.missing] } : {}),
    ...((s.judge?.name ?? s.judgment?.judge?.name) ? { judge: (s.judge?.name ?? s.judgment?.judge?.name)! } : {}),
    ...(top !== undefined && Number.isFinite(top) && top > 0 ? { confidence: Number(top.toFixed(4)) } : {}),
  } : undefined;
  const turn = w.contextId || trace.recalledTurns !== undefined ? { ...(w.contextId ? { contextId: w.contextId } : {}), ...(trace.recalledTurns !== undefined ? { recalledTurns: trace.recalledTurns } : {}) } : undefined;
  return { stages, ...(trace.selectionMs !== undefined ? { selectionMs: trace.selectionMs } : {}), ...(selection ? { selection } : {}), ...(trace.skillStage ? { skillStage: trace.skillStage } : {}), ...(trace.chainProceed ? { chainProceed: true } : {}), ...(turn ? { turn } : {}) };
}
