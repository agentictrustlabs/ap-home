// THE APP'S HALF OF THE SEMANTIC CONTEXT PLANE — spec 358 W1.
//
// `@agenticprimitives/context` owns the plane (resolution, standing, the kb/vault questions, discovery
// reads); this module owns what only a deployment knows: HOW discovery is reached (a Cloudflare service
// binding here, a base URL in dev — Workers cannot fetch sibling workers.dev hosts, error 1042) and
// WHICH vendor answers the one structured model call — the same provider the turn plans with (spec 377),
// so the two adapter packages (`orchestration-anthropic`, `orchestration-openai-compat`) remain the only
// vendor-touching ones.
import { defaultProvider, providerConfigured, modelFor, GROQ_DEFAULTS, type PlannerEnv, type LlmProvider } from './orchestration.js';
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
export function structuredCallFor(env: ModelEnv, provider?: LlmProvider): StructuredCall | undefined {
  const p = provider ?? defaultProvider(env);
  if (p === null) return undefined;
  providerConfigured(env, p);
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
