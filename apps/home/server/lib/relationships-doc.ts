// spec 323 W1 — the AUTHORITATIVE person↔org graph is the person's vault `relationships.data`
// (written via their InteractionsDO, spec 322 W3d). The Home's `related:*` KV is a rebuildable
// PROJECTION/cache of it. These helpers read/merge the vault doc through the person's DO using the
// person's own home-session bearer (the DO op is self-gated) — reconciling the projection from its
// source is not a fallback mechanism (ADR-0013; same doctrine as membership.ts).
export interface RelationshipEntryV1 {
  org: string;
  relationship: 'member' | 'steward';
  orgName?: string;
  delegationHash?: string;
  delegations?: unknown[];
  updatedAt: string;
}
export interface RelationshipsDocV1 { orgs: Record<string, RelationshipEntryV1> }

interface DocEnv { A2A_CUSTODY_URL?: string }

const base = (env: DocEnv): string | null => (env.A2A_CUSTODY_URL?.trim() ? env.A2A_CUSTODY_URL.replace(/\/$/, '') : null);

/** The person's authoritative relationships doc, or null when their interactions plane isn't
 *  enabled / the transport is unconfigured (empty is an answer — the projection then stands alone). */
export async function readRelationshipsDoc(env: DocEnv, person: string, bearer: string): Promise<RelationshipsDocV1 | null> {
  const b = base(env);
  if (!b || !bearer) return null;
  try {
    const r = await fetch(`${b}/interactions/${person.toLowerCase()}/relationships.get`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: bearer }),
    });
    if (!r.ok) return null;
    const out = (await r.json()) as { ok?: boolean; relationships?: RelationshipsDocV1 };
    return out.ok && out.relationships ? out.relationships : null;
  } catch {
    return null;
  }
}

/** Best-effort write-through of one entry into the person's authoritative doc (409 pre-enable is
 *  expected — the doc catches up at the person's interactions ceremony). */
export async function mergeRelationshipEntry(
  env: DocEnv,
  person: string,
  bearer: string,
  entry: Partial<RelationshipEntryV1> & { org: string },
): Promise<void> {
  const b = base(env);
  if (!b || !bearer) return;
  await fetch(`${b}/interactions/${person.toLowerCase()}/relationships.merge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: bearer, entry }),
  }).catch(() => null);
}
