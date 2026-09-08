// The demo-a2a binding of the Ring-0 agentic loop (ADR-0044). ONE definition of the agent's exposed tools +
// the planner selection + the run, shared by the two first-party entry points:
//   • the A2aTaskDO `orchestrate` SkillHandler (the canonical TASK path: a real A2A message/send → task →
//     orchestrate → tasks/get), used by agent-to-agent intents through /api/a2a; and
//   • the `/a2a/intent` relayer endpoint (the session-bridged first-party convenience for the simple demo-web,
//     where the browser holds a server-side session rather than a signable A2A message).
// Both run the IDENTICAL orchestration core over a delegation-bound invoker — the planner chooses WHICH tool;
// every composed MCP call rides the supplied delegation (authority unchanged, ADR-0041).
import { runIntent, createRuleBasedPlanner, type Planner, type ToolSpec, type ToolInvoker, type RunResult, type AnswerComposer } from '@agenticprimitives/orchestration';
import { createAnthropicPlanner, createAnthropicComposer, createFetchAnthropicClient, DEFAULT_PLANNER_MODEL as ANTHROPIC_DEFAULT_MODEL } from '@agenticprimitives/orchestration-anthropic';
import { createOpenAiCompatPlanner, createOpenAiCompatComposer, createFetchOpenAiCompatClient, type OpenAiCompatLike } from '@agenticprimitives/orchestration-openai-compat';
import type { Address } from 'viem';
// Type-only import (erased at build — no runtime cycle with index.ts).
import type { Env } from './index.js';

/** The MCP tools this agent may COMPOSE to satisfy an intent. Ids are exactly the delegation-gated demo-mcp
 *  tools (`callMcpToolViaDelegation`). The web posts a GOAL; the planner picks among THESE. */
export const ORCHESTRATION_TOOLS: ToolSpec[] = [
  {
    id: 'get_profile',
    description:
      "Read the principal's profile (name, email, phone) — the default for \"read/show my profile\". Returns the seeded demo profile. Needs no arguments.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    id: 'get_vault_record',
    description:
      "Read one of the principal's private vault records by recordType (e.g. \"impact-profile\" for their profile). Use this to read the user's own stored data.",
    inputSchema: {
      type: 'object',
      properties: { recordType: { type: 'string', description: 'The record type to read, e.g. "impact-profile".' } },
      required: ['recordType'],
    },
  },
  {
    id: 'list_vault_record',
    description: "List the recordTypes the principal has stored in their vault. Use this when the user asks what data they have.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    id: 'get_pii',
    description:
      "Read the principal's personal identifying information (PII — high sensitivity). Use this only when the user explicitly asks for their personal/identity details.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    id: 'get_org_sensitive',
    description:
      "Read the ORGANIZATION's gated/sensitive data (when the principal is an org Smart Agent). Use this for \"read my org/organization details\".",
    inputSchema: { type: 'object', properties: {} },
  },
];

/** The deterministic default planner (no model, no creds) — the LIVE default. Maps a goal → a plan. */
const RULE_BASED_PLANNER: Planner = createRuleBasedPlanner([
  // MULTI-STEP: "show me everything / all my data" → list the vault, then read the FIRST record the list
  // returns. Step 2's recordType is threaded from step 1's result via a path $ref (the loop resolves
  // `list.record_types.0.record_type`). Exercises the loop's multi-step composition + $ref threading live.
  {
    match: /\b(everything|all my data|all my records|summar)/,
    steps: [
      { toolId: 'list_vault_record', args: {}, ref: 'list' },
      { toolId: 'get_vault_record', args: { recordType: { $ref: 'list.record_types.0.record_type' } } },
    ],
  },
  // "read my profile / personal info" → get_pii. get_pii uses readSensitive (entitlement→KAS→audit→decrypt)
  // and works for any person SA; get_profile needs a per-person vault-key binding (spec 278) the simple flow
  // never creates (it returns vault_key_unauthorized), so it is NOT the default — it stays an exposed tool a
  // binding-holding caller (e.g. via demo-sso) or the LLM planner may still select.
  { match: /\b(org|organization|organisation)\b/, toolId: 'get_org_sensitive' },
  { match: /\b(profile|pii|personal|identity|who am i)\b/, toolId: 'get_pii' },
  // App-driven vault ops (demo-gs/jp operational reads): EXPLICIT, collision-free goals that carry the exact
  // recordType verbatim (no fuzzy keyword matching — recordTypes can be anything: hyphens, colons, prefixes).
  // These are intent-shaped + ride the custody-agnostic delegation, but the recordType is app-known, so the
  // goal names it precisely rather than relying on the NL planner to guess.
  {
    match: /^read vault record /i,
    toolId: 'get_vault_record',
    args: (goal) => ({ recordType: goal.replace(/^read vault record /i, '').trim() }),
  },
  { match: /^list vault records$/i, toolId: 'list_vault_record' },
  { match: /\b(list|which records|what records|my records|records)\b/, toolId: 'list_vault_record' },
  // A bare "read my <recordType>" fallback → vault read of that record type (NL convenience).
  {
    match: /\bread my (\w[\w-]*)/,
    toolId: 'get_vault_record',
    args: (goal) => ({ recordType: /\bread my (\w[\w-]*)/.exec(goal.toLowerCase())?.[1] ?? 'impact-profile' }),
  },
]);

