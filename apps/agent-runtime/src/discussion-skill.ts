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
import {
  consultCandidateLine,
  consultSelectionBasis,
  questionAddressesRole,
  deterministicStatusBody,
  deterministicSynthesisBody,
  routedTurnDegrade,
  synthesisOutcomeLines,
  type ConsultCandidateV1,
  type ConsultOutcomeV1,
} from '@agenticprimitives/fabric/messaging';
import { selectPlanner, type PlannerEnv } from './orchestration.js';
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

/** spec 329 W3 — the routing extension of the discussion turn. Present ⇔ the steward enabled
 *  routing on this topic AND the org consult wire is custodied AND the trigger is human-authored
 *  (`routingToolsAllowed`, the depth-1 guard) AND the per-topic routing bucket admitted this
 *  question — the CALLER (the org's A2aTaskDO) decides all of that; this module only runs the
 *  turn. `candidates` are the HARNESS-computed, discovery-ranked eligible set (spec 329 §4 — the
 *  327 "harness reads, model posts" finding applied to routing: a plan-then-execute planner
 *  cannot compose ask/status args from results it hasn't seen, so the candidate snapshot is
 *  pre-read and embedded in the goal; the find_members TOOL returns the same snapshot, and
 *  ask_member's INVOKER pins every memberSA to it — allow-list pinning, never planner authority). */
