// GET /connect/related-orgs?client_id=<id>  (spec 246 / ADR-0025)
//
// Person-session-authorized: the relying app presents the connected person's id_token
// (Authorization: Bearer, or ?id_token=). We verify it against the broker JWKS, pin the
// audience to the calling `client_id`, extract the person SA from the session `sub`, and
// return that person's related-agent links scoped to this client_id — from the private
// Connect-home vault (KV). person↔org never travels as public graph state.
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
  // `client_id` present → a RELYING app's scoped view (orgs it requested; token aud = client_id).
  // `client_id` absent  → the PERSON's OWN home view (ALL their orgs; token aud = the home aud).
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

  const idx = JSON.parse((await env.AUTH_CODES.get(`related-idx:${person}`)) ?? '[]') as string[];
  const orgs: Array<Record<string, unknown>> = [];
  for (const org of idx) {
    const raw = await env.AUTH_CODES.get(`related:${person}:${org}`);
    if (!raw) continue;
    const link = JSON.parse(raw) as {
      orgAgent: string; orgName: string; purpose: string; requestedBy: string;
      siteDelegation: unknown; proofHash: string | null; createdAt?: number;
    };
    if (clientId && link.requestedBy !== clientId) continue; // relying-app view is scoped
    orgs.push({
      orgAgent: link.orgAgent,
      orgName: link.orgName,
      purpose: link.purpose,
      requestedBy: link.requestedBy,
      createdAt: link.createdAt ?? null,
      delegation: link.siteDelegation,
      proofHash: link.proofHash,
    });
  }
  return jsonCors({ orgs }, request);
};
