// spec 329 §3 — the `discussion.consult` A2A skill on PERSON agents: an org's agent asks this
// member's agent one discussion question over the STANDARD task rail. Unlike the in-Worker
// assistant turns (./discussion-skill.ts, ./inbox-skill.ts), this IS a public A2A skill — its
// authorization is the member-signed consultability delegation, re-verified per message by
// `authorizeA2aMessage` on THIS side (delegate === the org sender, allowedTargets === this member,
// allowedMethods === the `discussion.consult` selector, timestamp window, on-chain isRevoked +
// ERC-1271; spec 269 FR-4). No delegation, no consult, no exception (ADR-0013).
//
// The turn itself mirrors ./inbox-skill.ts (spec 328, the pattern of record): the SHARED Ring-0
// loop (ADR-0044), HARNESS READS (the member's SKILL.md playbook via a marker-gated internal op +
// the routed question/context from the task message), MODEL POSTS through exactly ONE tool —
// post_consult_answer — which `tool_choice: any` guarantees is called. The playbook governs
// tone/scope and may instruct declines; the DECLINE path is first-class (answered xor declined by
// construction — fabric buildConsultAnswer). No vault reads beyond the playbook in this wave
// (spec 329 §3.2 honest-capability statement): the answer grounds on the question, its carried
// context, and the playbook only.
import { runIntent, createRuleBasedPlanner, type Planner, type ToolSpec, type RunResult } from '@agenticprimitives/orchestration';
import {
  buildConsultAnswer,
  parseConsultRequest,
  type ConsultAnswerV1,
  type ConsultRequestV1,
} from '@agenticprimitives/fabric/messaging';
import type { CanonicalAgentId } from '@agenticprimitives/types';
import { selectPlanner, type PlannerEnv, type PlannerKind, llmConfigured as isLlmConfigured } from './orchestration.js';

export const CONSULT_TOOLS: ToolSpec[] = [
  {
    id: 'post_consult_answer',
    description:
      'Submit the ONE consult terminal: either `answer` (the complete answer text) or `declined: true` ' +
      '(optionally with `declineReason`) — never both. May be called at most once per turn.',
    inputSchema: {
      type: 'object',
      properties: {
        answer: { type: 'string', description: 'The complete answer text (omit when declining).' },
        declined: { type: 'boolean', description: 'true to explicitly decline answering.' },
        declineReason: { type: 'string', description: 'Optional short reason for the decline.' },
      },
    },
  },
];

/** The consult SITUATION — always part of the system prompt, after the archetype's doctrine when the
 *  member has one (a config default, not a fallback mechanism: the load path is one read). */
export const DEFAULT_CONSULT_SKILL_MD =
  "You are this person's agent, answering a question routed from a discussion in an organization " +
  'they belong to. Answer concisely and only from the question and its carried discussion context; ' +
  'be honest about uncertainty. If the question needs the person themselves, private information, ' +
  'or falls outside what they would want answered automatically, DECLINE with a short reason.';

/** The NON-NEGOTIABLE tool contract, appended AFTER the playbook (the must-answer guarantee is
 *  structural anyway — single tool + tool_choice any — this keeps the instructions coherent no
 *  matter what the owner wrote above it). */
const CONSULT_CONTRACT =
  '\n\nTool contract (always applies): call post_consult_answer exactly once — with the complete ' +
  'answer as `answer`, OR with `declined: true` (and optionally `declineReason`) when you should ' +
  'not answer. Never answer in prose, never both answer and decline.';

/** What the marker-gated `internal.consult.context` op returns (the archetype's compiled instructions
 *  — spec 354 K3, digest-verified by the DO — + display name). */
interface ConsultContextRead {
  playbook?: string;
  displayName?: string;
}

export interface ConsultIo {
  /** Harness pre-read of the member's playbook/display name (BY THE HARNESS, never the planner).
   *  Best-effort enrichment: a failed read means the default playbook, same mechanism. */
  readContext: () => Promise<unknown>;
}

function tailLines(request: ConsultRequestV1): string {
  const rows = request.context.topicTail ?? [];
  if (rows.length === 0) return '';
  return `\nRecent discussion context (oldest first):\n${rows.map((r) => `- ${r.author}: ${r.bodyText}`).join('\n')}`;
}

