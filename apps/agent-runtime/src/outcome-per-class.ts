// THE OUTCOME, ONE CLASS PER CALL — 2026-10-14 ("evals article gap" W4), the runtime's copy of
// `judgeOutcomePerClass` (@agenticprimitives/orchestration, answer-quality.ts, v4) built on the primitives the pinned
// orchestration already exports (`judgeQuestions`, `structuredCallDecisionModel`). The next orchestration publish ships
// the function itself; this module is replaced by the import then, byte for byte in what it records.
//
// Why one call per class: v3 asked one call about every class at once (one judge call grading several dimensions) and
// a judge that could not read the answer still had to put a number on every class. v4 asks ONE question per class,
// each in its own call, worded from the class's own `rdfs:comment` and the fields its shape requires (W3 hands these
// over on the definition's `domainShapes`), and lets the judge say UNKNOWN — earl:cantTell: counted, reported, and OUT
// of the denominator. The "which classes does the request ask for" question is about the request, not the answer, so
// it stays one call of its own. Units, alternative groups and the arithmetic are v3's.
import { judgeQuestions, structuredCallDecisionModel, type JudgmentQuestionV1, type OutcomeUnitV1 } from '@agenticprimitives/orchestration';
import type { StructuredCallLike } from '@agenticprimitives/orchestration';

export const OUTCOME_PER_CLASS_JUDGE = { name: 'ap.outcome-per-class-judge.v4', kind: 'model' as const };
export type OutcomeVerdictV1 = 'delivered' | 'missing' | 'unknown';
export type OutcomeExpectationKindV1 = 'delivered' | 'named-missing' | 'asked-which';
export interface OutcomeExpectationV1 {
  iri: string; label: string; required?: boolean; alternative?: string;
  comment?: string; requiredFields?: string[]; qualityFields?: string[];
  kind?: OutcomeExpectationKindV1;
}
export interface OutcomeUnitVerdictV1 extends OutcomeUnitV1 { verdict: OutcomeVerdictV1 }
export interface OutcomePerClassV1 {
  judge: typeof OUTCOME_PER_CLASS_JUDGE;
  classes: Record<string, number>; requested: Record<string, number>; verdicts: Record<string, OutcomeVerdictV1>; units: OutcomeUnitVerdictV1[];
  score: number; counted: number; cantTell: number; calls: number; ms: number; error?: string;
}

export function outcomeQuestionOf(c: OutcomeExpectationV1): string {
  const what = c.comment ? ` ${c.comment.trim().replace(/\s+/g, ' ')}` : '';
  const has = c.requiredFields?.length ? ` A complete one has: ${c.requiredFields.join(', ')}.` : '';
  const good = c.qualityFields?.length ? ` A good one also has: ${c.qualityFields.join(', ')}.` : '';
  switch (c.kind ?? 'delivered') {
    case 'named-missing':
      return `The right answer NAMES the ${c.label} as missing — says it needs it, asks for it, or leaves a marked placeholder — instead of inventing one.${what} Does the answer do that?`;
    case 'asked-which':
      return `The right answer ASKS the person which of the named options they mean, instead of choosing one for them. Does the answer ask which?`;
    default:
      return `Does the answer deliver a ${c.label}?${what}${has}${good} "Delivered" means the answer contains a complete ${c.label}, or lays out its full structure filled in wherever the request gave the facts and names the facts still needed.`;
  }
}

