// THE APP'S HALF OF THE SEMANTIC CONTEXT PLANE — spec 358 W1.
//
// `@agenticprimitives/context` owns the plane (resolution, standing, the kb/vault questions, discovery
// reads); this module owns what only a deployment knows: HOW discovery is reached (a Cloudflare service
// binding here, a base URL in dev — Workers cannot fetch sibling workers.dev hosts, error 1042) and
// WHICH vendor answers the one structured model call (the same Anthropic fetch client the planner uses,
// so `orchestration-anthropic` stays the only vendor-touching package).
import { createFetchAnthropicClient } from '@agenticprimitives/orchestration-anthropic';
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

export interface ModelEnv {
  ORCHESTRATION_LLM?: string;
  ANTHROPIC_API_KEY?: string;
  ORCHESTRATION_MODEL?: string;
}

/** The one structured model call the plane may make (grounded SPARQL, record selection). `undefined`
 *  when no model is configured — the tools are then not offered rather than offered and broken. */
export function structuredCallFor(env: ModelEnv): StructuredCall | undefined {
  if (env.ORCHESTRATION_LLM !== 'anthropic' || !env.ANTHROPIC_API_KEY) return undefined;
  const client = createFetchAnthropicClient({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.ORCHESTRATION_MODEL ?? 'claude-sonnet-4-6';
  return async ({ system, messages, tool, maxTokens }) => {
    const res = await client.messages.create({
      model, max_tokens: maxTokens ?? 1500, system, messages,
      tools: [tool as never], tool_choice: { type: 'tool', name: tool.name },
    });
    const block = res.content.find((b) => b.type === 'tool_use' && b.name === tool.name);
    return (block?.input ?? {}) as Record<string, unknown>;
  };
}
