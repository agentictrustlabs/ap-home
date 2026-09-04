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
import { keccak256, stringToBytes } from 'viem';
import type { ConsultCandidateFacetsV1 } from '@agenticprimitives/fabric/messaging';

// ── Claimed-capability tier (capability-architecture.md §2 `aps:claimsCapability`) ──────────────────────
// The transport that owns the raw attestations settles independence HERE, so the pure fabric scorer only
// ever sees a clean `endorsedCapabilityIds` set. keccak matches a member's declared capability id STRINGS
// against endorsement skillIds (schemaId = keccak256(capabilityId), the shared identity).
const skillIdOf = (capabilityId: string): string => keccak256(stringToBytes(capabilityId)).toLowerCase();
/** attestations CREDENTIAL_TYPE.CapabilityEndorsement — kept in lockstep with the SDK + the seed. */
const CAPABILITY_ENDORSEMENT_TYPE = keccak256(stringToBytes('CapabilityEndorsementCredential')).toLowerCase();
const EPOCH_SECONDS = 3600;                   // AttestationRegistry.EPOCH_SECONDS
const ENDORSEMENT_HALFLIFE_S = 180 * 86400;   // linear decay to 0 over ~1yr
/** Relationship types that make an endorser NON-INDEPENDENT of the subject (same-org). */
const GOVERNANCE_TYPES = new Set(['HAS_GOVERNANCE_OVER', 'HAS_MEMBER', 'OPERATES_ON_BEHALF_OF']);

export interface DiscoveryEnv {
  /** Service binding to demo-discovery-mcp (production). */
  DISCOVERY_MCP?: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
  /** Dev/base-URL fallback transport (no binding outside deployed environments). */
  DISCOVERY_MCP_BASE?: string;
}

interface LookupRow {
  smartAgent?: string; name?: string | null; displayName?: string | null; description?: string | null;
  /** ADR-0051: the public assertion is `capabilities`. The MCP row was renamed with it; one name, here too. */
  capabilities?: string | null; facets?: string[]; shaclConforms?: boolean; registryStatus?: string | null;
  kind?: string | null;
  /** Spec 331 — the structured facets the matcher now ranks on, ahead of any lexical signal. */
  capabilityIds?: string[]; languages?: string | null; regions?: string | null; focusAreas?: string | null;
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

/** Settle the claimed-capability tier for ONE member: given its declared capability ids and the raw trust
 *  fabric (its endorsement attestations + governance edges), return the capability ids it is BOTH declared
 *  for AND independently endorsed for, applying every abuse rule (self ignored · volume deduped by issuer ·
 *  same-org via a public governance edge discounted · staleness revoked⇒out / aged⇒decayed). Mirrors
 *  demo-discovery-a2a's `independentEndorsementWeight` — the two transports must agree, so the rule is
 *  stated identically in both. `independentEndorsers` = DISTINCT non-self valid endorsers (trust term). */
function settleEndorsements(declaredIds: string[], selfSa: string, trust: Record<string, unknown> | null): { endorsedCapabilityIds: string[]; independentEndorsers: number } {
  if (!trust) return { endorsedCapabilityIds: [], independentEndorsers: 0 };
  const atts = (Array.isArray(trust.attestations) ? trust.attestations : []) as Array<Record<string, unknown>>;
  const rels = (Array.isArray(trust.relationships) ? trust.relationships : []) as Array<Record<string, unknown>>;
  const self = selfSa.toLowerCase();
  const gov = new Set(rels
    .filter((e) => String(e.status) === 'active' && GOVERNANCE_TYPES.has(String(e.relationshipType)))
    .map((e) => String(e.counterparty ?? '').toLowerCase()));
  const endorsements = atts
    .filter((x) => String(x.credentialType ?? '').toLowerCase() === CAPABILITY_ENDORSEMENT_TYPE && x.schemaId)
    .map((x) => ({ issuer: String(x.issuer ?? '').toLowerCase(), skillId: String(x.schemaId).toLowerCase(), valid: x.valid === true, issuedAt: Number(x.issuedAt ?? 0) }));
  const nowS = Math.floor(Date.now() / 1000);
  const independentIssuers = new Set(endorsements.filter((e) => e.valid && e.issuer !== self).map((e) => e.issuer));
  const endorsedCapabilityIds: string[] = [];
  for (const id of declaredIds) {
    const want = skillIdOf(id);
    const byIssuer = new Map<string, number>();
    for (const e of endorsements) {
      if (!e.valid || e.skillId !== want || e.issuer === self) continue;
      let w = 1;
      if (gov.has(e.issuer)) w *= 0.15;                                    // same-org discount
      if (e.issuedAt > 0) w *= Math.max(0, 1 - Math.max(0, nowS - e.issuedAt * EPOCH_SECONDS) / (2 * ENDORSEMENT_HALFLIFE_S));
      byIssuer.set(e.issuer, Math.max(byIssuer.get(e.issuer) ?? 0, w)); // volume dedupe
    }
    const weight = [...byIssuer.values()].reduce((a, b) => a + b, 0);
    if (weight > 0) endorsedCapabilityIds.push(id);
  }
  return { endorsedCapabilityIds, independentEndorsers: independentIssuers.size };
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
      capabilities: row.capabilities ?? null,
      // Spec 331 — carried through so `rankConsultCandidates` can score STRUCTURE. The MCP parses
      // `capabilityIds` out of the capability assertion server-side so every consumer agrees on what a
      // declared capability id is; the `?? []` is the pre-migration server, not a silent default.
      capabilityIds: row.capabilityIds ?? [],
      languages: row.languages ?? null,
      regions: row.regions ?? null,
      focusAreas: row.focusAreas ?? null,
      facets: row.facets ?? [],
      shaclConforms: row.shaclConforms === true,
      registered: row.registryStatus === 'active' || (row.facets ?? []).includes('registry'),
    };
    // Agent kind (person-only mandate) now arrives on the SAME row — no second capped `/names` read.
    if (row.kind) out[sa]!.kind = row.kind;
  }
  // Claimed-capability tier — enrich each member with its endorsement signal. One /trust read per member
  // (the member set is small and known — spec 329 routing), so this is bounded by the roster, not the KB.
  // A per-member failure leaves the member with a bare declaration (no endorsement boost), never a phantom.
  await Promise.all(Object.entries(out).map(async ([sa, facet]) => {
    const trust = await discoveryGet(env, `/trust?key=${encodeURIComponent(sa)}`);
    const { endorsedCapabilityIds, independentEndorsers } = settleEndorsements(facet.capabilityIds ?? [], sa, trust);
    if (endorsedCapabilityIds.length) facet.endorsedCapabilityIds = endorsedCapabilityIds;
    if (independentEndorsers) facet.independentEndorsers = independentEndorsers;
  }));
  return out;
}
