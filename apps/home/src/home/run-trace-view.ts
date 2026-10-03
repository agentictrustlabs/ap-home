// THE RUN, AS A TREE — spec 415 §5c / A3 (LangSmith's run tree, with the authority column it lacks). Pure: the Run
// inspector and the run list draw from these, and a test pins them. Everything here is ids, kinds, digests, numbers and
// verdicts read back from the agent's own record — never an argument, a result or a word of the ask (spec 414 §2).
//
// The tree: the DOOR the intent came through → the RUN under its VARIANT → the MODEL CALLS it made (role, provider,
// model, tokens when reported, why the route put it there) → each STEP (capability, the SKILL contract that governed
// it, the authority verdict, the harness capabilities it engaged) → a CHILD RUN on another agent where a step was
// handed off. Harness capabilities engaged on the run as a whole (skill selection with what it could choose from, what
// it chose and what it rejected; standing instructions; memory) hang off the run node.

export type RunDoorKindV1 = 'a2a-message' | 'harness-ask' | 'routed' | 'trigger' | 'resume' | 'home-mcp' | 'channel-mention' | 'background';
export interface RunDoorView { kind: RunDoorKindV1 | string; messageId?: string; contextId?: string; taskId?: string }
export interface ModelCallView { role: string; model?: string; provider?: string; promptDigest?: string; tokensIn?: number; tokensOut?: number; routeReason?: string; startedAt?: string; endedAt?: string; /** Spec 418 §3 — the step whose call this was (a skill's answer); absent for plan, compose and judge. */ stepRef?: string; failed?: boolean; /** The record listing carries raw ms instead of ISO times. */ startMs?: number; endMs?: number }
export interface VariantView { digest?: string; playbook?: string; plannerKind?: string; routePolicy?: string; build?: string; toggles?: Record<string, string> }
export interface EngagementView { capability: string; effect: string; version?: string; offered?: string[]; chose?: string[]; rejected?: string[] }
export interface TraceStepView {
  stepRef: string; toolId: string; capability?: { id: string }; status: string; startedAt?: string; endedAt?: string;
  authority?: { decision: string; afterApproval?: boolean; presentedRef?: string | null };
  skill?: { id: string; version: string; contractDigest: string };
  engagements?: Array<{ capability: string; effect: string }>;
  delegatedTo?: string; delegatedToRun?: string; errorClass?: string;
}
export interface TraceRecordView {
  runRef: string; agent: string; outcome: string; endedAt?: string;
  door?: RunDoorView; variant?: VariantView; startingState?: { digest: string };
  modelCalls?: ModelCallView[]; engagements?: EngagementView[]; steps: TraceStepView[];
}

export interface TraceNode {
  id: string;
  kind: 'door' | 'run' | 'model' | 'step' | 'child' | 'engagement';
  label: string;
  /** Short facts beside the label, in order: timing, tokens, verdicts, kinds. */
  facts: string[];
  /** The authority column: what permitted this node (a step), or null where nothing needed permitting. */
  authority?: string | null;
  tone?: 'ok' | 'warn' | 'bad' | 'muted';
  children: TraceNode[];
  ms?: number;
}

