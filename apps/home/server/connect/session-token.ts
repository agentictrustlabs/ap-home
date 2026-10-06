// Spec 426 §5 — THE PRODUCTION SESSION SEAM: an id_token for the signed-in person's OWN agent, scoped to
// ONE registered client, minted from the Home session they already hold.
//
//   POST /connect/session-token { client_id, as? }      Authorization: Bearer <home session | registered-client id_token>
//   → { id_token, expires_in, sub, aud }
//
// WHY. The runtime's executor-invoke step calls an executor AS the run's principal, and the executor
// verifies a Home id_token for its own client. Until now the runtime could obtain one only through
// `demo-signin { as }`, which mints for seeded demo personas — a real person's invoke refused with
// "could not obtain a session". The credential that proves the person is the Home session the runtime
// already runs under; this route turns it into the executor's id_token without a second ceremony.
//
// WHAT IT NEVER DOES. It mints for the SESSION'S OWN AGENT only. `as` is accepted for the caller's
// convenience (the runtime names the run's principal) and REFUSED when it is not that agent: acting
// as an organization, a team or another person is a mandate question, not a session question
// (spec 426 §6/§8 — v1 is self-acting). The audience is a registered client, never a free string, so
// the token cannot be replayed to an app the Home does not know. Nothing here is a grant: the executor
// re-runs its own authority server-side (ADR-0041 — the bearer is an ingress envelope).
import { importJwks, mintIdToken, verifyAgentSession } from '@agenticprimitives/connect';
import { getServer, resolveOrigin, ownIssuer, type FnContext } from '../_lib/server-broker';
import { resolveClient } from '../_lib/oidc-registry';

const ID_TOKEN_TTL = 3600;
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization' };
const json = (b: unknown, s = 200): Response =>
  new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', ...cors } });

export const onRequestOptions = async (): Promise<Response> => new Response(null, { status: 204, headers: cors });

function unverifiedAud(token: string): string | null {
  try {
    const seg = token.split('.')[1] ?? '';
    const aud = JSON.parse(atob(seg.replace(/-/g, '+').replace(/_/g, '/'))).aud;
    return typeof aud === 'string' ? aud : null;
  } catch {
    return null;
  }
}

/** The address a CAIP-10 subject names, lower-cased, or '' when it is not one. */
const addressOf = (sub: string): string => (sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase();

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const body = (await request.json().catch(() => null)) as { client_id?: string; as?: string; session?: string } | null;
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : String(body?.session ?? '').trim();
  if (!token) return json({ error: 'a Home session is required (Authorization: Bearer …)' }, 401);

  const clientId = String(body?.client_id ?? '').trim();
  if (!clientId) return json({ error: 'client_id is required' }, 400);
  const client = await resolveClient(env, clientId);
  if (!client) return json({ error: `"${clientId}" is not a registered client` }, 400);

  // The same two readings channels.ts gives a bearer: the Home's own portal session, else an id_token
  // for a registered relying app (an app driving the Home on the signed-in person's behalf).
  const { jwks, signer, directory } = await getServer(env);
  const keys = await importJwks(jwks);
  const iss = ownIssuer(request, env);
  let v = await verifyAgentSession(token, { keys, expectedAud: env.DEMO_SSO_AUD ?? 'demo-sso', expectedIss: iss });
  if (!v.ok) {
    const aud = unverifiedAud(token);
    if (aud && (await resolveClient(env, aud))) v = await verifyAgentSession(token, { keys, expectedAud: aud, expectedIss: iss });
  }
  if (!v.ok) return json({ error: 'session not verified' }, 401);

  const sub = v.session.sub;
  const self = addressOf(sub);
  if (!self) return json({ error: 'the session names no agent' }, 401);
  const asRaw = String(body?.as ?? '').trim().toLowerCase();
  if (asRaw && asRaw !== self) {
    return json({ error: 'this session can mint for its own agent only — acting as another agent is a mandate, not a session' }, 403);
  }

  let agentName: string | undefined;
  try {
    const view = await directory.agent(sub);
    agentName = view?.facets?.name ?? undefined;
  } catch {
    agentName = undefined;
  }
  const idToken = await mintIdToken(
    { iss: resolveOrigin(request, env), sub: sub as Parameters<typeof mintIdToken>[0]['sub'], aud: clientId, ttlSeconds: ID_TOKEN_TTL, ...(agentName ? { agentName } : {}) },
    signer,
  );
  return json({ id_token: idToken, expires_in: ID_TOKEN_TTL, sub, aud: clientId });
};
