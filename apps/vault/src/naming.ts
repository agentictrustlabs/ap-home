/**
 * Server-side `.agent` name resolution for demo-mcp.
 *
 * Same principle as the browser demos: ONE `reverseResolveString` view
 * call via the package client — no `eth_getLogs` walk, no fallback to a
 * second resolution mechanism (ADR-0012 / ADR-0013).
 *
 * The name is a non-critical display label attached to read-tool
 * responses. A transport error (RPC down) yields `null` so the tool
 * still returns its data — that is graceful degradation of an optional
 * label, NOT a fallback to a different resolution path.
 */

import { AgentNamingClient } from '@agenticprimitives/agent-naming';

interface NamingEnv {
  RPC_URL?: string;
  CHAIN_ID?: string;
  AGENT_NAME_REGISTRY?: string;
  AGENT_NAME_UNIVERSAL_RESOLVER?: string;
}

export async function resolveAgentName(
  env: NamingEnv,
  address: string,
): Promise<string | null> {
  const { RPC_URL, CHAIN_ID, AGENT_NAME_REGISTRY, AGENT_NAME_UNIVERSAL_RESOLVER } = env;
  if (!RPC_URL || !CHAIN_ID || !AGENT_NAME_REGISTRY || !AGENT_NAME_UNIVERSAL_RESOLVER) {
    return null;
  }
  try {
    const client = new AgentNamingClient({
      rpcUrl: RPC_URL,
      chainId: Number(CHAIN_ID),
      registry: AGENT_NAME_REGISTRY as `0x${string}`,
      universalResolver: AGENT_NAME_UNIVERSAL_RESOLVER as `0x${string}`,
    });
    return await client.reverseResolve(address as `0x${string}`);
  } catch {
    return null;
  }
}
