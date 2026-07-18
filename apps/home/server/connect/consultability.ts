// /connect/consultability — the member's per-org consult opt-in (spec 329 §2.1/§7).
//
// The AUTHORITY is the member-signed consultability delegation (member → org, allowedTargets =
// [member], allowedMethods = [discussion.consult selector], 180-day timestamp; spec 321's third,
// member-signed leg). This route keeps ONLY session extraction + pass-through + the member's own
// link-record projection — the ORG's InteractionsDO (the spec-322 execution point) owns the
// grant-shape verification, the ERC-1271/unrevoked checks, the custody (`org.consult-grant:<member>`),
// and the audit; the MEMBER's A2A gate re-verifies the delegation per consult message. The
// listing's `consultable` flag (the routing HINT) is published separately by the client through
// /connect/directory — flag without delegation stays inert (fail-closed).
//
//   GET                                    → { ok, orgs: [{ orgAgent, orgName, relationship,
//                                             consultable, consultGrantedAt, consultDelegation }] }
//   POST { action:'grant', org, delegation } → { ok, grantedAt }
//   POST { action:'revoke', org }            → { ok, consultDelegation } (returned so the CLIENT
//                                              revokes it ON-CHAIN — the org-member-remove pattern)
import { getServer, ownIssuer, type FnContext } from '../_lib/server-broker';
import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import { isAllowedClientOrigin } from '../../src/lib/oidc-clients';
import type { DelegationWire } from '../../src/lib/delegation';
import { callInteractions } from './channels';

function cors(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  return origin && isAllowedClientOrigin(origin)
    ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization, content-type', vary: 'Origin' }
    : {};
}
const jsonCors = (body: unknown, request: Request, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors(request) } });

export const onRequestOptions = async ({ request }: FnContext): Promise<Response> =>
  new Response(null, { status: 204, headers: cors(request) });

async function personFrom(request: Request, env: FnContext['env']): Promise<{ person: string; token: string } | null> {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  const { jwks } = await getServer(env);
  const keys = await importJwks(jwks);
  const v = await verifyAgentSession(token, { keys, expectedAud: env.DEMO_SSO_AUD ?? 'demo-sso', expectedIss: ownIssuer(request, env) });
  if (!v.ok) return null;
  const person = (v.session.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase();
  return person ? { person, token } : null;
}

interface ConsultLinkFields {
  consultDelegation?: DelegationWire;
  consultGrantedAt?: string;
}

/** The member's org links, decorated with their consult opt-in state ("orgs you belong to" —
 *  the SAME `related-idx`/`related:*` projection related-orgs serves; no new discovery). */
export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const who = await personFrom(request, env);
  if (!who) return jsonCors({ error: 'home session required' }, request, 401);
  const idx = JSON.parse((await env.AUTH_CODES.get(`related-idx:${who.person}`)) ?? '[]') as string[];
  const orgs: Array<Record<string, unknown>> = [];
  for (const org of idx) {
    const raw = await env.AUTH_CODES.get(`related:${who.person}:${org.toLowerCase()}`);
    if (!raw) continue;
    const link = JSON.parse(raw) as ConsultLinkFields & { orgAgent?: string; orgName?: string; relationship?: string; kind?: string };
    // Consultability is about ORG memberships — skip non-org tree nodes (treasuries etc.).
    if (link.kind && link.kind !== 'org') continue;
    orgs.push({
      orgAgent: (link.orgAgent ?? org).toLowerCase(),
      orgName: link.orgName ?? org,
      relationship: link.relationship ?? 'steward',
      consultable: !!link.consultDelegation,
      consultGrantedAt: link.consultGrantedAt ?? null,
      // The member's OWN copy (spec 329 §2.1 — kept for display/revocation; on-chain revoke needs it).
      consultDelegation: link.consultDelegation ?? null,
    });
  }
  return jsonCors({ ok: true, orgs }, request);
};

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const who = await personFrom(request, env);
  if (!who) return jsonCors({ error: 'home session required' }, request, 401);
  const body = (await request.json().catch(() => null)) as
    | { action?: string; org?: string; delegation?: DelegationWire }
    | null;
  const org = (body?.org ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(org)) return jsonCors({ error: 'org (SA address) required' }, request, 400);
  const linkKey = `related:${who.person}:${org}`;

  if (body?.action === 'grant') {
    const d = body.delegation;
    if (!d?.delegator || !d?.delegate || !d?.signature) return jsonCors({ error: 'signed consultability delegation required' }, request, 400);
    // The member consents for THEMSELVES, to THIS org — anything else is rejected, never fixed up.
    if (d.delegator.toLowerCase() !== who.person) return jsonCors({ error: 'delegation delegator must be your person agent' }, request, 403);
    if (d.delegate.toLowerCase() !== org) return jsonCors({ error: 'delegation delegate must be the organization' }, request, 403);
    // The org's DO verifies shape + signature + unrevoked and custodies the wire (the authority
    // store W2's find_members eligibility reads). Fail-closed pass-through.
    const r = await callInteractions(env, org, 'consult.grantPut', { session: who.token, delegation: d });
    if (r.status !== 200) return jsonCors(r.body, request, r.status);
    // Member-side projection: their own copy on the related link (display/revocation).
    const grantedAt = String((r.body as { grantedAt?: string }).grantedAt ?? new Date().toISOString());
    const existing = await env.AUTH_CODES.get(linkKey);
    if (existing) {
      const link = JSON.parse(existing) as Record<string, unknown>;
      await env.AUTH_CODES.put(linkKey, JSON.stringify({ ...link, consultDelegation: d, consultGrantedAt: grantedAt }));
    }
    return jsonCors({ ok: true, grantedAt }, request);
  }

  if (body?.action === 'revoke') {
    // Org-side eligibility kill first (immediate — routing loses this member NOW); then clear the
    // member's projection. The wire is RETURNED so the client revokes it ON-CHAIN (the authority
    // kill at the member's own gate — org-member-remove's client-revoke pattern).
    const r = await callInteractions(env, org, 'consult.grantRevoke', { session: who.token });
    if (r.status !== 200) return jsonCors(r.body, request, r.status);
    const existing = await env.AUTH_CODES.get(linkKey);
    let wire: DelegationWire | null = null;
    if (existing) {
      const link = JSON.parse(existing) as Record<string, unknown> & ConsultLinkFields;
      wire = link.consultDelegation ?? null;
      delete link.consultDelegation;
      delete link.consultGrantedAt;
      await env.AUTH_CODES.put(linkKey, JSON.stringify(link));
    }
    return jsonCors({ ok: true, consultDelegation: wire }, request);
  }

  return jsonCors({ error: 'unknown action' }, request, 400);
};
