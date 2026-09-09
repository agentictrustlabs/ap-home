// CANDIDATES FROM THE PUBLIC TIER — spec 384 W3 (the `CandidateSource` port of spec 336 §8). Discovery ASSERTS who
// might take an intent; it is evidence, never authority and never a score (spec 281). Two NAMED reads, both always
// run and both reported — not a fallback pair (ADR-0013): a candidate says which read found it and what the KB
// declares for it, so a reader can tell "declares the capability" from "is a service agent somebody could ask".
//
//   1. DECLARED — agents whose public profile skills name the capability (`approf:skills` → `capabilityIds`; the
//      indexer parsed them from on-chain profile bytes, ADR-0040). The strongest public evidence there is.
//   2. TYPED — service agents (on-chain `ap:agentType`, spec 346), found by the typed suffix. They declared
//      nothing about THIS capability; the probe is what finds out, and the row says so.
//
// A person's agent is never a candidate here: a person's agent answers a probe with "a human channel is
// required" by construction (W2), and asking one from a server discloses the intent for nothing.
import type { Address } from 'viem';
import type { CandidateSource, CandidateV1 } from '@agenticprimitives/intent-engagement';
import type { DiscoveryFetch } from '@agenticprimitives/context';

interface DiscoveryRow {
  smartAgent?: string; name?: string | null; displayName?: string | null; agentType?: string | null; kind?: string | null; tld?: string | null;
  capabilityIds?: string[]; registryStatus?: string | null; a2aEndpoint?: string | null; activeRelationships?: number;
}

async function search(fetchDiscovery: DiscoveryFetch, q: string, limit: number): Promise<DiscoveryRow[]> {
  const res = await fetchDiscovery(`/search?q=${encodeURIComponent(q)}&limit=${limit}`);
  if (!res) throw new Error('discovery is not reachable from this deployment');
  if (!res.ok) throw new Error(`discovery answered ${res.status}`);
  const body = (await res.json().catch(() => null)) as { results?: DiscoveryRow[]; agents?: DiscoveryRow[] } | null;
  return body?.results ?? body?.agents ?? [];
}

const isService = (r: DiscoveryRow) => r.agentType === 'service' || r.kind === 'ServiceAgent' || /^(svc|service)$/.test(String(r.tld ?? ''));

export function discoveryCandidateSource(fetchDiscovery: DiscoveryFetch, opts: { exclude?: ReadonlyArray<string>; now?: () => number } = {}): CandidateSource {
  const excluded = new Set((opts.exclude ?? []).map((a) => a.toLowerCase()));
  return {
    async candidatesFor({ capability, limit }) {
      const observedAt = new Date((opts.now ?? Date.now)()).toISOString();
      const [declared, typed] = await Promise.all([search(fetchDiscovery, capability, limit), search(fetchDiscovery, '.svc', limit)]);
      const out = new Map<string, CandidateV1>();
      const admit = (r: DiscoveryRow, reason: string) => {
        const agent = String(r.smartAgent ?? '').toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(agent) || excluded.has(agent)) return;
        if (r.registryStatus && r.registryStatus !== 'active') return; // suspended/revoked registry entries are not asked
        const declares = (r.capabilityIds ?? []).includes(capability);
        // A person's agent is not asked from a server (W2: it can only answer "a human channel is required").
        if (!declares && !isService(r)) return;
        if (r.agentType === 'person' || r.kind === 'PersonAgent') return;
        const existing = out.get(agent);
        const evidence = declares ? [{ capability, source: 'kb:approf:skills', observedAt }] : [];
        if (existing) { existing.reasons.push(reason); if (evidence.length && !existing.capabilityEvidence.length) existing.capabilityEvidence.push(...evidence); return; }
        out.set(agent, {
          agent: agent as Address, ...(r.name ? { name: String(r.name) } : {}), ...(r.a2aEndpoint ? { cardUrl: `${String(r.a2aEndpoint).replace(/\/$/, '')}/.well-known/agent-card.json` } : {}),
          capabilityEvidence: evidence,
          reasons: [reason, declares ? `declares ${capability} in its public profile` : `declares nothing about ${capability}; a ${r.agentType ?? 'service'} agent that can be asked`],
        });
      };
      for (const r of declared) admit(r, `found by the capability read (${capability})`);
      for (const r of typed) admit(r, 'found by the typed read (service agents)');
      // Declared first, then the rest in discovery's order — an ORDER for asking, never a rank.
      return [...out.values()].sort((a, b) => Number(!!b.capabilityEvidence.length) - Number(!!a.capabilityEvidence.length)).slice(0, limit);
    },
  };
}
