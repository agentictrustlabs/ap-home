// The demo-a2a binding of the Ring-0 agentic loop (ADR-0044). ONE definition of the agent's exposed tools +
// the planner selection + the run, shared by the two first-party entry points:
//   • the A2aTaskDO `orchestrate` SkillHandler (the canonical TASK path: a real A2A message/send → task →
//     orchestrate → tasks/get), used by agent-to-agent intents through /api/a2a; and
//   • the `/a2a/intent` relayer endpoint (the session-bridged first-party convenience for the simple demo-web,
//     where the browser holds a server-side session rather than a signable A2A message).
// Both run the IDENTICAL orchestration core over a delegation-bound invoker — the planner chooses WHICH tool;
// every composed MCP call rides the supplied delegation (authority unchanged, ADR-0041).
import { runIntent, createRuleBasedPlanner, OrchestrationError, type Planner, type ToolSpec, type ToolInvoker, type RunResult, type AnswerComposer } from '@agenticprimitives/orchestration';
import { createAnthropicPlanner, createAnthropicComposer, createFetchAnthropicClient, DEFAULT_PLANNER_MODEL as ANTHROPIC_DEFAULT_MODEL } from '@agenticprimitives/orchestration-anthropic';
import { createOpenAiCompatPlanner, createOpenAiCompatComposer, createFetchOpenAiCompatClient, type OpenAiCompatLike } from '@agenticprimitives/orchestration-openai-compat';
import type { ModelUsageV1 } from '@agenticprimitives/orchestration';
import type { Address } from 'viem';
// Type-only import (erased at build — no runtime cycle with index.ts).
import type { Env } from './index.js';
import { SpendWindow, type MeteredCandidate, type SpendReport } from './spend-window.js';
import { internalHeaders, internalMarker, type InternalMarkerEnv } from './internal-marker.js';

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
export const RULE_BASED_PLANNER: Planner = createRuleBasedPlanner([
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
export type PlannerEnv = Pick<Env, 'ORCHESTRATION_LLM' | 'ANTHROPIC_API_KEY' | 'ORCHESTRATION_MODEL' | 'GROQ_API_KEY' | 'ORCHESTRATION_GROQ_MODEL' | 'ORCHESTRATION_GROQ_BASE_URL' | 'ORCHESTRATION_GROQ_PROMPT_BUDGET' | 'OPENAI_API_KEY' | 'ORCHESTRATION_OPENAI_MODEL' | 'ORCHESTRATION_OPENAI_BASE_URL' | 'ORCHESTRATION_OPENAI_PROMPT_BUDGET' | 'XAI_API_KEY' | 'ORCHESTRATION_XAI_MODEL' | 'ORCHESTRATION_XAI_BASE_URL' | 'ORCHESTRATION_XAI_PROMPT_BUDGET'> & { GEMINI_API_KEY?: string; ORCHESTRATION_GEMINI_MODEL?: string; ORCHESTRATION_GEMINI_PLANNER_MODEL?: string; ORCHESTRATION_GEMINI_BASE_URL?: string; ORCHESTRATION_GEMINI_PROMPT_BUDGET?: string; ORCHESTRATION_GEMINI_TPM?: string } & { COMPOSER_MAX_TOKENS?: string; ORCHESTRATION_ROUTE?: string; ORCHESTRATION_GROQ_TPM?: string; ORCHESTRATION_OPENAI_TPM?: string; ORCHESTRATION_XAI_TPM?: string } & Partial<Pick<Env, 'PROVIDER_METER' | 'A2A_INTERNAL_MARKER'>>;

// ── WHICH MODEL PROPOSES — spec 377 ──────────────────────────────────────────────────────────────────────
//
// A deployment OFFERS an ordered list of providers (`ORCHESTRATION_LLM="anthropic,groq"`); the first is the
// default. A turn may NAME one (the Ask's picker); absent, the default runs. Nothing here decides authority —
// which model proposes is a display-and-billing fact — and nothing here swaps: a provider that is offered and
// not credentialed throws, a provider that is named and not offered is refused, and neither lands on another.

/** The providers this app knows how to construct. The id is what a turn names and the trace records. */
export type LlmProvider = 'anthropic' | 'groq' | 'openai' | 'xai' | 'gemini';
export const LLM_PROVIDERS: readonly LlmProvider[] = ['anthropic', 'groq', 'openai', 'xai', 'gemini'];
/** What `selectPlanner` reports having chosen. */
export type PlannerKind = LlmProvider | 'rule-based';

/** Groq is THIS APP's configuration of the vendor-neutral OpenAI-compatible adapter — the package names no
 *  host and no model (spec 377 §2). Override with ORCHESTRATION_GROQ_MODEL / ORCHESTRATION_GROQ_BASE_URL.
 *  `openai/gpt-oss-120b` is the strongest tool-calling model on Groq's free catalog as of 2026-09-08 (the
 *  Llama 3.x ids were retired from it); verified live with `tool_choice: 'required'`. */
export const GROQ_DEFAULTS = { model: 'openai/gpt-oss-120b', baseUrl: 'https://api.groq.com/openai/v1' } as const;

/** OpenAI is a SECOND configuration of the same vendor-neutral adapter — a host and a model, nothing more.
 *  `gpt-5-mini` is the cheapest OpenAI model that plans reliably with forced tool choice (a quarter of
 *  Haiku 4.5's input price), which is the whole reason it is offered: spec 388 routes to the cheapest
 *  provider that carries the call, and between the free tier and Haiku there was nothing. It is a REASONING
 *  model, so two things differ from Groq's configuration and both are the host's rule, not a preference:
 *  the completion bound travels as `max_completion_tokens` (`max_tokens` is refused), and the bound must
 *  leave room for the reasoning tokens the model spends before it calls a tool — hence the wider planner
 *  ceiling in `selectPlanner`. Override with ORCHESTRATION_OPENAI_MODEL / _BASE_URL. */
export const OPENAI_DEFAULTS = { model: 'gpt-5-mini', baseUrl: 'https://api.openai.com/v1' } as const;

/** xAI is a FOURTH configuration of the same adapter (2026-09-15). `grok-4.20-0309-non-reasoning` calls tools under
 *  `tool_choice: 'required'` and takes `max_tokens` (verified live); it spends no reasoning tokens, so the planner
 *  ceiling needs no headroom and `reasoning_effort` is NOT sent (the host rejects it on the 4.x models). The reasoning
 *  siblings (`grok-4.6`) bill their thinking outside the completion bound — name one with ORCHESTRATION_XAI_MODEL and
 *  widen the ceiling if you do. Override the host with ORCHESTRATION_XAI_BASE_URL. */
export const XAI_DEFAULTS = { model: 'grok-4.20-0309-non-reasoning', baseUrl: 'https://api.x.ai/v1' } as const;

/**
 * Gemini is a FIFTH configuration of the same vendor-neutral adapter (2026-09-17), through Google's own
 * OpenAI-compatible surface — verified live with `tool_choice: 'required'`, which is what a planner needs.
 *
 * TWO MODELS, BECAUSE THE TWO CALLS ARE NOT THE SAME JOB. Choosing which tool to run is a routing decision over
 * a short prompt and is the cheapest thing the harness does; writing the reply is the thing a person reads. So
 * this provider names a `plannerModel` as well as a `model`, and `modelFor` takes the CALL — the first per-call
 * model split in this file, and the reason the parameter exists.
 *
 * THE 2.5 GENERATION IS CLOSED TO NEW KEYS. `gemini-2.5-flash` and `-flash-lite` answer a model LIST and then
 * refuse a completion with "no longer available to new users. Please update your code to use
 * models/gemini-3.5-…" — measured 2026-09-17. The 3.5 pair is the live equivalent and is what these defaults
 * name; `-latest` aliases exist but a floating alias is not a thing to pin a deployment to.
 */
export const GEMINI_DEFAULTS = {
  model: 'gemini-3.5-flash',
  plannerModel: 'gemini-3.5-flash-lite',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
} as const;

const PROVIDER_LABEL: Record<LlmProvider, string> = { anthropic: 'Claude (Anthropic)', groq: 'GPT-OSS 120B (Groq, free)', openai: 'GPT-5 mini (OpenAI)', xai: 'Grok 4.20 (xAI)', gemini: 'Gemini 3.5 Flash (Google)' };
const PROVIDER_FREE: Record<LlmProvider, boolean> = { anthropic: false, groq: true, openai: false, xai: false, gemini: false };
const PROVIDER_KEY: Record<LlmProvider, keyof PlannerEnv> = { anthropic: 'ANTHROPIC_API_KEY', groq: 'GROQ_API_KEY', openai: 'OPENAI_API_KEY', xai: 'XAI_API_KEY', gemini: 'GEMINI_API_KEY' };

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
  // OpenAI's paid tiers bound a MINUTE, not a request, and a 400k-context model is not the binding
  // constraint on any prompt this app builds — so no bound unless a deployment names one.
  if (provider === 'openai') { const n = Number(env.ORCHESTRATION_OPENAI_PROMPT_BUDGET); return Number.isFinite(n) && n > 0 ? Math.floor(n) : null; }
  if (provider === 'xai') { const n = Number(env.ORCHESTRATION_XAI_PROMPT_BUDGET); return Number.isFinite(n) && n > 0 ? Math.floor(n) : null; }
  if (provider === 'gemini') { const n = Number(env.ORCHESTRATION_GEMINI_PROMPT_BUDGET); return Number.isFinite(n) && n > 0 ? Math.floor(n) : null; }
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
export interface RouteNeed {
  call: 'planner' | 'composer' | 'structured';
  estimatedTokens: number;
  /** The composer only: the largest single result body it must carry whole. A provider whose evidence cap would
   *  replace that body with a summary does not CARRY the call — the composer would then compose over three titles of
   *  thirty and say "nothing matched" (seen live on the Ligonier catalog, 12,890 chars against Groq's 12,000). */
  largestBodyChars?: number;
}
/** Each provider's composer evidence cap (the same numbers `selectComposer` builds them with). */
export const COMPOSER_EVIDENCE_CAP: Record<LlmProvider, number> = { anthropic: 24_000, openai: 24_000, groq: 12_000, xai: 24_000, gemini: 24_000 };
export interface RouteDecision {
  provider: LlmProvider | null;
  /** Why, in words a trace reader can check against the numbers beside it. */
  because: string;
  considered: Array<{ provider: LlmProvider; budget: number | null; spentThisMinute?: number; fits: boolean }>;
}
/** Groq's free plan meters tokens per MINUTE per model; the per-request budget above is derived from it. */
export const GROQ_FREE_PLAN_TPM = 8000;
export function providerTpm(env: PlannerEnv, p: LlmProvider): number | null {
  // OpenAI meters a minute too, but at tier-1 volumes (hundreds of thousands of tokens) it is never the
  // reason a call routes elsewhere. Unmetered here unless a deployment names its own ceiling.
  if (p === 'openai') { const n = Number(env.ORCHESTRATION_OPENAI_TPM); return Number.isFinite(n) && n > 0 ? Math.floor(n) : null; }
  if (p === 'xai') { const n = Number(env.ORCHESTRATION_XAI_TPM); return Number.isFinite(n) && n > 0 ? Math.floor(n) : null; }
  if (p === 'gemini') { const n = Number(env.ORCHESTRATION_GEMINI_TPM); return Number.isFinite(n) && n > 0 ? Math.floor(n) : null; }
  if (p !== 'groq') return null;
  const raw = Number(env.ORCHESTRATION_GROQ_TPM);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : GROQ_FREE_PLAN_TPM;
}
// ── WHERE THE MINUTE IS COUNTED — spec 388 W3 ────────────────────────────────────────────────────
//
// The route reads a rolling 60 s window of what a metered provider has already been sent. W1 kept that
// window in this module, which made it per Worker ISOLATE: the planner and composer of ONE turn saw each
// other, two concurrent asks did not, and on the free plan the second one paid a 429's 30-60 s wait.
// W3 adds the SHARED window — a Durable Object, one per deployment — and the deployment's bindings choose
// which is in use ONCE, at wiring time. That choice is configuration, never an escalation: nothing here
// tries the object and lands on the isolate when it fails (ADR-0013). Which one served is on the trace.
export interface SpendMeter {
  readonly kind: 'isolate' | 'shared';
  /** Walk the metered candidates in the route's order, take the first ELIGIBLE one whose window carries
   *  its estimate, charge it — atomically, so two concurrent asks cannot both read an empty minute.
   *  Reports every candidate's window as it stood when the decision was made. */
  admit(candidates: MeteredCandidate[], now: number): Promise<SpendReport>;
  /** Charge a provider unconditionally — the route's last resort, where nothing fit and the first offered
   *  provider takes the call anyway. */
  charge(provider: LlmProvider, tokens: number, now: number): Promise<void>;
}

/** This isolate's own window. Honest about its scope: one Worker isolate, not the account. */
const isolateWindow = new SpendWindow();
export function spentThisMinute(p: LlmProvider, now = Date.now()): number { return isolateWindow.spent(p, now); }
export function recordSpend(p: LlmProvider, tokens: number, now = Date.now()): void { isolateWindow.charge(p, tokens, now); }
/** Test seam. */
export function resetSpend(): void { isolateWindow.clear(); }

export const ISOLATE_METER: SpendMeter = {
  kind: 'isolate',
  async admit(candidates, now) { return isolateWindow.admit(candidates, now); },
  async charge(provider, tokens, now) { isolateWindow.charge(provider, tokens, now); },
};

/** The name of the one meter object a deployment keeps. The meter is an ACCOUNT-wide fact (a provider
 *  meters the key, not the caller), so it is one object, not one per agent. */
export const PROVIDER_METER_KEY = 'provider-meter';

export function sharedMeter(ns: DurableObjectNamespace, env: InternalMarkerEnv): SpendMeter {
  const call = async (body: unknown): Promise<SpendReport> => {
    const stub = ns.get(ns.idFromName(PROVIDER_METER_KEY));
    const headers = internalHeaders(env);
    const send = () => stub.fetch('https://provider-meter.internal/', { method: 'POST', headers, body: JSON.stringify(body) });
    let res: Response;
    try {
      res = await send();
      if (!res.ok) res = await send(); // ADR-0013: one bounded retry of the SAME call, never a second mechanism
    } catch {
      res = await send();
    }
    if (!res.ok) throw new Error(`provider meter refused the ${(body as { op: string }).op} (HTTP ${res.status})`);
    const out = (await res.json()) as { picked?: string | null; spent?: Record<string, number> };
    return { picked: (out.picked ?? null) as string | null, spent: out.spent ?? {} };
  };
  return {
    kind: 'shared',
    async admit(candidates, now) { void now; return call({ op: 'admit', candidates }); },
    async charge(provider, tokens, now) { void now; await call({ op: 'charge', provider, tokens }); },
  };
}

/** The meter this deployment counts with — decided from the bindings, before any call. */
export function meterFor(env: PlannerEnv): SpendMeter {
  return env.PROVIDER_METER && internalMarker(env) ? sharedMeter(env.PROVIDER_METER, env) : ISOLATE_METER;
}

export async function routeProvider(
  env: PlannerEnv,
  requested: LlmProvider | undefined,
  need: RouteNeed,
  opts: { now?: number; meter?: SpendMeter } = {},
): Promise<RouteDecision> {
  const now = opts.now ?? Date.now();
  if (requested) { providerConfigured(env, requested); return { provider: requested, because: `${requested}: named by the turn`, considered: [] }; }
  const offered = llmAllowlist(env);
  if (!offered.length) return { provider: null, because: 'no model offered', considered: [] };
  if (routePolicy(env) === 'first') { providerConfigured(env, offered[0]!); return { provider: offered[0]!, because: `${offered[0]}: first offered (ORCHESTRATION_ROUTE=first)`, considered: [] }; }

  // Every offered provider, in order, against its per-request budget. A listed-but-keyless provider THROWS
  // here too — a route may not quietly skip a misconfiguration.
  const entries = offered.map((p) => {
    providerConfigured(env, p);
    const budget = plannerPromptBudget(env, p);
    const capFits = need.call !== 'composer' || need.largestBodyChars === undefined || need.largestBodyChars <= COMPOSER_EVIDENCE_CAP[p];
    return { provider: p, budget, tpm: providerTpm(env, p), budgetFits: (budget === null || need.estimatedTokens <= budget) && capFits, capFits };
  });
  // The walk stops at the first UNMETERED provider whose budget carries the call: it needs no meter, so
  // nothing past it is ever consulted. Everything before it that is metered goes to the meter in one call.
  const stop = entries.findIndex((e) => e.budgetFits && e.tpm === null);
  const examined = stop === -1 ? entries : entries.slice(0, stop + 1);
  const candidates: MeteredCandidate[] = examined
    .filter((e) => e.tpm !== null)
    .map((e) => ({ provider: e.provider, tpm: e.tpm!, tokens: need.estimatedTokens, eligible: e.budgetFits }));
  const meter = opts.meter ?? meterFor(env);
  const report = candidates.length ? await meter.admit(candidates, now) : { picked: null, spent: {} as Record<string, number> };

  const considered: RouteDecision['considered'] = examined.map((e) => {
    const spent = e.tpm !== null ? (report.spent[e.provider] ?? 0) : undefined;
    return {
      provider: e.provider,
      budget: e.budget,
      ...(spent !== undefined ? { spentThisMinute: spent } : {}),
      fits: e.budgetFits && (e.tpm === null || need.estimatedTokens + (spent ?? 0) <= e.tpm),
    };
  });
  const winner = (report.picked as LlmProvider | null) ?? (stop === -1 ? null : entries[stop]!.provider);
  if (winner) {
    const at = considered.findIndex((c) => c.provider === winner);
    const mine = considered[at]!;
    const before = considered.slice(0, at);
    const why = mine.budget === null ? 'no budget' : `estimate ${need.estimatedTokens} ≤ budget ${mine.budget}${mine.spentThisMinute !== undefined ? ` and ${need.estimatedTokens}+${mine.spentThisMinute} ≤ ${providerTpm(env, winner)}/min` : ''}`;
    const rejected = before.length ? ` (${before.map((c) => `${c.provider} would not: ${!entries.find((e) => e.provider === c.provider)!.capFits ? `its ${COMPOSER_EVIDENCE_CAP[c.provider]}-char evidence cap would summarize a ${need.largestBodyChars}-char result` : c.budget !== null && need.estimatedTokens > c.budget ? `estimate ${need.estimatedTokens} > ${c.budget}` : `${need.estimatedTokens}+${c.spentThisMinute ?? 0} > ${providerTpm(env, c.provider)}/min`}`).join('; ')})` : '';
    return { provider: winner, because: `${winner} for the ${need.call}: ${why}${rejected}`, considered: considered.slice(0, at + 1) };
  }
  // Nothing carries it: the first offered provider takes it, made to fit (the prompt fitter records every drop).
  const first = offered[0]!;
  if (providerTpm(env, first) !== null) await meter.charge(first, need.estimatedTokens, now);
  return {
    provider: first,
    because: `${first} for the ${need.call}: no offered provider carries ${need.estimatedTokens} tokens (${considered.map((c) => `${c.provider} budget ${c.budget ?? '∞'}${c.spentThisMinute !== undefined ? `, spent ${c.spentThisMinute}` : ''}`).join('; ')}) — first offered, prompt fitted`,
    considered,
  };
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
/**
 * WHICH MODEL CARRIES THIS CALL. `call` is optional and only one provider reads it: choosing a tool is a
 * routing decision over a short prompt, and writing the reply is what a person reads, so a provider may name a
 * cheaper model for the planner than for the composer. Every other provider answers the same either way.
 */
export function modelFor(env: PlannerEnv, p: LlmProvider, call?: RouteNeed['call']): string {
  if (p === 'gemini') {
    return call === 'planner'
      ? env.ORCHESTRATION_GEMINI_PLANNER_MODEL || env.ORCHESTRATION_GEMINI_MODEL || GEMINI_DEFAULTS.plannerModel
      : env.ORCHESTRATION_GEMINI_MODEL || GEMINI_DEFAULTS.model;
  }
  if (p === 'anthropic') return env.ORCHESTRATION_MODEL || ANTHROPIC_DEFAULT_MODEL;
  if (p === 'openai') return env.ORCHESTRATION_OPENAI_MODEL || OPENAI_DEFAULTS.model;
  if (p === 'xai') return env.ORCHESTRATION_XAI_MODEL || XAI_DEFAULTS.model;
  return env.ORCHESTRATION_GROQ_MODEL || GROQ_DEFAULTS.model;
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

function openAiClient(env: PlannerEnv): OpenAiCompatLike {
  // `max_completion_tokens`: OpenAI's reasoning models REFUSE `max_tokens` outright (HTTP 400), so this is
  // the host's rule travelling as configuration, not a preference. The 429 wait stays the adapter's default —
  // a paid tier's minute is not the free plan's, and a long wait here would hide a real rate problem.
  return createFetchOpenAiCompatClient({ apiKey: env.OPENAI_API_KEY!, baseUrl: env.ORCHESTRATION_OPENAI_BASE_URL || OPENAI_DEFAULTS.baseUrl, tokenLimitParam: 'max_completion_tokens' });
}

export function geminiClient(env: PlannerEnv): OpenAiCompatLike {
  providerConfigured(env, 'gemini');
  return createFetchOpenAiCompatClient({ apiKey: env.GEMINI_API_KEY!, baseUrl: env.ORCHESTRATION_GEMINI_BASE_URL || GEMINI_DEFAULTS.baseUrl });
}

export function xaiClient(env: PlannerEnv): OpenAiCompatLike {
  // Plain `max_tokens`, the adapter's default 429 wait: a paid API whose limits are per account, not a free minute.
  return createFetchOpenAiCompatClient({ apiKey: env.XAI_API_KEY!, baseUrl: env.ORCHESTRATION_XAI_BASE_URL || XAI_DEFAULTS.baseUrl });
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

export function selectComposer(env: PlannerEnv, opts?: { systemPrompt?: string; provider?: LlmProvider; /** Told what each composing call used, as the provider reported it. */ onUsage?: (u: ModelUsageV1) => void }): AnswerComposer | null {
  const p = providerFor(env, opts?.provider);
  if (p === null) return null;
  // THE REPLY'S LENGTH IS A DEPLOYMENT SETTING, not a per-ask guess. The composers' own default (700 tokens)
  // fits a sentence-or-paragraph answer; a composition over evidence — a six-week study from a catalog, with
  // a link per item (spec 387 W2) — was cut off after week three at that cap, and the caller had to finish
  // the plan from the artifact. Unset ⇒ the composer's default; a non-number is refused, never silently 700.
  const cap = (env.COMPOSER_MAX_TOKENS ?? '').trim();
  if (cap && !/^\d{2,5}$/.test(cap)) throw new Error(`COMPOSER_MAX_TOKENS must be a number of tokens, got ${JSON.stringify(cap)}`);
  const maxTokens = cap ? { maxTokens: Number(cap) } : {};
  if (p === 'openai') {
    return createOpenAiCompatComposer({
      ...(opts?.onUsage ? { onUsage: opts.onUsage } : {}),
      client: openAiClient(env), model: modelFor(env, 'openai'), label: 'openai',
      // A reasoning model spends completion tokens thinking BEFORE it writes, and the bound covers both —
      // so the deployment's reply cap gets the same headroom the planner gets, or a long composition ends
      // mid-sentence with nothing said about why.
      maxEvidenceChars: 24_000, ...(maxTokens.maxTokens ? { maxTokens: maxTokens.maxTokens + OPENAI_REASONING_HEADROOM } : {}),
      ...(opts?.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
    });
  }
  if (p === 'gemini') {
    return createOpenAiCompatComposer({
      ...(opts?.onUsage ? { onUsage: opts.onUsage } : {}),
      client: geminiClient(env), model: modelFor(env, 'gemini', 'composer'), label: 'gemini',
      maxEvidenceChars: 24_000, ...maxTokens,
      ...(opts?.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
    });
  }
  if (p === 'xai') {
    return createOpenAiCompatComposer({
      ...(opts?.onUsage ? { onUsage: opts.onUsage } : {}),
      client: xaiClient(env), model: modelFor(env, 'xai'), label: 'xai',
      maxEvidenceChars: 24_000, ...maxTokens,
      ...(opts?.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
    });
  }
  if (p === 'groq') {
    return createOpenAiCompatComposer({
      ...(opts?.onUsage ? { onUsage: opts.onUsage } : {}),
      client: groqClient(env), model: modelFor(env, 'groq'), label: 'groq',
      // A smaller evidence cap than the Anthropic composer's 24k: the free tier is bounded by tokens-per-minute,
      // and the composer is the turn's largest request.
      maxEvidenceChars: 12_000, ...maxTokens,
      ...(opts?.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
    });
  }
  return createAnthropicComposer({
      ...(opts?.onUsage ? { onUsage: opts.onUsage } : {}),
    client: createFetchAnthropicClient({ apiKey: env.ANTHROPIC_API_KEY! }),
    ...(env.ORCHESTRATION_MODEL ? { model: env.ORCHESTRATION_MODEL } : {}),
    ...maxTokens,
    ...(opts?.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
  });
}

/** Spec 388 — the composer for THIS reply, chosen by what it must carry (the evidence), with the reason recorded. */
export async function selectComposerRouted(env: PlannerEnv, opts: { systemPrompt?: string; provider?: LlmProvider; need: RouteNeed; onUsage?: (u: ModelUsageV1) => void }): Promise<{ composer: AnswerComposer | null; route: RouteDecision }> {
  const route = await routeProvider(env, opts.provider, opts.need);
  if (route.provider === null) return { composer: null, route };
  return { composer: selectComposer(env, { ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}), provider: route.provider, ...(opts.onUsage ? { onUsage: opts.onUsage } : {}) }), route };
}

/** What a reasoning model may spend THINKING before it calls a tool. The completion bound covers reasoning
 *  and output together, so a 1,024-token planner ceiling that is enough for Groq's gpt-oss (whose reasoning
 *  is billed in the same completion but rarely long at `low`) can be swallowed whole by a gpt-5 turn,
 *  leaving no tool call and a `no_plan` that looks like the planner refusing. */
export const OPENAI_REASONING_HEADROOM = 2048;

export function selectPlanner(env: PlannerEnv, opts?: { systemPrompt?: string; maxTokens?: number; provider?: LlmProvider; /** Told what each planning call used, as the provider reported it. */ onUsage?: (u: ModelUsageV1) => void }): { planner: Planner; kind: PlannerKind; model?: string } {
  const p = providerFor(env, opts?.provider);
  if (p === 'openai') {
    const planner = createOpenAiCompatPlanner({
      ...(opts?.onUsage ? { onUsage: opts.onUsage } : {}),
      client: openAiClient(env), model: modelFor(env, 'openai'), label: 'openai',
      ...(opts?.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
      maxTokens: (opts?.maxTokens ?? 1024) + OPENAI_REASONING_HEADROOM,
      reasoningEffort: 'low',
    });
    return { planner, kind: 'openai', model: modelFor(env, 'openai') };
  }
  if (p === 'gemini') {
    // The ROUTER: the cheapest model that reliably picks a tool under `tool_choice: 'required'`. It spends no
    // reasoning tokens outside the completion bound, so the ceiling needs no headroom.
    const model = modelFor(env, 'gemini', 'planner');
    const planner = createOpenAiCompatPlanner({
      ...(opts?.onUsage ? { onUsage: opts.onUsage } : {}),
      client: geminiClient(env), model, label: 'gemini',
      ...(opts?.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
      maxTokens: opts?.maxTokens ?? 1024,
    });
    return { planner, kind: 'gemini', model };
  }
  if (p === 'xai') {
    const planner = createOpenAiCompatPlanner({
      ...(opts?.onUsage ? { onUsage: opts.onUsage } : {}),
      client: xaiClient(env), model: modelFor(env, 'xai'), label: 'xai',
      ...(opts?.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
      ...(opts?.maxTokens ? { maxTokens: opts.maxTokens } : {}),
      // no reasoning_effort: the default model does not reason and the host refuses the parameter on 4.x
    });
    return { planner, kind: 'xai', model: modelFor(env, 'xai') };
  }
  if (p === 'groq') {
    const planner = createOpenAiCompatPlanner({
      ...(opts?.onUsage ? { onUsage: opts.onUsage } : {}),
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
      ...(opts?.onUsage ? { onUsage: opts.onUsage } : {}),
      client,
      ...(env.ORCHESTRATION_MODEL ? { model: env.ORCHESTRATION_MODEL } : {}),
      ...(opts?.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
      ...(opts?.maxTokens ? { maxTokens: opts.maxTokens } : {}),
    });
    return { planner, kind: 'anthropic', model: modelFor(env, 'anthropic') };
  }
  return { planner: RULE_BASED_PLANNER, kind: 'rule-based' };
}

/**
 * RULES FIRST, A MODEL ONLY WHEN THE RULES CANNOT DECIDE (2026-09-17).
 *
 * `selectPlanner` reaches the rule-based planner ONLY when no provider is configured at all, so on any
 * credentialed deployment every intent costs a model call — including the ones that are not questions.
 * An app driving this at volume ("read vault record cardroom.hand", "list vault records") was paying a
 * planner turn to be told what a regular expression already knew, and a game with eight characters
 * talking to each other is exactly that shape at exactly that volume.
 *
 * WHICH RULES MAY PRE-EMPT A MODEL, and why it is not all of them. The anchored, app-driven goals are
 * machine-written: a program composed them from a record type it already knew, so matching one is a
 * certainty rather than a guess. The fuzzy keyword rules exist to give a MODELLESS deployment something
 * reasonable, and they are too eager to sit in front of a model — `/profile|pii|personal/` would swallow
 * "summarise my profile and draft an intro", which a model should answer and a single tool call cannot.
 * So: the anchored ones short-circuit, the fuzzy ones stay the fallback they were written to be.
 *
 * A DEPLOYMENT CAN TURN IT OFF (`ORCHESTRATION_PREPLAN="off"`), and nothing about authority changes either
 * way — the same delegation-bound invoker runs the same tools; only who chose them differs, and the trace
 * says which.
 */
const PREPLANNED: RegExp[] = [/^read vault record /i, /^list vault records$/i];

export function preplanEnabled(env: { ORCHESTRATION_PREPLAN?: string }): boolean {
  return String(env.ORCHESTRATION_PREPLAN ?? '').trim().toLowerCase() !== 'off';
}

/** Wrap a model planner so a goal the anchored rules already answer never reaches it. */
export function rulesFirst(model: Planner, enabled = true): Planner {
  return {
    async plan(input) {
      const goal = input.intent.goal ?? '';
      if (enabled && PREPLANNED.some((re) => re.test(goal.trim()))) {
        try {
          return await RULE_BASED_PLANNER.plan(input);
        } catch (e) {
          // The rule matched the words and could not build a plan — an unexposed tool, say. That is the
          // model's turn, not an error: falling through is the whole point of trying the cheap one first.
          if (!(e instanceof OrchestrationError) || e.code !== 'no_plan') throw e;
        }
      }
      return model.plan(input);
    },
  };
}

/** Run an intent through the shared orchestration core. `invoke` is the delegation-bound MCP composer (the
 *  authority boundary) — the caller supplies it (the skill wraps `ctx.mcp.callTool`; the relayer wraps
 *  `callMcpToolViaDelegation`). Returns the run result + which planner ran. */
export async function runOrchestration(
  env: PlannerEnv,
  args: { goal: string; principal: Address; invoke: ToolInvoker },
): Promise<{ result: RunResult; plannerKind: PlannerKind }> {
  const { planner, kind } = selectPlanner(env);
  // A goal the anchored rules already answer never reaches the model — see `rulesFirst`. When no model was
  // selected at all the planner IS the rule-based one and this wraps nothing.
  const chosen = kind === 'rule-based' ? planner : rulesFirst(planner, preplanEnabled(env as { ORCHESTRATION_PREPLAN?: string }));
  const result = await runIntent(
    { goal: args.goal, context: { principal: args.principal } },
    { planner: chosen, tools: ORCHESTRATION_TOOLS, invoke: args.invoke },
  );
  return { result, plannerKind: kind };
}
