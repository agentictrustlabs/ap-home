// spec 328 §4 — the PERSON inbox auto-reply turn (the person's OWN agent answering their 1:1
// mail). The person twin of ./discussion-skill.ts (spec 327), same construction throughout:
// runs the SHARED Ring-0 loop (ADR-0044) with the invoker closed over the ONE conversation the
// trigger came from (the planner never chooses the conversation and never carries authority —
// ADR-0041; sending rides the person's existing interactions + delivery grants through the
// InteractionsDO `internal.inbox.post` pipeline, `from`/`actor` pinned server-side).
//
// HARNESS READS, MODEL POSTS (the 327 prod finding, ported verbatim): the harness pre-fetches
// recent conversation context itself (`internal.inbox.read`) and embeds it in the goal; the
// planner is given exactly ONE tool — post_inbox_reply — which `tool_choice: any` GUARANTEES is
// called. Determinism by construction, not prompt obedience.
//
// Planner selection is the EXISTING deploy-config seam (`selectPlanner`): Anthropic when
// ORCHESTRATION_LLM='anthropic' + ANTHROPIC_API_KEY, else a deterministic template reply — a
// config choice, not a fallback path (ADR-0013). Message bodies are DATA to the planner; the tool
// below is the total capability surface, and the invoker enforces at-most-one reply per turn.
import { runIntent, createRuleBasedPlanner, type Planner, type ToolSpec, type RunResult } from '@agenticprimitives/orchestration';
import { selectPlanner, type PlannerEnv } from './orchestration.js';

export interface InboxRespondInput {
  principal: string;
  conversationId: string;
  /** The triggering envelope id (audit/context anchor; the read op returns the thread anyway). */
  messageId?: string;
  senderCaip: string;
  subject?: string;
  /** Captured at enable time (spec 328 §2) and carried by the dispatch — no per-turn chain read. */
  displayName: string;
}

/** The turn's I/O seam — both calls land on the person's InteractionsDO internal ops.
 *  `readConversation` is invoked BY THE HARNESS (context pre-fetch), never by the planner. */
export interface InboxIo {
  readConversation: () => Promise<unknown>;
  post: (bodyText: string) => Promise<{ messageId?: string }>;
}

/** What `internal.inbox.read` returns (the slice the goal-context builder needs). */
interface ConversationReadResult {
  messages?: Array<{ from?: string; actor?: string; bodyText?: string; mine?: boolean }>;
  /** spec 354 K3 — the instructions of the person's COMPILED ARCHETYPE (digest-verified by the DO), if
   *  one is assigned. The doctrine the agent answers under; it grants nothing. */
  playbook?: string;
}

export const INBOX_TOOLS: ToolSpec[] = [
  {
    id: 'post_inbox_reply',
    description: 'Send ONE reply into this conversation, authored as the person you assist. `bodyText` is the complete reply text. May be called at most once per turn.',
    inputSchema: { type: 'object', properties: { bodyText: { type: 'string', description: 'The full reply text.' } }, required: ['bodyText'] },
  },
];

/** The inbox SITUATION — always part of the system prompt. Alone when the person has no archetype;
 *  after the archetype's doctrine when they do. A config default, not a fallback mechanism: the load
 *  path is one read; absent means this constant. */
export const DEFAULT_PERSON_ASSISTANT_SKILL_MD =
  "You are this person's personal inbox assistant, replying on their behalf while they are away. " +
  'Be concise, warm, and honest that you are their assistant; answer what you can from the recent ' +
  'conversation, and say plainly when something needs the person themselves to follow up.';

/** The NON-NEGOTIABLE tool contract, appended AFTER the playbook. The must-post guarantee is
 *  structural anyway (single tool + tool_choice any) — this line keeps the instructions coherent
 *  no matter what the owner wrote above it. */
const INBOX_CONTRACT =
  '\n\nTool contract (always applies): call post_inbox_reply exactly once, with the complete ' +
  'reply text as bodyText. Write the reply directly from the goal and the recent-conversation ' +
  'context it contains. Never answer in prose.';

