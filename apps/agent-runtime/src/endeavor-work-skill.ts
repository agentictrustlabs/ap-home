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
import { selectPlanner, withPlaybook, type PlannerEnv } from './orchestration.js';
import { QUERY_PUBLIC_GRAPH_TOOL, runPublicSparql, digestRows, type PublicGraphEnv } from './public-graph.js';

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
  /** spec 327 §4b / 334 §6 — the org's steward-authored playbook (the SAME SKILL.md the discussion
   *  assistant uses), prepended to the work contract so the deliverable reflects the org's own
   *  domain, policy, and voice. Absent/empty ⇒ the built-in contract alone (unchanged behaviour). */
  playbook?: string;
  /** spec 334 §6 gather phase — reference facts the model gathered from the public graph BEFORE
   *  writing (a compact digest, produced once per run by `gatherReferenceContext`). Read-only public
   *  data, embedded as context; the model still writes through the single `submit_work` sink. */
  references?: string;
}

const GATHER_CONTRACT =
  "You are gathering reference facts for a coordination task. Use query_public_graph to pull PUBLIC " +
  'data relevant to the goal, and read_org_record to read your organization\'s OWN stored records ' +
  '(e.g. its claims/attestations) when the goal needs them — your organization guidance above ' +
  'describes the graph vocabulary and which record types exist. Gather only what the goal needs; ' +
  'call the tools as many times as you need, then stop. If nothing is relevant, make no calls.';

/** The tool the model composes to read ONE of the org's own vault records by recordType (fulfilled by
 *  the caller against the read-only coordination grant). The recordType names live in the org's
 *  playbook, not here — the platform stays domain-agnostic. */
const READ_ORG_RECORD_TOOL: ToolSpec = {
  id: 'read_org_record',
  description:
    "Read one of your organization's OWN stored records by its record type (as named in your " +
    'organization guidance above — e.g. an attestations/claims record). Returns the stored JSON, or ' +
    'an error if that record type is not readable. Use it to ground the work in what your ' +
    'organization has actually recorded — never invent a claim or a figure.',
  inputSchema: {
    type: 'object',
    properties: { recordType: { type: 'string', description: "The record type to read (from your org guidance)." } },
    required: ['recordType'],
  },
};

/** spec 334 §6 gather phase — let the model author read-only queries against the PUBLIC graph and
 *  collect the results into a compact digest that the write turn reasons over. Runs ONLY with an LLM
 *  planner and a configured public endpoint (the rule-based planner cannot author SPARQL); otherwise
 *  returns '' and the run proceeds with no reference data — a pure enrichment, never a dependency.
 *  The query is the MODEL's (guided by the playbook); this function only guards + executes + digests,
 *  so no domain vocabulary lives in the platform. */