/** The env subset the planner selection needs. */
export type PlannerEnv = Pick<Env, 'ORCHESTRATION_LLM' | 'ANTHROPIC_API_KEY' | 'ORCHESTRATION_MODEL' | 'GROQ_API_KEY' | 'ORCHESTRATION_GROQ_MODEL' | 'ORCHESTRATION_GROQ_BASE_URL'>;

// ── WHICH MODEL PROPOSES — spec 377 ──────────────────────────────────────────────────────────────────────
//
// A deployment OFFERS an ordered list of providers (`ORCHESTRATION_LLM="anthropic,groq"`); the first is the
// default. A turn may NAME one (the Ask's picker); absent, the default runs. Nothing here decides authority —
// which model proposes is a display-and-billing fact — and nothing here swaps: a provider that is offered and
// not credentialed throws, a provider that is named and not offered is refused, and neither lands on another.

/** The providers this app knows how to construct. The id is what a turn names and the trace records. */
export type LlmProvider = 'anthropic' | 'groq';
export const LLM_PROVIDERS: readonly LlmProvider[] = ['anthropic', 'groq'];
/** What `selectPlanner` reports having chosen. */
export type PlannerKind = LlmProvider | 'rule-based';

/** Groq is THIS APP's configuration of the vendor-neutral OpenAI-compatible adapter — the package names no
 *  host and no model (spec 377 §2). Override with ORCHESTRATION_GROQ_MODEL / ORCHESTRATION_GROQ_BASE_URL.
 *  `openai/gpt-oss-120b` is the strongest tool-calling model on Groq's free catalog as of 2026-09-08 (the
 *  Llama 3.x ids were retired from it); verified live with `tool_choice: 'required'`. */
export const GROQ_DEFAULTS = { model: 'openai/gpt-oss-120b', baseUrl: 'https://api.groq.com/openai/v1' } as const;

const PROVIDER_LABEL: Record<LlmProvider, string> = { anthropic: 'Claude (Anthropic)', groq: 'GPT-OSS 120B (Groq, free)' };
const PROVIDER_FREE: Record<LlmProvider, boolean> = { anthropic: false, groq: true };
const PROVIDER_KEY: Record<LlmProvider, keyof PlannerEnv> = { anthropic: 'ANTHROPIC_API_KEY', groq: 'GROQ_API_KEY' };