/** Bound the context embedded in the goal (the planner turn is small). */
const CONTEXT_MESSAGES = 8;
const CONTEXT_CLIP = 300;

function contextLines(read: ConversationReadResult | null): string {
  const rows = (read?.messages ?? []).slice(-CONTEXT_MESSAGES);
  if (rows.length === 0) return '';
  const lines = rows.map((m) => {
    const who = m.mine ? (m.actor ? 'you (assistant, earlier)' : 'the person you assist') : m.actor ? 'them (their assistant)' : 'them';
    return `- ${who}: ${(m.bodyText ?? '').slice(0, CONTEXT_CLIP)}`;
  });
  return `\nRecent messages in the conversation (oldest first):\n${lines.join('\n')}`;
}

export async function handleInboxRespond(
  env: PlannerEnv,
  input: InboxRespondInput,
  io: InboxIo,
): Promise<{ result: RunResult; plannerKind: 'anthropic' | 'rule-based'; posted: boolean; messageId?: string }> {
  // Harness context pre-fetch (LLM turns only — the template ignores it). Best-effort ENRICHMENT,
  // not authority and not a second mechanism: a failed read just means a trigger-only goal and the
  // default playbook. Also carries the archetype's compiled INSTRUCTIONS (spec 354 K3), which open the
  // planner's system prompt; the inbox situation below and the tool contract are appended after.
  const llmConfigured = env.ORCHESTRATION_LLM === 'anthropic' && !!env.ANTHROPIC_API_KEY;
  let conversationContext = '';
  let playbook = DEFAULT_PERSON_ASSISTANT_SKILL_MD;
  if (llmConfigured) {
    try {
      const read = (await io.readConversation()) as ConversationReadResult;
      conversationContext = contextLines(read);
      if (read.playbook?.trim()) playbook = `${read.playbook.trim()}\n\n${DEFAULT_PERSON_ASSISTANT_SKILL_MD}`;
    } catch { /* trigger-only context + default playbook */ }
  }

  const { planner, kind } = selectPlanner(env, { systemPrompt: playbook + INBOX_CONTRACT });
  // The deterministic turn (no LLM configured): one template reply acknowledging the message —
  // matching spec 327's rule-based behavior; sufficient for e2e without a model key.
  const deterministic: Planner = createRuleBasedPlanner([
    {
      match: () => true,
      toolId: 'post_inbox_reply',
      args: { bodyText: `${input.displayName}'s assistant here — thanks for your message. ${input.displayName} will follow up with you soon.` },
    },
  ]);
  const effective = kind === 'anthropic' ? planner : deterministic;

  let posted = false;
  let messageId: string | undefined;
  const invoke = async (toolId: string, args: Record<string, unknown>): Promise<unknown> => {
    if (toolId === 'post_inbox_reply') {
      if (posted) throw new Error('post_inbox_reply may be called at most once per turn');
      const bodyText = String(args.bodyText ?? '').trim();
      if (!bodyText) throw new Error('post_inbox_reply requires bodyText');
      posted = true;
      const r = await io.post(bodyText);
      messageId = r.messageId;
      return r;
    }
    throw new Error(`unknown tool: ${toolId}`);
  };

  const goal =
    `You are the personal inbox assistant of ${input.displayName}, replying on their behalf in a 1:1 conversation` +
    `${input.subject ? ` about "${input.subject}"` : ''}. ` +
    `A new message just arrived from ${input.senderCaip}. ` +
    `Send exactly one concise, helpful reply as ${input.displayName}'s assistant (call post_inbox_reply with the full reply as bodyText).` +
    conversationContext;

  const result = await runIntent(
    { goal, context: { principal: input.principal, conversationId: input.conversationId } },
    { planner: effective, tools: INBOX_TOOLS, invoke },
  );
  return { result, plannerKind: kind, posted, ...(messageId ? { messageId } : {}) };
}
