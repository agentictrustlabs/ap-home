// GET /connect/org-membership/mine?org=<sa> — spec 427 §5.3 (the member, for themselves).
//
// WHAT THIS ORGANIZATION RECORDS OF ME: my membership, the role on it, and the offer that role came from (its
// name, its description, the skill packs it offers my agent). A person cannot read an organization's vault and does
// not need to — the organization's own object answers for ITS record of the session's subject, deriving the key
// from the session and never from the request, so "my membership" cannot become "anybody's".
//
// It is how a person's Home knows which role packs their playbook SHOULD hold: one read per organization they
// belong to. An ended membership is answered as ended (its pack is dropped), and a workspace — which holds no
// members — answers with the organization that governs it.
import type { FnContext } from '../_lib/server-broker';
import { getServer, ownIssuer } from '../_lib/server-broker';
import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import { callInteractions } from './channels';

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization' };
const json = (b: unknown, s = 200): Response =>
  new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', ...cors } });

export const onRequestOptions = async (): Promise<Response> => new Response(null, { status: 204, headers: cors });

const isAddress = (s: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(s);

/** One organization's answer about the session's subject. Exported for the reconcile that asks several. */
export async function myMembershipAt(env: FnContext['env'], org: string, token: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const first = await callInteractions(env, org, 'org.membership.mine', { session: token });
  const governedBy = String((first.body as { governedBy?: unknown }).governedBy ?? '').toLowerCase();
  // A workspace names its governor; the membership is THERE. One hop, never a chain of them.
  if (first.status === 200 && !(first.body as { membership?: unknown }).membership && isAddress(governedBy) && governedBy !== org) {
    const second = await callInteractions(env, governedBy, 'org.membership.mine', { session: token });
    return { status: second.status, body: { ...(second.body as Record<string, unknown>), askedOf: org, governedBy } };
  }
  return { status: first.status, body: first.body as Record<string, unknown> };
}

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return json({ error: 'session required' }, 401);
  const org = (new URL(request.url).searchParams.get('org') ?? '').toLowerCase();
  if (!isAddress(org)) return json({ error: 'org (SA) required' }, 400);
  const { jwks } = await getServer(env);
  const v = await verifyAgentSession(token, { keys: await importJwks(jwks), expectedAud: env.DEMO_SSO_AUD ?? 'demo-sso', expectedIss: ownIssuer(request, env) });
  if (!v.ok) return json({ error: 'invalid session' }, 401);
  const r = await myMembershipAt(env, org, token);
  if (r.status !== 200) return json({ error: String(r.body.error ?? `membership read failed (${r.status})`) }, r.status === 409 ? 409 : 502);
  return json(r.body);
};