export async function gatherReferenceContext(
  env: PlannerEnv & PublicGraphEnv,
  input: {
    goal: string; playbook?: string; principal: string; endeavorId: string;
    /** Fulfils read_org_record — reads one of the org's OWN records by recordType via the read-only
     *  coordination grant. Omitted ⇒ the tool is not offered (org-record reads simply unavailable). */
    readOrgRecord?: (recordType: string) => Promise<{ ok: boolean; data?: unknown; error?: string; needsEnable?: boolean }>;
  },
): Promise<string> {
  const graphOn = !!String(env.PUBLIC_GRAPH_URL ?? '').trim();
  const orgReadsOn = !!input.readOrgRecord;
  if (!graphOn && !orgReadsOn) return '';
  const { planner, kind } = selectPlanner(env, { systemPrompt: withPlaybook(input.playbook, GATHER_CONTRACT), maxTokens: 1500 });
  if (kind !== 'anthropic') return ''; // only the LLM can author a query / pick a record; the template cannot.

  const tools: ToolSpec[] = [];
  if (graphOn) tools.push(QUERY_PUBLIC_GRAPH_TOOL);
  if (orgReadsOn) tools.push(READ_ORG_RECORD_TOOL);

  const digests: string[] = [];
  let n = 0;
  const invoke = async (toolId: string, args: Record<string, unknown>): Promise<unknown> => {
    if (toolId === 'query_public_graph') {
      if (!graphOn) throw new Error('public graph not available');
      n += 1;
      const run = await runPublicSparql(env, String(args.query ?? ''));
      if (!run.ok) return { ok: false, error: run.error }; // surfaced to the planner as an observation
      digests.push(digestRows(`Query ${n}`, run.rows ?? [], run.truncated));
      return { ok: true, rows: (run.rows ?? []).length, truncated: !!run.truncated };
    }
    if (toolId === 'read_org_record') {
      if (!input.readOrgRecord) throw new Error('org records not available');
      const recordType = String(args.recordType ?? '').trim();
      const r = await input.readOrgRecord(recordType);
      if (!r.ok) return { ok: false, error: r.error ?? (r.needsEnable ? 'org reads not enabled' : 'not readable') };
      // A compact JSON digest, hard-capped so a big record can't blow the downstream context budget.
      digests.push(`Org record "${recordType}":\n${JSON.stringify(r.data ?? null).slice(0, 1500)}`);
      return { ok: true, recordType };
    }
    throw new Error(`unknown tool: ${toolId}`);
  };

  try {
    await runIntent(
      { goal: `Gather the reference facts needed for: "${input.goal}".`, context: { principal: input.principal, endeavorId: input.endeavorId } },
      { planner, tools, invoke, maxSteps: 5 },
    );
  } catch { /* gather is best-effort enrichment — a failed turn just yields no reference data */ }

  return digests.join('\n\n').slice(0, 4500);
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
  'ANSWER their question. Your FIRST sentence MUST be the direct verdict/answer to the goal ' +
  '(e.g. "Yes — you can afford the trip, because…", "No — not yet, because…", "Aim for $450k–$550k."), ' +
  'then support it: synthesize the step deliverables into the concrete outcome they asked for ' +
  '(the actual recommendation, numbers, decision, or artifact), stated plainly and addressed to ' +
  'them. Where the deliverables left gaps, fill them with your own reasoning and clearly-labelled ' +
  'assumptions so the requester gets a real, actionable answer — then note what they should confirm ' +
  'or provide to refine it. Call submit_answer exactly once.';

/** Honest step fallback when no deliverable could be produced. The reason distinguishes "no model
 *  configured" from "the model calls failed" (rate limits) — the old text claimed the former in
 *  both cases, which misled operators on keyed deployments. */
function deterministicOutput(input: EndeavorStepWorkInput, kind: 'anthropic' | 'rule-based', lastError?: string): string {
  const d = input.stepDescription.trim().replace(/\.$/, '');
  const why = kind === 'anthropic'
    ? `The agent's model calls failed for this step${lastError ? ` (${lastError})` : ''} — recorded as picked up; re-run auto-work or refine by hand.`
    : 'No model configured on this deployment — recorded as an agent-completed step; a human can refine the deliverable.';
  return `Handled by the agent for the goal "${input.goal}": ${d}. (${why})`;
}

function sanitize(raw: unknown): string {
  const s = String(raw ?? '').trim();
  return s.slice(0, 4000);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Compact an error message to a short operator-readable tag. */
function shortError(e: string): string {
  if (/429|rate.?limit/i.test(e)) return 'rate-limited';
  if (/529|overloaded/i.test(e)) return 'model overloaded';
  const m = e.match(/HTTP \d{3}/);
  return m ? m[0] : e.slice(0, 80);
}

/** Run one single-tool turn, capturing the tool argument. The model path retries with REAL backoff
 *  — per-minute rate limits (429/529) are the common cause of dropped turns and need tens of
 *  seconds, not milliseconds, to clear (the autopilot fires several LLM calls back-to-back). Falls
 *  back to `fallback(lastError)` only after retries are exhausted. */
async function runSingleToolTurn(
  env: PlannerEnv,
  opts: {
    contract: string;
    tools: ToolSpec[];
    toolId: string;
    argKey: string;
    goal: string;
    context: Record<string, unknown>;
    fallback: (kind: 'anthropic' | 'rule-based', lastError?: string) => string;
  },
): Promise<{ output: string; plannerKind: 'anthropic' | 'rule-based'; fellBack: boolean }> {
  // maxTokens 4096: the deliverable/answer rides INSIDE the tool call's input, so the output budget
  // must cover the whole artifact — the planner's 1024 default truncated long answers mid-emit,
  // which surfaced as an empty capture with no error (the "model calls failed" fallback with no reason).
  const { planner, kind } = selectPlanner(env, { systemPrompt: opts.contract, maxTokens: 4096 });

  let captured = '';
  const invoke = async (toolId: string, args: Record<string, unknown>): Promise<unknown> => {
    if (toolId !== opts.toolId) throw new Error(`unknown tool: ${toolId}`);
    captured = sanitize(args[opts.argKey]);
    return { ok: true, length: captured.length };
  };

  if (kind !== 'anthropic') {
    const fallbackText = opts.fallback(kind);
    const deterministic: Planner = createRuleBasedPlanner([
      { match: () => true, toolId: opts.toolId, args: { [opts.argKey]: fallbackText } },
    ]);
    try {
      await runIntent({ goal: opts.goal, context: opts.context }, { planner: deterministic, tools: opts.tools, invoke });
    } catch { /* fall through to fallback */ }
    return { output: captured.length > 0 ? captured : fallbackText, plannerKind: kind, fellBack: true };
  }

  // Model path: 3 attempts. Rate-limit/overload errors get long waits (the per-minute window has
  // to actually elapse); other failures get short ones. All waits are IO (DO wall-clock, not CPU).
  let lastError: string | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    let result: RunResult;
    try {
      result = await runIntent(
        { goal: opts.goal, context: opts.context },
        { planner, tools: opts.tools, invoke },
      );
    } catch (e) {
      result = { outcome: 'failed', plan: { steps: [] }, steps: [], error: e instanceof Error ? e.message : String(e) };
    }
    if (captured.length > 0) return { output: captured, plannerKind: kind, fellBack: false };
    // A "successful" run with nothing captured = the model emitted an empty/truncated tool input;
    // name it so the fallback note carries a real reason instead of silence.
    lastError = result.error ?? lastError ?? 'model returned an empty tool output';
    if (attempt < 2) {
      const rateLimited = /429|529|rate.?limit|overloaded/i.test(lastError ?? '');
      await sleep(rateLimited ? 20_000 + attempt * 15_000 : 1_500 * (attempt + 1));
    }
  }
  return { output: opts.fallback(kind, lastError ? shortError(lastError) : undefined), plannerKind: kind, fellBack: true };
}

/** Clip prior deliverables for prompt context — full texts stay in the evidence record; the prompt
 *  only needs the gist (keeps per-minute input-token pressure down across a 6-step run). */
function clipPrior(outputs: Array<{ description: string; output: string }>): string {
  return outputs
    .map((p, i) => `Step ${i + 1} (${p.description}): ${p.output.length > 700 ? `${p.output.slice(0, 700)}…` : p.output}`)
    .join('\n');
}

/** Run one step's work turn. Returns the deliverable text (never empty — falls back to the
 *  honest pickup note) and which planner ran. Pure compute — the caller records it. */
export async function executeEndeavorStep(
  env: PlannerEnv,
  input: EndeavorStepWorkInput,
): Promise<{ output: string; plannerKind: 'anthropic' | 'rule-based'; fellBack: boolean }> {
  const priorText = clipPrior(input.priorOutputs ?? []);
  const refs = (input.references ?? '').trim();
  return runSingleToolTurn(env, {
    contract: withPlaybook(input.playbook, WORK_CONTRACT),
    tools: WORK_TOOLS,
    toolId: 'submit_work',
    argKey: 'output',
    goal:
      `Endeavor goal: "${input.goal}".\nExecute this ${input.stepKind} step: "${input.stepDescription}".` +
      (refs ? `\n\nReference data (from the public graph):\n${refs}` : '') +
      (priorText ? `\n\nDeliverables so far:\n${priorText}` : ''),
    context: { principal: input.principal, endeavorId: input.endeavorId },
    fallback: (kind, err) => deterministicOutput(input, kind, err),
  });
}

/** Synthesize the requester-facing OUTCOME — the actual answer to the goal (first sentence = the
 *  verdict), not a process recap (spec 334 §7). Takes every step's deliverable and produces the
 *  concrete result addressed to the requester. Full-length (recorded as the satisfy note +
 *  delivered to the requester's inbox). */
export async function synthesizeEndeavorOutcome(
  env: PlannerEnv,
  input: { principal: string; endeavorId: string; goal: string; deliverables: Array<{ description: string; output: string }>; playbook?: string; references?: string },
): Promise<{ answer: string; plannerKind: 'anthropic' | 'rule-based'; fellBack: boolean }> {
  const body = input.deliverables
    .map((d, i) => `Step ${i + 1} — ${d.description}\n${d.output}`)
    .join('\n\n');
  const fallback = (kind: 'anthropic' | 'rule-based', err?: string): string =>
    kind === 'anthropic'
      ? `The agent completed all ${input.deliverables.length} plan step(s) for "${input.goal}" (see the per-step ` +
        `results), but its model calls failed while writing the final answer${err ? ` (${err})` : ''}. ` +
        'The step deliverables contain the substance — a person can read them for the answer, or re-run the request.'
      : `Here is where things stand on "${input.goal}": the agent worked through ${input.deliverables.length} ` +
        'planned step(s) and recorded a deliverable for each (see the per-step results). No model is ' +
        'configured on this deployment, so a person should review the deliverables to produce the final answer.';
  const { output, plannerKind, fellBack } = await runSingleToolTurn(env, {
    contract: withPlaybook(input.playbook, ANSWER_CONTRACT),
    tools: ANSWER_TOOLS,
    toolId: 'submit_answer',
    argKey: 'answer',
    goal:
      `The requester's goal: "${input.goal}".\n\n` +
      ((input.references ?? '').trim() ? `Reference data (from the public graph):\n${(input.references ?? '').trim()}\n\n` : '') +
      `Deliverables produced across the plan:\n\n${body}\n\n` +
      'Write the final answer to the requester now — first sentence = the direct verdict.',
    context: { principal: input.principal, endeavorId: input.endeavorId },
    fallback,
  });
  return { answer: output, plannerKind, fellBack };
}
