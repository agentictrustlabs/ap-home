// WHO IS IN THIS ORGANIZATION — the question the public directory can never answer.
//
// Membership is PRIVATE (ADR-0025): a person↔organization link is a vault credential, not an on-chain
// edge, and the discovery knowledge base holds only what anyone could reproduce from the chain (ADR-0040).
// So "who are the members" asked of the directory returns nothing, truthfully and uselessly — the agent
// looked in the one place the answer cannot be.
//
// The roster lives in the ORGANIZATION's own vault (`directory.data`), which is exactly where the Home's
// Members panel reads it. This is that read, made available conversationally, under the same rule the Home
// applies: you may see the roster of an organization YOU ARE PART OF, and of no other.
//
// The gate is standing, derived (spec 353 S5) — self, steward or member. `none` is refused, and refused in
// those words: "you are not a member there" is a better answer than an empty list, which reads as "this
// organization has nobody in it" and is a different, false statement.
import type { ToolSpec, ToolInvoker } from '@agenticprimitives/orchestration';
import type { Address } from 'viem';
import { deriveStanding, type StandingDeps } from './standing.js';
import { rosterRows, invitedMemberRows, mergeRoster } from './directory-rows.js';

export const MEMBERSHIP_LIST_TOOL: ToolSpec = {
  id: 'organization.membership.list',
  description:
    'ANSWERS A QUESTION: who belongs to an organization, team, circle or church — its members. Use this '
    + 'whenever the ask is about members, membership, "who is in", "who belongs to" or a roster. The public '
    + 'directory does NOT contain members, so it is never the right tool for this. '
    + 'Args: org (the organization\'s name or address; omit it to mean the agent being asked).',
  inputSchema: {
    type: 'object',
    properties: { org: { type: 'string', description: 'The organization — a name (calvary.org) or an address. Omit for the agent being asked.' } },
  },
};

interface Listing { smartAgent?: string; agent?: string; displayName?: string; name?: string; role?: string; status?: string }

export interface MembershipDeps extends StandingDeps {
  resolveName?: (name: string) => Promise<string | null>;
  /** The org's own record INVENTORY (spec 356 §2.5) — how the invitation records are found without
   *  guessing member addresses. Absent ⇒ listings only, which hides everyone who joined by invite. */
  survey?: (subject: string) => Promise<Array<{ recordType: string; updatedAt?: string }>>;
  /** Read those invitation records, one batched call. */
  readRecords?: (subject: string, recordTypes: string[]) => Promise<Record<string, unknown>>;
  /** The roster read, WITH its reason. Three states a bare `null` cannot tell apart: the organization
   *  never enabled its own storage (permanent, and someone can act on it), the read failed (transient),
   *  and the roster is genuinely empty. Reporting the first as the second sent people to retry something
   *  that will never start working. */
  readSubjectRecordStatus?: (subject: string, recordType: string) => Promise<{ ok: boolean; needsEnable?: boolean; data: unknown; error?: string }>;
}

/**
 * The roster of an organization the asker is part of.
 *
 * Returns the members as the org itself records them. It does NOT fall back to a public search when the
 * private read is empty: an organization with an empty roster and one this agent may not read are
 * different answers, and blurring them is how a private tier stops meaning anything (ADR-0013).
 */
