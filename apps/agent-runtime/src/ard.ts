// Per-host ARD manifest (Agentic Resource Discovery v0.91) — spec 347 §8.5, docs/architecture/ard-acp-crosswalk.md.
// A bound agent host publishes ONE entry at `/.well-known/ard.json` whose `url` is its own well-known A2A card.
// Pure: index.ts hands it the host context + live/released card facts. The ARD vocabulary (media types, the
// well-known path, the trust schema) is the registry projection's — `@agenticprimitives/registry-kit/projection`
// (spec 399 §4) — imported, never restated; the per-host ENTRY shape stays this app's. MCP is never an entry (ADR-0057).

import { ARD_WELL_KNOWN_PATH, ARD_CONTEXT_URL, ARD_A2A_CARD_TYPE, AP_TRUST_SCHEMA } from '@agenticprimitives/registry-kit/projection';
export { ARD_WELL_KNOWN_PATH, ARD_CONTEXT_URL, ARD_A2A_CARD_TYPE, AP_TRUST_SCHEMA };

export interface HostArdInput {
  /** The public host serving this agent (`alice.faithnet.io`). */
  host: string;
  /** The bound Smart Agent (CAIP-10 or 0x address) — carried as `ap:canonicalAgentId`, never as the identifier. */
  agent: string;
  /** Typed agent name (`alice.me`), when bound. */
  name?: string | null;
  displayName?: string | null;
  description?: string | null;
  agentType?: string | null;
  /** The card's skills — ids become `capabilities`, examples become `representativeQueries` (2–5). */
  skills?: Array<{ id: string; examples?: string[] }>;
  /** Digest of the card actually served at the well-known path (released or live). */
  cardDigest?: string | null;
  cardSource?: 'released' | 'live';
  registryReceiptUri?: string | null;
  /** Agent implementation version (VERSION_LABELS.agentVersion), when known. */
  version?: string | null;
}

export function ardHostManifest(input: HostArdInput): { '@context': unknown; entries: Array<Record<string, unknown>> } {
  const label = ((input.name ?? '').split('@')[0]?.split('.')[0] ?? '').toLowerCase().replace(/[^a-z0-9._-]/g, '') || input.agent.toLowerCase();
  const capabilities = Array.from(new Set((input.skills ?? []).map((s) => s.id).filter(Boolean)));
  const queries = Array.from(new Set((input.skills ?? []).flatMap((s) => s.examples ?? []).filter((q) => typeof q === 'string' && q.trim()))).slice(0, 5);
  const entry: Record<string, unknown> = {
    identifier: `urn:air:${input.host}:agent:${label}`,
    displayName: input.displayName || input.name || label,
    type: ARD_A2A_CARD_TYPE,
    url: `https://${input.host}/.well-known/agent-card.json`,
    ...(input.description ? { description: input.description } : {}),
    ...(input.version ? { version: input.version } : {}),
    ...(queries.length >= 2 ? { representativeQueries: queries } : {}),
    ...(capabilities.length ? { capabilities } : {}),
    ...(input.agentType ? { tags: [input.agentType] } : {}),
    trustManifest: {
      identity: `https://${input.host}`,
      identityType: 'https-fqdn',
      trustSchema: AP_TRUST_SCHEMA,
      ...(input.registryReceiptUri ? { attestations: [{ type: 'ap-registry-receipt', uri: input.registryReceiptUri }] } : {}),
    },
    'ap:canonicalAgentId': input.agent,
    ...(input.agentType ? { 'ap:agentType': input.agentType } : {}),
    ...(input.cardDigest ? { 'ap:cardDigest': input.cardDigest, 'ap:cardSource': input.cardSource ?? 'live' } : {}),
  };
  return { '@context': [ARD_CONTEXT_URL, { ap: 'https://agenticprimitives.dev/ns/core#' }], entries: [entry] };
}
