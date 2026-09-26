// THE RUN, AS A TREE — spec 415 §5c / A3 (LangSmith's run tree, with the authority column it lacks). Pure: the Run
// inspector and the run list draw from these, and a test pins them. Everything here is ids, kinds, digests, numbers and
// verdicts read back from the agent's own record — never an argument, a result or a word of the ask (spec 414 §2).
//
// The tree: the DOOR the intent came through → the RUN under its VARIANT → the MODEL CALLS it made (role, provider,
// model, tokens when reported, why the route put it there) → each STEP (capability, the SKILL contract that governed
// it, the authority verdict, the harness capabilities it engaged) → a CHILD RUN on another agent where a step was
// handed off. Harness capabilities engaged on the run as a whole (skill selection with what it could choose from, what
// it chose and what it rejected; standing instructions; memory) hang off the run node.

export type RunDoorKindV1 = 'a2a-message' | 'harness-ask' | 'routed' | 'trigger' | 'resume' | 'home-mcp' | 'channel-mention';
export interface RunDoorView { kind: RunDoorKindV1 | string; messageId?: string; contextId?: string; taskId?: string }
export interface ModelCallView { role: string; model?: string; provider?: string; promptDigest?: string; tokensIn?: number; tokensOut?: number; routeReason?: string; startedAt?: string; endedAt?: string }
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
  resume: 'a resumed run', 'home-mcp': 'Home MCP (a client of the person)', 'channel-mention': 'an @-mention in a channel',
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

/** The whole tree for one run. */
export function traceTreeOf(rec: TraceRecordView): TraceNode {
  const runChildren: TraceNode[] = [];
  for (const [i, m] of (rec.modelCalls ?? []).entries()) {
    const tokens = m.tokensIn !== undefined || m.tokensOut !== undefined ? `${m.tokensIn ?? '?'} → ${m.tokensOut ?? '?'} tokens` : 'tokens not reported';
    const ms = msBetween(m.startedAt, m.endedAt);
    runChildren.push({ id: `model:${i}`, kind: 'model', label: `${m.role} · ${m.provider ?? 'model'}${m.model ? ` / ${m.model}` : ''}`, facts: [...(ms !== undefined ? [fmtMs(ms)] : []), tokens, ...(m.routeReason ? [`route: ${m.routeReason}`] : [])], authority: null, children: [], ...(ms !== undefined ? { ms } : {}) });
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
    const children: TraceNode[] = (s.engagements ?? []).map((e, i) => ({ id: `${s.stepRef}:engaged:${i}`, kind: 'engagement' as const, label: capabilityWord(e.capability), facts: [effectWord(e.effect)], authority: null, tone: 'muted' as const, children: [] }));
    if (s.delegatedTo) children.push({ id: `${s.stepRef}:child`, kind: 'child', label: `child run on ${short(s.delegatedTo, 12)}`, facts: s.delegatedToRun ? [`run ${short(s.delegatedToRun, 18)}`] : [], authority: null, children: [] });
    runChildren.push({
      id: `step:${s.stepRef}`, kind: 'step', label: s.capability?.id ?? s.toolId,
      facts: [...(ms !== undefined ? [fmtMs(ms)] : []), s.status, ...(s.skill ? [`skill ${skillWord(s.skill.id)}@${s.skill.version}`] : []), ...(s.errorClass ? [s.errorClass] : [])],
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

/** Runs grouped into THREADS by their A2A `contextId`; runs with none are each their own thread. Newest thread first. */
export function threadsOf<T extends RunRowFacts>(rows: readonly T[]): Array<{ id: string; contextId?: string; runs: T[]; lastAt: number }> {
  const m = new Map<string, { id: string; contextId?: string; runs: T[]; lastAt: number }>();
  for (const r of rows) {
    const ctx = r.door?.contextId;
    const id = ctx ? `ctx:${ctx}` : `run:${r.runRef}`;
    const t = m.get(id) ?? { id, ...(ctx ? { contextId: ctx } : {}), runs: [], lastAt: 0 };
    t.runs.push(r); t.lastAt = Math.max(t.lastAt, r.at); m.set(id, t);
  }
  return [...m.values()].map((t) => ({ ...t, runs: t.runs.sort((a, b) => a.at - b.at) })).sort((a, b) => b.lastAt - a.lastAt);
}
