// POST /connect/org-member-remove { org, member } — spec 321 W3 (steward-gated).
//
// Remove a member from the org: their directory listing (channel membership, spec 318), their
// authority-only member link (never a steward link), their entry in the org's inbound-grant index,
// and the stored/pending member-access grant. Returns the member-access delegation that was on
// record (if any) so the CLIENT can revoke it ON-CHAIN as the org (revokeDelegationByOwner — the
// server never signs; custody stays with the steward's credential). The member→org membership
// delegation is the MEMBER's to revoke on-chain; dropping it from delegated-idx stops the org
// exercising it (and it no longer appears anywhere).
import type { FnContext } from '../_lib/server-broker';
import { orgVault } from '../lib/org-vault';
import { controlsOrg } from './org-invite';
import { callInteractions, stewardWireFor } from './channels';
import { removeOrgMemberLink } from './membership';

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization' };
const json = (b: unknown, s = 200): Response =>
  new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', ...cors } });

export const onRequestOptions = async (): Promise<Response> => new Response(null, { status: 204, headers: cors });

const isAddress = (s: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(s);

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const body = (await request.json().catch(() => null)) as { org?: string; member?: string } | null;
  const org = (body?.org ?? '').toLowerCase();
  const member = (body?.member ?? '').toLowerCase();
  if (!isAddress(org) || !isAddress(member)) return json({ error: 'org + member (SAs) required' }, 400);
  if (!(await controlsOrg(env, request, org))) return json({ error: 'you must steward this organization to remove members' }, 403);

  // 1. Directory listing (channel membership) — steward removal through the community's
  //    InteractionsDO (spec 322 W2.3b: listings live in the org vault's directory.data; the DO
  //    tombstones the subject so a replayed listing cannot re-enter). Requires the caller's
  //    stewardship wire + session token.
  const auth = request.headers.get('authorization') ?? '';
  const callerToken = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const { getServer: gs, ownIssuer: oi } = await import('../_lib/server-broker');
  const { importJwks: ij, verifyAgentSession: vas } = await import('@agenticprimitives/connect');
  const { jwks } = await gs(env);
  const vv = await vas(callerToken, { keys: await ij(jwks), expectedAud: env.DEMO_SSO_AUD ?? 'demo-sso', expectedIss: oi(request, env) });
  const caller = vv.ok ? ((vv.session.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase()) : '';
  if (caller) {
    const stewardship = await stewardWireFor(env, caller, org);
    const r = await callInteractions(env, org, 'directory.remove', {
      session: callerToken, subject: member, ...(stewardship ? { stewardship } : {}),
    });
    if (r.status !== 200 && r.status !== 409) {
      return json({ error: `listing removal failed: ${String(r.body.error ?? r.status)}` }, 502);
    }
  }

  // 2. The authority-only member link (projection) — never a steward link (removeOrgMemberLink guards).
  await removeOrgMemberLink(env, member, org);

  // 3. The org's inbound-grant index (the Members panel source).
  const dKey = `delegated-idx:${org}`;
  const dIdx = JSON.parse((await env.AUTH_CODES.get(dKey)) ?? '[]') as Array<{ orgAgent: string }>;
  await env.AUTH_CODES.put(dKey, JSON.stringify(dIdx.filter((x) => x.orgAgent.toLowerCase() !== member)));

  // 4. The stored member-access grant (org vault) — tombstone + hand it back for on-chain revocation.
  let memberAccessDelegation: unknown = null;
  try {
    const vault = await orgVault(env, org);
    if (vault) {
      const key = `org.invite:agent:${member}`;
      const rec = (await vault.get(key)) as { delegation?: unknown; status?: string } | null;
      if (rec?.delegation && rec.status !== 'removed') memberAccessDelegation = rec.delegation;
      if (rec) await vault.set(key, { ...rec, status: 'removed', removedAt: Date.now() });
    }
  } catch { /* vault unreachable — the app-level removal above already stands */ }
  // Also surface a grant recorded only on the member link (email-path invites store it there).
  if (!memberAccessDelegation) {
    const linkRaw = await env.AUTH_CODES.get(`related:${member}:${org}`);
    const link = linkRaw ? (JSON.parse(linkRaw) as { memberAccessDelegation?: unknown }) : null;
    memberAccessDelegation = link?.memberAccessDelegation ?? null;
  }

  return json({ ok: true, memberAccessDelegation });
};
