// Partial-match agent search (spec 314 W2). ONE mechanism (ADR-0013): the discovery
// knowledge base (GraphDB), queried through the discovery MCP's REST seam — the same
// KB the indexer keeps current from on-chain naming/profile/registry events (the
// ENS-v2 + The-Graph pattern). No chain fallback: a KB miss means "not indexed".
// Search is DISCOVERY, never authority — acting on a result (message, delegate)
// re-verifies against the chain at the point of action.

const MCP_URL =
  (process.env.NEXT_PUBLIC_DISCOVERY_MCP_URL as string | undefined) ??
  'https://demo-discovery-mcp.richardpedersen3.workers.dev';

export interface AgentSearchHit {
  /** Full agent name, e.g. `sarah.impact` (null for unnamed — filtered out below). */
  name: string;
  /** First label — what message delivery addresses. */
  label: string;
  smartAgent: string;
  displayName: string | null;
  description: string | null;
  skills: string | null; // `approf:skills` — the agent's DECLARED CAPABILITIES; KB key is legacy, prose says capability.
  registryStatus: string | null;
  facets: string[];
}

export async function searchAgentsKb(q: string, limit = 20): Promise<AgentSearchHit[]> {
  const res = await fetch(`${MCP_URL}/search?q=${encodeURIComponent(q)}&limit=${limit}`);
  if (!res.ok) throw new Error(`knowledge-base search failed (${res.status})`);
  const out = (await res.json()) as {
    ok?: boolean;
    error?: string;
    results?: Array<{
      name?: string | null; smartAgent?: string; displayName?: string | null;
      description?: string | null; skills?: string | null; registryStatus?: string | null; facets?: string[];
    }>;
  };
  if (!out.ok) throw new Error(out.error ?? 'knowledge-base search failed');
  return (out.results ?? [])
    .filter((r): r is typeof r & { name: string; smartAgent: string } => !!r.name && !!r.smartAgent)
    .map((r) => ({
      name: r.name,
      label: r.name.split('.')[0] ?? r.name,
      smartAgent: r.smartAgent,
      displayName: r.displayName ?? null,
      description: r.description ?? null,
      skills: r.skills ?? null,
      registryStatus: r.registryStatus ?? null,
      facets: r.facets ?? [],
    }));
}
