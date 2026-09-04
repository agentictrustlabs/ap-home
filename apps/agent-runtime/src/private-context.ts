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
// WHAT THIS DOES NOT REACH YET, said plainly: the ROSTERS of organizations they belong to. Alice known to
// Nathan only as a fellow member of a team he is in, with no link of her own in his tree, is not found
// here — the person is asked instead of guessed at. Reading a roster requires standing in that org, which
// is a second private read against a different subject (spec 353 S3, Ask-2).
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
