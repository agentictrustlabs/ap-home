// THE ASKER'S OWN TIER — spec 352 F2 / spec 353 §3, over the `context` ports.
//
// "send 2 usdc to alice" must resolve Alice among the people this person actually knows. The first cut
// looked her up in the PUBLIC directory, which is wrong in a way that reads as helpful: a directory hit
// proves an agent exists, never that the asker knows them, and using it to fill a payee means a stranger
// with a common label can be paid by a sentence that named a friend. Spec 352 §7 says it plainly — "Alice"
// resolves in MY private tier or refuses; a global people search is a different ask (279/338).
//
// The private tier here is the asker's `relationships.data` — the same record the Home's switcher renders
// (ADR-0025: person↔agent links are private vault credentials, never on-chain edges). It is read through
// the asker's OWN InteractionsDO under their own interactions grant, in-Worker: no client-asserted list, no
// second copy, and nothing about who they know leaves their tier.
//
// TWO PRIVATE READS, TWO SUBJECTS. The asker's own links are the first. The second is the ROSTER of an
// organization they belong to — because most people you can name are known to you through something you
// are both in, not through a link you keep to them personally.
//
// The standing gate falls out of the data rather than being asserted: a roster is read ONLY for an
// organization that appears in the asker's own private tree, and that link is a private vault credential
// they hold (ADR-0025) — it IS the evidence that they belong. No public enumeration of who is in what, no
// app-supplied membership claim (spec 353 §2), and nothing about the roster leaves the ask that used it.
import type { EntityCandidate, EntityProvider, EntityQuery } from '@agenticprimitives/context';

/** One row of the asker's private tree, as `relationships.data` stores it. */
interface RelatedAgentRow {
  orgAgent?: string;
  agent?: string;
  orgName?: string;
  name?: string;
  kind?: string;
  purpose?: string;
}

export interface PrivateTierDeps {
  /** Read one record from a subject's own vault, through their InteractionsDO. */
  readSubjectRecord: (subject: string, recordType: string) => Promise<unknown>;
}

const lc = (s: string) => s.trim().toLowerCase();

/** Does this row answer to the words? Exact name, the label before the suffix, or the display name. */
function rowMatches(term: string, name: string, display: string): string | null {
  const t = lc(term);
  const n = lc(name);
  if (n === t) return 'exact-name';
  if (n.split('.')[0] === t) return 'label';
  if (display && lc(display).split(/\s+/).includes(t)) return 'display-name';
  if (display && lc(display) === t) return 'display-name';
  return null;
}

/**
 * The asker's related agents: the organizations, teams, treasuries, workspaces, circles and churches in
 * their tree, and the people they have links to. Private tier, one subject, read under their own grant.
 */
export function relationshipsProvider(deps: PrivateTierDeps): EntityProvider {
  return {
    source: 'relationships',
    tier: 'private',
    async candidates(query: EntityQuery): Promise<EntityCandidate[]> {
      if (!query.subject) return []; // enforced by the resolver too; stated here because it is the rule
      const doc = await deps.readSubjectRecord(query.subject, 'relationships.data');
      const rows = ((doc as { rows?: RelatedAgentRow[]; orgs?: RelatedAgentRow[] } | null)?.rows
        ?? (doc as { orgs?: RelatedAgentRow[] } | null)?.orgs
        ?? (Array.isArray(doc) ? (doc as RelatedAgentRow[]) : [])) as RelatedAgentRow[];
      const out: EntityCandidate[] = [];
      for (const r of rows) {
        const agent = String(r.orgAgent ?? r.agent ?? '').toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(agent)) continue;
        const name = String(r.orgName ?? r.name ?? '');
        const match = rowMatches(query.term, name, name);
        if (!match) continue;
        out.push({
          agent,
          label: name || agent,
          ...(name.includes('.') ? { name } : {}),
          ...(r.kind ?? r.purpose ? { kind: String(r.kind ?? r.purpose) } : {}),
          provenance: { tier: 'private', source: 'relationships', subject: query.subject, match },
        });
      }
      return out;
    },
  };
}