const DOOR_WORDS: Record<string, string> = {
  'a2a-message': 'A2A message', 'harness-ask': 'direct ask', routed: 'routed from another agent', trigger: 'the agent\'s own trigger',
  resume: 'a resumed run', 'home-mcp': 'Home MCP (a client of the person)', 'channel-mention': 'an @-mention in a channel', background: 'a background read (the app checking)',
};
const short = (v: unknown, n = 14): string => { const t = String(v ?? ''); return t.length > n ? `${t.slice(0, n - 4)}…${t.slice(-3)}` : t; };
const msBetween = (a?: string, b?: string): number | undefined => (a && b ? Math.max(0, Date.parse(b) - Date.parse(a)) : undefined);
export const fmtMs = (ms: number | undefined): string => (ms === undefined ? '' : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
/** `https://…/execution#hc-skillSelectionModel` → `skill-selection/model`; a bare notation passes through. */
export const capabilityWord = (iri: string): string => {
  const local = iri.includes('#') ? iri.split('#').pop()! : iri;
  if (!local.startsWith('hc-')) return local;
  return local.slice(3).replace(/([A-Z])/g, (_m, c: string, i: number) => (i === 0 ? c.toLowerCase() : `-${c.toLowerCase()}`))
    .replace(/^skill-selection-/, 'skill-selection/').replace(/^planner-/, 'planner/').replace(/^retrieval-/, 'retrieval/');
};
const effectWord = (iri: string): string => (iri.includes('#ee-') ? iri.split('#ee-').pop()!.replace(/([A-Z])/g, '-$1').toLowerCase() : iri);
const capId = (iri: string): string => iri.replace(/^urn:ap:capability:/, '');
/** `skill:ns/name@v#digest` or `urn:ap:prov:skill-contract:skill:ns/name@…` → `ns/name`. */
export const skillWord = (id: string): string => id.replace(/^urn:ap:prov:skill-contract:/, '').replace(/^skill:/, '').replace(/[@#].*$/, '');

const stepTone = (s: TraceStepView): TraceNode['tone'] =>
  s.errorClass || /fail|denied|refused/.test(s.status) ? 'bad' : /suspend|await|authority-required/.test(s.status) ? 'warn' : /skip/.test(s.status) ? 'muted' : 'ok';

/** Per-step measures (spec 418 §3): latency, model calls and tokens for each step, from the run's DQV rows. */
export interface StepMeasuresView { latencyMs?: number; modelCalls?: number; tokensIn?: number; tokensOut?: number }
export function stepMeasuresOf(rows: ReadonlyArray<{ metric: string; value: number; step?: string }>): Record<string, StepMeasuresView> {
  const out: Record<string, StepMeasuresView> = {};
  const KEY: Record<string, keyof StepMeasuresView> = { 'latency-ms': 'latencyMs', 'model-calls': 'modelCalls', 'tokens-in': 'tokensIn', 'tokens-out': 'tokensOut' };
  for (const r of rows) { const k = KEY[r.metric]; if (!r.step || !k || !Number.isFinite(r.value)) continue; (out[r.step] ??= {})[k] = r.value; }
  return out;
}
const measureFacts = (m: StepMeasuresView | undefined): string[] => {
  if (!m) return [];
  const t = m.tokensIn !== undefined || m.tokensOut !== undefined ? [`${m.tokensIn ?? 0} → ${m.tokensOut ?? 0} tokens`] : [];
  return [...(m.modelCalls ? [`${m.modelCalls} model call${m.modelCalls === 1 ? '' : 's'}`] : []), ...t];
};

const modelNode = (m: ModelCallView, id: string): TraceNode => {
  const tokens = m.tokensIn !== undefined || m.tokensOut !== undefined ? `${m.tokensIn ?? '?'} → ${m.tokensOut ?? '?'} tokens` : 'tokens not reported';
  const ms = msBetween(m.startedAt, m.endedAt) ?? (m.startMs !== undefined && m.endMs !== undefined ? Math.max(0, m.endMs - m.startMs) : undefined);
  return { id, kind: 'model', label: `${m.role} · ${m.provider ?? 'model'}${m.model ? ` / ${m.model}` : ''}`, facts: [...(ms !== undefined ? [fmtMs(ms)] : []), tokens, ...(m.failed ? ['failed'] : []), ...(m.routeReason ? [`route: ${m.routeReason}`] : [])], authority: null, ...(m.failed ? { tone: 'bad' as const } : {}), children: [], ...(ms !== undefined ? { ms } : {}) };
};

/** The whole tree for one run. A model call that names its step (spec 418 §3) hangs under that step; the rest (plan,
 *  compose, judge — and a call naming a step the record does not hold) under the run. `measures` adds each step's
 *  model calls and tokens from its DQV rows when they have been read. */
export function traceTreeOf(rec: TraceRecordView, measures?: Record<string, StepMeasuresView>): TraceNode {
  const runChildren: TraceNode[] = [];
  const stepRefs = new Set(rec.steps.map((s) => s.stepRef));
  const byStep = new Map<string, TraceNode[]>();
  for (const [i, m] of (rec.modelCalls ?? []).entries()) {
    const node = modelNode(m, `model:${i}`);
    if (m.stepRef && stepRefs.has(m.stepRef)) byStep.set(m.stepRef, [...(byStep.get(m.stepRef) ?? []), node]);
    else runChildren.push(node);
  }
  for (const [i, e] of (rec.engagements ?? []).entries()) {
    const facts = [effectWord(e.effect)];
    if (e.offered?.length) facts.push(`${e.offered.length} offered`);
    if (e.chose?.length) facts.push(`chose ${e.chose.map(capId).join(', ')}`);
    else if (/skill-selection/.test(capabilityWord(e.capability))) facts.push('chose nothing');
    if (e.rejected?.length) facts.push(`rejected ${e.rejected.map(capId).join(', ')}`);
    runChildren.push({ id: `engaged:${i}`, kind: 'engagement', label: capabilityWord(e.capability), facts, authority: null, tone: 'muted', children: [] });
  }
  for (const s of rec.steps) {
    const ms = msBetween(s.startedAt, s.endedAt);
    const children: TraceNode[] = [...(byStep.get(s.stepRef) ?? []), ...(s.engagements ?? []).map((e, i) => ({ id: `${s.stepRef}:engaged:${i}`, kind: 'engagement' as const, label: capabilityWord(e.capability), facts: [effectWord(e.effect)], authority: null, tone: 'muted' as const, children: [] }))];
    if (s.delegatedTo) children.push({ id: `${s.stepRef}:child`, kind: 'child', label: `child run on ${short(s.delegatedTo, 12)}`, facts: s.delegatedToRun ? [`run ${short(s.delegatedToRun, 18)}`] : [], authority: null, children: [] });
    runChildren.push({
      id: `step:${s.stepRef}`, kind: 'step', label: s.capability?.id ?? s.toolId,
      facts: [...(ms !== undefined ? [fmtMs(ms)] : []), s.status, ...(s.skill ? [`skill ${skillWord(s.skill.id)}@${s.skill.version}`] : []), ...(s.errorClass ? [s.errorClass] : []), ...measureFacts(measures?.[s.stepRef])],
      authority: s.authority ? `${s.authority.decision}${s.authority.afterApproval ? ' after approval' : ''}${s.authority.presentedRef ? ` under ${short(s.authority.presentedRef)}` : ''}` : 'informational — no authority stage',
      tone: stepTone(s), children, ...(ms !== undefined ? { ms } : {}),
    });
  }
  const v = rec.variant;
  const runFacts = [rec.outcome, ...(v?.plannerKind ? [`planner ${v.plannerKind}`] : []), ...(v?.routePolicy ? [`route ${v.routePolicy}`] : []),
    ...Object.entries(v?.toggles ?? {}).map(([k, x]) => `${k}=${x}`), ...(v?.digest ? [`variant ${short(v.digest, 16)}`] : []), ...(rec.startingState ? [`from state ${short(rec.startingState.digest, 16)}`] : [])];
  const run: TraceNode = { id: `run:${rec.runRef}`, kind: 'run', label: `run ${short(rec.runRef, 22)}`, facts: runFacts, authority: null, tone: /fail|denied/.test(rec.outcome) ? 'bad' : /complete|answer|done/.test(rec.outcome) ? 'ok' : 'warn', children: runChildren };
  if (!rec.door) return run;
  const d = rec.door;
  return { id: 'door', kind: 'door', label: DOOR_WORDS[d.kind] ?? d.kind, facts: [...(d.messageId ? [`message ${short(d.messageId, 16)}`] : []), ...(d.contextId ? [`context ${short(d.contextId, 16)}`] : []), ...(d.taskId ? [`task ${short(d.taskId, 16)}`] : [])], authority: null, children: [run] };
}

/** Depth-first, for rendering as indented rows. */
export function flattenTree(root: TraceNode): Array<{ node: TraceNode; depth: number }> {
  const out: Array<{ node: TraceNode; depth: number }> = [];
  const walk = (n: TraceNode, depth: number) => { out.push({ node: n, depth }); for (const c of n.children) walk(c, depth + 1); };
  walk(root, 0);
  return out;
}

// ── The run list: facets and threads (LangSmith's filters and Threads) ──

export interface RunRowFacts {
  runRef: string; at: number; outcome: string;
  /** When the ask arrived (ms) — with `at`, the turn's wall time. */
  receivedAt?: number;
  /** Spec 418 §3 — the turn's operations (the conversation it belongs to lives on `turn.contextId`). */
  operational?: RunOperationalView;
  door?: RunDoorView; variant?: VariantView; modelCalls?: ModelCallView[];
  engaged?: Array<{ capability: string; effect: string }>;
  /** The skill contracts that governed its steps (canonical ids) and the tools its steps ran — from the listing. */
  skills?: string[]; tools?: string[];
}

export type FacetKey = 'skill' | 'capability' | 'model' | 'planner' | 'door';
export const FACET_LABELS: Record<FacetKey, string> = { skill: 'Skill', capability: 'Capability', model: 'Model', planner: 'Planner', door: 'Door' };

/** The facet values a row carries (a row may carry several skills or capabilities). */
export function facetValuesOf(r: RunRowFacts, key: FacetKey): string[] {
  switch (key) {
    case 'skill': return [...new Set((r.skills ?? []).map(skillWord))];
    case 'capability': return [...new Set(r.tools ?? [])];
    case 'model': return [...new Set((r.modelCalls ?? []).map((m) => m.model ?? m.provider).filter((x): x is string => !!x))];
    case 'planner': return r.variant?.plannerKind ? [r.variant.plannerKind] : [];
    case 'door': return r.door?.kind ? [r.door.kind] : [];
  }
}

/** Every facet's values with counts, for the chips; values sorted by count, then name. */
export function facetsOf(rows: readonly RunRowFacts[]): Record<FacetKey, Array<{ value: string; count: number }>> {
  const out = {} as Record<FacetKey, Array<{ value: string; count: number }>>;
  for (const key of Object.keys(FACET_LABELS) as FacetKey[]) {
    const m = new Map<string, number>();
    for (const r of rows) for (const v of facetValuesOf(r, key)) m.set(v, (m.get(v) ?? 0) + 1);
    out[key] = [...m.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  }
  return out;
}

/** Keep the rows that carry every selected facet value. */
export function applyFacets<T extends RunRowFacts>(rows: readonly T[], selected: Partial<Record<FacetKey, string>>): T[] {
  const active = Object.entries(selected).filter(([, v]) => v) as Array<[FacetKey, string]>;
  return active.length ? rows.filter((r) => active.every(([k, v]) => facetValuesOf(r, k).includes(v))) : [...rows];
}

/** A turn's wall time (ms) — arrival to record — or undefined when the arrival was not recorded. */
export const turnMsOf = (r: RunRowFacts): number | undefined => (typeof r.receivedAt === 'number' && r.receivedAt > 0 ? Math.max(0, r.at - r.receivedAt) : undefined);
/** A turn's reported tokens (in + out over its model calls), or undefined when no call reported any. */
export const turnTokensOf = (r: RunRowFacts): number | undefined => {
  const calls = (r.modelCalls ?? []).filter((m) => m.tokensIn !== undefined || m.tokensOut !== undefined);
  return calls.length ? calls.reduce((a, m) => a + (m.tokensIn ?? 0) + (m.tokensOut ?? 0), 0) : undefined;
};
export interface ThreadTotals { turns: number; ms?: number; tokens?: number; /** turns whose time / tokens were recorded */ timed: number; counted: number }

/** Runs grouped into THREADS by their conversation — the turn's own `operational.turn.contextId`, else the door's A2A
 *  `contextId`; runs with none are each their own thread. Newest thread first; each with its totals (turns, wall ms and
 *  reported tokens summed over the turns that recorded them — a total over none is absent, never zero). */
export function threadsOf<T extends RunRowFacts>(rows: readonly T[]): Array<{ id: string; contextId?: string; runs: T[]; lastAt: number; totals: ThreadTotals }> {
  const m = new Map<string, { id: string; contextId?: string; runs: T[]; lastAt: number }>();
  for (const r of rows) {
    const ctx = r.operational?.turn?.contextId ?? r.door?.contextId;
    const id = ctx ? `ctx:${ctx}` : `run:${r.runRef}`;
    const t = m.get(id) ?? { id, ...(ctx ? { contextId: ctx } : {}), runs: [], lastAt: 0 };
    t.runs.push(r); t.lastAt = Math.max(t.lastAt, r.at); m.set(id, t);
  }
  return [...m.values()].map((t) => {
    const runs = t.runs.sort((a, b) => a.at - b.at);
    const ms = runs.map(turnMsOf).filter((x): x is number => x !== undefined);
    const tk = runs.map(turnTokensOf).filter((x): x is number => x !== undefined);
    const totals: ThreadTotals = { turns: runs.length, timed: ms.length, counted: tk.length, ...(ms.length ? { ms: ms.reduce((a, b) => a + b, 0) } : {}), ...(tk.length ? { tokens: tk.reduce((a, b) => a + b, 0) } : {}) };
    return { ...t, runs, totals };
  }).sort((a, b) => b.lastAt - a.lastAt);
}

// ── Spec 418 §3 — a turn's operations: the stage waterfall, its model calls by step, and the selection ──

/** Mirror of the runtime's `RunOperationalV1` (names, ids and numbers). */
export interface RunOperationalView {
  stages?: Record<string, number>;
  selectionMs?: number;
  selection?: { approach: string; chose: string | null; hold?: string; chain?: string[]; missing?: string[]; judge?: string; confidence?: number };
  skillStage?: string;
  turn?: { contextId?: string; recalledTurns?: number };
}

export interface WaterfallBar { name: string; ms: number; family: string }
export interface StageWaterfall {
  /** The wall phases in order: before the run (admission, reads, preparing), the run, and — when the whole turn's time is
   *  known — what came after it (compose, record, the reply's way back). */
  phases: WaterfallBar[];
  /** Each named stage (summed per name; stages may overlap — they are not a timeline), largest first. */
  stages: WaterfallBar[];
  /** The scale: the largest phase or stage. */
  maxMs: number;
  totalMs?: number;
}
const familyOf = (name: string): string => (name.includes(':') ? name.split(':')[0]! : name);
/** The waterfall of one turn. `totalMs`, when the caller observed the whole turn, adds the after-run phase. Empty stages
 *  (not recorded) → null: nothing is drawn rather than a zero. */
export function stageWaterfallOf(stages: Record<string, number> | undefined, totalMs?: number): StageWaterfall | null {
  const entries = Object.entries(stages ?? {}).filter(([, v]) => typeof v === 'number' && Number.isFinite(v));
  if (!entries.length) return null;
  const get = (k: string) => entries.find(([n]) => n === k)?.[1];
  const pre = get('phase:pre-run'); const run = get('phase:run');
  const phases: WaterfallBar[] = [];
  if (pre !== undefined) phases.push({ name: 'before the run', ms: pre, family: 'phase' });
  if (run !== undefined) phases.push({ name: 'the run', ms: run, family: 'phase' });
  if (typeof totalMs === 'number' && totalMs > 0 && (pre !== undefined || run !== undefined)) {
    const rest = totalMs - (pre ?? 0) - (run ?? 0);
    if (rest > 0) phases.push({ name: 'after the run', ms: rest, family: 'phase' });
  }
  const named = entries.filter(([n]) => !n.startsWith('phase:')).map(([name, ms]) => ({ name, ms, family: familyOf(name) })).sort((a, b) => b.ms - a.ms);
  return { phases, stages: named, maxMs: Math.max(1, ...phases.map((p) => p.ms), ...named.map((x) => x.ms)), ...(typeof totalMs === 'number' ? { totalMs } : {}) };
}

/** One model call of a turn as the How pane lists it. */
export interface TurnModelCall { role: string; provider?: string; model?: string; tokensIn?: number; tokensOut?: number; ms?: number; stepRef?: string; failed?: boolean }
/** The live trace's usage + calls, as far as the How pane reads them (a structural subset of the reply's plannerTrace). */
export interface TurnCallsSource {
  planner?: string; model?: string;
  plannerUsage?: { tokensIn: number; tokensOut: number };
  composeUsage?: { tokensIn: number; tokensOut: number };
  structuredCalls?: Array<{ role: string; stepRef?: string; provider: string; model: string; startMs: number; endMs: number; failed?: boolean; tokensIn?: number; tokensOut?: number }>;
  quality?: { judge: string; ms: number; tokensIn?: number; tokensOut?: number; error?: string };
  selectionMs?: number;
}
const MODEL_PLANNERS = new Set(['anthropic', 'groq', 'openai', 'xai', 'gemini']);
/** A turn's model calls: the planner's (tokens as reported; its ms is the selection time when a model planned), each
 *  structured call (judge, a skill's answer — under its step), the composer's, and the quality judge's, apart. Grouped:
 *  `run` holds the calls that name no step, `byStep` the rest by stepRef in first-seen order. */
export function turnModelCallsOf(t: TurnCallsSource): { run: TurnModelCall[]; byStep: Array<{ stepRef: string; calls: TurnModelCall[] }>; tokensIn: number; tokensOut: number; reported: boolean } {
  const all: TurnModelCall[] = [];
  if (t.plannerUsage || (t.planner && MODEL_PLANNERS.has(t.planner))) {
    all.push({ role: 'plan', ...(t.planner ? { provider: t.planner } : {}), ...(t.model ? { model: t.model } : {}), ...(t.plannerUsage ? { tokensIn: t.plannerUsage.tokensIn, tokensOut: t.plannerUsage.tokensOut } : {}) });
  }
  for (const c of t.structuredCalls ?? []) all.push({ role: c.role, provider: c.provider, model: c.model, ms: Math.max(0, c.endMs - c.startMs), ...(c.stepRef ? { stepRef: c.stepRef } : {}), ...(c.failed ? { failed: true } : {}), ...(c.tokensIn !== undefined ? { tokensIn: c.tokensIn } : {}), ...(c.tokensOut !== undefined ? { tokensOut: c.tokensOut } : {}) });
  if (t.composeUsage) all.push({ role: 'compose', tokensIn: t.composeUsage.tokensIn, tokensOut: t.composeUsage.tokensOut });
  if (t.quality) all.push({ role: 'quality', model: t.quality.judge, ms: t.quality.ms, ...(t.quality.error ? { failed: true } : {}), ...(t.quality.tokensIn !== undefined ? { tokensIn: t.quality.tokensIn } : {}), ...(t.quality.tokensOut !== undefined ? { tokensOut: t.quality.tokensOut } : {}) });
  const run = all.filter((c) => !c.stepRef);
  const byStep: Array<{ stepRef: string; calls: TurnModelCall[] }> = [];
  for (const c of all) if (c.stepRef) { const g = byStep.find((x) => x.stepRef === c.stepRef); if (g) g.calls.push(c); else byStep.push({ stepRef: c.stepRef, calls: [c] }); }
  // The ask's own tokens — the quality judge is an instrument, kept apart.
  const counted = all.filter((c) => c.role !== 'quality');
  const reported = counted.some((c) => c.tokensIn !== undefined || c.tokensOut !== undefined);
  return { run, byStep, tokensIn: counted.reduce((a, c) => a + (c.tokensIn ?? 0), 0), tokensOut: counted.reduce((a, c) => a + (c.tokensOut ?? 0), 0), reported };
}

/** The selection a turn made, read from the live trace's `selection` (any arm) the way the runtime's `operationalOf`
 *  reads it for the record: the arm, the choice or the hold, the chain (an outcome plan, else the one chosen skill), the
 *  missing inputs, the judge and its top probability; for the outcome arm, what the request supplied and each arrow's
 *  probability. Null when no arm ran (a model or compiled plan). */
export interface TurnSelectionView {
  approach: string; chose: string | null; hold?: string; chain?: string[]; missing?: string[]; judge?: string; confidence?: number;
  supplied?: Array<{ name: string; p: number }>; edges?: Array<{ name: string; p: number }>;
}
export function turnSelectionOf(sel: unknown): TurnSelectionView | null {
  const s = sel as { approach?: string; chose?: string | null; hold?: string; plan?: { steps?: Array<{ tool: string }>; missing?: string[] }; judge?: { name?: string }; judgment?: { judge?: { name?: string }; distribution?: Record<string, number> }; distribution?: Record<string, number>; supplied?: Record<string, number>; edges?: Record<string, number> } | null | undefined;
  if (!s?.approach) return null;
  const dist = s.distribution ?? s.judgment?.distribution;
  const top = dist ? Math.max(0, ...Object.values(dist).filter((v) => typeof v === 'number')) : 0;
  const pairs = (o?: Record<string, number>) => Object.entries(o ?? {}).filter(([, p]) => typeof p === 'number').map(([name, p]) => ({ name, p })).sort((a, b) => b.p - a.p);
  const judge = s.judge?.name ?? s.judgment?.judge?.name;
  return {
    approach: s.approach, chose: s.chose ?? null, ...(s.hold ? { hold: s.hold } : {}),
    ...(s.plan?.steps?.length ? { chain: s.plan.steps.map((x) => x.tool) } : s.chose ? { chain: [s.chose] } : {}),
    ...(s.plan?.missing?.length ? { missing: [...s.plan.missing] } : {}),
    ...(judge ? { judge } : {}), ...(top > 0 ? { confidence: top } : {}),
    ...(s.supplied && Object.keys(s.supplied).length ? { supplied: pairs(s.supplied) } : {}),
    ...(s.edges && Object.keys(s.edges).length ? { edges: pairs(s.edges) } : {}),
  };
}
/** The last segment of a class IRI or edge (`producer|https://…#Report|consumer` → `producer › Report › consumer`). */
export const classWord = (iri: string): string => iri.split('|').map((p) => p.split(/[#/]/).pop() || p).join(' › ');
