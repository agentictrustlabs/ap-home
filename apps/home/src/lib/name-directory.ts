// Registered-name directory (most-recent-first). ONE mechanism (ADR-0013): the discovery knowledge
// base (GraphDB) through the discovery MCP's REST seam — same read tier as agent-search.ts. The KB's
// `apnam:registeredAt` is projected off AgentNameRegistry storage by the indexer (on-chain-derivable,
// ADR-0040); no chain fallback — a KB miss means "not indexed yet".

// Through this deployment's own agent — see the note in `agent-search.ts`. A browser must not hold a
// discovery hostname: the binding behind `/a2a` is per environment, so a faithnet Home reads faithnet's
// names and a production Home reads production's, with nothing to keep in step by hand.
const DIRECTORY = '/a2a/discovery';

export interface RegisteredName {
  /** Full agent name, e.g. `sarah.impact`. */
  name: string;
  smartAgent: string;
  /** Unix seconds the name was registered on-chain; null until the KB reindexes with the metadata. */
  registeredAt: number | null;
  expiresAt: number | null;
  /** 'PersonAgent' | 'OrganizationAgent' | 'ServiceAgent' | null (undeclared on-chain). */
  kind: string | null;
  displayName: string | null;
  description: string | null;
  appContext: string | null;
  orgRole: string | null;
  serviceUrl: string | null;
  siteUrl: string | null;
}

export async function listRegisteredNames(limit = 200): Promise<RegisteredName[]> {
  const res = await fetch(`${DIRECTORY}/names?limit=${limit}`);
  if (!res.ok) throw new Error(`name directory read failed (${res.status})`);
  const out = (await res.json()) as { ok?: boolean; error?: string; names?: RegisteredName[] };
  if (!out.ok) throw new Error(out.error ?? 'name directory read failed');
  return out.names ?? [];
}

export async function getRegisteredNameMetadata(key: string): Promise<{ agent: string; triples: { p: string; o: string }[] }> {
  const res = await fetch(`${DIRECTORY}/agent?key=${encodeURIComponent(key)}`);
  if (!res.ok) throw new Error(`agent metadata read failed (${res.status})`);
  const out = (await res.json()) as { ok?: boolean; error?: string; agent?: string; triples?: { p: string; o: string }[] };
  if (!out.ok || !out.agent) throw new Error(out.error ?? 'agent metadata read failed');
  return { agent: out.agent, triples: out.triples ?? [] };
}
