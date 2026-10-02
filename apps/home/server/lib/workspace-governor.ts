// A WORKSPACE HOLDS NO MEMBERS — the server's half of the owner's rule (2026-10-02; `org.ttl` §2, `core.ttl`;
// the client's half is `src/lib/workspace-governor.ts`).
//
// A `<label>.workspace` Smart Agent is a SERVICE (`ap:WorkspaceAgent ⊑ ap:ServiceAgent`) that coordinates a
// workspace; membership (`aporg:OrganizationMembership`, the `org.membership:member:<sa>` record and its role
// assignment) belongs to the ORGANIZATION that governs it (`aporg:governedBy`). So the two routes that record or
// offer membership — `/connect/org-membership` and `/connect/org-invite/agent` — refuse a workspace agent as the
// target, by name, and say where the membership belongs when they can.
//
// HOW A ROUTE KNOWS, cheapest truth first and never a chain call for the question alone:
//   1. the caller's own link to the target (`related:<caller>:<target>`): kind `workspace`, or the legacy
//      `field-workspace` purpose the link store already heals into that kind — present for the inviting steward
//      and for a joining member whose link landed;
//   2. the target's typed name, reverse-resolved — `<label>.workspace` names the derived type (spec 346) — using
//      the naming read the route makes anyway for the organization's display name.
// The GOVERNOR hint comes from the link only (`governor`, written by the ceremonies and the migration, or an
// organization-class `parent`): reading the workspace's vault pointer here would be a second DO round trip on
// every join, for a hint. The runtime refuses the same write with the same code and the pointer's answer.
import type { Address } from '@agenticprimitives/types';

export const NOT_AN_ORGANIZATION = 'not_an_organization' as const;
export const NOT_AN_ORGANIZATION_HINT = 'a workspace is coordinated by a service agent; membership belongs to its governing organization';

/** The fields of a `related:<person>:<org>` link this decision reads. */
export interface LinkLike {
  kind?: string;
  purpose?: string;
  parent?: string;
  governor?: string;
}

const isAddr = (s: unknown): s is string => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);

/** Pure: does this link say its agent is a workspace? A legacy `field-workspace` purpose on a generic kind counts,
 *  exactly as the link store's own read heals it. */
export function linkSaysWorkspace(link: LinkLike | null | undefined): boolean {
  if (!link) return false;
  const kind = (link.kind ?? '').toLowerCase();
  if (kind === 'workspace') return true;
  return (kind === '' || kind === 'org') && (link.purpose ?? '').toLowerCase() === 'field-workspace';
}

/** Pure: does this primary name carry the `.workspace` suffix? The typed name is `<label>.workspace`, possibly
 *  under a context (`<label>.workspace@<ctx>`) or in dotted on-chain form (`<label>.workspace.<zone>…`). */
export function nameSaysWorkspace(name: string | null | undefined): boolean {
  if (!name) return false;
  const display = name.split('@')[0] ?? '';
  const labels = display.toLowerCase().split('.').filter(Boolean);
  return labels.length >= 2 && labels[1] === 'workspace';
}

/** Pure: the governor a link names, when it names one — the written `governor`, else a parent that is not the
 *  person. The caller decides whether to trust a bare parent; this never invents one. */
export function governorHintOf(link: LinkLike | null | undefined, person: string): Address | null {
  if (!link) return null;
  if (isAddr(link.governor)) return link.governor.toLowerCase() as Address;
  if (isAddr(link.parent) && link.parent.toLowerCase() !== person.toLowerCase()) return link.parent.toLowerCase() as Address;
  return null;
}

/** The refusal body both routes answer with. */
export function notAnOrganization(governor: Address | null): { error: typeof NOT_AN_ORGANIZATION; hint: string; governor?: Address } {
  return { error: NOT_AN_ORGANIZATION, hint: NOT_AN_ORGANIZATION_HINT, ...(governor ? { governor } : {}) };
}

/**
 * Is the target a workspace agent? Reads the caller's link from KV and, failing that, asks `reverseName` (the
 * route's own naming read). Answers `{ workspace: false }` on every miss: an agent the links do not know and the
 * naming service does not name is treated as an organization, which is today's behaviour for every organization.
 */
export async function workspaceCheck(
  kv: { get(k: string): Promise<string | null> },
  caller: string,
  target: string,
  reverseName: () => Promise<string | null>,
): Promise<{ workspace: boolean; governor: Address | null }> {
  const raw = await kv.get(`related:${caller.toLowerCase()}:${target.toLowerCase()}`);
  const link = raw ? (JSON.parse(raw) as LinkLike) : null;
  if (linkSaysWorkspace(link)) return { workspace: true, governor: governorHintOf(link, caller) };
  const name = await reverseName().catch(() => null);
  if (nameSaysWorkspace(name)) return { workspace: true, governor: governorHintOf(link, caller) };
  return { workspace: false, governor: null };
}
