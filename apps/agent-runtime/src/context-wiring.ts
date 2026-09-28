// THE APP'S HALF OF THE SEMANTIC CONTEXT PLANE — spec 358 W1.
//
// `@agenticprimitives/context` owns the plane (resolution, standing, the kb/vault questions, discovery
// reads); this module owns what only a deployment knows: HOW discovery is reached (a Cloudflare service
// binding here, a base URL in dev — Workers cannot fetch sibling workers.dev hosts, error 1042) and
// WHICH vendor answers the one structured model call — the same provider the turn plans with (spec 377),
// so the two adapter packages (`orchestration-anthropic`, `orchestration-openai-compat`) remain the only
// vendor-touching ones.
import { defaultProvider, providerConfigured, modelFor, geminiClient, GEMINI_DEFAULTS, GROQ_DEFAULTS, OPENAI_DEFAULTS, XAI_DEFAULTS, OPENAI_REASONING_HEADROOM, routePolicy, routeProvider, llmAllowlist, type PlannerEnv, type LlmProvider, type RouteDecision } from './orchestration.js';
import { createFetchAnthropicClient, usageOfAnthropic } from '@agenticprimitives/orchestration-anthropic';
import { addUsage, type ModelUsageV1 } from '@agenticprimitives/orchestration';
import { createFetchOpenAiCompatClient, createOpenAiCompatStructuredCall, createOpenAiCompatLogprobChoice, createOpenAiCompatTextStream, type TextStreamCall } from '@agenticprimitives/orchestration-openai-compat';
import type { DiscoveryFetch, StructuredCall } from '@agenticprimitives/context';
import type { DiscoveryEnv } from './discovery-facets.js';

/** Reach the discovery MCP. `null` when no binding is configured — the plane turns that into an honest
 *  "not reachable" throw rather than an empty answer (ADR-0013). */
export function discoveryFetchFor(env: DiscoveryEnv): DiscoveryFetch {
  return async (path, init) => {
    if (env.DISCOVERY_MCP) return env.DISCOVERY_MCP.fetch(`https://discovery-mcp${path}`, init);
    if (env.DISCOVERY_MCP_BASE?.trim()) return fetch(`${env.DISCOVERY_MCP_BASE.replace(/\/$/, '')}${path}`, init);
    return null;
  };
}

/**
 * Spec 413 — whether this estate offers passage retrieval over the public tier, and how.
 *   off       (unset) — not offered: a tool whose index is not bound would only fail, so it is not listed (ADR-0013);
 *   tool      `kb.retrieve` is a tool the planner may choose;
 *   playbook  also, when the acting agent's playbook declares `retrievalQueries`, ONE retrieval step runs before the
 *             plan and its passages are an observation the answer is composed from (never the planner's prompt).
 */
export type KbRetrievalMode = 'off' | 'tool' | 'playbook';
export function kbRetrievalMode(env: { KB_RETRIEVAL?: string }): KbRetrievalMode {
  const v = (env.KB_RETRIEVAL ?? '').trim().toLowerCase();
  return v === 'tool' || v === 'playbook' ? v : 'off';
}

/** Kept as a name for the env subset the model wiring reads; it IS the planner's env (spec 377). */
export type ModelEnv = PlannerEnv;

/** The one structured model call the plane may make (grounded SPARQL, record selection). `undefined`
 *  when no model is configured — the tools are then not offered rather than offered and broken. Runs on
 *  `provider` when the turn named one, else the deployment default; a listed-but-keyless provider throws. */
/** One structured call as it ran — who carried it, on which model, why, and when. The trace's model invocation. */
export interface StructuredCallRecordV1 { provider: LlmProvider; model: string; because?: string; startMs: number; endMs: number; failed?: boolean;
  /** What the provider reported the call used (absent when it reported nothing — never estimated). */
  tokensIn?: number; tokensOut?: number; cachedIn?: number; reasoningOut?: number }

