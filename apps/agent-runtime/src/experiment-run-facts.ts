// WHAT THE RUNTIME ADDS TO A RUN RECORD — 2026-10-14 ("evals article gap" W1 · W2 · W3 · W4), beside the published
// runner. `runOneCase` (@agenticprimitives/evaluation at the version this app pins) reads a run's selection verdict and
// its outcome SCORE from the reply's trace and nothing else. The trace now carries more, and the record must say it:
//
//   W1  WHY a run has no verdict — agent · grader · environment — so an estate outage never reads as an agent miss;
//   W2  the outcome judged against the GOLD plan (`basis`), with the agent-plan number beside it;
//   W3  the state check — per expected class, exists / valid / errors;
//   W4  the per-class verdicts (delivered · missing · unknown = cantTell) and the ISOLATION refusal: a repeat that
//       recalled earlier turns, or arrived under a context id another run of this experiment already used, is
//       recorded and NOT scored.
//
// Pure functions over the run and the trace, so the object can apply them after each case and a test can hold them.
// They mirror the package's own rules (evaluation/src/experiment.ts `failureCauseOf`, compare-runner.ts
// `isolationRefusalOf`); when the pinned version carries them, the enrichment here finds the fields already set and
// leaves them alone.
import type { ExperimentRunV1 } from '@agenticprimitives/evaluation';

export type { FailureCauseV1, OutcomeVerdictV1 } from '@agenticprimitives/evaluation';
import { failureCauseOf, type FailureCauseV1, type OutcomeVerdictV1 } from '@agenticprimitives/evaluation';
export { failureCauseOf };

/** The run as this runtime records it: the pinned package's record plus the fields above (a superset, never a change). */
export type RunRecordPlusV1 = ExperimentRunV1 & {
  /** W1 — the outcome check was asked for and did not run: the reason, on the record (a question is not a missing judge). */
  outcomeSkipped?: string;
  failureCause?: FailureCauseV1;
  graderError?: string;
  isolation?: { refused: true; recalledTurns?: number; contextId?: string; because: string };
  outcome?: { score: number; classes: Record<string, number>; basis?: 'gold-plan' | 'agent-plan'; judge?: string; verdicts?: Record<string, OutcomeVerdictV1>; cantTell?: number; counted?: number };
  outcomeAgentPlan?: { score: number; classes: Record<string, number> };
  stateCheck?: { pass: boolean; classes: Record<string, { exists: boolean; valid: boolean; errors: string[]; /** An alternative output stood in for this class. */ satisfiedBy?: string; /** The record read back belongs to an EARLIER run (its runRef differs) — read as absent. */ stale?: string }> };
};

/** The declared rule from an error's words to its cause (the package's rule, restated): the grader's own failures first,
 *  then the environment's signatures, else the agent — an unexplained failure must not leave the agent's denominator. */

/** What the ask route left on the reply's trace that the record reads (names and numbers only). */
export interface TraceFactsV1 {
  recalledTurns?: number;
  contextId?: string;
  outcomeCheck?: { score?: number; classes?: Record<string, number>; error?: string; basis?: string; judge?: string; judgeModel?: string; verdicts?: Record<string, string>; cantTell?: number; counted?: number; skipped?: string };
  outcomeCheckAgentPlan?: { score?: number; classes?: Record<string, number>; error?: string };
  stateCheck?: { pass?: boolean; classes?: Record<string, { exists?: boolean; valid?: boolean; errors?: string[]; satisfiedBy?: string; stale?: string }> };
}

