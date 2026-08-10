// Organization lifecycle status (spec 342) — active | inactive | deleted.
//
// TWO TIERS, and the split matters (ADR-0055):
//   • THE RECORD is `org.lifecycle` in the ORG's own vault, written over the stewardship delegation.
//     It is a fact about the organization, so it lives with the organization.
//   • THE PROJECTION is `status` on the person's related-org link, so a roster can be filtered
//     without one vault read per row.
//
// The status decides what surfaces SHOW. It is not authority: deactivating or deleting an org
// revokes no delegation, disables no agent, and destroys no vault record (spec 342 §1).
import type { Address } from '@agenticprimitives/types';

export type OrgLifecycleStatus = 'active' | 'inactive' | 'deleted';

/** The org's own vault record — the authoritative one. */
export const RT_ORG_LIFECYCLE = 'org.lifecycle';

export interface OrgLifecycleRecordV1 {
  v: 1;
  status: OrgLifecycleStatus;
  /** ISO-8601. Without it a tombstone can't be told from a decision taken years ago. */
  changedAt: string;
  /** The steward who decided. Attribution, not authorization. */
  changedBy?: Address;
  reason?: string;
}

const STATUSES: readonly string[] = ['active', 'inactive', 'deleted'];

/**
 * Read a status off anything that may carry one.
 *
 * ABSENT MEANS ACTIVE — an org nobody ever deactivated has no decision to record. Same default as
 * the `at:organizationLifecycleStatus` ontology term. An unrecognised value also reads as active:
 * a projection that has drifted must not be able to hide an organization by accident.
 */
export function orgStatusOf(x: { status?: string | null } | null | undefined): OrgLifecycleStatus {
  const s = x?.status;
  return typeof s === 'string' && STATUSES.includes(s) ? (s as OrgLifecycleStatus) : 'active';
}

/**
 * Which set of statuses a surface is allowed to render.
 *   working — the default everywhere: only active.
 *   roster  — the organizations list: active + inactive, so an inactive org can be reactivated.
 *   any     — a workspace addressed by SA, and the Settings section itself.
 */
export type OrgSurface = 'working' | 'roster' | 'any';

export function isVisibleOn(status: OrgLifecycleStatus, surface: OrgSurface): boolean {
  if (surface === 'any') return true;
  if (status === 'deleted') return false;
  return surface === 'roster' || status === 'active';
}

/** True when this org should be hidden from the ordinary working surfaces. */
export const isHiddenOrg = (x: { status?: string | null }): boolean => !isVisibleOn(orgStatusOf(x), 'working');

export const STATUS_LABEL: Record<OrgLifecycleStatus, string> = {
  active: 'Active',
  inactive: 'Inactive',
  deleted: 'Deleted',
};

/**
 * Filter a list of agent-tree rows for a surface.
 *
 * CASCADES TO CHILDREN: an agent whose `parent` is a hidden org is hidden too. Without this a
 * deleted org walks back onto the treasuries page as the parent label of its own treasury.
 */
export function filterByLifecycle<T extends { agent: string; parent?: string; status?: string | null }>(
  rows: readonly T[],
  surface: OrgSurface,
): T[] {
  if (surface === 'any') return [...rows];
  const hidden = new Set(
    rows.filter((r) => !isVisibleOn(orgStatusOf(r), surface)).map((r) => r.agent.toLowerCase()),
  );
  return rows.filter(
    (r) => !hidden.has(r.agent.toLowerCase()) && !(r.parent && hidden.has(r.parent.toLowerCase())),
  );
}

/** The same filter over the `MyOrg` shape, whose address field is `orgAgent`. */
export function filterMyOrgsByLifecycle<T extends { orgAgent: string; status?: string | null }>(
  rows: readonly T[],
  surface: OrgSurface,
): T[] {
  if (surface === 'any') return [...rows];
  return rows.filter((r) => isVisibleOn(orgStatusOf(r), surface));
}
