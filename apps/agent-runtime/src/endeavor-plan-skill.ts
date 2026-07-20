// The org agent's coordination-plan DRAFTING turn (spec 327 planner reused for spec 334 §6).
// When a steward ADOPTS an EndeavorRequest, the org's own agent drafts a first multi-step plan
// from the plain-language goal — the same "harness reads, model posts" construction as the
// discussion turn: the planner is given exactly ONE tool (`draft_plan`) which `tool_choice: any`
// guarantees is called, so the turn is deterministic by construction, never prompt-obedience.
//
// The draft is a PROPOSAL only — it is proposed as plan revision N (org = actor = managing
// principal, so the reducer's participant gate passes) and the steward reviews/edits/adopts it.
// Authority is unchanged (ADR-0041): drafting composes no MCP tools and grants nothing.
import { runIntent, createRuleBasedPlanner, type Planner, type ToolSpec, type RunResult } from '@agenticprimitives/orchestration';
import { selectPlanner, withPlaybook, type PlannerEnv } from './orchestration.js';

export interface EndeavorPlanDraftInput {
  principal: string;
  endeavorId: string;
  goal: string;
  /** spec 327 §4b / 334 §6 — the org's steward-authored playbook (the SAME SKILL.md the discussion
   *  assistant uses). Prepended to the planning contract so the draft reflects the org's own domain,
   *  policy, and voice. Absent/empty ⇒ the built-in contract alone (unchanged behaviour). */
  playbook?: string;
}

export type DraftStepKind = 'contribution' | 'interaction' | 'decision' | 'aggregation' | 'validation';
export interface DraftStep { kind: DraftStepKind; description: string }

const STEP_KINDS: DraftStepKind[] = ['contribution', 'interaction', 'decision', 'aggregation', 'validation'];

const DRAFT_TOOLS: ToolSpec[] = [
  {
    id: 'draft_plan',
    description:
      'Propose the multi-step plan that would satisfy this goal. `steps` is an ordered array of ' +
      '3-7 concrete steps; each step has a `kind` (one of: contribution = someone does work; ' +
      'interaction = gather info / coordinate with someone; decision = a choice to make; ' +
      'aggregation = combine results; validation = confirm the outcome) and a short imperative ' +
      '`description`. Call this exactly once.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: STEP_KINDS, description: 'The step kind.' },
              description: { type: 'string', description: 'A short imperative description of the step.' },
            },
            required: ['kind', 'description'],
          },
        },
      },
      required: ['steps'],
    },
  },
];

const PLAN_CONTRACT =
  "You are an organization's coordination planner. Given a goal, break it into a small, concrete, " +
  'ordered plan of 3-7 steps that a team could actually execute. Prefer a first step that gathers ' +
  'any missing details (kind: interaction), middle steps that do the work (kind: contribution), and ' +
  'a final step that confirms the outcome (kind: validation). Call draft_plan exactly once with the ' +
  'steps. Never answer in prose.';

/** Deterministic fallback (no LLM configured) — a generic gather → do → confirm skeleton so the
 *  steward always gets a starting draft to edit, even without a model key. */
function deterministicSteps(goal: string): DraftStep[] {
  const g = goal.trim().replace(/\.$/, '');
  return [
    { kind: 'interaction', description: `Gather the details needed to ${g.charAt(0).toLowerCase()}${g.slice(1)}` },
    { kind: 'contribution', description: `Carry out the work to ${g.charAt(0).toLowerCase()}${g.slice(1)}` },
    { kind: 'validation', description: 'Confirm the outcome meets the goal and close it out' },
  ];
}

function sanitize(raw: unknown): DraftStep[] {
  if (!Array.isArray(raw)) return [];
  const out: DraftStep[] = [];
  for (const s of raw) {
    const o = (s ?? {}) as Record<string, unknown>;
    const kind = String(o.kind ?? '') as DraftStepKind;
    const description = String(o.description ?? '').trim();
    if (STEP_KINDS.includes(kind) && description) out.push({ kind, description: description.slice(0, 280) });
    if (out.length >= 7) break;
  }
  return out;
}

/** Run the drafting turn. Returns the drafted steps (never empty — falls back to the deterministic
 *  skeleton) and which planner ran. Pure compute — the caller proposes the plan. */
export async function draftEndeavorPlan(
  env: PlannerEnv,
  input: EndeavorPlanDraftInput,
): Promise<{ steps: DraftStep[]; plannerKind: 'anthropic' | 'rule-based' }> {
  const { planner, kind } = selectPlanner(env, { systemPrompt: withPlaybook(input.playbook, PLAN_CONTRACT) });

  let captured: DraftStep[] = [];
  const invoke = async (toolId: string, args: Record<string, unknown>): Promise<unknown> => {
    if (toolId !== 'draft_plan') throw new Error(`unknown tool: ${toolId}`);
    captured = sanitize(args.steps);
    return { ok: true, count: captured.length };
  };

  const deterministic: Planner = createRuleBasedPlanner([
    { match: () => true, toolId: 'draft_plan', args: { steps: deterministicSteps(input.goal) } },
  ]);
  const effective = kind === 'anthropic' ? planner : deterministic;

  let result: RunResult;
  try {
    result = await runIntent(
      { goal: `Draft a coordination plan for this goal: "${input.goal}".`, context: { principal: input.principal, endeavorId: input.endeavorId } },
      { planner: effective, tools: DRAFT_TOOLS, invoke },
    );
  } catch {
    result = { outcome: 'failed', plan: { steps: [] }, steps: [] };
  }

  // Fail-safe: an LLM turn that produced nothing usable still yields the deterministic skeleton so
  // the steward is never left with an empty Plan section (ADR-0013: one mechanism — the draft — with
  // a config default, not a second live path).
  const steps = captured.length > 0 ? captured : deterministicSteps(input.goal);
  void result;
  return { steps, plannerKind: kind };
}
