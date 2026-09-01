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
import { AGENT_REGISTRY_URN } from './domain';
import { resolveCredential } from '../connect-client';

// WHICH discovery agent, and WHICH registry, are DEPLOYMENT facts. Both were hardcoded to production's,
// so a Home on another chain silently read production's knowledge base and reported its own registered
// agents as missing — "not in the registry" for an agent plainly in its directory (seen 2026-08-31 on
// faithnet). The default stays only as a last resort for local dev; every deployed Home sets these.
const A2A_URL = (process.env.NEXT_PUBLIC_DISCOVERY_A2A_URL as string | undefined) ?? 'https://demo-discovery-a2a.richardpedersen3.workers.dev';
/** The directory host this Home reads — shown to a steward so a misconfigured deployment is VISIBLE
 *  rather than silently answering about someone else's agents. */
export const DISCOVERY_HOST = (() => { try { return new URL(A2A_URL).host; } catch { return A2A_URL; } })();
export const DISCOVERY_REGISTRY_ID = AGENT_REGISTRY_URN;

export interface AgentRegistryRow {
  name: string | null;
  subjectAgent: Address;
  /** Has a projected AgentRegistryBase entry in the knowledge base (the `registry` facet). */
  registered: boolean;
  /** SHACL-conformant in the A-box. */
  shaclConforms: boolean;
  /** Set by markCustody(): does the connected credential custody this SA? Undefined = not checked
   *  (the credential couldn't be resolved client-side — e.g. a Google/KMS session). */
  mine?: boolean;
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

/** Mark which rows the connected credential custodies — answered by the discovery MCP over the knowledge
 *  base (ADR-0040), NOT by reading the chain from the browser. We resolve the viewer's own on-chain
 *  identifier (passkey digest / EOA) locally, then ONE batched POST to the discovery agent `/custody`
 *  checks all the rows you care about (non-registered) at once. Cached per (credential, sa) across renders.
 *  When the credential can't be resolved client-side (Google/KMS) every row is left untouched — the
 *  on-chain register ceremony still gates by RB-01 / ERC-1271. */
const custodyCache = new Map<string, boolean>();

export async function markCustody(rows: AgentRegistryRow[], via: string | undefined, name: string | null, token?: string | null): Promise<AgentRegistryRow[]> {
  const cred = await resolveCredential(via, name, token);
  if (!cred) return rows;
  const value = cred.kind === 'passkey' ? cred.digest : cred.address;
  const credKey = `${cred.kind}:${value.toLowerCase()}`;
  const ck = (sa: string) => `${credKey}|${sa.toLowerCase()}`;
  // Check custody for EVERY row — the "you steward" badge applies whether or not the agent is registered.
  // (The Register button is gated separately; it just doesn't show for already-registered rows.)
  const unknown = rows.filter((r) => custodyCache.get(ck(r.subjectAgent)) === undefined);
  if (unknown.length) {
    try {
      const res = await fetch(`${A2A_URL}/custody`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subjectAgents: unknown.map((r) => r.subjectAgent), credential: value }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; results?: Record<string, boolean> };
      if (res.ok && body.ok && body.results) {
        for (const r of unknown) custodyCache.set(ck(r.subjectAgent), body.results[r.subjectAgent.toLowerCase()] === true);
      }
    } catch { /* leave rows unmarked; the on-chain register ceremony still gates by RB-01 */ }
  }
  return rows.map((r) => {
    const v = custodyCache.get(ck(r.subjectAgent));
    return v === undefined ? r : { ...r, mine: v };
  });
}

export const REGISTRY = {
  registryId: DISCOVERY_REGISTRY_ID,
  address: CONTRACTS.agentRegistryBase,
  chainId: CHAIN_ID,
  agent: A2A_URL,
  source: 'discovery agent → MCP → GraphDB',
};