export function structuredCallFor(env: ModelEnv, provider?: LlmProvider, opts: { /** Spec 388 W2 — each routed call's decision, for the trace. */ onRoute?: (d: RouteDecision) => void; /** Spec 415 — EVERY call, routed or named, as it ran: a model call the trace does not name is a model call nobody can audit. */ onCall?: (c: StructuredCallRecordV1) => void; /** `light`: the provider's lighter model where it names one (Gemini's planner model) — for a call that only has to choose. `minimal` (spec 418 A1): the default model, thinking at `minimal` effort — for an answer whose first words wait on its thinking. */ tier?: 'light' | 'strong' | 'minimal'; /** Test seam: build a provider's call without a client. */ make?: (p: LlmProvider) => StructuredCall } = {}): StructuredCall | undefined {
  const build = (p: LlmProvider, onUsage?: (u: ModelUsageV1) => void): StructuredCall => (opts.make ? opts.make(p) : providerStructuredCall(env, p, onUsage, opts.tier));
  const modelOf = (p: LlmProvider) => (opts.tier === 'strong' ? strongModelFor(env, p) : modelFor(env, p, opts.tier === 'light' ? 'planner' : undefined));
  // Each invocation is built with its own usage callback: two calls in flight at once (a judge's permutations) must not
  // mix their counts.
  const timed = (p: LlmProvider, because?: string): StructuredCall => async (input) => {
    if (!opts.onCall) return build(p)(input);
    const startMs = Date.now();
    let usage: ModelUsageV1 | undefined;
    const c = build(p, (u) => { usage = addUsage(usage, u); });
    const rec = (failed: boolean) => opts.onCall!({ provider: p, model: modelOf(p), ...(because ? { because } : {}), startMs, endMs: Date.now(), ...(failed ? { failed } : {}), ...(usage ?? {}) });
    try { const out = await c(input); rec(false); return out; } catch (e) { rec(true); throw e; }
  };
  // Spec 388 W2 — ROUTED PER REQUEST when the turn named no provider and the deployment routes by budget: the
  // structured call is built at request time from what it carries (the system text, the messages, the tool's
  // schema — the vault chooser's inventory alone was once 9,996 tokens), and the decision is recorded like the
  // planner's. A named provider is the turn's choice; `first` keeps spec 377.
  if (!provider && routePolicy(env) === 'budget' && llmAllowlist(env).length) {
    return async (input) => {
      const estimatedTokens = Math.ceil((input.system.length + input.messages.reduce((n, m) => n + m.content.length, 0)) / 4 + JSON.stringify(input.tool).length / 3.5);
      const route = await routeProvider(env, undefined, { call: 'structured', estimatedTokens });
      opts.onRoute?.(route);
      if (route.provider === null) throw new Error('no model offered for the structured call');
      return timed(route.provider, route.because)(input);
    };
  }
  const p = provider ?? defaultProvider(env);
  if (p === null) return undefined;
  return timed(p, 'named');
}

/** Roughly 4k tokens — the smallest prefix the vendor's prompt cache will hold for the models in use. */
const CACHEABLE_SYSTEM_CHARS = 16_000;

/**
 * One provider's structured call — the vendor-touching half. ONE BRANCH PER PROVIDER, NO DEFAULT (ADR-0013): this
 * once ended in an unconditional Anthropic client, so a provider without a branch (Gemini, when it was added) was
 * carried by Claude while the route said Gemini — measured 2026-09-26: every skill-selection judgment on faithnet
 * ran on Claude Haiku 4.5. An unlisted provider, or one this function does not know, now throws.
 */
/** Spec 418 — the provider's STRONGER model, for a comparison of long answers (Gemini: ORCHESTRATION_GEMINI_STRONG_MODEL,
 *  default gemini-3.5-pro); a provider that names none uses its default model. */
export function strongModelFor(env: ModelEnv, p: LlmProvider): string {
  return p === 'gemini' ? ((env as { ORCHESTRATION_GEMINI_STRONG_MODEL?: string }).ORCHESTRATION_GEMINI_STRONG_MODEL?.trim() || 'gemini-3.5-pro') : modelFor(env, p);
}