/**
 * The naming service, as a PRIVATE-tier lookup for one specific subject's own reach.
 *
 * A dotted name the person typed (`alice2.treasury`) is not a search — it is an exact reference, and
 * resolving it on chain tells us who holds it. That is public information, but using it here is not a
 * search of the public tier: the person named this agent themselves. A BARE label is different and does
 * not come here; it belongs to the tiers that know who this person knows.
 */
/** One row of an organization's `directory.data` — a member who published themselves to that community. */
interface DirectoryListing {
  smartAgent?: string;
  agent?: string;
  name?: string;
  displayName?: string;
  title?: string;
  localName?: string;
}

/** Agent-ish kinds whose members are worth searching. A treasury has no roster; a church does. */
const ROSTERED_KINDS = new Set(['org', 'organization', 'team', 'workspace', 'circle', 'church']);

/**
 * The people the asker can reach THROUGH something they are both in.
 *
 * Reads the asker's tree for the organizations they belong to, then each of those organizations' member
 * directories. Bounded (a handful of organizations, a handful of matches) because this runs inside one
 * conversational turn, and a resolver that takes ten seconds is a resolver people route around.
 *
 * Every candidate says WHERE it was found ("Alice Okoro — in Northern Colorado Field"), because when two
 * Alices come back the shared organization is exactly what tells the person which one they meant.
 */
export function rosterProvider(deps: PrivateTierDeps, opts: { maxOrgs?: number } = {}): EntityProvider {
  const maxOrgs = opts.maxOrgs ?? 8;
  return {
    source: 'roster',
    tier: 'private',
    async candidates(query: EntityQuery): Promise<EntityCandidate[]> {
      if (!query.subject) return [];
      const tree = await deps.readSubjectRecord(query.subject, 'relationships.data');
      const rows = ((tree as { rows?: RelatedAgentRow[]; orgs?: RelatedAgentRow[] } | null)?.rows
        ?? (tree as { orgs?: RelatedAgentRow[] } | null)?.orgs
        ?? (Array.isArray(tree) ? (tree as RelatedAgentRow[]) : [])) as RelatedAgentRow[];
      const orgs = rows
        .filter((r) => ROSTERED_KINDS.has(String(r.kind ?? r.purpose ?? '').toLowerCase()))
        .map((r) => ({ agent: String(r.orgAgent ?? r.agent ?? '').toLowerCase(), name: String(r.orgName ?? r.name ?? '') }))
        .filter((o) => /^0x[0-9a-f]{40}$/.test(o.agent))
        .slice(0, maxOrgs);

      const found = await Promise.all(orgs.map(async (org) => {
        // One organization's failure is not the search's: a directory that is not enabled yet simply has
        // nobody in it as far as this ask is concerned.
        const doc = await deps.readSubjectRecord(org.agent, 'directory.data').catch(() => null);
        const listings = ((doc as { listings?: DirectoryListing[] } | null)?.listings ?? []) as DirectoryListing[];
        const out: EntityCandidate[] = [];
        for (const l of listings) {
          const agent = String(l.smartAgent ?? l.agent ?? '').toLowerCase();
          if (!/^0x[0-9a-f]{40}$/.test(agent) || agent === lc(query.subject ?? '')) continue; // never the asker
          const name = String(l.name ?? '');
          const display = String(l.displayName ?? l.title ?? l.localName ?? '');
          const match = rowMatches(query.term, name, display);
          if (!match) continue;
          out.push({
            agent,
            label: `${display || name || agent}${org.name ? ` — in ${org.name}` : ''}`,
            ...(name.includes('.') ? { name } : {}),
            provenance: { tier: 'private', source: 'roster', subject: org.agent, match },
          });
        }
        return out;
      }));
      return found.flat();
    },
  };
}

export function exactNameProvider(resolveName: (name: string) => Promise<string | null>): EntityProvider {
  return {
    source: 'naming',
    tier: 'private',
    async candidates(query: EntityQuery): Promise<EntityCandidate[]> {
      const term = lc(query.term);
      if (!term.includes('.')) return []; // bare labels are not names
      const agent = await resolveName(term);
      if (!agent) return [];
      return [{ agent: agent.toLowerCase(), label: term, name: term, provenance: { tier: 'private', source: 'naming', subject: query.subject ?? '', match: 'exact-name' } }];
    },
  };
}
