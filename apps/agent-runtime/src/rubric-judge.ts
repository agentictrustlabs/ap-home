// THE PER-CASE RUBRIC JUDGE (2026-10-15) — what an eval author writes for the grader, applied to one answer.
//
// The shape is the industry's: free-text INSTRUCTIONS (what matters, what to ignore — Braintrust's and LangSmith's
// LLM-as-judge prompts), and scored CRITERIA the judge answers one by one (promptfoo's `llm-rubric` with weights, OpenAI's
// score-model graders), each AWARDED when met or DEDUCTED when the fault is present, with a `required` criterion that fails
// the case alone. Three answers per criterion — met · not met · cannot tell — because a judge forced to a binary verdict
// on a question the answer does not settle invents one (Anthropic, "Demystifying evals": give the judge an Unknown).
//
// ONE call per case, every criterion in it: the judge sees the whole rubric at once (a criterion's meaning depends on its
// neighbours, and a case is five to ten criteria, not fifty), and answers with a reason per criterion that a person can
// read in the Lab. The score is (awarded − deducted) / awardable, clamped to 0–1, "cannot tell" out of the denominator;
// a required criterion not met fails the case whatever the score. A SECOND number beside the outcome judge's, never pooled.
import type { StructuredCall } from '@agenticprimitives/context';

export interface RubricCriterionV1 { id: string; text: string; points: number; kind?: 'award' | 'deduct'; required?: boolean }
export interface RubricV1 { instructions?: string; criteria: RubricCriterionV1[]; passAt?: number }
export type CriterionVerdictV1 = 'met' | 'not-met' | 'cannot-tell';
export interface RubricCheckV1 {
  /** (awarded − deducted) / awardable over the criteria the judge could decide; null when it could decide none. */
  score: number | null;
  pass: boolean | null;
  passAt: number;
  awardable: number; awarded: number; deducted: number;
  /** Criteria the judge could not decide (out of the denominator), and required ones not met (a fail on their own). */
  cannotTell: number; requiredFailed: string[];
  criteria: Record<string, { verdict: CriterionVerdictV1; because?: string; points: number; kind: 'award' | 'deduct'; required?: boolean }>;
  judge: string; judgeModel?: string; ms: number; error?: string;
}

export function validateRubricV1(r: unknown): { ok: true; rubric: RubricV1 } | { ok: false; error: string } {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, error: 'rubric: an object' };
  const x = r as Partial<RubricV1>;
  const crit = Array.isArray(x.criteria) ? x.criteria : [];
  if (!crit.length && !(typeof x.instructions === 'string' && x.instructions.trim())) return { ok: false, error: 'rubric: instructions or at least one criterion' };
  const ids = new Set<string>();
  for (const [i, c] of crit.entries()) {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(c.id)) return { ok: false, error: `rubric.criteria[${i}].id: letters, digits and -` };
    if (ids.has(c.id)) return { ok: false, error: `rubric: criterion "${c.id}" twice` }; ids.add(c.id);
    if (typeof c.text !== 'string' || !c.text.trim()) return { ok: false, error: `rubric.criteria[${i}].text: required` };
    if (typeof c.points !== 'number' || !(c.points > 0 && c.points <= 100)) return { ok: false, error: `rubric.criteria[${i}].points: in (0, 100]` };
    if (c.kind !== undefined && c.kind !== 'award' && c.kind !== 'deduct') return { ok: false, error: `rubric.criteria[${i}].kind: award | deduct` };
  }
  if (crit.length && !crit.some((c) => (c.kind ?? 'award') === 'award')) return { ok: false, error: 'rubric: at least one award criterion' };
  if (x.passAt !== undefined && !(typeof x.passAt === 'number' && x.passAt > 0 && x.passAt <= 1)) return { ok: false, error: 'rubric.passAt: in (0, 1]' };
  return { ok: true, rubric: { ...(x.instructions?.trim() ? { instructions: x.instructions.trim() } : {}), criteria: crit.map((c) => ({ id: c.id, text: c.text.trim(), points: c.points, kind: c.kind ?? 'award', ...(c.required ? { required: true } : {}) })), passAt: x.passAt ?? 0.7 } };
}