export function providerStructuredCall(env: ModelEnv, p: LlmProvider, onUsage?: (u: ModelUsageV1) => void, tier?: 'light' | 'strong' | 'minimal'): StructuredCall {
  if (!providerConfigured(env, p)) throw new Error(`structured call on ${p}: this deployment does not offer ${p} (ORCHESTRATION_LLM) — no other provider carries it (ADR-0013)`);
  if (p === 'gemini') {
    // Gemini 3.5 Flash THINKS inside the completion bound: a judge's 600-token bound was spent thinking and the call came
    // back with no tool call ("answered in prose", measured 2026-09-26). Low effort + headroom, and `required` — the
    // form Gemini's planner already uses reliably.
    return createOpenAiCompatStructuredCall({ ...(onUsage ? { onUsage } : {}), client: geminiClient(env), model: tier === 'strong' ? strongModelFor(env, 'gemini') : modelFor(env, 'gemini', tier === 'light' ? 'planner' : undefined), label: 'gemini', reasoningEffort: tier === 'minimal' ? 'minimal' : 'low', reasoningHeadroom: OPENAI_REASONING_HEADROOM, toolChoice: 'required' });
  }
  if (p === 'openai') {
    return createOpenAiCompatStructuredCall({
      ...(onUsage ? { onUsage } : {}),
      client: createFetchOpenAiCompatClient({ apiKey: env.OPENAI_API_KEY!, baseUrl: env.ORCHESTRATION_OPENAI_BASE_URL || OPENAI_DEFAULTS.baseUrl, tokenLimitParam: 'max_completion_tokens' }),
      model: modelFor(env, 'openai'), label: 'openai', reasoningEffort: 'low', reasoningHeadroom: OPENAI_REASONING_HEADROOM,
    });
  }
  if (p === 'xai') {
    return createOpenAiCompatStructuredCall({
      ...(onUsage ? { onUsage } : {}),
      client: createFetchOpenAiCompatClient({ apiKey: env.XAI_API_KEY!, baseUrl: env.ORCHESTRATION_XAI_BASE_URL || XAI_DEFAULTS.baseUrl }),
      model: modelFor(env, 'xai'), label: 'xai',
    });
  }
  if (p === 'groq') {
    return createOpenAiCompatStructuredCall({
      ...(onUsage ? { onUsage } : {}),
      client: createFetchOpenAiCompatClient({ apiKey: env.GROQ_API_KEY!, baseUrl: env.ORCHESTRATION_GROQ_BASE_URL || GROQ_DEFAULTS.baseUrl }),
      model: modelFor(env, 'groq'), label: 'groq',
    });
  }
  if (p !== 'anthropic') { const never: never = p; throw new Error(`structured call: no adapter for provider ${String(never)} (ADR-0013)`); }
  const client = createFetchAnthropicClient({ apiKey: env.ANTHROPIC_API_KEY! });
  const model = modelFor(env, 'anthropic');
  return async ({ system, messages, tool, maxTokens }) => {
    // A LONG SYSTEM PROMPT IS CACHED AT THE PROVIDER. A playbook's compiled doctrine is the same text on
    // every call for the same agent and act (a coach's is ~40k characters), and the vendor's prompt cache
    // keys on the exact prefix: marking it once turns the input pass from seconds into a cache read for
    // the next five minutes. Below the cache's own minimum the marker is ignored, so it is only set where
    // it can take. Nothing about the answer changes.
    const cached = system.length >= CACHEABLE_SYSTEM_CHARS ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : system;
    const res = await client.messages.create({
      model, max_tokens: maxTokens ?? 1500, system: cached as never, messages,
      tools: [tool as never], tool_choice: { type: 'tool', name: tool.name },
    });
    const block = res.content.find((b) => b.type === 'tool_use' && b.name === tool.name);
    // No call is not an empty answer (ADR-0013): say so, with why the model stopped.
    { const u = usageOfAnthropic(res.usage); if (u) onUsage?.(u); }
    if (!block) throw new Error(`anthropic(${model}) did not call "${tool.name}" (stop_reason: ${String((res as { stop_reason?: unknown }).stop_reason ?? 'unknown')})`);
    return (block.input ?? {}) as Record<string, unknown>;
  };
}

