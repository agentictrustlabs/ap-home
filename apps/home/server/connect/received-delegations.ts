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
import { getServer, resolveOrigin, ownIssuer, type FnContext } from '../_lib/server-broker';
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
  const v = await verifyAgentSession(token, { keys, expectedAud: clientId ?? homeAud, expectedIss: ownIssuer(request, env) });
  if (!v.ok) return jsonCors({ error: `invalid session token: ${v.reason}` }, request, 401);

  const person = (v.session.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase();
  if (!person) return jsonCors({ error: 'no person address in token sub' }, request, 401);

  // spec 323 W1-tail — the orgs the person STEWARDS come from the AUTHORITATIVE vault
  // relationships.data (non-'member' entries confer custody; a 'member' link is authority-only and
  // never exposes the org's grant graph — ADR-0025). The KV related-idx is the fallback cache when
  // the doc isn't reachable. The per-org inbound member grants (`delegated-idx`) are a cache whose
  // authoritative source is the org's own directory.data roster (portable; a second Home renders it
  // from there). Reconcile-from-source, not a second mechanism (ADR-0013).
  const { readRelationshipsDoc } = await import('../lib/relationships-doc');
  const doc = await readRelationshipsDoc(env, person, token);
  const stewardOrgs: Array<{ org: string; orgName: string }> = [];
  if (doc?.orgs) {
    for (const [org, e] of Object.entries(doc.orgs)) {
      if (e.relationship !== 'member') stewardOrgs.push({ org, orgName: e.orgName ?? '' });
    }
  } else {
    const orgIdx = JSON.parse((await env.AUTH_CODES.get(`related-idx:${person}`)) ?? '[]') as string[];
    for (const org of orgIdx) {
      const linkRaw = await env.AUTH_CODES.get(`related:${person}:${org}`);
      const link = linkRaw ? (JSON.parse(linkRaw) as { orgName?: string; relationship?: string }) : null;
      if (link?.relationship !== 'member') stewardOrgs.push({ org, orgName: link?.orgName ?? '' });
    }
  }
  const received: Array<Record<string, unknown>> = [];
  for (const { org, orgName } of stewardOrgs) {
    const grants = JSON.parse((await env.AUTH_CODES.get(`delegated-idx:${org}`)) ?? '[]') as Array<Record<string, unknown>>;
    for (const g of grants) received.push({ viaOrg: org, viaOrgName: orgName, ...g });
  }
  return jsonCors({ received }, request);
};