export interface DiscussionRoutingOpts {
  questionId: string;
  candidates: ConsultCandidateV1[];
  /** Fan-out K (steward-tuned 1..5; approved default 3). */
  maxFanout: number;
  /** Submit ONE consult task (the caller signs + sends + records the intent). Throws on failure —
   *  the loop observes it (the planner may re-plan); a member is never silently skipped. */
  ask: (memberSA: string, question: string) => Promise<{ taskId: string }>;
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

/** spec 329 §4 — the two routing tools of the routed turn. NOTE (2026-07-17 live 502): only
 *  `ask_member` is OFFERED to the planner — see PLANNER_ROUTING_TOOLS below. `find_members` stays
 *  defined (spec surface) and its invoker branch stays live, but it is never presented to a
 *  plan-then-execute model. */
export const ROUTING_TOOLS: ToolSpec[] = [
  {
    id: 'find_members',
    description:
      'List the members whose agents may be consulted about this question (already computed: the ' +
      'candidate list in the goal). Returns the ranked candidates with evidence. Deterministic — ' +
      'it can never add members beyond the opted-in, topic-participant set.',
    inputSchema: { type: 'object', properties: { need: { type: 'string', description: 'What kind of expertise the question needs.' } } },
  },
  {
    id: 'ask_member',
    description:
      "Send the question to ONE candidate member's agent (asynchronous — answers arrive later; a " +
      'follow-up post will be made automatically when they do). `memberSA` MUST be one of the ' +
      'candidates; `question` is the exact question their agent should answer. Ask at most the ' +
      'stated fan-out limit of members, then post an honest status reply saying who you asked.',
    inputSchema: {
      type: 'object',
      properties: {
        memberSA: { type: 'string', description: "The candidate's 0x agent address (from the candidate list)." },
        question: { type: 'string', description: 'The question to route to this member.' },
      },
      required: ['memberSA', 'question'],
    },
  },
];

/** The routing tools the PLANNER is offered — ask_member ONLY. The live 2026-07-17 502 (demo-a2a
 *  v9fbd0b33) re-proved the spec-327 harness-reads finding for routing: a plan-then-execute
 *  planner OFFERED a read tool (find_members) planned only the read — the plan "completed" with
 *  nothing asked and nothing posted, and the turn died. The candidate snapshot is already embedded
 *  in the goal, so the read tool adds no capability, only the trap. */
const PLANNER_ROUTING_TOOLS: ToolSpec[] = ROUTING_TOOLS.filter((t) => t.id === 'ask_member');

/** The default playbook (spec 327 §4b) — used when the org's steward hasn't authored one. A config
 *  default, not a fallback mechanism: the load path is one read; absent means this constant. */
const DEFAULT_ASSISTANT_SKILL_MD =
  "You are the organization's discussion-board assistant. Be concise, warm, and concrete; answer " +
  'the question that was actually asked, ground your reply in the recent topic messages when they ' +
  "are relevant, and say plainly when something needs a human steward's follow-up.";

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

/** The routing addendum to the tool contract (spec 329 §4.1 turn 1 + §4 skill-based
 *  auto-selection): SELECTION IS THE MODEL'S, grounded in each candidate's PUBLISHED CAPABILITIES —
 *  the asker never has to name anyone (a named member is an override, not a requirement), and a
 *  no-fit outcome is stated honestly, never silent. */
const ROUTING_CONTRACT =
  '\n\nRouting (enabled for this topic): the goal lists candidate members whose agents you MAY ' +
  "consult, each with their ORG ROLE (when they published one) and their PUBLISHED CAPABILITIES. " +
  'Selecting who to consult is YOUR job, and you match on BOTH facets. (1) ORG ROLE: a candidate ' +
  'marked "role: X" holds role X in THIS organization. When the question ADDRESSES a role — ' +
  '"@ask tax advisor …", "ask our tax advisor about …", "what does the bookkeeper think" — ' +
  'consult exactly the candidate(s) holding that role. A role match OUTRANKS a generic skill ' +
  "match: if one candidate's role answers the question, prefer them over a candidate who merely " +
  "published a related capability. (2) PUBLISHED CAPABILITIES: otherwise match the question's subject " +
  "against each candidate's published capabilities (for a candidate with no role and no published " +
  'skills, match only on their displayName/description — never assume a role or skills they did ' +
  "not publish). When a candidate's role or published capabilities clearly cover the question's " +
  'domain, consult them via ask_member EVEN IF the question named no one — a member named in the ' +
  'question is an override to honor, never a requirement for consulting. Never ask more members ' +
  'than the fan-out limit. Make your single post_topic_message an HONEST status reply naming ' +
  'exactly who you asked and the selection basis for each — when a role drove the pick, STATE THE ' +
  'ROLE, e.g. "asking alice (org role: tax advisor)"; otherwise "asking alice (published capabilities: ' +
  'water systems, plumbing)", or the name/description basis for a candidate with neither. ' +
  "Their answers arrive in a follow-up post. If NO candidate's org role, published capabilities (or " +
  'name/description) fit the question, ask no one, answer the question yourself, and say plainly ' +
  'that the org has no opted-in member with a matching role or published capabilities. Always finish ' +
  'with exactly one post_topic_message.';

/** Why (and at which step) the routing extension degraded this dispatch to the base reply —
 *  the execution point audits `interactions.routing.degraded` with this. */
export interface DiscussionTurnDegraded { step: 'routed-turn'; cause: string }

export async function handleDiscussionRespond(
  env: PlannerEnv & PublicGraphEnv,
  input: DiscussionRespondInput,
  io: DiscussionIo,
  routing?: DiscussionRoutingOpts,
): Promise<{ result: RunResult; plannerKind: 'anthropic' | 'rule-based'; posted: boolean; messageId?: string; asked: Array<{ memberSA: string; displayName: string; taskId: string }>; degraded?: DiscussionTurnDegraded }> {
  // Harness context pre-fetch (LLM turns only — the template ignores it). Best-effort ENRICHMENT,
  // not authority and not a second mechanism: a failed read just means the goal carries only the
  // trigger message and the default playbook. Also carries the org's steward-authored PLAYBOOK
  // (spec 327 §4b), which becomes the planner's system prompt with the tool contract appended.
  const llmConfigured = env.ORCHESTRATION_LLM === 'anthropic' && !!env.ANTHROPIC_API_KEY;
  let topicContext = '';
  let playbook = DEFAULT_ASSISTANT_SKILL_MD;
  if (llmConfigured) {
    try {
      const read = (await io.readTopic()) as TopicReadResult;
      topicContext = contextLines(read);
      if (read.skillMarkdown?.trim()) playbook = read.skillMarkdown.trim();
    } catch { /* trigger-only context + default playbook */ }
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

  const routingOn = !!routing && routing.candidates.length > 0;

  // Turn state is PER DISPATCH, not per runIntent call: at-most-one post and the ask ledger hold
  // across the routed attempt AND a degraded plain re-run (the invoker below closes over these).
  let posted = false;
  let messageId: string | undefined;
  const asked: Array<{ memberSA: string; displayName: string; taskId: string }> = [];
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
    if (routingOn && toolId === 'find_members') {
      // Deterministic snapshot return — the harness already computed + embedded it (no LLM authority).
      return { candidates: routing.candidates, note: 'harness-computed eligibility ∩ discovery ranking (spec 329 §4)' };
    }
    if (routingOn && toolId === 'ask_member') {
      // INVOKER pinning (spec 329 §4/§8): memberSA MUST be in the harness snapshot; the fan-out
      // bound holds regardless of the plan; a member is asked at most once per question.
      const memberSA = String(args.memberSA ?? '').toLowerCase();
      const candidate = routing.candidates.find((c) => c.memberSA === memberSA);
      if (!candidate) throw new Error('ask_member: memberSA is not in the candidate set (allow-list pinning)');
      if (asked.some((a) => a.memberSA === memberSA)) throw new Error('ask_member: this member was already asked');
      if (asked.length >= routing.maxFanout) throw new Error(`ask_member: fan-out limit of ${routing.maxFanout} reached`);
      const question = String(args.question ?? '').trim() || input.triggerBody;
      const r = await routing.ask(memberSA, question);
      asked.push({ memberSA, displayName: candidate.displayName, taskId: r.taskId });
      return { ok: true, taskId: r.taskId, member: candidate.displayName };
    }
    throw new Error(`unknown tool: ${toolId}`);
  };

  /** One runIntent pass — routed (ask_member offered, candidates in the goal) or plain spec-327
   *  (single tool; `tool_choice: any` + the invoker guarantee the post structurally). */
  const runTurn = async (withRouting: boolean): Promise<{ result: RunResult; kind: 'anthropic' | 'rule-based' }> => {
    const { planner, kind } = selectPlanner(env, {
      systemPrompt: playbook + DISCUSSION_CONTRACT + (withRouting ? ROUTING_CONTRACT : ''),
    });
    // The deterministic turn (no LLM configured). Routing variant: ask the top-K candidates, then
    // post the exact honest status body — sufficient for e2e verification without a model key.
    const deterministicSteps: PlanStep[] = withRouting && routingOn
      ? [
          ...routing.candidates.slice(0, routing.maxFanout).map((c) => ({
            toolId: 'ask_member',
            args: { memberSA: c.memberSA, question: input.triggerBody },
          })),
          {
            toolId: 'post_topic_message',
            args: { bodyText: deterministicStatusBody(routing.candidates.slice(0, routing.maxFanout).map((c) => ({ displayName: c.displayName, basis: consultSelectionBasis(c, questionAddressesRole(input.triggerBody, c.orgRole)) }))) },
          },
        ]
      : [
          {
            toolId: 'post_topic_message',
            args: { bodyText: `${input.displayName} here — thanks for the mention, ${input.triggerAuthor}. A steward will follow up in this topic.` },
          },
        ];
    const deterministic: Planner = createRuleBasedPlanner([{ match: () => true, steps: deterministicSteps }]);
    const effective = kind === 'anthropic' ? planner : deterministic;
    const candidateBlock = withRouting && routingOn
      ? `\nCandidate members you may consult (ranked; fan-out limit ${routing.maxFanout}). Match ` +
        "the question against each candidate's ORG ROLE first (\"role: …\" — a question that " +
        'addresses that role selects them, ahead of a generic skill match), then against their ' +
        'published capabilities; a candidate marked "NO published capabilities" and carrying no role may only ' +
        'be matched on displayName/description — never assume a role or skills they have not ' +
        'published:\n' +
        routing.candidates.map((c) => consultCandidateLine(c)).join('\n')
      : '';
    const goal =
      `You are ${input.displayName}, the organization's own assistant participating in its discussion topic "${input.topicTitle}". ` +
      `${input.triggerAuthor} just posted: "${input.triggerBody}". ` +
      (withRouting && routingOn
        ? 'Select which candidate members to consult by matching the question against their ORG ' +
          "ROLE (a question addressing a role picks the holder of that role, and OUTRANKS a " +
          "generic skill match) and then their published capabilities (the question does NOT need to " +
          'name anyone; a named member is an override, not a requirement). Call ask_member for ' +
          'each selected candidate (at most the fan-out limit), then post exactly one reply — an ' +
          "honest status naming who you asked and each pick's selection basis (state the ROLE " +
          "when a role drove the pick), or, if no candidate's org role, published capabilities (or " +
          'name/description) fit, a direct answer that says the org has no opted-in member with a ' +
          'matching role or published capabilities.'
        : 'Post exactly one concise, helpful reply as the organization (call post_topic_message with the full reply as bodyText).') +
      candidateBlock +
      topicContext;
    const result = await runIntent(
      { goal, context: { principal: input.principal, channelId: input.channelId, ...(withRouting && routingOn ? { questionId: routing.questionId } : {}) } },
      { planner: effective, tools: withRouting && routingOn ? [...DISCUSSION_TOOLS, ...PLANNER_ROUTING_TOOLS] : DISCUSSION_TOOLS, invoke },
    );
    return { result, kind };
  };

  // ── RESILIENCE INVARIANT (2026-07-17 live 502): the routing EXTENSION may fail; the base reply
  // may not. The routed attempt runs first (when routing is on); the fabric routedTurnDegrade
  // verdict then finishes the dispatch honestly — harness-posted status when consults are already
  // in flight, else the plain spec-327 turn. Only a failure of the PLAIN turn (posting itself
  // broken) surfaces to the caller as an error. ──
  let degraded: DiscussionTurnDegraded | undefined;
  let last: { result: RunResult; kind: 'anthropic' | 'rule-based' } | undefined;
  if (routingOn) {
    let outcome: { outcome: 'completed' | 'failed'; error?: string };
    try {
      last = await runTurn(true);
      outcome = { outcome: last.result.outcome, ...(last.result.error ? { error: last.result.error } : {}) };
    } catch (e) {
      // A throw OUTSIDE the loop's observation (planner/setup) — same invariant, same degrade.
      outcome = { outcome: 'failed', error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
    }
    const verdict = routedTurnDegrade({ posted, askedCount: asked.length, ...outcome });
    if (verdict.action !== 'none' || verdict.cause) degraded = { step: 'routed-turn', cause: verdict.cause ?? 'unknown' };
    if (verdict.action === 'post-status') {
      // Consults ARE in flight — the member still sees the honest status (harness post, determinism
      // by construction; the caller's io.post attaches the routed-consultation contextRef).
      posted = true;
      try {
        const r = await io.post(deterministicStatusBody(asked.map((a) => {
          const c = routing.candidates.find((x) => x.memberSA === a.memberSA);
          return {
            displayName: a.displayName,
            ...(c ? { basis: consultSelectionBasis(c, questionAddressesRole(input.triggerBody, c.orgRole)) } : {}),
          };
        })));
        messageId = r.messageId;
      } catch (e) {
        posted = false; // the post itself failed — fall through to the plain turn's own attempt
        degraded = { step: 'routed-turn', cause: `${verdict.cause}; status post failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
  }
  if (!posted) {
    // The plain spec-327 turn — the base reply. Errors here propagate: they are BASE failures
    // (posting itself broken), not routing failures.
    last = await runTurn(false);
  }
  const finalResult: RunResult = last?.result ?? { outcome: 'failed', plan: { steps: [] }, steps: [], error: 'no turn ran' };
  return {
    result: finalResult,
    plannerKind: (last?.kind ?? (llmConfigured ? 'anthropic' : 'rule-based')),
    posted,
    asked,
    ...(messageId ? { messageId } : {}),
    ...(degraded ? { degraded } : {}),
  };
}

// ── spec 329 §4.1 turn 2 — the synthesis turn (Ring-0, single tool, harness pre-reads) ─────────

export interface ConsultSynthesisInput {
  principal: string;
  channelId: string;
  topicTitle: string;
  displayName: string;
  question: string;
  questionId: string;
  outcomes: ConsultOutcomeV1[];
}

/** The non-negotiable synthesis contract (attribution is REQUIRED — spec 329 §4.1). */
const SYNTHESIS_CONTRACT =
  '\n\nTool contract (always applies): call post_topic_message exactly once with the complete ' +
  'follow-up reply. You are synthesizing member agents\' answers to an earlier question. You MUST ' +
  'name who was consulted, attribute what you use to the member whose agent said it (quoting is ' +
  'allowed, with names), and state plainly who declined or did not respond in time. Never invent ' +
  'an answer for a member who gave none. Never answer in prose.';

/**
 * Run the turn-2 synthesis: harness pre-reads the collected answers + the playbook; the model
 * posts through exactly ONE tool. The deterministic (no-LLM) variant posts the exact
 * attribution-complete template from fabric.
 */
export async function handleConsultSynthesis(
  env: PlannerEnv,
  input: ConsultSynthesisInput,
  io: DiscussionIo,
): Promise<{ result: RunResult; plannerKind: 'anthropic' | 'rule-based'; posted: boolean; messageId?: string }> {
  const llmConfigured = env.ORCHESTRATION_LLM === 'anthropic' && !!env.ANTHROPIC_API_KEY;
  let playbook = DEFAULT_ASSISTANT_SKILL_MD;
  let topicContext = '';
  if (llmConfigured) {
    try {
      const read = (await io.readTopic()) as TopicReadResult;
      topicContext = contextLines(read);
      if (read.skillMarkdown?.trim()) playbook = read.skillMarkdown.trim();
    } catch { /* answers-only context + default playbook */ }
  }

  const { planner, kind } = selectPlanner(env, { systemPrompt: playbook + SYNTHESIS_CONTRACT });
  const deterministic: Planner = createRuleBasedPlanner([
    { match: () => true, toolId: 'post_topic_message', args: { bodyText: deterministicSynthesisBody(input.question, input.outcomes) } },
  ]);
  const effective = kind === 'anthropic' ? planner : deterministic;

  let posted = false;
  let messageId: string | undefined;
  const invoke = async (toolId: string, args: Record<string, unknown>): Promise<unknown> => {
    if (toolId !== 'post_topic_message') throw new Error(`unknown tool: ${toolId}`);
    if (posted) throw new Error('post_topic_message may be called at most once per turn');
    const bodyText = String(args.bodyText ?? '').trim();
    if (!bodyText) throw new Error('post_topic_message requires bodyText');
    posted = true;
    const r = await io.post(bodyText);
    messageId = r.messageId;
    return r;
  };

  const goal =
    `You are ${input.displayName}, the organization's assistant, following up in topic "${input.topicTitle}". ` +
    `Earlier you asked member agents about: "${input.question}". Their outcomes:\n` +
    synthesisOutcomeLines(input.outcomes) +
    '\nPost exactly one synthesized follow-up reply with full attribution (who was consulted, who contributed what, who declined or timed out).' +
    topicContext;

  const result = await runIntent(
    { goal, context: { principal: input.principal, channelId: input.channelId, questionId: input.questionId } },
    { planner: effective, tools: DISCUSSION_TOOLS, invoke },
  );
  return { result, plannerKind: kind, posted, ...(messageId ? { messageId } : {}) };
}