/**
 * Spec 416 §4f — the ONE-LETTER call for the log-probability judge, on the provider's light model, recorded like any judge
 * call (provider, model, time, reported tokens). OpenAI-compatible hosts only; Anthropic returns no log-probabilities, so
 * there it is `undefined` and the judgment holds `no-judge` — said, never substituted.
 */
export function logprobChoiceFor(env: ModelEnv, provider: LlmProvider | undefined, opts: { onCall?: (c: StructuredCallRecordV1) => void } = {}): ((input: { system: string; user: string; letters: readonly string[] }) => Promise<Record<string, number>>) | undefined {
  const p = provider ?? defaultProvider(env);
  if (!p || p === 'anthropic' || !providerConfigured(env, p)) return undefined;
  const model = modelFor(env, p, 'planner');
  const client = p === 'gemini' ? geminiClient(env)
    : createFetchOpenAiCompatClient({ apiKey: (p === 'openai' ? env.OPENAI_API_KEY : p === 'xai' ? env.XAI_API_KEY : env.GROQ_API_KEY)!, baseUrl: p === 'openai' ? env.ORCHESTRATION_OPENAI_BASE_URL || OPENAI_DEFAULTS.baseUrl : p === 'xai' ? env.ORCHESTRATION_XAI_BASE_URL || XAI_DEFAULTS.baseUrl : env.ORCHESTRATION_GROQ_BASE_URL || GROQ_DEFAULTS.baseUrl });
  return async (input) => {
    const startMs = Date.now();
    let usage: ModelUsageV1 | undefined;
    const choose = createOpenAiCompatLogprobChoice({ client, model, label: p, onUsage: (u) => { usage = addUsage(usage, u); } });
    const rec = (failed: boolean) => opts.onCall?.({ provider: p, model, because: 'named', startMs, endMs: Date.now(), ...(failed ? { failed } : {}), ...(usage ?? {}) });
    try { const out = await choose(input); rec(false); return out; } catch (e) { rec(true); throw e; }
  };
}

/** Spec 418 A1 — a STREAMED text answer (Gemini only; any other provider ⇒ undefined, and the caller keeps the structured
 *  call — one mechanism per provider, never a silent switch mid-answer). Recorded on the trace like any structured call. */
export function textStreamFor(env: ModelEnv, provider: LlmProvider | undefined, opts: { onCall?: (c: StructuredCallRecordV1) => void; tier?: 'light' | 'strong' | 'minimal' } = {}): TextStreamCall | undefined {
  const p = provider ?? (env.ORCHESTRATION_LLM ?? '').split(',').map((x) => x.trim()).filter(Boolean)[0] as LlmProvider | undefined;
  if (p !== 'gemini' || !(env as { GEMINI_API_KEY?: string }).GEMINI_API_KEY) return undefined;
  const model = opts.tier === 'strong' ? strongModelFor(env, 'gemini') : modelFor(env, 'gemini', opts.tier === 'light' ? 'planner' : undefined);
  return async (input) => {
    const startMs = Date.now();
    let usage: ModelUsageV1 | undefined;
    const call = createOpenAiCompatTextStream({ apiKey: (env as { GEMINI_API_KEY: string }).GEMINI_API_KEY, baseUrl: (env as { ORCHESTRATION_GEMINI_BASE_URL?: string }).ORCHESTRATION_GEMINI_BASE_URL || GEMINI_DEFAULTS.baseUrl, model, label: 'gemini', reasoningEffort: opts.tier === 'minimal' ? 'minimal' : 'low', reasoningHeadroom: OPENAI_REASONING_HEADROOM, onUsage: (u) => { usage = addUsage(usage, u); } });
    try {
      const text = await call(input);
      opts.onCall?.({ provider: 'gemini', model, because: 'stream', startMs, endMs: Date.now(), ...(usage ?? {}) });
      return text;
    } catch (e) {
      opts.onCall?.({ provider: 'gemini', model, because: 'stream', startMs, endMs: Date.now(), failed: true, ...(usage ?? {}) });
      throw e;
    }
  };
}
