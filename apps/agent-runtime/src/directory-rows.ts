// READING AN ORGANIZATION'S ROSTER — one parser, for the same reason `relationship-rows.ts` exists.
//
// `directory.data` is stored as a bare ARRAY of `{ listing: DirectoryListingV1, label }` rows — that is
// what the DO writes (`readDoc<IndexedListing[]>(grant, DIRECTORY_RESOURCE, [])`) and what
// `directory.list` reads back. The membership tool read `doc.listings`, which is `undefined` for an
// array, so it answered "0 members" for every organization on the estate WHATEVER its roster held. The
// failure was invisible because zero is a plausible answer for a young org.
//
// This is the second time today the same shape has bitten: `relationships.data` is a MAP and was being
// read as `{rows:[…]}`. The lesson is not "be careful with shapes" — it is that a record's shape belongs
// in ONE place that every reader shares, and a reader that guesses will guess plausibly and be believed.
//
// So this normalises every shape we have written — the indexed array, a `{listings:[…]}` wrapper, a bare
// array of listings — and is the only place that knows any of them.

export interface RosterRow {
  /** The member's SA address, lower-cased. */
  agent: string;
  /** What to call them: their public name, their org-local label, or their display name. */
  name: string | null;
  /** How this membership is evidenced — a self-published listing, or the org's own invitation record. */
  via: 'listing' | 'invitation' | 'membership';
  role?: string;
}

const addressIn = (v: unknown): string => (typeof v === 'string' ? (v.match(/0x[0-9a-fA-F]{40}/)?.[0] ?? '').toLowerCase() : '');
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** One stored row → a roster row, whichever shape it was written in. */
function rowFrom(raw: unknown): RosterRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  // The indexed form: `{ listing: {...}, label }`. The flat form: the listing (or a legacy row) itself.
  const listing = (r.listing && typeof r.listing === 'object' ? r.listing : r) as Record<string, unknown>;
  const agent = addressIn(listing.subject) || addressIn(listing.smartAgent) || addressIn(listing.agent);
  if (!agent) return null;
  const name = str(listing.displayName) || str(listing.name) || str(r.label) || null;
  const role = str(listing.role) || str(listing.primaryRole);
  return { agent, name, via: 'listing', ...(role ? { role } : {}) };
}

/** The roster, from `directory.data` in any shape it has ever been written. */
export function rosterRows(doc: unknown): RosterRow[] {
  const rows = Array.isArray(doc)
    ? doc
    : Array.isArray((doc as { listings?: unknown[] } | null)?.listings)
      ? (doc as { listings: unknown[] }).listings
      : [];
  const out: RosterRow[] = [];
  const seen = new Set<string>();
  for (const raw of rows) {
    const row = rowFrom(raw);
    if (!row || seen.has(row.agent)) continue;
    seen.add(row.agent);
    out.push(row);
  }
  return out;
}

/**
 * MEMBERS THE ORGANIZATION ITSELF RECORDED — `org.invite:agent:<sa>` records in its own vault.
 *
 * A listing is SELF-published: a member who joined by invitation and never published one is a real member
 * with no listing, and reading listings alone hides them. The organization's own invitation records name
 * them, live in its own vault, and are exactly as authoritative as the roster: the org wrote them when it
 * admitted somebody.
 *
 * This is the vault-side half of the union the Home's roster already computes. It is NOT complete for
 * members admitted before that record existed — those are only in a Home cache, which is a finding, not
 * something to paper over here.
 */
export function invitedMemberRows(recordTypes: readonly string[], bodies: Record<string, unknown>): RosterRow[] {
  const out: RosterRow[] = [];
  for (const rt of recordTypes) {
    const agent = addressIn(rt.slice('org.invite:agent:'.length));
    if (!agent) continue;
    const body = bodies[rt] as Record<string, unknown> | undefined;
    const name = str(body?.displayName) || str(body?.name) || null;
    out.push({ agent, name, via: 'invitation' });
  }
  return out;
}

/**
 * THE ORGANIZATION'S OWN MEMBERSHIP RECORDS — `org.membership:member:<sa>`, spec 325's shape.
 *
 * This is the roster proper. A listing is what a member says about themselves; an invitation is how they
 * came to be admitted (the T-box files invitations under "Enrollment instruments — NOT membership"). The
 * membership record is the organization's own statement that they belong, carrying the role assignment
 * and the delegation that materialises it.
 */
export function membershipRows(recordTypes: readonly string[], bodies: Record<string, unknown>): RosterRow[] {
  const out: RosterRow[] = [];
  for (const rt of recordTypes) {
    const body = bodies[rt] as Record<string, unknown> | undefined;
    const agent = addressIn(body?.memberAgent) || addressIn(rt.slice(rt.lastIndexOf(':') + 1));
    if (!agent) continue;
    // An ended membership is not a member. Kept in the vault (a roster that forgets cannot answer "who
    // was here then"), absent from the answer to "who is here now".
    if (str(body?.endedAt)) continue;
    const role = (body?.roleAssignment as { assignedRole?: unknown } | undefined)?.assignedRole;
    out.push({
      agent,
      name: str(body?.displayName) || null,
      via: 'membership',
      ...(str(role) ? { role: str(role) } : {}),
    });
  }
  return out;
}

/** Listings and invitations are two views of one roster; a member in both is one member. A listing wins
 *  on the name, because the member wrote it about themselves. */
export function mergeRoster(listings: RosterRow[], invited: RosterRow[]): RosterRow[] {
  const byAgent = new Map<string, RosterRow>();
  for (const r of invited) byAgent.set(r.agent, r);
  for (const r of listings) byAgent.set(r.agent, { ...byAgent.get(r.agent), ...r });
  return [...byAgent.values()];
}
