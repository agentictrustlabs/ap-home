// THE LAB'S EXPERIMENT JOB — spec 415 A5 (the Home's Lab replaces the static developer/evals). What a person submits
// to run a comparison HERE, on the deployment, instead of from `ap eval compare` on a laptop: the replay set, its
// gold, the variants (each one request the ask route already knows, per-area providers included), the split and
// the repeats. The job is plain data; the Durable Object (experiment-do.ts) drives it one case per alarm through the
// SAME pieces the CLI runs — startComparison · runOneCase · finishComparison — so a record made here and a record
// made by the CLI are the same record.
//
// Pure: no I/O, no clock. Parsing and progress live here so they can be tested without a Durable Object.
import {
  validateReplaySet, replaySetDigest, criterionDigest, experimentPlan, validateExperimentPlan, DEFAULT_SELECTION_THRESHOLDS,
  type ReplaySetV1, type SelectionCriterionV1, type ExperimentPlanV1, type VariantRequestV1, type ExperimentRunV1, type StartingStateFixtureV1,
} from '@agenticprimitives/evaluation';
import { validateRubricV1, type RubricV1 } from './rubric-judge.js';

export type ExperimentStatusV1 = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/** The job as the object keeps it. The SESSION is the asker's Home session the ask route verifies per case — it is
 *  what the CLI sends too; it expires, and an expired one fails the remaining cases by name (never silently). */
/** Spec 418 §2 / W2 (2026-10-14) — the OUTCOME GOLD per case: the plan (capability ids in run order; [] = none), the
 *  inputs the right plan names missing, the behaviour (clarify · several) when no one skill is right. Digest-pinned to
 *  the set like the criterion. THE EXPERT'S PLAN IS WHAT GETS SCORED: the ask route builds the outcome check's expected
 *  classes from it, and keeps the agent's own plan as a second number. */
export interface OutcomeGoldCaseV1 { plan: string[]; missing?: string[]; behaviour?: 'clarify' | 'several' }
export interface OutcomeGoldV1 { type: 'ap.outcome-gold.v1'; replaySetDigest: string; note?: string; references?: string; cases: Record<string, OutcomeGoldCaseV1> }

export interface ExperimentJobV1 {
  type: 'ap.lab-experiment-job.v1';
  planId: string;
  plan: ExperimentPlanV1;
  set: ReplaySetV1;
  criterion: SelectionCriterionV1;
  fixtures?: Record<string, StartingStateFixtureV1>;
  outcomeGold?: OutcomeGoldV1;
  /** 2026-10-15 — the per-case rubrics (`ap.rubrics.v1`, pinned to the set): each case's answer is judged against its own. */
  rubrics?: RubricsV1;
  /** The asker (the steward who submitted) and the agent asked, both addresses. */
  asker: string;
  addressee: string;
  /** The Home session the cases are asked under. */
  session: string;
  /** The deployment's own origin, so the object can dispatch to its own ask route. */
  origin: string;
  submittedAt: string;
}

export interface ExperimentRequestV1 {
  set: ReplaySetV1; criterion: SelectionCriterionV1; variants: Record<string, VariantRequestV1>;
  split?: 'held-out' | 'development' | 'all'; repeats?: number; planId?: string; fixtures?: Record<string, StartingStateFixtureV1>;
  policy?: 'primary' | 'any-fire';
  outcomeGold?: OutcomeGoldV1;
  rubrics?: RubricsV1;
}
export interface RubricsV1 { type: 'ap.rubrics.v1'; replaySetDigest: string; cases: Record<string, RubricV1> }
/** The rubrics, checked: the record type, the digest (rubrics for THIS set), each case a case of the set, each rubric sound. */
export function validateRubrics(raw: unknown, setDigest: string, intentIds: ReadonlySet<string>): { ok: true; rubrics: RubricsV1 } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'rubrics: an ap.rubrics.v1 record is required' };
  const g = raw as Partial<RubricsV1>;
  if (g.type !== 'ap.rubrics.v1') return { ok: false, error: 'rubrics: type must be ap.rubrics.v1' };
  if (g.replaySetDigest !== setDigest) return { ok: false, error: `rubrics: rubrics for ${String(g.replaySetDigest)}, not this set (${setDigest})` };
  if (!g.cases || typeof g.cases !== 'object' || Array.isArray(g.cases)) return { ok: false, error: 'rubrics: cases must map a case id to its rubric' };
  const cases: Record<string, RubricV1> = {};
  for (const [id, r] of Object.entries(g.cases)) {
    if (!intentIds.has(id)) return { ok: false, error: `rubrics: ${id} is not a case of this set` };
    const v = validateRubricV1(r); if (!v.ok) return { ok: false, error: `rubrics: ${id}: ${v.error}` };
    cases[id] = v.rubric;
  }
  return { ok: true, rubrics: { type: 'ap.rubrics.v1', replaySetDigest: setDigest, cases } };
}