/** The score, from verdicts — pure, so a test can hold the arithmetic. */
export function scoreRubric(rubric: RubricV1, verdicts: Record<string, { verdict: CriterionVerdictV1; because?: string }>): Omit<RubricCheckV1, 'judge' | 'judgeModel' | 'ms'> {
  const passAt = rubric.passAt ?? 0.7;
  let awardable = 0, awarded = 0, deducted = 0, cannotTell = 0; const requiredFailed: string[] = [];
  const criteria: RubricCheckV1['criteria'] = {};
  for (const c of rubric.criteria) {
    const kind = c.kind ?? 'award';
    const v = verdicts[c.id]?.verdict ?? 'cannot-tell';
    criteria[c.id] = { verdict: v, ...(verdicts[c.id]?.because ? { because: verdicts[c.id]!.because } : {}), points: c.points, kind, ...(c.required ? { required: true } : {}) };
    if (v === 'cannot-tell') { cannotTell++; continue; }
    if (kind === 'award') { awardable += c.points; if (v === 'met') awarded += c.points; else if (c.required) requiredFailed.push(c.id); }
    else if (v === 'met') { deducted += c.points; if (c.required) requiredFailed.push(c.id); } // a deduction "met" = the fault is present
  }
  const score = awardable > 0 ? Math.max(0, Math.min(1, (awarded - deducted) / awardable)) : null;
  const pass = score === null ? null : score >= passAt && requiredFailed.length === 0;
  return { score, pass, passAt, awardable, awarded, deducted, cannotTell, requiredFailed, criteria };
}

const JUDGE_NAME = 'ap.rubric-judge.v1';

/** The judge's system and user turns, and the tool it answers with. Pure, so a test can hold the words. */
export function rubricJudgeInput(input: { request: string; answer: string; rubric: RubricV1 }): { system: string; messages: Array<{ role: 'user'; content: string }>; tool: { name: string; description: string; input_schema: Record<string, unknown> } } {
  const r = input.rubric;
  const lines = r.criteria.map((c, i) => `${i + 1}. [${c.id}] ${(c.kind ?? 'award') === 'deduct' ? 'FAULT (deduct if present): ' : ''}${c.text}${c.required ? ' (required)' : ''}`);
  const system = [
    'You grade ONE answer against the rubric its author wrote. You judge only what is in the answer: you add no knowledge of your own, and you do not reward length, confidence or polish. A placeholder the answer marks for a fact the request did not supply is honest, not a miss. A criterion the answer does not let you decide is "cannot-tell" — never a guess.',
    r.instructions ? `THE AUTHOR'S INSTRUCTIONS:\n${r.instructions}` : '',
    `THE CRITERIA (answer each by its id):\n${lines.join('\n')}`,
    'For each criterion say met, not-met or cannot-tell, and one sentence on why, citing what in the answer decided it. For a FAULT criterion, "met" means the fault IS present.',
  ].filter(Boolean).join('\n\n');
  const user = `THE REQUEST:\n${input.request}\n\nTHE ANSWER:\n${input.answer}`;
  const tool = {
    name: 'rubric_verdicts', description: 'Your verdict on every criterion of the rubric.',
    input_schema: { type: 'object', properties: { criteria: { type: 'array', items: { type: 'object', properties: { id: { type: 'string', enum: r.criteria.map((c) => c.id) }, verdict: { type: 'string', enum: ['met', 'not-met', 'cannot-tell'] }, because: { type: 'string', description: 'one sentence, citing the answer' } }, required: ['id', 'verdict'] } } }, required: ['criteria'] },
  };
  return { system, messages: [{ role: 'user', content: user }], tool };
}

/** The judge, through whichever structured call the comparison routes judges to (its provider and tier). */
export async function judgeRubric(input: { request: string; answer: string; rubric: RubricV1 }, call: StructuredCall, onModel?: () => string | undefined): Promise<RubricCheckV1> {
  const t0 = Date.now();
  const q = rubricJudgeInput(input);
  const out = await call({ system: q.system, messages: q.messages, tool: q.tool, maxTokens: 400 + 80 * input.rubric.criteria.length });
  const rows = Array.isArray((out as { criteria?: unknown }).criteria) ? ((out as { criteria: Array<{ id?: unknown; verdict?: unknown; because?: unknown }> }).criteria) : [];
  const verdicts: Record<string, { verdict: CriterionVerdictV1; because?: string }> = {};
  for (const row of rows) {
    const id = String(row.id ?? ''); const v = String(row.verdict ?? '');
    if (!input.rubric.criteria.some((c) => c.id === id)) continue;
    verdicts[id] = { verdict: v === 'met' || v === 'not-met' ? v : 'cannot-tell', ...(typeof row.because === 'string' && row.because.trim() ? { because: row.because.trim().slice(0, 300) } : {}) };
  }
  const judgeModel = onModel?.();
  return { ...scoreRubric(input.rubric, verdicts), judge: JUDGE_NAME, ...(judgeModel ? { judgeModel } : {}), ms: Date.now() - t0 };
}