/** The ordered allowlist. An entry this app cannot construct THROWS: a typo must not silently drop a model. */
export function llmAllowlist(env: PlannerEnv): LlmProvider[] {
  const raw = String(env.ORCHESTRATION_LLM ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const out: LlmProvider[] = [];
  for (const id of raw) {
    if (!(LLM_PROVIDERS as readonly string[]).includes(id)) throw new Error(`ORCHESTRATION_LLM names an unknown provider "${id}" (known: ${LLM_PROVIDERS.join(', ')})`);
    if (!out.includes(id as LlmProvider)) out.push(id as LlmProvider);
  }
  return out;
}

/** The provider a turn gets when it names none. `null` ⇒ no model is configured (a configuration, not a fallback). */
export function defaultProvider(env: PlannerEnv): LlmProvider | null {
  return llmAllowlist(env)[0] ?? null;
}

/** The concrete model a provider runs — reported on the trace, never re-derived there. */
export function modelFor(env: PlannerEnv, p: LlmProvider): string {
  return p === 'anthropic' ? (env.ORCHESTRATION_MODEL || ANTHROPIC_DEFAULT_MODEL) : (env.ORCHESTRATION_GROQ_MODEL || GROQ_DEFAULTS.model);
}

/**
 * IS THIS PROVIDER CONFIGURED — one answer per provider, no fallback (ADR-0013).
 *
 * Listing a provider in `ORCHESTRATION_LLM` is a statement that this deployment plans and composes with it.
 * Without its key that statement cannot be honoured, and honouring it QUIETLY with another provider or the
 * rule-based planner is the drift this refuses. So: listed + keyed ⇒ true; not listed ⇒ false (the caller
 * refuses or takes the default); listed and keyless ⇒ a thrown configuration error, at the first turn that
 * would have needed it.
 */
export function providerConfigured(env: PlannerEnv, p: LlmProvider): boolean {
  if (!llmAllowlist(env).includes(p)) return false;
  if (!env[PROVIDER_KEY[p]]) throw new Error(`ORCHESTRATION_LLM lists ${p} but ${PROVIDER_KEY[p]} is not set — this deployment is configured to plan with that model and cannot; no rule-based fallback (ADR-0013)`);
  return true;
}

/** A turn's request for a provider, resolved against the offer. `ok:false` is the caller's 400 — the message
 *  names what IS offered. A listed-but-keyless provider throws (config error), never lands on the default. */
export function resolveProvider(env: PlannerEnv, requested?: string | null): { ok: true; provider: LlmProvider | null } | { ok: false; error: string } {
  const want = String(requested ?? '').trim().toLowerCase();
  if (!want) return { ok: true, provider: defaultProvider(env) };
  const offered = llmAllowlist(env);
  if (!(LLM_PROVIDERS as readonly string[]).includes(want) || !offered.includes(want as LlmProvider)) {
    return { ok: false, error: `model "${want}" is not offered by this agent${offered.length ? `; offered: ${offered.join(', ')}` : ''}` };
  }
  providerConfigured(env, want as LlmProvider); // throws when listed and keyless
  return { ok: true, provider: want as LlmProvider };
}

/** What this deployment OFFERS a surface: the allowlisted providers that are credentialed. A listed-but-keyless
 *  provider is omitted here (a surface must not show a choice that cannot be served); the loud throw happens on
 *  the turn that names it. `default` marks the one a turn gets when it names none. */
export function availableModels(env: PlannerEnv): Array<{ id: LlmProvider; label: string; model: string; free: boolean; default: boolean }> {
  const def = defaultProvider(env);
  const out: Array<{ id: LlmProvider; label: string; model: string; free: boolean; default: boolean }> = [];
  for (const p of llmAllowlist(env)) {
    let ok = false;
    try { ok = providerConfigured(env, p); } catch { ok = false; }
    if (ok) out.push({ id: p, label: PROVIDER_LABEL[p], model: modelFor(env, p), free: PROVIDER_FREE[p], default: p === def });
  }
  return out;
}

function groqClient(env: PlannerEnv): OpenAiCompatLike {
  return createFetchOpenAiCompatClient({ apiKey: env.GROQ_API_KEY!, baseUrl: env.ORCHESTRATION_GROQ_BASE_URL || GROQ_DEFAULTS.baseUrl });
}

/** spec 327 §4b / 334 §6 — prepend the org's steward-authored playbook AS CONTEXT, keeping the
 *  turn's mechanical contract AFTER it so the must-call-the-tool / never-prose guarantee always wins
 *  no matter what the steward wrote (the same org-voice-first ordering the discussion turn uses).
 *  Absent/blank playbook ⇒ the contract alone, byte-identical to the pre-playbook behaviour. Shared
 *  by the plan-draft and work turns so one SKILL.md governs discussion AND coordination. */
export function withPlaybook(playbook: string | undefined, contract: string): string {
  const p = (playbook ?? '').trim();
  return p
    ? `Your organization's guidance (apply it; the tool contract that follows is non-negotiable):\n${p}\n\n${contract}`
    : contract;
}

/** Select the planner per env: the Anthropic LLM planner when explicitly enabled + keyed, else deterministic.
 *  `opts.systemPrompt` overrides the LLM planner's system prompt for turns whose contract differs from the
 *  default single-tool selection job (spec 327: the discussion turn MUST post) — ignored on rule-based.
 *  `opts.maxTokens` MUST be raised for turns whose tool argument carries a long artifact (work
 *  deliverables, outcome answers): the 1024 default silently truncates the tool input mid-emit and
 *  the turn yields an empty capture with NO error. */
/** The ANSWERING binding, when this deployment has a model. Absent ⇒ the caller renders the raw result:
 *  a rendering may degrade, and the EVIDENCE (receipts, observations) is identical either way. This is not
 *  the fallback ADR-0013 forbids — nothing here decides anything, and no authority path has a second
 *  mechanism. */
/**
 * IS A MODEL CONFIGURED — one answer, no fallback (ADR-0013). The DEFAULT provider's answer: `null` default ⇒
 * false (the deterministic paths are the configuration, not a fallback); a default that is listed and keyless
 * ⇒ the thrown configuration error. A single `ORCHESTRATION_LLM=anthropic` behaves exactly as it always has.
 */
export function llmConfigured(env: PlannerEnv): boolean {
  const def = defaultProvider(env);
  return def !== null && providerConfigured(env, def);
}

/** The provider a turn runs on: the one it named, else the default. Throws when that provider is listed and
 *  keyless; `null` when no model is configured at all. A NAMED provider that is not offered is the caller's
 *  400 (`resolveProvider`) and never reaches here. */
function providerFor(env: PlannerEnv, requested?: LlmProvider): LlmProvider | null {
  const p = requested ?? defaultProvider(env);
  if (p === null) return null;
  providerConfigured(env, p);
  return p;
}

export function selectComposer(env: PlannerEnv, opts?: { systemPrompt?: string; provider?: LlmProvider }): AnswerComposer | null {
  const p = providerFor(env, opts?.provider);
  if (p === null) return null;
  if (p === 'groq') {
    return createOpenAiCompatComposer({
      client: groqClient(env), model: modelFor(env, 'groq'), label: 'groq',
      // A smaller evidence cap than the Anthropic composer's 24k: the free tier is bounded by tokens-per-minute,
      // and the composer is the turn's largest request.
      maxEvidenceChars: 12_000,
      ...(opts?.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
    });
  }
  return createAnthropicComposer({
    client: createFetchAnthropicClient({ apiKey: env.ANTHROPIC_API_KEY! }),
    ...(env.ORCHESTRATION_MODEL ? { model: env.ORCHESTRATION_MODEL } : {}),
    ...(opts?.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
  });
}

export function selectPlanner(env: PlannerEnv, opts?: { systemPrompt?: string; maxTokens?: number; provider?: LlmProvider }): { planner: Planner; kind: PlannerKind; model?: string } {
  const p = providerFor(env, opts?.provider);
  if (p === 'groq') {
    const planner = createOpenAiCompatPlanner({
      client: groqClient(env), model: modelFor(env, 'groq'), label: 'groq',
      ...(opts?.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
      ...(opts?.maxTokens ? { maxTokens: opts.maxTokens } : {}),
    });
    return { planner, kind: 'groq', model: modelFor(env, 'groq') };
  }
  if (p === 'anthropic') {
    const client = createFetchAnthropicClient({ apiKey: env.ANTHROPIC_API_KEY! });
    const planner = createAnthropicPlanner({
      client,
      ...(env.ORCHESTRATION_MODEL ? { model: env.ORCHESTRATION_MODEL } : {}),
      ...(opts?.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
      ...(opts?.maxTokens ? { maxTokens: opts.maxTokens } : {}),
    });
    return { planner, kind: 'anthropic', model: modelFor(env, 'anthropic') };
  }
  return { planner: RULE_BASED_PLANNER, kind: 'rule-based' };
}

/** Run an intent through the shared orchestration core. `invoke` is the delegation-bound MCP composer (the
 *  authority boundary) — the caller supplies it (the skill wraps `ctx.mcp.callTool`; the relayer wraps
 *  `callMcpToolViaDelegation`). Returns the run result + which planner ran. */
export async function runOrchestration(
  env: PlannerEnv,
  args: { goal: string; principal: Address; invoke: ToolInvoker },
): Promise<{ result: RunResult; plannerKind: PlannerKind }> {
  const { planner, kind } = selectPlanner(env);
  const result = await runIntent(
    { goal: args.goal, context: { principal: args.principal } },
    { planner, tools: ORCHESTRATION_TOOLS, invoke: args.invoke },
  );
  return { result, plannerKind: kind };
}