/** The facts off a planner trace, tolerant of absence (an older build's trace carries none). */
export function traceFactsOf(trace: unknown): TraceFactsV1 {
  const t = (trace ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const oc = t['outcomeCheck'] as TraceFactsV1['outcomeCheck'] | undefined;
  const oa = t['outcomeCheckAgentPlan'] as TraceFactsV1['outcomeCheckAgentPlan'] | undefined;
  const sc = t['stateCheck'] as TraceFactsV1['stateCheck'] | undefined;
  return {
    ...(num(t['recalledTurns']) !== undefined ? { recalledTurns: num(t['recalledTurns'])! } : {}),
    ...(typeof t['contextId'] === 'string' ? { contextId: t['contextId'] as string } : {}),
    ...(oc && typeof oc === 'object' ? { outcomeCheck: oc } : {}),
    ...(oa && typeof oa === 'object' ? { outcomeCheckAgentPlan: oa } : {}),
    ...(sc && typeof sc === 'object' ? { stateCheck: sc } : {}),
  };
}

const VERDICTS = new Set<OutcomeVerdictV1>(['delivered', 'missing', 'unknown']);
const numbers = (m: unknown): Record<string, number> => Object.fromEntries(Object.entries((m ?? {}) as Record<string, unknown>).filter(([, v]) => typeof v === 'number')) as Record<string, number>;

/** Add what the pinned runner did not record. `seen` is the experiment's context ids so far (mutated: the first run under
 *  an id is the fresh one). A run already carrying a field keeps it. */
export function enrichRun(run: ExperimentRunV1, facts: TraceFactsV1, seen: string[]): RunRecordPlusV1 {
  const r: RunRecordPlusV1 = { ...run };
  if (r.status !== 'ok') { r.failureCause ??= r.status === 'unreadable' ? 'environment' : failureCauseOf(r.error); return r; }
  // W4 — ISOLATION: refused, never scored. The verdict the runner computed is dropped with the reason on the record.
  if (!r.isolation) {
    const refusal = isolationOf(facts, seen);
    if (refusal) {
      const { verdict: _v, selected: _s, ...rest } = r;
      return { ...rest, status: 'unreadable', failureCause: 'environment', isolation: refusal, selected: [], evidence: 'none', error: `isolation: ${refusal.because}` };
    }
  }
  const oc = facts.outcomeCheck;
  if (oc) {
    if (typeof oc.skipped === 'string' && oc.skipped) r.outcomeSkipped ??= oc.skipped;
    else if (oc.error) { r.failureCause ??= 'grader'; r.graderError ??= `outcome judge: ${String(oc.error).slice(0, 200)}`; }
    else if (typeof oc.score === 'number') {
      const verdicts = oc.verdicts ? Object.fromEntries(Object.entries(oc.verdicts).filter(([, v]) => VERDICTS.has(v as OutcomeVerdictV1))) as Record<string, OutcomeVerdictV1> : undefined;
      r.outcome = { ...(r.outcome ?? { score: oc.score, classes: numbers(oc.classes) }),
        ...(oc.basis === 'gold-plan' || oc.basis === 'agent-plan' ? { basis: oc.basis } : {}), ...(typeof oc.judge === 'string' ? { judge: oc.judge } : {}), ...(typeof oc.judgeModel === 'string' ? { judgeModel: oc.judgeModel } : {}),
        ...(verdicts && Object.keys(verdicts).length ? { verdicts } : {}), ...(typeof oc.cantTell === 'number' ? { cantTell: oc.cantTell } : {}), ...(typeof oc.counted === 'number' ? { counted: oc.counted } : {}) };
    }
  }
  const oa = facts.outcomeCheckAgentPlan;
  if (oa && typeof oa.score === 'number' && !oa.error) r.outcomeAgentPlan ??= { score: oa.score, classes: numbers(oa.classes) };
  const sc = facts.stateCheck;
  if (sc && typeof sc.pass === 'boolean' && sc.classes && typeof sc.classes === 'object') {
    r.stateCheck ??= { pass: sc.pass, classes: Object.fromEntries(Object.entries(sc.classes).map(([k, v]) => [k, { exists: v?.exists === true, valid: v?.valid === true, errors: Array.isArray(v?.errors) ? v.errors.map(String).slice(0, 20) : [], ...(typeof v?.satisfiedBy === 'string' ? { satisfiedBy: v.satisfiedBy } : {}), ...(typeof v?.stale === 'string' ? { stale: v.stale } : {}) }])) };
  }
  return r;
}

/** W4 — fresh context or not: recalled turns on the trace, or a context id seen before in this experiment. */
export function isolationOf(facts: TraceFactsV1, seen: string[]): RunRecordPlusV1['isolation'] | null {
  const rt = facts.recalledTurns;
  if (rt !== undefined && rt > 0) return { refused: true, recalledTurns: rt, ...(facts.contextId ? { contextId: facts.contextId } : {}), because: `the agent recalled ${rt} earlier turn${rt === 1 ? '' : 's'} — not a fresh context` };
  if (facts.contextId) {
    if (seen.includes(facts.contextId)) return { refused: true, ...(rt !== undefined ? { recalledTurns: rt } : {}), contextId: facts.contextId, because: `context ${facts.contextId} already carried a run of this experiment — not a fresh context` };
    seen.push(facts.contextId);
  }
  return null;
}
