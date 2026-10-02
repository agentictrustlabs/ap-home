// THE OUTCOME CHECK, REPEATED — `quality/judge-repeats` (1 | 2).
//
// The judge itself moves between repeats on a FIXED answer (measured 2026-10-01 on the CIL Commons held-out 8: Claude
// Haiku a 0.025 mean gap between two runs of the same check; Gemini far more). A one-call check therefore carries the
// judge's own noise into every comparison it instruments. Under N repeats the same answer is judged N times, the score
// and each class are AVERAGED, and the SPREAD (max − min of the per-repeat scores) goes on the trace beside the number of
// repeats — so a judge that disagreed with itself is visible on the record, never averaged away in silence. Ships at 1
// (`QUALITY_JUDGE_REPEATS_DEFAULT` unset) until the Lab measures whether two calls buy a steadier instrument.
import type { OutcomeCheckV1, OutcomeUnitV1 } from '@agenticprimitives/orchestration';

/** How many times to judge: a comparison's toggle first, else the deployment's knob, else 1. Bounded to 1..4 — the
 *  check is an instrument on EVERY run of an arm, and a misread knob must not turn one call into twenty. */
export function judgeRepeatsOf(toggle: string | undefined, envDefault: string | undefined): number {
  const n = Number.parseInt((toggle ?? envDefault ?? '').trim(), 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 4) : 1;
}

type OutcomeCheckLike = Pick<OutcomeCheckV1, 'judge' | 'classes' | 'score' | 'ms' | 'error'> & { requested?: Record<string, number>; units?: OutcomeUnitV1[] };

export interface OutcomeCheckAveragedV1 {
  judge: OutcomeCheckLike['judge'];
  /** Per class, the mean of the repeats' P(delivered). */
  classes: Record<string, number>;
  /** Per class, the mean of the repeats' P(requested) — when the judge reports it. */
  requested?: Record<string, number>;
  /** v3 (2026-10-02) — the scoring units (a class, or an alternative group scored once), each with the mean of the
   *  repeats' requested / delivered, `counted` when ANY repeat counted it — what was scored, on the record. */
  units?: OutcomeUnitV1[];
  /** The mean of the per-repeat scores. */
  score: number;
  /** The repeats' own time, summed — the wall time of the check when the repeats ran one after another (they do). */
  ms: number;
  repeats: number;
  /** max − min of the per-repeat scores: 0 when the judge agreed with itself; the gap when it did not. */
  spread: number;
  /** Each repeat's score, in order — the spread's evidence. */
  scores: number[];
  error?: string;
}

const r4 = (x: number) => Number(x.toFixed(4));

/** The average of N results for the same answer, with the spread. Pure; one result is itself (spread 0). */
export function averageOutcomeChecks(results: ReadonlyArray<OutcomeCheckLike>): OutcomeCheckAveragedV1 {
  if (!results.length) throw new Error('averageOutcomeChecks: no results');
  const n = results.length;
  const meanOf = (pick: (r: OutcomeCheckLike) => Record<string, number> | undefined): Record<string, number> | undefined => {
    const maps = results.map(pick).filter((m): m is Record<string, number> => !!m);
    if (!maps.length) return undefined;
    const keys = [...new Set(maps.flatMap((m) => Object.keys(m)))];
    // Over the repeats that REPORTED the map: a failed repeat reports `classes: {}` (so every class counts 0 for it — a
    // missing answer is a non-delivery, not an abstention) and no `requested` at all (the request did not change because
    // the judge timed out, so it is not pulled toward 0). Within a reported map, a class not scored counts 0.
    return Object.fromEntries(keys.map((k) => [k, r4(maps.reduce((a, m) => a + (m[k] ?? 0), 0) / maps.length)]));
  };
  const scores = results.map((r) => r.score);
  const requested = meanOf((r) => r.requested);
  const errors = results.flatMap((r) => (r.error ? [r.error] : []));
  // Units are averaged over the repeats that reported them (a failed repeat reports none), like `requested`.
  const unitRuns = results.flatMap((r) => (r.units ? [r.units] : []));
  const units = unitRuns.length ? [...new Map(unitRuns.flat().map((u) => [u.id, u])).values()].map((u0) => {
    const seen = unitRuns.map((us) => us.find((u) => u.id === u0.id));
    const mean = (f: (u: OutcomeUnitV1) => number) => r4(seen.reduce((a, u) => a + (u ? f(u) : 0), 0) / unitRuns.length);
    return { ...u0, requested: mean((u) => u.requested), delivered: mean((u) => u.delivered), counted: seen.some((u) => u?.counted) };
  }) : undefined;
  return {
    judge: results[0]!.judge,
    classes: meanOf((r) => r.classes) ?? {},
    ...(requested ? { requested } : {}),
    ...(units ? { units } : {}),
    score: r4(scores.reduce((a, b) => a + b, 0) / n),
    ms: results.reduce((a, r) => a + r.ms, 0),
    repeats: n,
    spread: r4(Math.max(...scores) - Math.min(...scores)),
    scores: scores.map(r4),
    ...(errors.length ? { error: errors.join(' | ') } : {}),
  };
}