/** W2 — the outcome gold, checked: the record type, the digest (gold for THIS set), and each case's shape; a case the set
 *  does not have is refused by name (gold for a case that never runs is a typo nobody would see). */
export function validateOutcomeGold(raw: unknown, setDigest: string, intentIds: ReadonlySet<string>): { ok: true; gold: OutcomeGoldV1 } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'outcomeGold: an ap.outcome-gold.v1 record is required' };
  const g = raw as Partial<OutcomeGoldV1>;
  if (g.type !== 'ap.outcome-gold.v1') return { ok: false, error: 'outcomeGold: type must be ap.outcome-gold.v1' };
  if (g.replaySetDigest !== setDigest) return { ok: false, error: `outcomeGold: gold for ${String(g.replaySetDigest)}, not this set (${setDigest})` };
  if (!g.cases || typeof g.cases !== 'object' || Array.isArray(g.cases)) return { ok: false, error: 'outcomeGold: cases must map a case id to { plan, missing?, behaviour? }' };
  for (const [id, c] of Object.entries(g.cases)) {
    if (!intentIds.has(id)) return { ok: false, error: `outcomeGold: ${id} is not a case of this set` };
    if (!c || typeof c !== 'object' || !Array.isArray(c.plan) || c.plan.some((p) => typeof p !== 'string' || !p)) return { ok: false, error: `outcomeGold: ${id}: plan must be a list of capability ids` };
    if (c.missing !== undefined && (!Array.isArray(c.missing) || c.missing.some((m) => typeof m !== 'string'))) return { ok: false, error: `outcomeGold: ${id}: missing must be class IRIs` };
    if (c.behaviour !== undefined && c.behaviour !== 'clarify' && c.behaviour !== 'several') return { ok: false, error: `outcomeGold: ${id}: behaviour must be clarify or several` };
  }
  return { ok: true, gold: g as OutcomeGoldV1 };
}

/** The submission, checked the way the CLI checks it before it registers a plan: a valid replay set, a criterion that
 *  is gold for THAT set, at least one variant the runtime will accept, a split, repeats ≥ 1. The plan is built here
 *  (digests included) so the job carries exactly what the record will say was pre-registered. */
