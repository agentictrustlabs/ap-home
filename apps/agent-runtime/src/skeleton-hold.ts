// THE SKELETON ON HOLD — `skill-selection/hold` (ask | skeleton).
//
// WHAT "HOLD" IS HERE. The outcome plan names REQUIRED consumed classes the request neither gives, the asker holds, nor
// any skill produces (`OutcomePlanV1.missing`). Today (`ask`) the terminal step's question carries "(Not given and not
// produced here: X — ask for it rather than invent it.)", the skill runs under it, and the answer is a question back.
// Measured 2026-10-01 (CIL Commons skills, held-out 8, Gemini answering, Claude Haiku judging): the harness beats a bare
// model on delivered classes (+0.07) and TRAILS it exactly on these cases — the bare model writes the whole template
// with placeholders, and the outcome check (`judgeOutcomeDelivered`, `s<i>`: "lays out the <class>'s full structure,
// filled where the request gave the facts, and names the facts still needed") credits that; a hold that only asks
// scores 0 on every class it did not deliver.
//
// `skeleton` RUNS THE SKILL ANYWAY, with the instruction below in front of its question: the complete structure of each
// output, filled where the request gave the facts, every missing fact a named `[MISSING: …]` placeholder, and the three
// to five questions that would complete it FIRST — so the asking is kept, not replaced. Nothing else changes: the skill
// body, the model tier, the stream, the chain's intermediate steps. The run records that this path ran
// (`skillStage: 'skeleton'`) so a comparison can tell a skeleton from a delivered answer on the trace, never by reading
// the answer. Ships OFF (`ask`) until the Lab measures it — the way every default in wrangler.toml's faithnet env was adopted.
import type { OutcomePlanV1 } from '@agenticprimitives/orchestration';

export type HoldMode = 'ask' | 'skeleton';
export const HOLD_MODES: readonly HoldMode[] = ['ask', 'skeleton'];

/** The mode this run holds under: a comparison's toggle first, else the deployment's `SKILL_HOLD_DEFAULT`, else `ask`.
 *  An unknown value is `ask` — a misspelt knob must never turn the skeleton on silently. */
export function holdModeOf(toggle: string | undefined, envDefault: string | undefined): HoldMode {
  const v = (toggle ?? envDefault ?? '').trim().toLowerCase();
  return v === 'skeleton' ? 'skeleton' : 'ask';
}

/** The instruction, verbatim (the Lab's arm is this text; change it and the measurement is of something else). */
export const SKELETON_INSTRUCTION =
  'The request does not carry every fact this skill needs. Lay out the complete structure of each output this skill '
  + 'produces, fill in what the request gave, write every missing fact as a named placeholder like [MISSING: the '
  + 'funder\'s deadline], and open with three to five one-line questions whose answers would complete it. Never invent a figure.';

/** The instruction with the facts the plan found missing named (labels, never IRIs — the answerer reads the person's terms). */
export function skeletonInstruction(missingLabels: readonly string[]): string {
  const named = missingLabels.filter((l) => l.trim()).map((l) => l.trim());
  return named.length ? `${SKELETON_INSTRUCTION}\n\n(Not given and not produced here: ${named.join(', ')}.)` : SKELETON_INSTRUCTION;
}

/** Would the plan hold (a required input missing), and does this mode answer that with a skeleton? */
export function holdDecision(plan: Pick<OutcomePlanV1, 'missing'>, mode: HoldMode): { wouldHold: boolean; skeleton: boolean } {
  const wouldHold = plan.missing.length > 0;
  return { wouldHold, skeleton: wouldHold && mode === 'skeleton' };
}

export interface OutcomeStepLike { toolId: string; args: Record<string, unknown>; id: string; ref: string }

/**
 * The steps under the hold mode. `ask`: the steps as built (the ask note is in the terminal question). `skeleton`: the
 * steps are built over the plan WITH NOTHING MISSING (so no ask note is written), and the skeleton instruction — naming
 * the missing facts — is put in front of the TERMINAL step's question: that is the step whose outputs the person asked
 * for; an intermediate step's question ("Produce the X this request will need") is left alone, because a chain's
 * producer is not where the gaps are reported. Pure: `build` is `outcomeSteps` (or anything with its shape).
 */
export function stepsUnderHold(plan: OutcomePlanV1, mode: HoldMode, labelOf: (iri: string) => string, build: (plan: OutcomePlanV1) => OutcomeStepLike[]): { steps: OutcomeStepLike[]; skeleton: boolean } {
  const d = holdDecision(plan, mode);
  if (!d.skeleton) return { steps: build(plan), skeleton: false };
  const steps = build({ ...plan, missing: [] });
  const last = steps[steps.length - 1];
  if (!last) return { steps, skeleton: false };
  const question = typeof last.args.question === 'string' ? last.args.question : '';
  const instructed = { ...last, args: { ...last.args, question: `${skeletonInstruction(plan.missing.map(labelOf))}\n\n${question}`.trim(), skeleton: true } };
  return { steps: [...steps.slice(0, -1), instructed], skeleton: true };
}
