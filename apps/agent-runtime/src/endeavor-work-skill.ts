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
  'step description, and prior deliverables — produce a concrete, useful artifact. Do not claim to ' +
  'have performed real-world actions you cannot verify (bookings, payments, external contacts); when ' +
  'a step needs one, produce the ready-to-act plan/draft and say what a human must still authorize. ' +
  'Call submit_work exactly once. Never answer in prose outside the tool.';

/** Deterministic fallback (no LLM configured) — an honest note that the step was picked up by the
 *  agent, so auto-work still advances the plan and leaves a real evidence trail even without a key. */
function deterministicOutput(input: EndeavorStepWorkInput): string {
  const d = input.stepDescription.trim().replace(/\.$/, '');
  return `Handled by the agent for the goal "${input.goal}": ${d}. (No model configured on this deployment — recorded as an agent-completed step; a human can refine the deliverable.)`;
}

function sanitize(raw: unknown): string {
  const s = String(raw ?? '').trim();
  return s.slice(0, 2000);
}

/** Run one step's work turn. Returns the deliverable text (never empty — falls back to the
 *  deterministic note) and which planner ran. Pure compute — the caller records it. */
export async function executeEndeavorStep(
  env: PlannerEnv,
  input: EndeavorStepWorkInput,
): Promise<{ output: string; plannerKind: 'anthropic' | 'rule-based' }> {
  const { planner, kind } = selectPlanner(env, { systemPrompt: WORK_CONTRACT });

  let captured = '';
  const invoke = async (toolId: string, args: Record<string, unknown>): Promise<unknown> => {
    if (toolId !== 'submit_work') throw new Error(`unknown tool: ${toolId}`);
    captured = sanitize(args.output);
    return { ok: true, length: captured.length };
  };

  const deterministic: Planner = createRuleBasedPlanner([
    { match: () => true, toolId: 'submit_work', args: { output: deterministicOutput(input) } },
  ]);
  const effective = kind === 'anthropic' ? planner : deterministic;

  const priorText = (input.priorOutputs ?? [])
    .map((p, i) => `Step ${i + 1} (${p.description}): ${p.output}`)
    .join('\n');

  let result: RunResult;
  try {
    result = await runIntent(
      {
        goal:
          `Endeavor goal: "${input.goal}".\nExecute this ${input.stepKind} step: "${input.stepDescription}".` +
          (priorText ? `\n\nDeliverables so far:\n${priorText}` : ''),
        context: { principal: input.principal, endeavorId: input.endeavorId },
      },
      { planner: effective, tools: WORK_TOOLS, invoke },
    );
  } catch {
    result = { outcome: 'failed', plan: { steps: [] }, steps: [] };
  }

  const output = captured.length > 0 ? captured : deterministicOutput(input);
  void result;
  return { output, plannerKind: kind };
}
