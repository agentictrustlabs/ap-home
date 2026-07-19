// spec 329 W2 — discovery reach for `find_members`: demo-a2a → demo-discovery-mcp, read-only,
// PUBLIC facets only (ADR-0040). Transport mirrors the demo-a2a → demo-mcp seam: a same-account
// SERVICE BINDING in production (Workers can't fetch sibling *.workers.dev — error 1042), a plain
// base-URL fetch in dev (DISCOVERY_MCP_BASE). Failure mode is spec 329 §4's degraded mode: return
// null and the caller ranks nothing (fewer signals, NEVER more candidates).
//
// ── Why this uses `POST /lookup` and not `GET /search?q=&limit=200` ────────────────────────────────────
// It used to enrich the WHOLE candidate set from a single bulk `/search?q=&limit=200` read. That read was
// capped at 200 rows *silently* — asking for 500 or 1000 still returned 200, with nothing in the response
// admitting it — and the KB now holds more than 200 agents. Any member outside that arbitrary
// `ORDER BY ?name` window was therefore invisible to enrichment even though its facets were correct in
// GraphDB, and spec 329 §4 then seated it on consent alone with `score: 0`. A silent routing degradation,
// invisible from the writer's side because every ceremony succeeded. (Reproduced with advisor
// `yara-haddad`: correct `atl:skills` on chain, a targeted query returns them, the bulk read drops her.)
//
// `POST /lookup` is the exact form: we send the SAs we already hold, the filter runs server-side, and the
// answer is complete by construction — its cost scales with the candidate count, not with KB size. It also
// removes the second `/names?limit=500` read, which had the identical cap: agent `kind` now comes back on
// the same row.
import type { ConsultCandidateFacetsV1 } from '@agenticprimitives/fabric/messaging';

export interface DiscoveryEnv {
  /** Service binding to demo-discovery-mcp (production). */
  DISCOVERY_MCP?: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
  /** Dev/base-URL fallback transport (no binding outside deployed environments). */
  DISCOVERY_MCP_BASE?: string;
}

interface LookupRow {
  smartAgent?: string; name?: string | null; displayName?: string | null; description?: string | null;
  skills?: string | null; facets?: string[]; shaclConforms?: boolean; registryStatus?: string | null;
  kind?: string | null;
}

async function discoveryPost(env: DiscoveryEnv, path: string, body: unknown): Promise<Record<string, unknown> | null> {
  const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  try {
    const res = env.DISCOVERY_MCP
      ? await env.DISCOVERY_MCP.fetch(`https://discovery-mcp${path}`, init)
      : env.DISCOVERY_MCP_BASE?.trim()
        ? await fetch(`${env.DISCOVERY_MCP_BASE.replace(/\/$/, '')}${path}`, init)
        : null;
    if (!res?.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Fetch the public discovery facets for `memberSAs` (lowercased 0x).
 *
 * Returns `null` ONLY when discovery is unreachable/unconfigured — the caller then degrades per spec 329
 * §4. A member absent from the returned map is genuinely absent from the KB (roster-only signals for
 * them), which is now a DIFFERENT and distinguishable condition from "the read didn't reach them": the
 * lookup is exact, so there is no truncation window a member can silently fall outside of.
 */
export async function fetchDiscoveryFacets(
  env: DiscoveryEnv,
  memberSAs: string[],
): Promise<Record<string, ConsultCandidateFacetsV1> | null> {
  if (memberSAs.length === 0) return {};
  const wanted = [...new Set(memberSAs.map((m) => m.toLowerCase()))];
  const res = await discoveryPost(env, '/lookup', { agents: wanted });
  if (!res || res.ok !== true || !Array.isArray(res.results)) return null; // unreachable ⇒ degraded
  // Defence in depth: an exact lookup must never come back truncated. If a future server build ever says
  // it did, treat the read as degraded rather than silently under-enriching (the original bug).
  if (res.truncated === true) return null;
  const want = new Set(wanted);
  const out: Record<string, ConsultCandidateFacetsV1> = {};
  for (const row of res.results as LookupRow[]) {
    const sa = (row.smartAgent ?? '').toLowerCase();
    if (!want.has(sa)) continue;
    out[sa] = {
      name: row.name ?? null,
      displayName: row.displayName ?? null,
      description: row.description ?? null,
      skills: row.skills ?? null,
      facets: row.facets ?? [],
      shaclConforms: row.shaclConforms === true,
      registered: row.registryStatus === 'active' || (row.facets ?? []).includes('registry'),
    };
    // Agent kind (person-only mandate) now arrives on the SAME row — no second capped `/names` read.
    if (row.kind) out[sa].kind = row.kind;
  }
  return out;
}