export async function parseExperimentRequest(raw: unknown, now: Date): Promise<{ ok: true; request: ExperimentRequestV1; plan: ExperimentPlanV1 } | { ok: false; error: string }> {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'a JSON object is required' };
  const b = raw as Record<string, unknown>;
  const setR = validateReplaySet(b['set']);
  if (!setR.ok) return { ok: false, error: `set: ${setR.errors.join('; ')}` };
  const criterion = b['criterion'] as SelectionCriterionV1 | undefined;
  if (!criterion || typeof criterion !== 'object' || criterion.type !== 'ap.selection-criterion.v1') return { ok: false, error: 'criterion: an ap.selection-criterion.v1 record is required' };
  const setDigest = await replaySetDigest(setR.set);
  if (criterion.replaySetDigest !== setDigest) return { ok: false, error: `criterion: gold for ${criterion.replaySetDigest}, not this set (${setDigest})` };
  const variants = b['variants'];
  if (!variants || typeof variants !== 'object' || Array.isArray(variants) || !Object.keys(variants).length) return { ok: false, error: 'variants: at least one named variant is required' };
  for (const [n, v] of Object.entries(variants as Record<string, unknown>)) if (!v || typeof v !== 'object' || Array.isArray(v) || !/^[a-z0-9][a-z0-9._-]{0,40}$/i.test(n)) return { ok: false, error: `variants.${n}: a name (letters, digits, . _ -) and an object are required` };
  const split = (b['split'] ?? 'held-out') as ExperimentRequestV1['split'];
  if (!['held-out', 'development', 'all'].includes(String(split))) return { ok: false, error: 'split must be held-out | development | all' };
  const repeats = b['repeats'] === undefined ? 1 : Number(b['repeats']);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) return { ok: false, error: 'repeats must be an integer from 1 to 10' };
  const policy = b['policy'] === undefined ? undefined : (b['policy'] as 'primary' | 'any-fire');
  if (policy !== undefined && policy !== 'primary' && policy !== 'any-fire') return { ok: false, error: 'policy must be primary | any-fire' };
  const planId = b['planId'] === undefined ? `${setR.set.id}@${setR.set.version}-${Object.keys(variants as object).join('+')}-${split}-r${repeats}` : String(b['planId']);
  if (!/^[A-Za-z0-9][A-Za-z0-9._@+-]{0,120}$/.test(planId)) return { ok: false, error: 'planId: letters, digits and . _ @ + - only' };
  const fixtures = b['fixtures'] === undefined ? undefined : (b['fixtures'] as Record<string, StartingStateFixtureV1>);
  if (fixtures !== undefined && (!fixtures || typeof fixtures !== 'object' || Array.isArray(fixtures))) return { ok: false, error: 'fixtures must map a scenario id to its starting state' };
  let outcomeGold: OutcomeGoldV1 | undefined;
  if (b['outcomeGold'] !== undefined && b['outcomeGold'] !== null) {
    const og = validateOutcomeGold(b['outcomeGold'], setDigest, new Set(setR.set.intents.map((i) => i.id)));
    if (!og.ok) return { ok: false, error: og.error };
    outcomeGold = og.gold;
  }
  let rubrics: RubricsV1 | undefined;
  if (b['rubrics'] !== undefined && b['rubrics'] !== null) {
    const rb = validateRubrics(b['rubrics'], setDigest, new Set(setR.set.intents.map((i) => i.id)));
    if (!rb.ok) return { ok: false, error: rb.error };
    rubrics = rb.rubrics;
  }
  const plan = experimentPlan({ id: planId, replaySetDigest: setDigest, criterionDigest: await criterionDigest(criterion), split: split!, repeats, variants: variants as Record<string, VariantRequestV1>, thresholds: DEFAULT_SELECTION_THRESHOLDS, registeredAt: now.toISOString(), ...(policy ? { policy } : {}) });
  const pv = validateExperimentPlan(plan);
  if (!pv.ok) return { ok: false, error: `plan: ${pv.errors.join('; ')}` };
  return { ok: true, request: { set: setR.set, criterion, variants: variants as Record<string, VariantRequestV1>, split: split!, repeats, planId, ...(fixtures ? { fixtures } : {}), ...(policy ? { policy } : {}), ...(rubrics ? { rubrics } : {}), ...(outcomeGold ? { outcomeGold } : {}) }, plan };
}

/** What a poller sees while the object runs: how far, what the runs so far said, and the record when it is done. */
export interface ExperimentProgressV1 {
  planId: string; status: ExperimentStatusV1; total: number; done: number; failed: number;
  byOutcome: Record<string, number>;
  startedAt?: string; finishedAt?: string; error?: string;
  /** The last few runs, newest first — ids and verdicts only, never words. */
  recent: Array<{ intentId: string; variant: string; repeat: number; status: string; outcome?: string; selected: string[]; ms: number }>;
}

export function progressOf(job: Pick<ExperimentJobV1, 'planId'>, status: ExperimentStatusV1, runs: ReadonlyArray<ExperimentRunV1>, total: number, extra: { startedAt?: string; finishedAt?: string; error?: string } = {}): ExperimentProgressV1 {
  const byOutcome: Record<string, number> = {};
  for (const r of runs) { const k = r.verdict?.outcome ?? r.status; byOutcome[k] = (byOutcome[k] ?? 0) + 1; }
  return {
    planId: job.planId, status, total, done: runs.length, failed: runs.filter((r) => r.status !== 'ok').length, byOutcome,
    ...(extra.startedAt ? { startedAt: extra.startedAt } : {}), ...(extra.finishedAt ? { finishedAt: extra.finishedAt } : {}), ...(extra.error ? { error: extra.error } : {}),
    recent: [...runs].slice(-8).reverse().map((r) => ({ intentId: r.intentId, variant: r.variant, repeat: r.repeat, status: r.status, ...(r.verdict?.outcome ? { outcome: r.verdict.outcome } : {}), selected: r.selected, ms: r.ms ?? 0 })),
  };
}
