// spec 327 §4 — the org-assistant discussion turn (318 §8.1: the org's OWN agent replying in its
// topic). Runs the SHARED Ring-0 loop (ADR-0044) over exactly two tools whose invoker is closed
// over the ONE topic the trigger came from (the planner never chooses the topic, and it never
// carries authority — ADR-0041; posting rides the org's existing interactions grant through the
// InteractionsDO `internal.channels.post` pipeline, `from`/`actor` pinned server-side).
//
// Planner selection is the EXISTING deploy-config seam (`selectPlanner`): Anthropic when
// ORCHESTRATION_LLM='anthropic' + ANTHROPIC_API_KEY, else a deterministic template reply — a
// config choice, not a fallback path (ADR-0013). Message bodies are DATA to the planner; the tool
// set below is the total capability surface (fail-closed assertKnownTools in the loop), and the
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

/** The assistant turn's I/O seam — both calls land on the org's InteractionsDO internal ops. */
export interface DiscussionIo {
  readTopic: () => Promise<unknown>;
  post: (bodyText: string) => Promise<{ messageId?: string }>;
}

export const DISCUSSION_TOOLS: ToolSpec[] = [
  {
    id: 'read_topic_messages',
    description: 'Read the recent messages of this discussion topic (bounded context for composing the reply). Needs no arguments.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    id: 'post_topic_message',
    description: "Post ONE reply into the discussion topic, authored as the organization. `bodyText` is the complete reply text. May be called at most once per turn.",
    inputSchema: { type: 'object', properties: { bodyText: { type: 'string', description: 'The full reply text.' } }, required: ['bodyText'] },
  },
];

/** The discussion turn's PLANNING contract (spec 327 §4). The shared default prompt says "choose the
 *  single tool", which lets the model plan a context READ and stop — completing without ever posting
 *  (the invoker then fails the turn closed: "completed without posting a reply", 2026-07-17 prod
 *  finding). This prompt makes the post mandatory; the read stays optional and BEFORE it. */
const DISCUSSION_PLANNER_SYSTEM =
  "You compose the reply for an organization's discussion-board assistant. You MUST call " +
  'post_topic_message exactly once, with the complete reply text as bodyText — a turn that never ' +
  'posts is a failure. You may also call read_topic_messages before it (in the same plan) when more ' +
  'context would genuinely help. You may ONLY use the provided tools; never answer in prose.';

export async function handleDiscussionRespond(
  env: PlannerEnv,
  input: DiscussionRespondInput,
  io: DiscussionIo,
): Promise<{ result: RunResult; plannerKind: 'anthropic' | 'rule-based'; posted: boolean; messageId?: string }> {
  const { planner, kind } = selectPlanner(env, { systemPrompt: DISCUSSION_PLANNER_SYSTEM });
  // The deterministic turn (no LLM configured): read for the audit trail's sake is skipped — one
  // template reply acknowledging the trigger. Sufficient for e2e verification without a model key.
  const deterministic: Planner = createRuleBasedPlanner([
    {
      match: () => true,
      toolId: 'post_topic_message',
      args: { bodyText: `${input.displayName} here — thanks for the mention, ${input.triggerAuthor}. A steward will follow up in this topic.` },
    },
  ]);
  const effective = kind === 'anthropic' ? planner : deterministic;

  let posted = false;
  let messageId: string | undefined;
  const invoke = async (toolId: string, args: Record<string, unknown>): Promise<unknown> => {
    if (toolId === 'read_topic_messages') return io.readTopic();
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
    `Post exactly one concise, helpful reply as the organization (call post_topic_message with the full reply as bodyText); ` +
    `optionally read the recent topic messages first if more context would genuinely help.`;

  const result = await runIntent(
    { goal, context: { principal: input.principal, channelId: input.channelId } },
    { planner: effective, tools: DISCUSSION_TOOLS, invoke },
  );
  return { result, plannerKind: kind, posted, ...(messageId ? { messageId } : {}) };
}
