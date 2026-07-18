// spec 329 W2 — discovery reach for `find_members`: demo-a2a → demo-discovery-mcp, read-only,
// PUBLIC facets only (ADR-0040). Transport mirrors the demo-a2a → demo-mcp seam: a same-account
// SERVICE BINDING in production (Workers can't fetch sibling *.workers.dev — error 1042), a plain
// base-URL fetch in dev (DISCOVERY_MCP_BASE). TWO bounded reads enrich the WHOLE candidate set —
// `/search` (profile text + atl:skills + registry/SHACL facets) + `/names` (agent kind) — never a
// per-candidate fan-out. Failure mode is spec 329 §4's degraded mode: return null and the caller
// ranks nothing (fewer signals, NEVER more candidates); a partial read enriches what it can.
import type { ConsultCandidateFacetsV1 } from '@agenticprimitives/fabric/messaging';

export interface DiscoveryEnv {
  /** Service binding to demo-discovery-mcp (production). */
  DISCOVERY_MCP?: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
  /** Dev/base-URL fallback transport (no binding outside deployed environments). */
  DISCOVERY_MCP_BASE?: string;
}

interface SearchRow {
  smartAgent?: string; name?: string | null; displayName?: string | null; description?: string | null;
  skills?: string | null; facets?: string[]; shaclConforms?: boolean; registryStatus?: string | null;
}
interface NameRow { smartAgent?: string; kind?: string | null }

async function discoveryGet(env: DiscoveryEnv, path: string): Promise<Record<string, unknown> | null> {
  try {
    const res = env.DISCOVERY_MCP
      ? await env.DISCOVERY_MCP.fetch(`https://discovery-mcp${path}`)
      : env.DISCOVERY_MCP_BASE?.trim()
        ? await fetch(`${env.DISCOVERY_MCP_BASE.replace(/\/$/, '')}${path}`)
        : null;
    if (!res?.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Fetch the public discovery facets for `memberSAs` (lowercased 0x). Returns null when discovery
 * is unreachable/unconfigured (the caller degrades per spec 329 §4); a member absent from the KB
 * simply has no entry (roster-only signals for them).
 */
export async function fetchDiscoveryFacets(
  env: DiscoveryEnv,
  memberSAs: string[],
): Promise<Record<string, ConsultCandidateFacetsV1> | null> {
  if (memberSAs.length === 0) return {};
  const search = await discoveryGet(env, '/search?q=&limit=200');
  if (!search || search.ok !== true || !Array.isArray(search.results)) return null; // unreachable ⇒ degraded
  const wanted = new Set(memberSAs.map((m) => m.toLowerCase()));
  const out: Record<string, ConsultCandidateFacetsV1> = {};
  for (const row of search.results as SearchRow[]) {
    const sa = (row.smartAgent ?? '').toLowerCase();
    if (!wanted.has(sa)) continue;
    out[sa] = {
      name: row.name ?? null,
      displayName: row.displayName ?? null,
      description: row.description ?? null,
      skills: row.skills ?? null,
      facets: row.facets ?? [],
      shaclConforms: row.shaclConforms === true,
      registered: row.registryStatus === 'active' || (row.facets ?? []).includes('registry'),
    };
  }
  // Agent kind (person-only mandate) — best-effort second read; its absence loses ONLY that signal.
  const names = await discoveryGet(env, '/names?limit=500');
  if (names?.ok === true && Array.isArray(names.names)) {
    for (const row of names.names as NameRow[]) {
      const sa = (row.smartAgent ?? '').toLowerCase();
      if (wanted.has(sa) && out[sa] && row.kind) out[sa].kind = row.kind;
    }
  }
  return out;
}
