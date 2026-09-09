// spec 327 §4 — the org-assistant discussion turn (318 §8.1: the org's OWN agent replying in its
// topic). Runs the SHARED Ring-0 loop (ADR-0044) with the invoker closed over the ONE topic the
// trigger came from (the planner never chooses the topic, and it never carries authority —
// ADR-0041; posting rides the org's existing interactions grant through the InteractionsDO
// `internal.channels.post` pipeline, `from`/`actor` pinned server-side).
//
// HARNESS READS, MODEL POSTS (2026-07-17 prod finding, twice): reading topic context is NOT a
// decision — plan-then-execute planners that were OFFERED a read tool repeatedly planned only the
// read (they cannot compose bodyText from a result they haven't seen) and the turn completed
// without posting (fail-closed "completed without posting a reply"). So the harness pre-fetches
// the recent messages itself and embeds them in the goal; the planner is given exactly ONE tool —
// post_topic_message — which `tool_choice: any` then GUARANTEES is called. Determinism by
// construction, not prompt obedience.
//
// Planner selection is the EXISTING deploy-config seam (`selectPlanner`): Anthropic when
// ORCHESTRATION_LLM='anthropic' + ANTHROPIC_API_KEY, else a deterministic template reply — a
// config choice, not a fallback path (ADR-0013). Message bodies are DATA to the planner; the tool
// below is the total capability surface (fail-closed assertKnownTools in the loop), and the
// invoker enforces at-most-one post per turn independently of the plan.
import { runIntent, createRuleBasedPlanner, type Planner, type PlanStep, type ToolSpec, type RunResult } from '@agenticprimitives/orchestration';
import { selectPlanner, type PlannerEnv, type PlannerKind, llmConfigured as isLlmConfigured } from './orchestration.js';
import { gatherReferenceContext } from './endeavor-work-skill.js';
import type { PublicGraphEnv } from './public-graph.js';

export interface DiscussionRespondInput {
  principal: string;
  channelId: string;
  topicTitle: string;
  displayName: string;
  triggerAuthor: string;
  triggerBody: string;
}


/** The assistant turn's I/O seam — both calls land on the org's InteractionsDO internal ops.
 *  `readTopic` is invoked BY THE HARNESS (context pre-fetch), never by the planner. */
export interface DiscussionIo {
  readTopic: () => Promise<unknown>;
  post: (bodyText: string) => Promise<{ messageId?: string }>;
  /** spec 334 §6 gather phase, extended to the @ask turn: read ONE of the org's OWN records by
   *  recordType (owner-self, through the read-only coordination grant). recordType is OPAQUE here —
   *  the record vocabulary lives in the org's playbook, never in the platform. Omitted ⇒ org-record
   *  grounding is simply not offered (the turn grounds on topic messages + playbook only). Invoked
   *  BY THE HARNESS's gather sub-turn, never by the post planner. */
  readOrgRecord?: (recordType: string) => Promise<{ ok: boolean; data?: unknown; error?: string; needsEnable?: boolean }>;
}

/** What `internal.channels.read` returns (the slice the goal-context builder needs). */
interface TopicReadResult {
  messages?: Array<{ authorName?: string; actor?: string; bodyText?: string }>;
  /** spec 327 §4b — the org's steward-authored assistant playbook (SKILL.md projection), if any. */
  skillMarkdown?: string;
}

export const DISCUSSION_TOOLS: ToolSpec[] = [
  {
    id: 'post_topic_message',
    description: "Post ONE reply into the discussion topic, authored as the organization. `bodyText` is the complete reply text. May be called at most once per turn.",
    inputSchema: { type: 'object', properties: { bodyText: { type: 'string', description: 'The full reply text.' } }, required: ['bodyText'] },
  },
];

const NO_PLAYBOOK_NOTICE = (reason: 'missing' | 'unreadable'): string =>
  'You have NO operating guidance loaded. ' +
  (reason === 'unreadable'
    ? "This organization's playbook could not be read from its vault — a storage or grant problem, not an empty configuration. "
    : 'No playbook has been authored into this organization\'s vault yet. ') +
  'You therefore have no skills, no domain vocabulary and no record types. ' +
  'Answer ONLY what the recent topic messages already contain, and OPEN your reply by stating plainly ' +
  'that no skills are loaded for this organization so nobody mistakes this for a configured agent. ' +
  'Do not improvise domain expertise and do not describe capabilities you do not have.';

/** The NON-NEGOTIABLE tool contract, appended AFTER the playbook. The must-post guarantee is
 *  structural anyway (single tool + tool_choice any) — this line keeps the instructions coherent
 *  no matter what the steward wrote above it. */
const DISCUSSION_CONTRACT =
  '\n\nTool contract (always applies): call post_topic_message exactly once, with the complete ' +
  'reply text as bodyText. Write the reply directly from the goal and the recent-messages context ' +
  'it contains. Never answer in prose.';

/** Bound the context embedded in the goal (the planner turn is small — 1024 max_tokens out). */
const CONTEXT_MESSAGES = 8;
const CONTEXT_CLIP = 300;

function contextLines(read: TopicReadResult | null): string {
  const rows = (read?.messages ?? []).slice(-CONTEXT_MESSAGES);
  if (rows.length === 0) return '';
  const lines = rows.map((m) => {
    const who = m.actor ? `${m.authorName ?? 'assistant'} (assistant)` : (m.authorName ?? 'member');
    return `- ${who}: ${(m.bodyText ?? '').slice(0, CONTEXT_CLIP)}`;
  });
  return `\nRecent messages in the topic:\n${lines.join('\n')}`;
}

