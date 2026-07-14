// Cross-principal ENTITLEMENTS — client side. uupg-interop port of the GC impact home's
// entitlements-admin (spec 277). Custody ≠ access: an ORG grants a MEMBER (a different SA) scoped
// read access to the org's vault via a signed entitlement, enforced server-side. issue/list/revoke
// present the ORG's authority (its org→person stewardship delegation → the MCP recovers principal =
// the org). The member-read demo presents a MEMBER self-delegation (delegator = delegate = member,
// signed by the person who custodies it) → principal = member.
//
// Transport adaptations from impact: same-origin '/a2a' (Next rewrites ride '/a2a/mcp/*' to the
// edge), CSRF via this repo's ensureCsrfToken/csrfHeaders (same pattern as src/lib/vault-client.ts),
// and the member self-delegation is built with issueSiteDelegation + signHashFor (this home's
// credential-routed signer) instead of impact's buildUnsignedSiteDelegation/signHashForVia pair.

import type { Address } from '@agenticprimitives/types';
import { issueSiteDelegation, toWire, type DelegationWire } from './delegation';
import { signHashFor, type Via } from '../home/onboarding';
import { ensureCsrfToken, csrfHeaders } from '../csrf';

const A2A = '/a2a';

export interface IssuedEntitlement {
  id: string;
  member: Address;
  resource: string;
  recordType: string;
  validUntil: string | null;
  status: 'granted' | 'revoked' | string;
  createdAt: string;
}

async function post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  await ensureCsrfToken();
  const r = await fetch(`${A2A}/mcp/${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify(body),
  });
  return (await r.json().catch(() => ({}))) as Record<string, unknown>;
}

/** The org's authority for issuer ops — present its stewardship grant (delegator = org,
 *  delegate = the person; `requester` is that person SA). */
export interface OrgAuthority {
  stewardship: DelegationWire;
  requester: Address;
}

/** The per-alliance membership GROUP id. Being in this group is the collective-capability primitive:
 *  a group-conferred grant an alliance's members issue applies to every SA in the roster (O(members)
 *  instead of O(members²) direct grants). Domain-agnostic — a relying app maps its own meaning onto it. */
export function allianceGroupId(allianceSA: Address): string {
  return `urn:alliance:${allianceSA.toLowerCase()}`;
}

/** Add a member org SA to an alliance's membership group. The ALLIANCE owns the group — present its
 *  stewardship authority (delegator = the alliance). Mirrors issueOrgEntitlement's transport. */
export async function addToAllianceGroup(
  auth: OrgAuthority,
  allianceSA: Address,
  member: Address,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const j = await post('entitlement/group', {
    delegation: auth.stewardship,
    requester: auth.requester,
    groupId: allianceGroupId(allianceSA),
    members: [member],
    op: 'add',
  });
  if (j.ok === true) return { ok: true };
  return { ok: false, error: [j.error, j.detail].filter(Boolean).join(' — ') || 'group add failed' };
}

export async function issueOrgEntitlement(
  auth: OrgAuthority,
  grant: { member: Address; recordType: string; fields?: string[]; ttlSeconds?: number; purpose?: string },
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const j = await post('entitlement/issue', {
    delegation: auth.stewardship,
    requester: auth.requester,
    subject: grant.member,
    recordType: grant.recordType,
    ...(grant.fields && grant.fields.length ? { fields: grant.fields } : {}),
    ...(typeof grant.ttlSeconds === 'number' ? { ttlSeconds: grant.ttlSeconds } : {}),
    ...(grant.purpose ? { purpose: grant.purpose } : {}),
  });
  if (j.ok === true && typeof j.id === 'string') return { ok: true, id: j.id };
  return { ok: false, error: [j.error, j.detail].filter(Boolean).join(' — ') || 'issue failed' };
}

export async function listOrgEntitlements(auth: OrgAuthority): Promise<IssuedEntitlement[]> {
  const j = await post('entitlement/list', { delegation: auth.stewardship, requester: auth.requester });
  return Array.isArray(j.entitlements) ? (j.entitlements as IssuedEntitlement[]) : [];
}

export async function revokeOrgEntitlement(
  auth: OrgAuthority,
  id: string,
): Promise<{ ok: true; revoked: boolean } | { ok: false; error: string }> {
  const j = await post('entitlement/revoke', { delegation: auth.stewardship, requester: auth.requester, id });
  if (j.ok === true) return { ok: true, revoked: j.revoked === true };
  return { ok: false, error: [j.error, j.detail].filter(Boolean).join(' — ') || 'revoke failed' };
}

/** Read an ORG's vault record AS a member, gated by the entitlement. Only works when the connected
 *  person CUSTODIES `member` (so we can sign the member's self-delegation) — i.e. the demonstrable
 *  case where the member is one of the person's own agents. Returns the data, or a denial reason. */
export async function readOrgAsMember(opts: {
  member: Address;
  via: Via;
  token?: string | null;
  owner: Address;
  recordType: string;
  fields?: string[];
}): Promise<{ ok: true; data: unknown; allowedFields: string[] | null } | { ok: false; error: string; reason?: string }> {
  // A fresh short-lived member→member session delegation, signed by the person as the member's
  // custodian (signHashFor routes to passkey / wallet / KMS by `via`; KMS needs the session token).
  let wire: DelegationWire;
  try {
    const signHash = await signHashFor(opts.via, opts.member, opts.token ? { token: opts.token } : undefined);
    wire = toWire(await issueSiteDelegation(opts.member, opts.member, signHash, 60 * 30));
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'could not sign as the member (do you custody it?)' };
  }
  const j = await post('entitled/get', {
    delegation: wire,
    requester: opts.member,
    owner: opts.owner,
    recordType: opts.recordType,
    ...(opts.fields && opts.fields.length ? { fields: opts.fields } : {}),
  });
  if (j.ok === true) return { ok: true, data: j.data ?? null, allowedFields: (j.allowedFields as string[] | null) ?? null };
  return {
    ok: false,
    error: [j.error, j.detail].filter(Boolean).join(' — ') || 'read failed',
    reason: typeof j.reason === 'string' ? j.reason : undefined,
  };
}
