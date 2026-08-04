// The steward's view of an organization's join queue — read and written AT THE ORG'S AGENT
// (spec 341 §5.3).
//
// WHAT THIS REPLACES. `/connect/org-applications` (read) and the queue cleanup inside
// `/connect/org-decide` (write) both reached the org's InteractionsDO over the shared-secret bridge.
// The secret proves the caller is our Home. It proves nothing about whether the person behind the
// request may act for this organization — that was a separate `controlsOrg` check against a Home-local
// KV projection, which is a different fact in a different place from the authority itself.
//
// Now one artifact answers both: the org's stewardship delegation, verified at the agent (delegator is
// the org, delegate is the caller, stewardship SHAPE not merely member access per SEC-C1, ERC-1271-live
// and unrevoked on-chain). Revoking it stops the steward everywhere at once, which a KV projection
// could not do.
//
// READING THE QUEUE CONFERS NOTHING (ADR-0041). An application is a request; approving it is a separate
// act, and even approval creates no membership — the member writes their own on join (ADR-0048).

import type { Address } from '@agenticprimitives/types';
import { ensureCsrfToken, csrfHeaders } from '../csrf';
import { SESSION_KEY } from '../context/session';
import { readSsoCookie } from './sso-cookie';

export interface OrgApplication {
  applicationId: string;
  applicant: string;
  message: string;
  submittedAt: string;
}

function homeBearer(): string {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    const t = raw ? (JSON.parse(raw) as { token?: string }).token : undefined;
    if (t) return t;
  } catch { /* fall through */ }
  return readSsoCookie()?.token ?? '';
}

async function orgOp<T>(org: Address, op: string, payload: Record<string, unknown>): Promise<T> {
  await ensureCsrfToken();
  const session = homeBearer();
  if (!session) throw new Error('no home session');
  const res = await fetch(`/a2a/interactions/${org.toLowerCase()}/${op}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify({ session, ...payload }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  // 409 means the org's interactions plane is not enabled — a provisioning state, not a denial, and
  // the steward's queue is legitimately empty until it is.
  if (res.status === 409) return { doc: null } as T;
  if (!res.ok || body.ok === false) throw new Error(String(body.error ?? `${op} failed (${res.status})`));
  return body as T;
}

/** The org's pending join requests. Empty (not an error) when the plane is unprovisioned. */
export async function readOrgApplications(org: Address, stewardship: unknown): Promise<OrgApplication[]> {
  const r = await orgOp<{ doc?: { applications?: OrgApplication[] } | null }>(org, 'applications.get', { stewardship });
  return r.doc?.applications ?? [];
}

/**
 * Remove one applicant from the queue after a decision.
 *
 * READ-MODIFY-WRITE of a whole doc, so it is done HERE rather than passed a diff: the caller has just
 * decided, and a stale list would silently resurrect an application the steward already handled. The
 * filter is by APPLICANT, not by applicationId — one entry per applicant is the invariant the submit
 * side maintains, and re-applying updates in place.
 */
export async function dropOrgApplication(org: Address, stewardship: unknown, applicant: string): Promise<void> {
  const applications = await readOrgApplications(org, stewardship);
  const next = applications.filter((a) => a.applicant.toLowerCase() !== applicant.toLowerCase());
  if (next.length === applications.length) return; // already gone — no write, no audit noise
  await orgOp(org, 'applications.put', { stewardship, doc: { applications: next } });
}
