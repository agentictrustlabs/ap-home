// READING THE PERSON'S OWN LINKS — one parser, because two readers disagreeing about the shape is how a
// private tier goes quietly empty.
//
// The authoritative record (`relationships.data`, spec 323 W1) is `{ orgs: Record<address, entry> }` — an
// object MAP keyed by agent address, not a list. Readers here had been treating it as `{ rows: [...] }`
// and calling `.find` on it, which throws; every one of those calls sat inside a `.catch`, so the private
// tier reported "no links" instead of "I could not read this". Same words, opposite meanings.
//
// So this normalises every shape we have ever written — the map, a list under `orgs` or `rows`, or a bare
// array — into one row type, and it is the ONLY place that knows any of them.

export interface RelationshipRow {
  /** The linked agent. From the map KEY when the entry omits it — the key is the address. */
  agent: string;
  name: string;
  relationship: 'steward' | 'member';
  kind?: string;
  parent?: string;
  /** The stewardship wire, when one is held. Written as `delegations[0]` today; older rows named it. */
  stewardshipDelegation?: unknown;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function toRow(key: string, raw: unknown): RelationshipRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  const agent = (str(e.org) || str(e.orgAgent) || str(e.agent) || str(e.smartAgent) || key).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(agent)) return null;
  const wire = Array.isArray(e.delegations) ? e.delegations[0] ?? null : (e.stewardshipDelegation ?? null);
  return {
    agent,
    name: str(e.orgName) || str(e.name) || agent,
    // Anything not explicitly `steward` is a member. A missing value must not read as the stronger one.
    relationship: e.relationship === 'steward' ? 'steward' : 'member',
    ...(str(e.kind) ? { kind: str(e.kind) } : {}),
    ...(str(e.parent) ? { parent: str(e.parent).toLowerCase() } : {}),
    ...(wire ? { stewardshipDelegation: wire } : {}),
  };
}

/** Every link in a person's `relationships.data`, whatever shape it was written in. Never throws: an
 *  unreadable document yields no rows, and the CALLER decides whether that is an answer or a gap. */
export function relationshipRows(doc: unknown): RelationshipRow[] {
  if (!doc) return [];
  const container = (() => {
    if (Array.isArray(doc)) return doc;
    if (typeof doc !== 'object') return null;
    const d = doc as Record<string, unknown>;
    return d.orgs ?? d.rows ?? d.agents ?? d.related ?? null;
  })();
  if (!container) return [];
  const entries: Array<[string, unknown]> = Array.isArray(container)
    ? container.map((v, i) => [String(i), v])
    : typeof container === 'object' ? Object.entries(container as Record<string, unknown>) : [];
  return entries.map(([k, v]) => toRow(k, v)).filter((r): r is RelationshipRow => r !== null);
}
