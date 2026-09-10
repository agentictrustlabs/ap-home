// THE APP'S HALF OF THE SEMANTIC CONTEXT PLANE — spec 358 W1.
//
// `@agenticprimitives/context` owns the plane (resolution, standing, the kb/vault questions, discovery
// reads); this module owns what only a deployment knows: HOW discovery is reached (a Cloudflare service
// binding here, a base URL in dev — Workers cannot fetch sibling workers.dev hosts, error 1042) and
// WHICH vendor answers the one structured model call — the same provider the turn plans with (spec 377),
// so the two adapter packages (`orchestration-anthropic`, `orchestration-openai-compat`) remain the only
// vendor-touching ones.
import { defaultProvider, providerConfigured, modelFor, GROQ_DEFAULTS, OPENAI_DEFAULTS, OPENAI_REASONING_HEADROOM, routePolicy, routeProvider, llmAllowlist, type PlannerEnv, type LlmProvider, type RouteDecision } from './orchestration.js';
import { createFetchAnthropicClient } from '@agenticprimitives/orchestration-anthropic';
import { createFetchOpenAiCompatClient, createOpenAiCompatStructuredCall } from '@agenticprimitives/orchestration-openai-compat';
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

/** Kept as a name for the env subset the model wiring reads; it IS the planner's env (spec 377). */
export type ModelEnv = PlannerEnv;

/** The one structured model call the plane may make (grounded SPARQL, record selection). `undefined`
 *  when no model is configured — the tools are then not offered rather than offered and broken. Runs on
 *  `provider` when the turn named one, else the deployment default; a listed-but-keyless provider throws. */
export function structuredCallFor(env: ModelEnv, provider?: LlmProvider, opts: { /** Spec 388 W2 — each routed call's decision, for the trace. */ onRoute?: (d: RouteDecision) => void; /** Test seam: build a provider's call without a client. */ make?: (p: LlmProvider) => StructuredCall } = {}): StructuredCall | undefined {
  // Spec 388 W2 — ROUTED PER REQUEST when the turn named no provider and the deployment routes by budget: the
  // structured call is built at request time from what it carries (the system text, the messages, the tool's
  // schema — the vault chooser's inventory alone was once 9,996 tokens), and the decision is recorded like the
  // planner's. A named provider is the turn's choice; `first` keeps spec 377.
  if (!provider && routePolicy(env) === 'budget' && llmAllowlist(env).length) {
    const built = new Map<LlmProvider, StructuredCall>();
    const callOn = (p: LlmProvider): StructuredCall => { let c = built.get(p); if (!c) { c = (opts.make ?? ((q: LlmProvider) => providerStructuredCall(env, q)))(p); built.set(p, c); } return c; };
    return async (input) => {
      const estimatedTokens = Math.ceil((input.system.length + input.messages.reduce((n, m) => n + m.content.length, 0)) / 4 + JSON.stringify(input.tool).length / 3.5);
      const route = await routeProvider(env, undefined, { call: 'structured', estimatedTokens });
      opts.onRoute?.(route);
      if (route.provider === null) throw new Error('no model offered for the structured call');
      return callOn(route.provider)(input);
    };
  }
  const p = provider ?? defaultProvider(env);
  if (p === null) return undefined;
  return opts.make ? opts.make(p) : providerStructuredCall(env, p);
}

/** One provider's structured call — the vendor-touching half, unchanged from spec 358 W1. */
function providerStructuredCall(env: ModelEnv, p: LlmProvider): StructuredCall {
  providerConfigured(env, p);
  if (p === 'openai') {
    return createOpenAiCompatStructuredCall({
      client: createFetchOpenAiCompatClient({ apiKey: env.OPENAI_API_KEY!, baseUrl: env.ORCHESTRATION_OPENAI_BASE_URL || OPENAI_DEFAULTS.baseUrl, tokenLimitParam: 'max_completion_tokens' }),
      model: modelFor(env, 'openai'), label: 'openai', reasoningEffort: 'low', maxTokens: 1500 + OPENAI_REASONING_HEADROOM,
    });
  }
  if (p === 'groq') {
    return createOpenAiCompatStructuredCall({
      client: createFetchOpenAiCompatClient({ apiKey: env.GROQ_API_KEY!, baseUrl: env.ORCHESTRATION_GROQ_BASE_URL || GROQ_DEFAULTS.baseUrl }),
      model: modelFor(env, 'groq'), label: 'groq',
    });
  }
  const client = createFetchAnthropicClient({ apiKey: env.ANTHROPIC_API_KEY! });
  const model = modelFor(env, 'anthropic');
  return async ({ system, messages, tool, maxTokens }) => {
    const res = await client.messages.create({
      model, max_tokens: maxTokens ?? 1500, system, messages,
      tools: [tool as never], tool_choice: { type: 'tool', name: tool.name },
    });
    const block = res.content.find((b) => b.type === 'tool_use' && b.name === tool.name);
    return (block?.input ?? {}) as Record<string, unknown>;
  };
}
