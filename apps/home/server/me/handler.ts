// GET /me/profile      → basic profile (any valid AgentSession; login-grade OK)
// GET /me/sensitive    → sensitive PII (custody-grade only; else 403 step-up)
//
// The demo's "person MCP": served from the Connect origin, it verifies the
// SAME-origin AgentSession against the broker's published JWKS (connect's
// importJwks + verifyAgentSession — app-layer verify per spec 227 §7/U1), then
// gates on the session's assurance (P1-E). Token via `Authorization: Bearer` or
// `?token=`. Exact `aud` match (P1-F); fail-closed everywhere.
import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import { getServer, json, type FnContext } from '../_lib/server-broker';
import { basicProfile, sensitivePii } from '../../src/lib/pii';

/** The person MCP's own audience (same-origin demo; the server-client mints with this aud). */
const AUD = 'demo-sso';

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const url = new URL(request.url);
  const iss = url.origin; // the Connect origin that issued the token
  const bearer = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const token = bearer || url.searchParams.get('token') || '';
  if (!token) return json({ error: 'AgentSession bearer token required' }, 401);

  const { jwks, directory } = await getServer(env);
  const keys = await importJwks(jwks);
  const v = await verifyAgentSession(token, { keys, expectedIss: iss, expectedAud: AUD });
  if (!v.ok) return json({ error: `invalid AgentSession: ${v.reason}` }, 401);
  const session = v.session;

  // Best-effort .demo.agent name for the basic profile (on-chain reverse-resolve).
  let name: string | null = null;
  try {
    const view = await directory.agent(session.sub);
    name = view?.facets?.name ?? null;
  } catch {
    name = null;
  }

  const route = url.pathname.replace(/^\/me\/?/, '');
  if (route === '' || route === 'profile') {
    return json({ profile: basicProfile(session, name) });
  }
  if (route === 'sensitive') {
    const pii = sensitivePii(session);
    if (!pii) {
      return json(
        {
          error: 'step_up_required',
          reason:
            'Your contact details are protected — confirm with your device (a custody-grade sign-in) to view them. (ADR-0017 / CN-2)',
          access: session.assurance,
        },
        403,
      );
    }
    return json({ sensitive: pii });
  }
  return json({ error: 'unknown route' }, 404);
};