export async function judgeOutcomePerClass(input: { request: string; answer: string; expected: ReadonlyArray<OutcomeExpectationV1>; maxChars?: number }, call: StructuredCallLike): Promise<OutcomePerClassV1> {
  const t0 = Date.now();
  const max = input.maxChars ?? 9000;
  const answer = input.answer.length > max ? `${input.answer.slice(0, max)}\n…(truncated)` : input.answer;
  const cands = input.expected.slice(0, 8);
  if (!cands.length) return { judge: OUTCOME_PER_CLASS_JUDGE, classes: {}, requested: {}, verdicts: {}, units: [], score: 0, counted: 0, cantTell: 0, calls: 0, ms: 0, error: 'no expected classes' };
  const port = structuredCallDecisionModel(call, { name: OUTCOME_PER_CLASS_JUDGE.name, stablePrefix: true });
  const state = `The request:\n${input.request}\n\nThe answer:\n${answer}`;
  const errors: string[] = [];
  const classes: Record<string, number> = {}; const verdicts: Record<string, OutcomeVerdictV1> = {};
  let calls = 0;
  for (const c of cands) {
    const q: JudgmentQuestionV1 = { id: 'd', kind: 'choice', question: outcomeQuestionOf(c), options: [
      { id: 'delivered', describe: c.kind === 'named-missing' ? 'the answer names it as missing and asks for it' : c.kind === 'asked-which' ? 'the answer asks which option is meant' : `the answer delivers a ${c.label} (complete, or its full structure with the missing facts named)` },
      { id: 'missing', describe: c.kind === 'named-missing' ? 'the answer invents it or does not mention it' : c.kind === 'asked-which' ? 'the answer chooses an option or does neither' : `the answer does not deliver a ${c.label}` },
    ], notApplicable: 'unknown — the answer cannot be read well enough to tell (empty, cut off, not about this request, or unreadable)' };
    calls++;
    const j = await judgeQuestions(state, [q], port);
    if (j.error !== undefined) errors.push(`${c.label}: ${j.error}`);
    const a = j.answers['d'];
    const top = a?.top;
    verdicts[c.iri] = top === 'delivered' || top === 'missing' ? top : 'unknown';
    classes[c.iri] = verdicts[c.iri] === 'unknown' ? 0 : Number((a!.distribution['delivered'] ?? 0).toFixed(4));
  }
  const optional = cands.filter((c) => !c.required);
  const requested: Record<string, number> = Object.fromEntries(cands.map((c) => [c.iri, c.required ? 1 : 0]));
  if (optional.length) {
    calls++;
    const rq = await judgeQuestions(`The request:\n${input.request}`, optional.map((c, i) => ({ id: `r${i + 1}`, kind: 'yes-no' as const, statement: `The request asks for a ${c.label}.` })), port);
    if (rq.error !== undefined) errors.push(`request: ${rq.error}`);
    optional.forEach((c, i) => { requested[c.iri] = Number((rq.answers[`r${i + 1}`]?.distribution['true'] ?? 0).toFixed(4)); });
  }
  const byId = new Map<string, OutcomeUnitVerdictV1>();
  for (const c of cands) {
    const id = c.alternative ? `alternative:${c.alternative}` : c.iri;
    const u = byId.get(id) ?? (byId.set(id, { id, members: [], requested: 0, delivered: 0, counted: false, verdict: 'unknown' }).get(id)!);
    u.members.push(c.iri);
    u.requested = Math.max(u.requested, requested[c.iri]!);
    const v = verdicts[c.iri]!;
    if (v === 'delivered' && (u.verdict !== 'delivered' || classes[c.iri]! > u.delivered)) { u.verdict = 'delivered'; u.delivered = Math.max(u.delivered, classes[c.iri]!); }
    else if (v === 'missing' && u.verdict === 'unknown') u.verdict = 'missing';
    if (v !== 'unknown') u.delivered = Math.max(u.delivered, classes[c.iri]!);
    if (c.required) u.required = true;
  }
  const units = [...byId.values()];
  let counted = units.filter((u) => u.requested >= 0.5);
  if (!counted.some((u) => !u.required)) {
    const opt = units.filter((u) => !u.required).sort((a, b) => b.requested - a.requested);
    if (opt[0]) counted = [...counted, opt[0]];
  }
  for (const u of counted) u.counted = true;
  const known = counted.filter((u) => u.verdict !== 'unknown');
  const vals = known.map((u) => u.delivered);
  return { judge: OUTCOME_PER_CLASS_JUDGE, classes, requested, verdicts, units, score: vals.length ? Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(4)) : 0, counted: known.length, cantTell: counted.length - known.length, calls, ms: Date.now() - t0, ...(errors.length ? { error: errors.join(' | ').slice(0, 300) } : {}) };
}
