// RECIPIENT DIRECTORY — where the "To:" picker gets people from (spec 313 §2.1, W6b).
//
// Three scopes, three sources, ONE mechanism each (ADR-0013):
//   • names        — the naming-service KB (`searchAgentsKb`; empty query = list all, capped);
//   • organization — the org's directory roster (`GET /connect/directory?communityId=`), which is the
//                    SAME read Discussions/Work use. It carries every member, INCLUDING the nameless:
//                    a member with no naming-service name is still a full member whose name here is the
//                    org-local `localName` / listing `displayName` (`publicName` is null for them);
//   • workspace    — a team / app-workspace agent, read through the same directory op.
// A picked recipient is always an ADDRESS — canonical identity is the SA (ADR-0010) — so a nameless
// member is as addressable as a named one. Picking never authorizes: the send still needs the
// person's wire to cover the counterparty (one-prompt ceremony).
import { searchAgentsKb } from './agent-search';

export type RecipientScope = 'names' | 'organization' | 'workspace';

export interface PickedRecipient {
  /** Lowercase 0x address — what the send is addressed to. */
  address: string;
  /** What the picker showed; the DM header uses the reverse-resolved name once the view lands. */
  title: string;
  /** Secondary line — the naming-service name, a role, or the short address. */
  subtitle?: string;
  /** Naming-service name when the recipient has one (so a caller may address by name if it prefers). */
  name?: string;
  scope: RecipientScope;
}

export interface RosterMember {
  address: string;
  /** How the member is known HERE: org-local chosen name → listing displayName. Never empty. */
  displayName: string;
  /** Their CURRENT naming-service name — null for the nameless. */
  publicName: string | null;
  role?: string;
  /** Household membership (spec 368): how this member is related to the founder — `aphh:kinRelation`. */
  kin?: string;
}

/** The directory response shape the Home proxies from the org's InteractionsDO `directory.list`. */
export interface DirectoryResponse {
  ok?: boolean;
  error?: string;
  listings?: Array<{
    listing?: { subject?: string; displayName?: string; localName?: string; publicName?: string | null; orgRole?: string };
    label?: string;
  }>;
}

const ADDR_RE = /0x[0-9a-fA-F]{40}$/;

/** Pure: roster rows from a directory response. Nameless members are kept; rows without a subject
 *  address are dropped (there is nothing to address). Sorted by display name, case-insensitive. */
export function rosterFromDirectoryResponse(body: DirectoryResponse): RosterMember[] {
  const out: RosterMember[] = [];
  const seen = new Set<string>();
  for (const row of body.listings ?? []) {
    const l = row.listing;
    const address = l?.subject?.match(ADDR_RE)?.[0]?.toLowerCase();
    if (!address || seen.has(address)) continue;
    seen.add(address);
    const displayName = (l?.localName?.trim() || l?.displayName?.trim() || row.label?.trim() || '').trim();
    out.push({
      address,
      displayName: displayName || `${address.slice(0, 6)}…${address.slice(-4)}`,
      publicName: l?.publicName?.trim() || null,
      ...(l?.orgRole ? { role: l.orgRole } : {}),
    });
  }
  return out.sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }));
}

/** The steward-side members index (`/connect/received-delegations`, spec 321/247): the members who
 *  redeemed an invite and delegated to the org, with the display name they chose at join. Keyed by
 *  the ORG they joined (`viaOrg`); the member's own SA is — confusingly — `orgAgent`. */
export interface ReceivedMembersResponse {
  received?: Array<{ viaOrg?: string; orgAgent?: string; displayName?: string; orgName?: string; kin?: string; role?: string }>;
}

/** Pure: the members of `org` from the received-delegations index. Empty for an org the person does
 *  not steward — the index is steward-readable, and "not yours to read" is an answer, not an error. */
export function membersFromReceivedDelegations(body: ReceivedMembersResponse, org: string): RosterMember[] {
  const target = org.toLowerCase();
  const out: RosterMember[] = [];
  for (const r of body.received ?? []) {
    if ((r.viaOrg ?? '').toLowerCase() !== target) continue;
    const address = r.orgAgent?.match(ADDR_RE)?.[0]?.toLowerCase();
    if (!address) continue;
    // ONLY the display name the member chose at join names them. The row's `orgName` is unreliable
    // for a person: it holds the member's name when they had one and the ORG's name when they did
    // not, and a roster that labels a member with the organization's name is wrong, not helpful.
    // With no chosen name the address is the honest label; the DM header resolves a naming-service
    // name once the thread opens.
    const displayName = r.displayName?.trim() || `${address.slice(0, 6)}…${address.slice(-4)}`;
    out.push({ address, displayName, publicName: null, ...(r.role ? { role: r.role } : {}), ...(r.kin ? { kin: r.kin } : {}) });
  }
  return out;
}

/** Pure: one roster from both projections of membership. A directory listing is the member's OWN
 *  self-signed row (richer: local/public name, role) and wins; the received-delegations index adds
 *  the members who joined by invite but never published a listing. This is a UNION of two views of
 *  the same fact, not a fallback chain (ADR-0013): both are always read. */
export function mergeRosters(listings: readonly RosterMember[], received: readonly RosterMember[]): RosterMember[] {
  const byAddr = new Map<string, RosterMember>();
  for (const m of received) byAddr.set(m.address, m);
  for (const m of listings) byAddr.set(m.address, { ...(byAddr.get(m.address) ?? {}), ...m });
  return [...byAddr.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }));
}

/**
 * Read an organization's / workspace's roster: the community directory (every member who published a
 * listing — readable by any member) UNIONED with the steward's members index (invite-redeemed members,
 * readable when the person stewards the org). A directory refusal (403 = not a member) is thrown and
 * named by the picker; it is never papered over by the other source.
 */
export async function fetchRoster(token: string, community: string): Promise<RosterMember[]> {
  const headers = { authorization: `Bearer ${token}` };
  const [dirRes, recRes] = await Promise.all([
    fetch(`/connect/directory?communityId=${encodeURIComponent(community.toLowerCase())}`, { headers }),
    fetch('/connect/received-delegations', { headers }),
  ]);
  const dir = (await dirRes.json().catch(() => ({}))) as DirectoryResponse;
  if (!dirRes.ok || dir.ok === false) throw new Error(dir.error ?? `roster read failed (${dirRes.status})`);
  const rec = recRes.ok ? ((await recRes.json().catch(() => ({}))) as ReceivedMembersResponse) : {};
  return mergeRosters(rosterFromDirectoryResponse(dir), membersFromReceivedDelegations(rec, community));
}

/** Named agents from the naming-service KB. Empty query lists everyone indexed (capped). */
export async function listNamedAgents(q: string, limit = 100): Promise<PickedRecipient[]> {
  const hits = await searchAgentsKb(q.trim().toLowerCase(), limit);
  return hits
    .filter((h) => ADDR_RE.test(h.smartAgent))
    .map((h) => ({
      address: h.smartAgent.toLowerCase(),
      title: h.displayName ?? h.name,
      subtitle: h.name,
      name: h.name,
      scope: 'names' as const,
    }))
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
}

/** Case-insensitive "as you type" filter over title / subtitle / address. */
export function filterRecipients<T extends { title: string; subtitle?: string; address: string }>(rows: readonly T[], q: string): T[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter((r) => r.title.toLowerCase().includes(needle) || (r.subtitle ?? '').toLowerCase().includes(needle) || r.address.includes(needle));
}
