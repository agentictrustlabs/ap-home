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
export type PlannerEnv = Pick<Env, 'ORCHESTRATION_LLM' | 'ANTHROPIC_API_KEY' | 'ORCHESTRATION_MODEL' | 'GROQ_API_KEY' | 'ORCHESTRATION_GROQ_MODEL' | 'ORCHESTRATION_GROQ_BASE_URL' | 'ORCHESTRATION_GROQ_PROMPT_BUDGET'> & { COMPOSER_MAX_TOKENS?: string; ORCHESTRATION_ROUTE?: string; ORCHESTRATION_GROQ_TPM?: string };

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

/**
 * A PROVIDER'S PROMPT BUDGET, in tokens — the most one planner request may carry, or `null` for no bound.
 *
 * Groq's free plan meters 8k tokens per minute per model, and a single request above that is refused
 * outright (HTTP 413), not queued: the ask fails. Every tool-calling model on that plan carries the same 8k
 * (the 70k compound systems accept no user-defined tools), so the bound is the plan's, not a model's. The
 * default leaves room for the tokenizer's variance over a chars-per-token estimate; `ORCHESTRATION_GROQ_PROMPT_BUDGET`
 * raises it on a paid tier. Anthropic's context is not the binding constraint and is left unbounded.
 * What the budget DROPS, and in what order, is `fitPlannerPrompt`'s documented contract — recorded on the
 * trace — never a silent truncation.
 */
export const GROQ_FREE_PLAN_PROMPT_BUDGET = 6500;
export function plannerPromptBudget(env: PlannerEnv, provider: LlmProvider | null): number | null {
  if (provider !== 'groq') return null;
  const raw = Number(env.ORCHESTRATION_GROQ_PROMPT_BUDGET);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : GROQ_FREE_PLAN_PROMPT_BUDGET;
}

// ── WHICH PROVIDER CARRIES THIS CALL — spec 388 (budget-routed selection) ────────────────────────
//
// `ORCHESTRATION_ROUTE="budget"`: the first OFFERED provider whose declared budget carries the call gets it —
// decided BEFORE the request from facts we measure (the fitted prompt's token estimate, the evidence size,
// what this isolate has already sent the metered provider this minute), and recorded on the trace with its
// reason. This is a ROUTE, not a fallback (ADR-0013): a provider chosen this way that then fails has failed —
// nothing re-sends to the next one. Unset (or "first") keeps spec 377's rule: the first offered provider.
export type RoutePolicy = 'first' | 'budget';
export function routePolicy(env: PlannerEnv): RoutePolicy {
  const raw = String(env.ORCHESTRATION_ROUTE ?? '').trim().toLowerCase();
  if (!raw || raw === 'first') return 'first';
  if (raw === 'budget') return 'budget';
  throw new Error(`ORCHESTRATION_ROUTE must be "first" or "budget", got ${JSON.stringify(raw)}`);
}
export interface RouteNeed { call: 'planner' | 'composer' | 'structured'; estimatedTokens: number }
export interface RouteDecision {
  provider: LlmProvider | null;
  /** Why, in words a trace reader can check against the numbers beside it. */
  because: string;
  considered: Array<{ provider: LlmProvider; budget: number | null; spentThisMinute?: number; fits: boolean }>;
}
/** Groq's free plan meters tokens per MINUTE per model; the per-request budget above is derived from it. */
export const GROQ_FREE_PLAN_TPM = 8000;
export function providerTpm(env: PlannerEnv, p: LlmProvider): number | null {
  if (p !== 'groq') return null;
  const raw = Number(env.ORCHESTRATION_GROQ_TPM);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : GROQ_FREE_PLAN_TPM;
}
// What THIS ISOLATE sent a metered provider in the last minute, by estimate. Honest about its scope: one
// Worker isolate, not the account — a second isolate does not see it. It spares the common case (planner +
// composer in one turn) the meter's 30-60 s wait, which is the case that actually happens.
const SPEND_WINDOW_MS = 60_000;
const spend = new Map<LlmProvider, Array<{ at: number; tokens: number }>>();
export function spentThisMinute(p: LlmProvider, now = Date.now()): number {
  const rows = (spend.get(p) ?? []).filter((r) => now - r.at < SPEND_WINDOW_MS);
  spend.set(p, rows);
  return rows.reduce((n, r) => n + r.tokens, 0);
}
export function recordSpend(p: LlmProvider, tokens: number, now = Date.now()): void {
  spend.set(p, [...(spend.get(p) ?? []), { at: now, tokens }]);
}
/** Test seam. */
export function resetSpend(): void { spend.clear(); }

