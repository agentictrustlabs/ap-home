// A CHAIN'S TERMINAL STEP PROCEEDS — `plan/chain-proceed` (off | on).
//
// THE CASE. Measured 2026-10-01/02 (CIL Commons skills, held-out 8 and chain panel 4, three repeats, Claude Haiku judging):
// the two-step grant chain — "Figure out which of our funder deadlines is next and get a first draft of that application
// going." — scores 0.35–0.46 on the outcome check in EVERY arm. The harness plans and runs both steps
// (`selection.chain: ["cic.grants.pipeline","cic.grants.draft"]`, `missing: []`); the tracker writes an intake with
// placeholder entries, and then the drafter (`grant-loi-proposal-drafter`) hits its Stage 1 SOFT GATE — no verified
// funder profile, basics uncertain ⇒ "pause … list what must be verified and wait for the user to confirm". So the reply
// is a tracker plus "please verify the funder first", and the judge finds no Letter of Inquiry / Grant Proposal (0.05).
//
// WHY THE SKELETON CANNOT REACH IT. `skill-selection/hold=skeleton` fires only when the plan names a required input
// missing (`plan.missing.length > 0`) — 0 of 547 runs on these sets. Here nothing is missing to the PLANNER; the pause is
// the skill's own judgement about fact quality, inside the body.
//
// WHY PROCEEDING IS THE SKILL'S OWN PATH, NOT AN OVERRIDE. The skill says "Note the assumption if the user wants to
// proceed anyway". A person who asks for the draft in the same sentence as the step before it has said exactly that. So
// `on` puts the instruction below in front of the TERMINAL step's question only — the step whose output the person
// asked for. The producer step ("Produce the X this request will need") is never rewritten: it has no gate to pass and
// its output is the material the terminal step builds on. Placeholders, never inventions: the instruction keeps the
// skill's "never invent a funder fact" rule in the person's terms. The run records `chainProceed: true` on the trace
// (carried into the record's operational facts) so a comparison reads the path from the record, never from the answer.
// Ships OFF until the Lab measures it — the way every default in wrangler.toml's faithnet env was adopted.
import type { OutcomeStepLike } from './skeleton-hold.js';

export type ChainProceedMode = 'off' | 'on';
export const CHAIN_PROCEED_MODES: readonly ChainProceedMode[] = ['off', 'on'];

/** The mode this run runs under: a comparison's toggle first, else the deployment's `PLAN_CHAIN_PROCEED_DEFAULT`, else
 *  `off`. An unknown value is `off` — a misspelt knob must never turn the instruction on silently. */
export function chainProceedModeOf(toggle: string | undefined, envDefault: string | undefined): ChainProceedMode {
  const v = (toggle ?? envDefault ?? '').trim().toLowerCase();
  return v === 'on' ? 'on' : 'off';
}

/** The instruction, verbatim (the Lab's arm is this text; change it and the measurement is of something else). */
export const CHAIN_PROCEED_INSTRUCTION =
  'The person asked for this output in the same request as the step before it, so they want to proceed. Where your '
  + 'skill would pause to confirm facts first, take its proceed-anyway path instead: produce the full output now, state '
  + 'each assumption you made in one line at the top, and write every unverified or missing fact as a named placeholder '
  + 'like [VERIFY: the funder\'s eligibility] or [MISSING: the deadline and its source]. Never invent a figure, a funder '
  + 'name, a deadline or a quote. End with the three to five facts that would complete it.';

/** Is this a CHAIN — a producer step before the terminal one whose output the terminal step consumes? `outcomeSteps`
 *  writes the producer's output as the terminal step's `material` (`{ $ref: 'o<i>.answer' }`), so the test is that ref
 *  naming an EARLIER step — not merely "more than one step": two independent outputs asked side by side are not a chain,
 *  and neither was asked "in the same request as the step before it" in the sense the instruction claims. */
export function isChain(steps: readonly OutcomeStepLike[]): boolean {
  if (steps.length < 2) return false;
  const last = steps[steps.length - 1]!;
  const earlier = new Set(steps.slice(0, -1).map((s) => `${s.ref}.answer`));
  const m = last.args.material;
  const refs = (Array.isArray(m) ? m : m ? [m] : []).map((x) => (x as { $ref?: unknown })?.$ref).filter((r): r is string => typeof r === 'string');
  return refs.some((r) => earlier.has(r));
}

/** Does the instruction go on? Mode on, a chain, and the plan does NOT hold (no required input missing).
 *  A HELD PLAN BELONGS TO `skill-selection/hold`, whichever its mode: under `skeleton` its text already says "run anyway,
 *  placeholders, never invent" and it is the arm the Lab measured first (2026-10-01) — so THE SKELETON WINS and there is
 *  one instruction, not two (two in front of one question would be a measurement of neither); under `ask` the terminal
 *  question carries "ask for it rather than invent it", and prepending "proceed" to that would contradict it in one
 *  prompt. Costs nothing measured: 0 of 547 runs on these sets held, and the grant chain's plan has `missing: []`. */
export function chainProceedDecision(steps: readonly OutcomeStepLike[], mode: ChainProceedMode, held: boolean): boolean {
  return mode === 'on' && !held && isChain(steps);
}

/** The steps under the mode: the TERMINAL step's question prefixed with the instruction and marked (`chainProceed: true`
 *  in its args, as the skeleton marks `skeleton: true`); every other step returned as it was. Pure. */
export function stepsUnderChainProceed(steps: OutcomeStepLike[], mode: ChainProceedMode, held: boolean): { steps: OutcomeStepLike[]; chainProceed: boolean } {
  if (!chainProceedDecision(steps, mode, held)) return { steps, chainProceed: false };
  const last = steps[steps.length - 1]!;
  const question = typeof last.args.question === 'string' ? last.args.question : '';
  const instructed = { ...last, args: { ...last.args, question: `${CHAIN_PROCEED_INSTRUCTION}\n\n${question}`.trim(), chainProceed: true } };
  return { steps: [...steps.slice(0, -1), instructed], chainProceed: true };
}
