// A2A-by-subdomain host context (spec 231; pattern ported from agentic-trust
// `apps/atp-agent/src/worker.ts`). A request to `<handle>.impact-agent.io`
// identifies an A2A request for the agent named `<handle>.demo.agent`. The
// personal subdomain is the agent's single canonical endpoint — humans get the
// Connect SSO home, machines get this A2A endpoint.
//
// In production the subdomain origin is served by demo-sso (Pages), which owns
// the `*.impact-agent.io` custom domain and proxies the A2A paths here while
// injecting `X-Agent-Subdomain` (the resolved label) + `X-Public-Origin` (the
// public `https://<handle>.impact-agent.io`). For direct workers.dev / local
// access we parse the Host header ourselves.

import { AgentNamingClient } from '@agenticprimitives/agent-naming';
import type { Address } from '@agenticprimitives/types';

/** The TLD names are claimed under. `alice` → `alice.impact`. (Deployment convention — the
 *  package owns naming primitives; the concrete TLD is an app concern, so it lives here, not in
 *  agent-naming.) */
export const AGENT_NAME_PARENT = 'impact';

/** The public registrable base domain for personal endpoints. */
export const DEFAULT_PUBLIC_BASE_DOMAIN = 'impact-agent.io';

/**
 * Extract a single-label subdomain from a hostname given the base domain.
 * `alice.impact-agent.io` + `impact-agent.io` → `alice`. The apex, nested
 * labels (`a.b.impact-agent.io`), and non-matching hosts → `null`.
 */
export function parseAgentSubdomain(hostname: string | undefined, baseDomain: string): string | null {
  if (!hostname) return null;
  const host = (hostname.split(':')[0] ?? '').toLowerCase();
  const base = baseDomain.toLowerCase();
  if (host === base) return null;
  if (!host.endsWith('.' + base)) return null;
  const label = host.slice(0, host.length - base.length - 1);
  if (!label || label.includes('.')) return null;
  return label;
}

/** The `.agent` name for a subdomain label (`alice` → `alice.demo.agent`). */
export function agentNameForLabel(label: string): string {
  return `${label}.${AGENT_NAME_PARENT}`;
}

export interface AgentHostContext {
  /** Subdomain label, e.g. `alice`. Null on the apex / generic endpoint. */
  label: string | null;
  /** Resolved canonical Smart Agent address, or null if the name has no agent. */
  agent: Address | null;
  /** The `.agent` name, or null on the apex. */
  name: string | null;
  /** Public endpoint origin (`https://alice.impact-agent.io`). */
  publicOrigin: string;
}

interface HostEnv {
  RPC_URL?: string;
  CHAIN_ID?: string;
  AGENT_NAME_REGISTRY?: string;
  AGENT_NAME_UNIVERSAL_RESOLVER?: string;
  A2A_PUBLIC_BASE_DOMAIN?: string;
}

/**
 * Resolve the A2A agent for a request. Label source priority (ONE mechanism per
 * source — ADR-0013): the `X-Agent-Subdomain` header injected by the demo-sso
 * Pages proxy, else the request Host parsed against `A2A_PUBLIC_BASE_DOMAIN`.
 * Returns a context whose `agent` is null when there is no subdomain (generic
 * endpoint) or the name resolves to no agent.
 */
export async function resolveAgentHost(
  req: Request,
  env: HostEnv,
  requestOrigin: string,
): Promise<AgentHostContext> {
  const baseDomain = env.A2A_PUBLIC_BASE_DOMAIN ?? DEFAULT_PUBLIC_BASE_DOMAIN;
  const injected = req.headers.get('x-agent-subdomain');
  const label = injected && injected.trim() ? injected.trim().toLowerCase() : parseAgentSubdomain(new URL(req.url).hostname, baseDomain);
  const publicOrigin = req.headers.get('x-public-origin')?.trim() || (label ? `https://${label}.${baseDomain}` : requestOrigin);

  if (!label) return { label: null, agent: null, name: null, publicOrigin };

  const name = agentNameForLabel(label);
  let agent: Address | null = null;
  if (env.RPC_URL && env.CHAIN_ID && env.AGENT_NAME_REGISTRY && env.AGENT_NAME_UNIVERSAL_RESOLVER) {
    const client = new AgentNamingClient({
      rpcUrl: env.RPC_URL,
      chainId: Number(env.CHAIN_ID),
      registry: env.AGENT_NAME_REGISTRY as `0x${string}`,
      universalResolver: env.AGENT_NAME_UNIVERSAL_RESOLVER as `0x${string}`,
    });
    agent = await client.resolveName(name);
  }
  return { label, agent, name, publicOrigin };
}

/**
 * Build an A2A v1.0 AgentCard (shape ported from agentic-trust atp-agent
 * `buildAgentCard`). Agent-bound when `ctx.agent` is set; generic otherwise.
 * `skills` is intentionally minimal for the demo — the discovery + routing
 * substrate is what spec 231 ships; the skill catalogue is future work.
 */
export function buildA2aAgentCard(ctx: AgentHostContext, chainId: number): Record<string, unknown> {
  const origin = ctx.publicOrigin.replace(/\/$/, '');
  const messageEndpoint = `${origin}/api/a2a`;
  const bound = Boolean(ctx.agent);
  return {
    protocolVersion: '1.0',
    name: bound ? (ctx.name ?? ctx.label) : 'Agentic Connect A2A',
    description: bound
      ? `A2A endpoint for ${ctx.name} (Smart Agent ${ctx.agent}).`
      : 'Agent-to-Agent endpoint. Per-agent endpoints are served on personal subdomains.',
    version: '0.1.0',
    // Canonical Smart Agent identity (ADR-0010) — the address IS the agent.
    agentAddress: ctx.agent ?? null,
    agentName: ctx.name ?? null,
    supportedInterfaces: [{ url: messageEndpoint, protocolBinding: 'JSONRPC' }],
    provider: { organization: 'Agentic Connect', url: origin },
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: [],
    supportsExtendedAgentCard: false,
    chainId,
  };
}
