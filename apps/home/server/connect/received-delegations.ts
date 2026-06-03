// GET /connect/received-delegations  (spec 247)
//
// Person-session-authorized: the person presents their session id_token (Bearer,
// or ?id_token=). We resolve the person SA from `sub`, look up the orgs they
// govern (the related vault, spec 246), and return — for each — the orgs that
// delegated scoped access TO it (the inbound grants their orgs received). This is
// the person-home view of /connect/delegated-orgs: control of the org is
// established by the person↔org link in the vault, so no per-org ERC-1271
// challenge is needed. No person identity of the grantors is exposed (ADR-0025) —
// only org↔org grants.
import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import { getServer, resolveOrigin, type FnContext } from '../_lib/server-broker';
import { isAllowedClientOrigin } from '../../src/lib/oidc-clients';

function cors(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  return origin && isAllowedClientOrigin(origin)
    ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization, content-type', vary: 'Origin' }
    : {};
}
function jsonCors(body: unknown, request: Request, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors(request) } });
}

export const onRequestOptions = async ({ request }: FnContext): Promise<Response> =>
  new Response(null, { status: 204, headers: cors(request) });

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const url = new URL(request.url);
  const clientId = url.searchParams.get('client_id');
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : url.searchParams.get('id_token') ?? '';
  if (!token) return jsonCors({ error: 'id_token required' }, request, 400);

  const iss = resolveOrigin(request, env);
  const homeAud = env.DEMO_SSO_AUD ?? 'demo-sso';
  const { jwks } = await getServer(env);
  const keys = await importJwks(jwks);
  const v = await verifyAgentSession(token, { keys, expectedAud: clientId ?? homeAud, expectedIss: iss });
  if (!v.ok) return jsonCors({ error: `invalid session token: ${v.reason}` }, request, 401);

  const person = (v.session.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase();
  if (!person) return jsonCors({ error: 'no person address in token sub' }, request, 401);

  // The orgs the person governs (from the related vault) → their inbound grants.
  const orgIdx = JSON.parse((await env.AUTH_CODES.get(`related-idx:${person}`)) ?? '[]') as string[];
  const received: Array<Record<string, unknown>> = [];
  for (const org of orgIdx) {
    const linkRaw = await env.AUTH_CODES.get(`related:${person}:${org}`);
    const orgName = linkRaw ? (JSON.parse(linkRaw) as { orgName?: string }).orgName ?? '' : '';
    const grants = JSON.parse((await env.AUTH_CODES.get(`delegated-idx:${org}`)) ?? '[]') as Array<Record<string, unknown>>;
    for (const g of grants) received.push({ viaOrg: org, viaOrgName: orgName, ...g });
  }
  return jsonCors({ received }, request);
};
