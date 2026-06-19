// Registry tab data source. Per the discovery architecture, the home is a CONSUMER of the discovery
// agent — it does NOT read the chain directly. The candidate named agents come from:
//
//   Registry tab → demo-discovery-a2a (/discover) → demo-discovery-mcp → GraphDB (the knowledge base)
//
// The MCP queries GraphDB (SPARQL), not on-chain; GraphDB is kept current by the indexer
// (demo-discovery-indexer). So a newly-onboarded or newly-registered agent appears here once the
// knowledge base has been (re-)indexed — registration is reflected via the projected `registry` facet.

import type { Address } from '@agenticprimitives/types';
import { CHAIN_ID, CONTRACTS } from './chain';

const A2A_URL = (process.env.NEXT_PUBLIC_DISCOVERY_A2A_URL as string | undefined) ?? 'https://demo-discovery-a2a.richardpedersen3.workers.dev';
export const DISCOVERY_REGISTRY_ID = 'urn:ap:registry:impact-agents';

export interface AgentRegistryRow {
  name: string | null;
  subjectAgent: Address;
  /** Has a projected AgentRegistryBase entry in the knowledge base (the `registry` facet). */
  registered: boolean;
  /** SHACL-conformant in the A-box. */
  shaclConforms: boolean;
}

interface DiscoverResult { name?: string | null; smartAgent?: string; facets?: string[]; shaclConforms?: boolean }

/** Candidate named agents from the discovery agent (→ MCP → GraphDB). Empty query = the full list. */
export async function loadRegistry(): Promise<AgentRegistryRow[]> {
  const res = await fetch(`${A2A_URL}/discover`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '' }),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; results?: DiscoverResult[]; error?: string };
  if (!res.ok || !body.ok) throw new Error(body.error ?? `discovery agent HTTP ${res.status}`);
  return (body.results ?? [])
    .filter((r) => r.smartAgent)
    .map((r) => ({
      name: r.name ?? null,
      subjectAgent: r.smartAgent as Address,
      registered: Array.isArray(r.facets) && r.facets.includes('registry'),
      shaclConforms: r.shaclConforms !== false,
    }))
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
}

export const REGISTRY = {
  registryId: DISCOVERY_REGISTRY_ID,
  address: CONTRACTS.agentRegistryBase,
  chainId: CHAIN_ID,
  agent: A2A_URL,
  source: 'discovery agent → MCP → GraphDB',
};