export function routeProvider(env: PlannerEnv, requested: LlmProvider | undefined, need: RouteNeed, now = Date.now()): RouteDecision {
  if (requested) { providerConfigured(env, requested); return { provider: requested, because: `${requested}: named by the turn`, considered: [] }; }
  const offered = llmAllowlist(env);
  if (!offered.length) return { provider: null, because: 'no model offered', considered: [] };
  if (routePolicy(env) === 'first') { providerConfigured(env, offered[0]!); return { provider: offered[0]!, because: `${offered[0]}: first offered (ORCHESTRATION_ROUTE=first)`, considered: [] }; }
  const considered: RouteDecision['considered'] = [];
  for (const p of offered) {
    providerConfigured(env, p); // listed and keyless THROWS here too — a route may not quietly skip a misconfiguration
    const budget = plannerPromptBudget(env, p);
    const tpm = providerTpm(env, p);
    const spent = tpm !== null ? spentThisMinute(p, now) : undefined;
    const fits = (budget === null || need.estimatedTokens <= budget) && (tpm === null || need.estimatedTokens + (spent ?? 0) <= tpm);
    considered.push({ provider: p, budget, ...(spent !== undefined ? { spentThisMinute: spent } : {}), fits });
    if (fits) {
      if (tpm !== null) recordSpend(p, need.estimatedTokens, now);
      const why = budget === null ? 'no budget' : `estimate ${need.estimatedTokens} ≤ budget ${budget}${spent !== undefined ? ` and ${need.estimatedTokens}+${spent} ≤ ${tpm}/min` : ''}`;
      return { provider: p, because: `${p} for the ${need.call}: ${why}${considered.length > 1 ? ` (${considered.slice(0, -1).map((c) => `${c.provider} would not: ${c.budget !== null && need.estimatedTokens > c.budget ? `estimate ${need.estimatedTokens} > ${c.budget}` : `${need.estimatedTokens}+${c.spentThisMinute ?? 0} > ${providerTpm(env, c.provider)}/min`}`).join('; ')})` : ''}`, considered };
    }
  }
  // Nothing carries it: the first offered provider takes it, made to fit (the prompt fitter records every drop).
  const first = offered[0]!;
  if (providerTpm(env, first) !== null) recordSpend(first, need.estimatedTokens, now);
  return { provider: first, because: `${first} for the ${need.call}: no offered provider carries ${need.estimatedTokens} tokens (${considered.map((c) => `${c.provider} budget ${c.budget ?? '∞'}${c.spentThisMinute !== undefined ? `, spent ${c.spentThisMinute}` : ''}`).join('; ')}) — first offered, prompt fitted`, considered };
}

/** Spec 388 W2 — the WIDEST prompt an offered provider carries, for sizing what a prompt may hold before it is routed
 *  (the vault inventory listing): the named provider's budget when a turn named one; under `first` the default's;
 *  under `budget` no bound if any offered provider is unbounded, else the largest. Sizing to the default's budget
 *  trimmed an inventory the stronger provider would have carried whole. */
export function widestPromptBudget(env: PlannerEnv, requested?: LlmProvider): number | null {
  if (requested) return plannerPromptBudget(env, requested);
  const offered = llmAllowlist(env);
  if (!offered.length) return null;
  if (routePolicy(env) === 'first') return plannerPromptBudget(env, offered[0]!);
  let widest: number | null = 0;
  for (const p of offered) { const b = plannerPromptBudget(env, p); if (b === null) return null; if (b > (widest ?? 0)) widest = b; }
  return widest;
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
  // A records question is TWO large calls in one turn (the planner, then the chooser over the inventory) and
  // together they exceed one minute of the free plan's 8k; the host then asks for ~35s. Waiting that out once
  // is the difference between the question answering slowly and never — so the bound is a minute here, not
  // the adapter's 30s. A longer wait, or a second 429, still surfaces as the refusal it is.
  return createFetchOpenAiCompatClient({ apiKey: env.GROQ_API_KEY!, baseUrl: env.ORCHESTRATION_GROQ_BASE_URL || GROQ_DEFAULTS.baseUrl, waitOn429UpToSeconds: 60 });
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
  // THE REPLY'S LENGTH IS A DEPLOYMENT SETTING, not a per-ask guess. The composers' own default (700 tokens)
  // fits a sentence-or-paragraph answer; a composition over evidence — a six-week study from a catalog, with
  // a link per item (spec 387 W2) — was cut off after week three at that cap, and the caller had to finish
  // the plan from the artifact. Unset ⇒ the composer's default; a non-number is refused, never silently 700.
  const cap = (env.COMPOSER_MAX_TOKENS ?? '').trim();
  if (cap && !/^\d{2,5}$/.test(cap)) throw new Error(`COMPOSER_MAX_TOKENS must be a number of tokens, got ${JSON.stringify(cap)}`);
  const maxTokens = cap ? { maxTokens: Number(cap) } : {};
  if (p === 'groq') {
    return createOpenAiCompatComposer({
      client: groqClient(env), model: modelFor(env, 'groq'), label: 'groq',
      // A smaller evidence cap than the Anthropic composer's 24k: the free tier is bounded by tokens-per-minute,
      // and the composer is the turn's largest request.
      maxEvidenceChars: 12_000, ...maxTokens,
      ...(opts?.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
    });
  }
  return createAnthropicComposer({
    client: createFetchAnthropicClient({ apiKey: env.ANTHROPIC_API_KEY! }),
    ...(env.ORCHESTRATION_MODEL ? { model: env.ORCHESTRATION_MODEL } : {}),
    ...maxTokens,
    ...(opts?.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
  });
}

/** Spec 388 — the composer for THIS reply, chosen by what it must carry (the evidence), with the reason recorded. */
export function selectComposerRouted(env: PlannerEnv, opts: { systemPrompt?: string; provider?: LlmProvider; need: RouteNeed }): { composer: AnswerComposer | null; route: RouteDecision } {
  const route = routeProvider(env, opts.provider, opts.need);
  if (route.provider === null) return { composer: null, route };
  return { composer: selectComposer(env, { ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}), provider: route.provider }), route };
}

export function selectPlanner(env: PlannerEnv, opts?: { systemPrompt?: string; maxTokens?: number; provider?: LlmProvider }): { planner: Planner; kind: PlannerKind; model?: string } {
  const p = providerFor(env, opts?.provider);
  if (p === 'groq') {
    const planner = createOpenAiCompatPlanner({
      client: groqClient(env), model: modelFor(env, 'groq'), label: 'groq',
      ...(opts?.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
      ...(opts?.maxTokens ? { maxTokens: opts.maxTokens } : {}),
      // gpt-oss reasons in the completion; a planner turn is one tool choice and gets the low setting.
      reasoningEffort: 'low',
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