export function membershipListInvoker(deps: MembershipDeps, addressee: Address, principal?: Address): ToolInvoker {
  return async (_toolId, args) => {
    const raw = String((args as { org?: unknown }).org ?? '').trim();
    let org = addressee;
    if (raw) {
      org = (/^0x[0-9a-fA-F]{40}$/.test(raw)
        ? raw
        : ((deps.resolveName ? await deps.resolveName(raw.toLowerCase()) : null) ?? addressee)).toLowerCase() as Address;
    }
    if (!principal) return { members: [], count: 0, refused: 'this agent does not know who is asking' };

    const standing = await deriveStanding(deps, { principal, subject: org }).catch(() => null);
    if (!standing || standing.relation === 'none') {
      return {
        members: [], count: 0,
        refused: `membership is private, and ${standing?.because ?? 'this agent cannot read your links'} — only someone who belongs there can see the roster`,
      };
    }
    if (!deps.readSubjectRecord) return { members: [], count: 0, refused: 'this agent cannot read the roster' };

    let doc: unknown = null;
    if (deps.readSubjectRecordStatus) {
      const r = await deps.readSubjectRecordStatus(org, 'directory.data').catch(() => ({ ok: false, data: null } as { ok: boolean; needsEnable?: boolean; data: unknown }));
      if (r.needsEnable) {
        return {
          members: [], count: 0,
          refused: 'this organization does not keep its roster in its own vault yet — a steward can turn on storage for it at its Home, and the members list will be readable here',
        };
      }
      if (!r.ok) return { members: [], count: 0, refused: 'the roster could not be read just now' };
      doc = r.data;
    } else {
      doc = await deps.readSubjectRecord(org, 'directory.data').catch(() => null);
      // Unreadable is not empty. Saying "no members" here would invent an answer.
      if (doc === null) return { members: [], count: 0, refused: 'the roster could not be read just now' };
    }
    // ONE PARSER (`directory-rows.ts`). This read `doc.listings`, which is `undefined` for the ARRAY the
    // DO actually writes — so it answered "0 members" for every organization whatever its roster held,
    // and zero is plausible enough for a young org that nobody questioned it.
    const published = rosterRows(doc);
    // AND THE ORG'S OWN INVITATIONS. A listing is self-published; somebody who joined by invitation and
    // never published one is a real member with no listing. The organization's `org.invite:agent:<sa>`
    // records name them, in its own vault, written when it admitted them.
    //
    // INERT TODAY, AND DELIBERATELY LEFT IN PLACE. The survey rides the organization's OWN DO grant,
    // whose per-record scope does not cover `org.invite:*` — so this finds nothing on the live estate
    // even though the records are there (verified: 123 records in Missio Nexus's vault, one of them an
    // invite, and the survey returns 122). That is per-record scope working, not failing. Reading them
    // needs the STEWARD's delegation presented, the way the Home's own reader does it — see finding
    // ORG-MEM-1. This runs the moment a caller supplies a survey that can see them, and asserts nothing
    // in the meantime.
    let invited: ReturnType<typeof invitedMemberRows> = [];
    if (deps.survey && deps.readRecords) {
      const inventory = await deps.survey(org).catch(() => []);
      const inviteKeys = inventory.map((r) => r.recordType).filter((rt) => rt.startsWith('org.invite:agent:')).slice(0, 100);
      if (inviteKeys.length) {
        const bodies = await deps.readRecords(org, inviteKeys).catch(() => ({}));
        invited = invitedMemberRows(inviteKeys, bodies);
      }
    }
    const members = mergeRoster(published, invited)
      .map((l) => ({
        agent: l.agent,
        name: l.name,
        via: l.via,
        ...(l.role ? { role: l.role } : {}),
      }))
      .filter((m) => /^0x[0-9a-f]{40}$/.test(m.agent));
    if (!members.length) {
      // AN EMPTY ROSTER IS NOT AN EMPTY ORGANIZATION, and saying "no members" here would be confidently
      // wrong: today a member appears in this record only by PUBLISHING their own signed listing, while
      // everyone who joined by invitation is recorded on the organization's side at its Home and nowhere
      // in its vault. The Home's Members panel shows the union of the two, so it can list people this read
      // cannot see. Say that, rather than reporting the half we can reach as the whole.
      return {
        org, yourStanding: standing.relation, members, count: 0,
        note: 'nobody has published a member listing in this organization\'s own records. Members who joined by invitation are held at its Home and are not in its vault yet, so the Members panel there may show people this cannot.',
      };
    }
    return { org, yourStanding: standing.relation, members, count: members.length };
  };
}
