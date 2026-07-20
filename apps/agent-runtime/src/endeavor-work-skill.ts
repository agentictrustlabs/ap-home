// The agent's coordination WORK turn (spec 334 §6, auto-work extension of the §6 plan-draft turn).
// When a principal (org or person) has AUTO-WORK enabled, its own agent doesn't just draft the plan
// — it EXECUTES the plan it can do itself: for each open step it runs a single-tool turn to produce
// the step's deliverable, which the caller then posts to the endeavor conversation and records as the
// step's completion evidence (`internal.endeavor.satisfyStep`, principal = actor).
//
// Same "harness reads, model posts" construction as the plan-draft turn: the model is given exactly
// ONE tool (`submit_work`) which `tool_choice: any` guarantees is called, so the turn is deterministic
// by construction. Doing work composes no MCP tools and grants nothing (ADR-0041) — the deliverable is
// a text artifact the agent authored, recorded as evidence; any real-world effect still flows through
// an explicit, separately-authorized capability, never inferred from this note.
import { runIntent, createRuleBasedPlanner, type Planner, type ToolSpec, type RunResult } from '@agenticprimitives/orchestration';
import { selectPlanner, type PlannerEnv } from './orchestration.js';

export interface EndeavorStepWorkInput {
  principal: string;
  endeavorId: string;
  /** The endeavor goal (context for every step). */
  goal: string;
  /** The step being executed. */
  stepKind: string;
  stepDescription: string;
  /** Deliverables produced by earlier steps in this run (short context, in order). */
  priorOutputs?: Array<{ description: string; output: string }>;
}

const WORK_TOOLS: ToolSpec[] = [
  {
    id: 'submit_work',
    description:
      'Submit the deliverable for this plan step. `output` is the concrete result of doing the step ' +
      '(e.g. the gathered details, the drafted artifact, the decision + rationale, the aggregated ' +
      'summary, or the validation finding) — written as if handing it to the team. Keep it focused ' +
      'and self-contained. Call this exactly once.',
    inputSchema: {
      type: 'object',
      properties: { output: { type: 'string', description: 'The deliverable for this step.' } },
      required: ['output'],
    },
  },
];

const WORK_CONTRACT =
  "You are an organization's or person's own agent, executing one step of an adopted coordination " +
  'plan on their behalf. Do the step as far as an autonomous agent honestly can from the goal, the ' +
  'step description, and prior deliverables — produce a concrete, useful artifact, NOT a description ' +
  'of what you would do. When a step needs facts the requester has not supplied (income, budget, ' +
  'location, dates), state clearly-labelled reasonable assumptions and PROCEED to a concrete result ' +
  'anyway — never stall by only asking for more input. Do not claim to have performed real-world ' +
  'actions you cannot verify (bookings, payments, external contacts); when a step needs one, produce ' +
  'the ready-to-act draft and say what a human must still authorize. Call submit_work exactly once. ' +
  'Never answer in prose outside the tool.';

const ANSWER_TOOLS: ToolSpec[] = [
  {
    id: 'submit_answer',
    description:
      'Submit the final answer/result for the requester. `answer` is the concrete outcome that ' +
      'directly satisfies their goal — the actual recommendation, numbers, decision, or artifact ' +
      'they asked for — addressed to them, with brief reasoning and any assumptions labelled. ' +
      'Call this exactly once.',
    inputSchema: {
      type: 'object',
      properties: { answer: { type: 'string', description: 'The final answer for the requester.' } },
      required: ['answer'],
    },
  },
];

const ANSWER_CONTRACT =
  "You are an organization's or person's own agent, writing the FINAL result of an adopted " +
  'coordination plan directly to the requester. Do not summarize the process or list the steps — ' +
  'ANSWER their question. Synthesize the step deliverables into the concrete outcome they asked for ' +
  '(the actual recommendation, price range, plan, decision, or artifact), stated plainly and ' +
  'addressed to them ("Here is…"). Where the deliverables left gaps, fill them with your own ' +
  'reasoning and clearly-labelled assumptions so the requester gets a real, actionable answer — ' +
  'then note what they should confirm or provide to refine it. Call submit_answer exactly once.';

/** Deterministic fallback (no LLM configured) — an honest note that the step was picked up by the
 *  agent, so auto-work still advances the plan and leaves a real evidence trail even without a key. */
function deterministicOutput(input: EndeavorStepWorkInput): string {
  const d = input.stepDescription.trim().replace(/\.$/, '');
  return `Handled by the agent for the goal "${input.goal}": ${d}. (No model configured on this deployment — recorded as an agent-completed step; a human can refine the deliverable.)`;
}