/**
 * The @-mention turn (spec 327): the organization answers ALONE, under its topic playbook, posting through
 * exactly one tool. The ROUTED turn — members consulted — is no longer this function's: spec 380 W3 made it
 * one harness run at the organization (`A2aTaskDO` `/internal/discussion-respond`), so this is the plain
 * turn the Durable Object falls back to when routing is off, no candidate ranks, or the run posts nothing.
 */
export async function handleDiscussionRespond(
  env: PlannerEnv & PublicGraphEnv,
  input: DiscussionRespondInput,
  io: DiscussionIo,
): Promise<{ result: RunResult; plannerKind: PlannerKind; posted: boolean; messageId?: string }> {
  const llmConfigured = isLlmConfigured(env);
  let topicContext = '';
  let playbook = NO_PLAYBOOK_NOTICE('missing');
  if (llmConfigured) {
    try {
      const read = (await io.readTopic()) as TopicReadResult;
      topicContext = contextLines(read);
      // The AUTHOR's vault is the only source of operating guidance. A missing playbook and an
      // unreadable one are different problems with different fixes, so they are reported differently.
      if (read.skillMarkdown?.trim()) playbook = read.skillMarkdown.trim();
    } catch { playbook = NO_PLAYBOOK_NOTICE('unreadable'); }
    // spec 334 §6 gather phase, applied to the @ask turn (same "harness reads, model posts"
    // construction): when the caller wired org-record reads, a gather sub-turn lets the org's own
    // agent read its OWN records — the recordTypes it reads are the ones the PLAYBOOK above names
    // (domain vocabulary stays in the org's guidance, never here) — and embeds a compact digest in
    // the goal. Pure enrichment: no grant / no LLM / nothing relevant ⇒ '' and the turn is unchanged.
    if (io.readOrgRecord) {
      try {
        const references = await gatherReferenceContext(env, {
          goal: input.triggerBody, playbook, principal: input.principal,
          endeavorId: input.channelId, // opaque correlation id for the gather sub-turn (no board here)
          readOrgRecord: io.readOrgRecord,
        });
        if (references.trim()) {
          topicContext +=
            "\n\nReference facts from your organization's own records (ground your reply in these; " +
            'follow your organization guidance above on how to cite and caveat them — never present a ' +
            'figure as more verified than the record says):\n' + references.trim();
        }
      } catch { /* gather is best-effort enrichment — a failure just yields no reference block */ }
    }
  }

  let posted = false;
  let messageId: string | undefined;
  const invoke = async (toolId: string, args: Record<string, unknown>): Promise<unknown> => {
    if (toolId === 'post_topic_message') {
      if (posted) throw new Error('post_topic_message may be called at most once per turn');
      const bodyText = String(args.bodyText ?? '').trim();
      if (!bodyText) throw new Error('post_topic_message requires bodyText');
      posted = true;
      const r = await io.post(bodyText);
      messageId = r.messageId;
      return r;
    }
    throw new Error(`unknown tool: ${toolId}`);
  };
  const { planner, kind } = selectPlanner(env, { systemPrompt: playbook + DISCUSSION_CONTRACT });
  const deterministic: Planner = createRuleBasedPlanner([{ match: () => true, steps: [
    { toolId: 'post_topic_message', args: { bodyText: `${input.displayName} here — thanks for the mention, ${input.triggerAuthor}. A steward will follow up in this topic.` } },
  ] as PlanStep[] }]);
  const effective = kind !== 'rule-based' ? planner : deterministic;
  const goal =
    `You are ${input.displayName}, the organization's own assistant participating in its discussion topic "${input.topicTitle}". ` +
    `${input.triggerAuthor} just posted: "${input.triggerBody}". ` +
    'Post exactly one concise, helpful reply as the organization (call post_topic_message with the full reply as bodyText).' +
    topicContext;
  const result = await runIntent({ goal, context: { principal: input.principal, channelId: input.channelId } }, { planner: effective, tools: DISCUSSION_TOOLS, invoke });
  return { result, plannerKind: kind, posted, ...(messageId ? { messageId } : {}) };
}

/**
 * Spec 380 W3 — WHAT THE COMPOSER IS TOLD for a routed topic reply: whose voice, which topic, whom it answers,
 * and the attribution rule that was the synthesis contract (329 §4.1) — name who was consulted, attribute
 * what each member's agent said, say plainly who declined or had not answered, never invent an answer.
 * The topic's steward-written assistant document (327 §4b) follows as guidance on tone and emphasis. Read
 * by the composer only; a verifier never sees it and it widens nothing.
 */
export function topicReplyGuidance(input: Pick<DiscussionRespondInput, 'displayName' | 'topicTitle' | 'triggerAuthor'>, topicGuidance?: string): string {
  const base =
    `You are ${input.displayName}, the organization's own assistant, replying in its discussion topic "${input.topicTitle}" ` +
    `to ${input.triggerAuthor}. Write the reply as ONE topic post in the organization's voice. You consulted member agents: ` +
    'name who was consulted, attribute what you use to the member whose agent said it (quoting is allowed, with names), ' +
    'and state plainly who declined, was not asked, or had not answered in time. Never invent an answer for a member who gave none.';
  const extra = (topicGuidance ?? '').trim();
  return extra ? `${base}\n\nThe organization's guidance for this topic:\n${extra}` : base;
}