/**
 * Run the consult turn for a PARSED request and return the built ConsultAnswer body (the caller —
 * the skill handler — emits it as the task Artifact and audits). `member` is pinned by the caller
 * from the VERIFIED principal (delegation.delegator), never from planner output.
 */
export async function handleConsultRespond(
  env: PlannerEnv,
  args: { member: CanonicalAgentId; request: ConsultRequestV1; orgLabel?: string },
  io: ConsultIo,
): Promise<{ result: RunResult; plannerKind: PlannerKind; answer: ConsultAnswerV1 | null; error?: string }> {
  const { request } = args;
  const llmConfigured = isLlmConfigured(env);
  let playbook = DEFAULT_CONSULT_SKILL_MD;
  let displayName = '';
  if (llmConfigured) {
    try {
      const read = (await io.readContext()) as ConsultContextRead;
      if (read.playbook?.trim()) playbook = `${read.playbook.trim()}\n\n${DEFAULT_CONSULT_SKILL_MD}`;
      if (read.displayName?.trim()) displayName = read.displayName.trim();
    } catch { /* default playbook + nameless goal — trigger-only context, same mechanism */ }
  }

  const { planner, kind } = selectPlanner(env, { systemPrompt: playbook + CONSULT_CONTRACT });
  // The deterministic turn (no LLM configured): one template answer acknowledging the question —
  // matching 327/328's rule-based behavior; sufficient for e2e without a model key. The playbook
  // cannot steer this turn (there is no model to steer) — honest capability floor.
  const deterministic: Planner = createRuleBasedPlanner([
    {
      match: () => true,
      toolId: 'post_consult_answer',
      args: {
        answer:
          `${displayName || 'This member'}'s agent here — I received the question "${request.goal.slice(0, 200)}" ` +
          'but no planner model is configured on this deployment, so I cannot compose a grounded answer. ' +
          `${displayName || 'The member'} can follow up in the discussion directly.`,
      },
    },
  ]);
  const effective = kind !== 'rule-based' ? planner : deterministic;

  let posted = false;
  let answer: ConsultAnswerV1 | null = null;
  let buildError: string | undefined;
  const invoke = async (toolId: string, toolArgs: Record<string, unknown>): Promise<unknown> => {
    if (toolId !== 'post_consult_answer') throw new Error(`unknown tool: ${toolId}`);
    if (posted) throw new Error('post_consult_answer may be called at most once per turn');
    const built = buildConsultAnswer(request, {
      member: args.member,
      answer: typeof toolArgs.answer === 'string' ? toolArgs.answer : undefined,
      declined: toolArgs.declined === true,
      declineReason: typeof toolArgs.declineReason === 'string' ? toolArgs.declineReason : undefined,
    });
    // Fail-closed INSIDE the loop: an invalid terminal (both/neither) throws so the planner
    // observes the failure — it can retry with a valid terminal; the turn never fabricates one.
    if (!built.ok) { buildError = built.error; throw new Error(built.error); }
    posted = true;
    answer = built.answer;
    return { ok: true, declined: built.answer.declined === true };
  };

  const goal =
    `You are answering ONE routed discussion question as ${displayName || 'this member'}'s agent, on behalf of a member of ` +
    `the organization ${args.orgLabel ?? request.context.orgSA}${request.context.topicTitle ? ` (topic "${request.context.topicTitle}")` : ''}. ` +
    `The question: ${request.goal}\n` +
    // Spec 380 W2 — WHY the organization asks, in its steward's words. Context for the member's own
    // judgement (and its declines); never an instruction the member's playbook must obey.
    (request.context.purpose ? `What the organization is asking for: ${request.context.purpose}\n` : '') +
    'Answer it via post_consult_answer (or decline per your instructions).' +
    tailLines(request);

  const result = await runIntent(
    { goal, context: { orgSA: request.context.orgSA, topicId: request.context.topicId, questionId: request.context.questionId } },
    { planner: effective, tools: CONSULT_TOOLS, invoke },
  );
  return { result, plannerKind: kind, answer: posted ? answer : null, ...(buildError && !posted ? { error: buildError } : {}) };
}