function sanitize(raw: unknown): string {
  const s = String(raw ?? '').trim();
  return s.slice(0, 4000);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Run one single-tool turn, capturing the tool argument. Retries the model path once on
 *  failure/empty (transient rate-limits are the common cause of a dropped step), then falls back
 *  to the deterministic planner. Returns the captured text (never empty) + which planner ran. */
async function runSingleToolTurn(
  env: PlannerEnv,
  opts: {
    contract: string;
    tools: ToolSpec[];
    toolId: string;
    argKey: string;
    goal: string;
    context: Record<string, unknown>;
    fallback: string;
  },
): Promise<{ output: string; plannerKind: 'anthropic' | 'rule-based' }> {
  const { planner, kind } = selectPlanner(env, { systemPrompt: opts.contract });

  let captured = '';
  const invoke = async (toolId: string, args: Record<string, unknown>): Promise<unknown> => {
    if (toolId !== opts.toolId) throw new Error(`unknown tool: ${toolId}`);
    captured = sanitize(args[opts.argKey]);
    return { ok: true, length: captured.length };
  };

  const deterministic: Planner = createRuleBasedPlanner([
    { match: () => true, toolId: opts.toolId, args: { [opts.argKey]: opts.fallback } },
  ]);

  const attempts = kind === 'anthropic' ? 2 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const effective = kind === 'anthropic' ? planner : deterministic;
    let result: RunResult;
    try {
      result = await runIntent(
        { goal: opts.goal, context: opts.context },
        { planner: effective, tools: opts.tools, invoke },
      );
    } catch {
      result = { outcome: 'failed', plan: { steps: [] }, steps: [] };
    }
    void result;
    if (captured.length > 0) return { output: captured, plannerKind: kind };
    if (attempt + 1 < attempts) await sleep(600 * (attempt + 1));
  }
  return { output: opts.fallback, plannerKind: kind };
}

/** Run one step's work turn. Returns the deliverable text (never empty — falls back to the
 *  deterministic note) and which planner ran. Pure compute — the caller records it. */
export async function executeEndeavorStep(
  env: PlannerEnv,
  input: EndeavorStepWorkInput,
): Promise<{ output: string; plannerKind: 'anthropic' | 'rule-based' }> {
  const priorText = (input.priorOutputs ?? [])
    .map((p, i) => `Step ${i + 1} (${p.description}): ${p.output}`)
    .join('\n');
  return runSingleToolTurn(env, {
    contract: WORK_CONTRACT,
    tools: WORK_TOOLS,
    toolId: 'submit_work',
    argKey: 'output',
    goal:
      `Endeavor goal: "${input.goal}".\nExecute this ${input.stepKind} step: "${input.stepDescription}".` +
      (priorText ? `\n\nDeliverables so far:\n${priorText}` : ''),
    context: { principal: input.principal, endeavorId: input.endeavorId },
    fallback: deterministicOutput(input),
  });
}

/** Synthesize the requester-facing OUTCOME — the actual answer to the goal, not a process recap
 *  (spec 334 §7). Takes every step's deliverable and produces the concrete result addressed to the
 *  requester. Full-length (recorded as the satisfy note + delivered to the requester's inbox). */
export async function synthesizeEndeavorOutcome(
  env: PlannerEnv,
  input: { principal: string; endeavorId: string; goal: string; deliverables: Array<{ description: string; output: string }> },
): Promise<{ answer: string; plannerKind: 'anthropic' | 'rule-based' }> {
  const body = input.deliverables
    .map((d, i) => `Step ${i + 1} — ${d.description}\n${d.output}`)
    .join('\n\n');
  const fallback =
    `Here is where things stand on "${input.goal}": the agent worked through ${input.deliverables.length} ` +
    'planned step(s) and recorded a deliverable for each (see the per-step results). No model is ' +
    'configured on this deployment, so a person should review the deliverables to produce the final answer.';
  const { output, plannerKind } = await runSingleToolTurn(env, {
    contract: ANSWER_CONTRACT,
    tools: ANSWER_TOOLS,
    toolId: 'submit_answer',
    argKey: 'answer',
    goal:
      `The requester's goal: "${input.goal}".\n\n` +
      `Deliverables produced across the plan:\n\n${body}\n\n` +
      'Write the final answer to the requester now.',
    context: { principal: input.principal, endeavorId: input.endeavorId },
    fallback,
  });
  return { answer: output, plannerKind };
}
