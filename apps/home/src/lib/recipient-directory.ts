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

/** Read an organization's / workspace's roster. Throws on refusal (403 = not a member of it) — the
 *  picker names the refusal; it does not fall back to a different source. */
export async function fetchRoster(token: string, community: string): Promise<RosterMember[]> {
  const res = await fetch(`/connect/directory?communityId=${encodeURIComponent(community.toLowerCase())}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await res.json().catch(() => ({}))) as DirectoryResponse;
  if (!res.ok || body.ok === false) throw new Error(body.error ?? `roster read failed (${res.status})`);
  return rosterFromDirectoryResponse(body);
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
