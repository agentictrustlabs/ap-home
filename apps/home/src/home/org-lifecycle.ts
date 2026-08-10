// spec 342 — reading and writing an organization's lifecycle status from the Home.
//
// ORDER IS THE POINT. The RECORD is `org.lifecycle` in the ORG's vault, written over the
// stewardship delegation; the `status` on the person's related-org link is a PROJECTION that exists
// only so a roster can be filtered without a vault read per row (ADR-0055). So:
//
//   1. write the record — if this fails, nothing happened, and nothing is projected;
//   2. then project — if THIS fails, the decision still stands and we say so plainly rather than
//      reporting a failure that would invite the steward to click again.
//
// Never the reverse: a projection written first would hide an organization whose vault never
// recorded the decision, and the next reconcile would bring it back with no explanation.
import type { Address } from '@agenticprimitives/types';
import type { DelegationWire } from '../lib/delegation';
import { vaultReadWithDelegation, vaultWriteWithDelegation } from '../lib/vault-client';
import {
  RT_ORG_LIFECYCLE,
  orgStatusOf,
  type OrgLifecycleRecordV1,
  type OrgLifecycleStatus,
} from '../lib/org-lifecycle';

/** The org's authoritative lifecycle record, or null when it has never been set (= active). */
export async function readOrgLifecycle(stewardship: DelegationWire): Promise<OrgLifecycleRecordV1 | null> {
  const r = await vaultReadWithDelegation<OrgLifecycleRecordV1>(stewardship, RT_ORG_LIFECYCLE);
  if (!r) return null;
  return { ...r, v: 1, status: orgStatusOf(r) };
}

/** Write ONLY the projection (the person's related-org link). Used by the record→projection
 *  reconcile, and as step 2 of a status change. */
export async function projectOrgStatus(input: {
  person: Address;
  org: Address;
  token: string;
  status: OrgLifecycleStatus;
}): Promise<boolean> {
  const r = await fetch('/connect/related-orgs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${input.token}` },
    body: JSON.stringify({ person: input.person, orgAgent: input.org, status: input.status }),
  }).catch(() => null);
  return Boolean(r?.ok);
}

export type SetStatusResult =
  | { ok: true; record: OrgLifecycleRecordV1; projected: boolean }
  | { ok: false; error: string };

/**
 * Record a steward's lifecycle decision about an organization.
 *
 * The authority is the stewardship delegation itself — the vault verifies it and refuses a write
 * nobody may make. There is no separate permission flag to check here, and adding one would create
 * a second enforcement point that could disagree with the first.
 */
export async function setOrgLifecycleStatus(input: {
  person: Address;
  org: Address;
  token: string;
  stewardship: DelegationWire;
  status: OrgLifecycleStatus;
  reason?: string;
}): Promise<SetStatusResult> {
  const record: OrgLifecycleRecordV1 = {
    v: 1,
    status: input.status,
    changedAt: new Date().toISOString(),
    changedBy: input.person,
    ...(input.reason?.trim() ? { reason: input.reason.trim().slice(0, 500) } : {}),
  };
  try {
    await vaultWriteWithDelegation(input.stewardship, RT_ORG_LIFECYCLE, record);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'could not write the organization’s vault' };
  }
  const projected = await projectOrgStatus({ person: input.person, org: input.org, token: input.token, status: input.status });
  return { ok: true, record, projected };
}
