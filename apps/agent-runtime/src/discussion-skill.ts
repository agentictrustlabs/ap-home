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
import { runIntent, createRuleBasedPlanner, type Planner, type ToolSpec, type RunResult } from '@agenticprimitives/orchestration';
import { selectPlanner, type PlannerEnv } from './orchestration.js';

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
}

/** What `internal.channels.read` returns (the slice the goal-context builder needs). */
interface TopicReadResult {
  messages?: Array<{ authorName?: string; actor?: string; bodyText?: string }>;
}

export const DISCUSSION_TOOLS: ToolSpec[] = [
  {
    id: 'post_topic_message',
    description: "Post ONE reply into the discussion topic, authored as the organization. `bodyText` is the complete reply text. May be called at most once per turn.",
    inputSchema: { type: 'object', properties: { bodyText: { type: 'string', description: 'The full reply text.' } }, required: ['bodyText'] },
  },
];

/** The discussion turn's PLANNING contract: one tool, one call, the reply is the arguments. */
const DISCUSSION_PLANNER_SYSTEM =
  "You compose the reply for an organization's discussion-board assistant. Call post_topic_message " +
  'exactly once, with the complete reply text as bodyText. Write the reply directly from the goal ' +
  'and the recent-messages context it contains. Never answer in prose.';

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

export async function handleDiscussionRespond(
  env: PlannerEnv,
  input: DiscussionRespondInput,
  io: DiscussionIo,
): Promise<{ result: RunResult; plannerKind: 'anthropic' | 'rule-based'; posted: boolean; messageId?: string }> {
  const { planner, kind } = selectPlanner(env, { systemPrompt: DISCUSSION_PLANNER_SYSTEM });
  // The deterministic turn (no LLM configured): one template reply acknowledging the trigger.
  // Sufficient for e2e verification without a model key.
  const deterministic: Planner = createRuleBasedPlanner([
    {
      match: () => true,
      toolId: 'post_topic_message',
      args: { bodyText: `${input.displayName} here — thanks for the mention, ${input.triggerAuthor}. A steward will follow up in this topic.` },
    },
  ]);
  const effective = kind === 'anthropic' ? planner : deterministic;

  // Harness context pre-fetch (LLM turns only — the template ignores it). Best-effort ENRICHMENT,
  // not authority and not a second mechanism: a failed read just means the goal carries only the
  // trigger message.
  let topicContext = '';
  if (kind === 'anthropic') {
    try {
      topicContext = contextLines((await io.readTopic()) as TopicReadResult);
    } catch { /* trigger-only context */ }
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

  const goal =
    `You are ${input.displayName}, the organization's own assistant participating in its discussion topic "${input.topicTitle}". ` +
    `${input.triggerAuthor} just posted: "${input.triggerBody}". ` +
    `Post exactly one concise, helpful reply as the organization (call post_topic_message with the full reply as bodyText).` +
    topicContext;

  const result = await runIntent(
    { goal, context: { principal: input.principal, channelId: input.channelId } },
    { planner: effective, tools: DISCUSSION_TOOLS, invoke },
  );
  return { result, plannerKind: kind, posted, ...(messageId ? { messageId } : {}) };
}
