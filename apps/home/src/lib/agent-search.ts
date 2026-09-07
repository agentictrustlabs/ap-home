// Partial-match agent search (spec 314 W2). ONE mechanism (ADR-0013): the discovery
// knowledge base (GraphDB), queried through the discovery MCP's REST seam — the same
// KB the indexer keeps current from on-chain naming/profile/registry events (the
// ENS-v2 + The-Graph pattern). No chain fallback: a KB miss means "not indexed".
// Search is DISCOVERY, never authority — acting on a result (message, delegate)
// re-verifies against the chain at the point of action.
//
// THROUGH THIS DEPLOYMENT'S OWN AGENT, and never a hostname held in the browser. It used to default to
// the production discovery MCP, so faithnet.me — a Home on faithchain (34348) — searched Base Sepolia's
// index and offered people agents that do not exist on the chain it acts on (`advisor-alpha.agent`,
// `alvaro-ferrer.impact`). A directory from the wrong chain is not a degraded answer; it is a confident
// wrong one, and picking a row from it means addressing an agent this Home cannot reach. `/a2a` rewrites
// to the a2a this deployment is wired to (next.config.mjs), whose `DISCOVERY_MCP` binding is per
// environment — so the chain decides the index, and no surface can be pointed at the wrong one.
const DIRECTORY = '/a2a/discovery';

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

// CLAIMED-tier corroboration (capability-architecture.md §2): how many DISTINCT non-self agents
// have endorsed this subject for a capability, aggregated by the discovery MCP. Self-endorsement,
// volume and same-org discounting are ALL applied server-side — we just display `independentEndorsers`.
// Best-effort: returns null on any failure (never throws) so a missing read can't break the page;
// returns 0 when the subject is not yet endorsed. This is CORROBORATION, never authorization.
export async function lookupIndependentEndorsers(sa: string): Promise<number | null> {
  try {
    const res = await fetch(`${DIRECTORY}/lookup?agents=${encodeURIComponent(sa)}`);
    if (!res.ok) return null;
    const out = (await res.json()) as {
      ok?: boolean;
      results?: Array<{ smartAgent?: string; independentEndorsers?: number }>;
    };
    if (!out.ok) return null;
    const row = (out.results ?? []).find((r) => r.smartAgent?.toLowerCase() === sa.toLowerCase()) ?? out.results?.[0];
    const n = row?.independentEndorsers;
    return typeof n === 'number' && n > 0 ? n : 0;
  } catch {
    return null;
  }
}

export async function searchAgentsKb(q: string, limit = 20): Promise<AgentSearchHit[]> {
  const res = await fetch(`${DIRECTORY}/search?q=${encodeURIComponent(q)}&limit=${limit}`);
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
