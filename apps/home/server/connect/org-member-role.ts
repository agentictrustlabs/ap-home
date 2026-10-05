// POST /connect/org-member-role { org, member, orgRole | null } — spec 427 §3.3 (steward-gated).
//
// A STEWARD CHANGES WHAT A MEMBER DOES HERE. The role is a record on the membership, in the organization's own
// vault; changing it replaces the role fields and keeps the delegation that materializes the membership. `orgRole:
// null` puts the member back to the plain role.
//
// WHAT THIS DOES NOT DO, and must not: it signs nothing, issues or revokes no access (the role's access role is
// issued by its own ceremony — spec 343), and it does not touch the member's playbook. An organization cannot
// write a person's playbook (spec 427 invariant 2); the member's own Home offers them the new role's pack and
// drops the old one, when THEY open it. The role authorizes nothing: no gate anywhere reads it.
//
// The organization's object decides: the caller must hold its stewardship wire (re-verified there against the
// chain), and the offer must be ids and words only. This route finds the wire, forwards, and then corrects the
// steward's roster projection (`delegated-idx:<org>`) so the Members page shows the role without a second read.
import type { FnContext } from '../_lib/server-broker';
import { getServer, ownIssuer } from '../_lib/server-broker';
import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import { callInteractions, stewardWireFor } from './channels';
import { parseRoleOffer, type RoleOfferV1 } from '../lib/org-role';

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization' };
const json = (b: unknown, s = 200): Response =>
  new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', ...cors } });

export const onRequestOptions = async (): Promise<Response> => new Response(null, { status: 204, headers: cors });

const isAddress = (s: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(s);

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return json({ error: 'session required' }, 401);
  const body = (await request.json().catch(() => null)) as { org?: string; member?: string; orgRole?: unknown } | null;
  const org = (body?.org ?? '').toLowerCase();
  const member = (body?.member ?? '').toLowerCase();
  if (!isAddress(org) || !isAddress(member)) return json({ error: 'org + member (SAs) required' }, 400);
  let orgRole: RoleOfferV1 | null = null;
  if (body?.orgRole !== undefined && body.orgRole !== null) {
    const parsed = parseRoleOffer(body.orgRole);
    if (!parsed.ok) return json({ error: parsed.error, code: 'invalid_role_offer' }, 400);
    orgRole = parsed.offer;
  }
  const { jwks } = await getServer(env);
  const v = await verifyAgentSession(token, { keys: await importJwks(jwks), expectedAud: env.DEMO_SSO_AUD ?? 'demo-sso', expectedIss: ownIssuer(request, env) });
  if (!v.ok) return json({ error: 'invalid session' }, 401);
  const caller = (v.session.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase();
  if (!caller) return json({ error: 'no person address in token sub' }, 401);

  // FIND the wire; the organization's object VERIFIES it (org-signed, unrevoked, stewardship-shaped) and refuses
  // without it. A missing wire is answered here, in words, rather than as the object's bare 403.
  const stewardship = await stewardWireFor(env, caller, org, token);
  if (!stewardship) return json({ error: 'you must steward this organization to set a member’s role' }, 403);
  const r = await callInteractions(env, org, 'org.setMemberRole', { session: token, member, orgRole, stewardship });
  if (r.status !== 200) {
    const b = r.body as { error?: unknown; code?: unknown };
    return json({ error: String(b.error ?? `the role was not set (${r.status})`), ...(typeof b.code === 'string' ? { code: b.code } : {}) }, r.status === 403 || r.status === 404 || r.status === 409 || r.status === 400 ? r.status : 502);
  }
  const out = r.body as { role?: string; roleName?: string; previous?: string; changed?: boolean };

  // The steward's roster projection follows the record — best-effort: the record is the fact.
  let projected = false;
  try {
    const dKey = `delegated-idx:${org}`;
    const rows = JSON.parse((await env.AUTH_CODES.get(dKey)) ?? '[]') as Array<Record<string, unknown>>;
    const row = rows.find((x) => String(x.orgAgent ?? '').toLowerCase() === member);
    if (row) {
      if (orgRole && out.role && out.role !== 'member') row.orgRole = { assignedRole: out.role, roleName: orgRole.name, roleDefinitionId: orgRole.roleDefinitionId };
      else delete row.orgRole;
      await env.AUTH_CODES.put(dKey, JSON.stringify(rows));
      projected = true;
    }
  } catch { /* the Members page reads the role again on its next load */ }

  return json({ ok: true, member, role: out.role ?? 'member', ...(out.roleName ? { roleName: out.roleName } : {}), previous: out.previous ?? 'member', changed: out.changed !== false, projected });
};
