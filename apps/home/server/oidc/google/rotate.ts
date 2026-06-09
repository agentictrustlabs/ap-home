// POST /oidc/google/rotate — "use Google for a new home" (spec 235 §5b).
//
// Authorized by the member's CURRENT Google custody session (they prove they hold this home),
// this bumps the per-(iss,sub) rotation counter. The member then signs out + signs back in with
// Google → the next session derives `C_sub(iss,sub,rotation+1)` → a FRESH agent (named via
// GoogleSecureHome). The old home is left behind (still server-custodied at the old rotation).
import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import { bumpRotation } from '../../../src/lib/kv-indexer';
import { CONNECT_DOMAIN } from '../../../src/lib/domain';
import { getServer, json, resolveOrigin, type FnContext } from '../../_lib/server-broker';

/** One of THIS site's own Connect origins (apex / per-handle home, spec 232) — a Google session
 *  is minted on the central origin but used on a subdomain (mirrors server/me/handler). */
function isOwnConnectOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    if (h === CONNECT_DOMAIN) return true;
    const sfx = '.' + CONNECT_DOMAIN;
    return h.endsWith(sfx) && /^[a-z0-9-]+$/.test(h.slice(0, -sfx.length));
  } catch {
    return false;
  }
}

/** Parse `oidcFacetId` (`"<iss>#<sub>"`) → the Google subject (split on the last `#`). */
function parseOidcId(id: string): { iss: string; sub: string } | null {
  const at = id.lastIndexOf('#');
  if (at <= 0 || at === id.length - 1) return null;
  return { iss: id.slice(0, at), sub: id.slice(at + 1) };
}

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  // SEC-024: gate iss through the Host allowlist.
  const reqOrigin = resolveOrigin(request, env);
  const aud = env.DEMO_SSO_AUD ?? 'demo-sso';
  const bearer = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  let token = bearer;
  if (!token) {
    const body = (await request.json().catch(() => ({}))) as { session?: string };
    token = body.session ?? '';
  }
  if (!token) return json({ error: 'Google custody session required' }, 401);

  const { jwks } = await getServer(env);
  const keys = await importJwks(jwks);
  // Verify signature/alg/aud/exp (alg-pin rejects HS256), then accept the issuer if it's one of
  // our own Connect origins (the session was minted on www, used here on any of our origins).
  const v = await verifyAgentSession(token, { keys, expectedAud: aud, expectedIss: (i) => i === reqOrigin || isOwnConnectOrigin(i) });
  if (!v.ok) return json({ error: `invalid session: ${v.reason}` }, 401);
  const s = v.session;
  if (s.iss !== reqOrigin && !isOwnConnectOrigin(s.iss)) {
    return json({ error: 'issuer not trusted' }, 401);
  }
  // Only a Google custody-grade session may rotate its own derivation.
  if (s.principal.kind !== 'oidc' || s.principal.role !== 'custody-grade' || s.assurance !== 'onchain-confirmed') {
    return json({ error: 'a Google custody session is required' }, 403);
  }
  const oidc = parseOidcId(s.principal.id);
  if (!oidc) return json({ error: 'malformed principal id' }, 400);

  const rotation = await bumpRotation(env.AUTH_CODES, oidc.iss, oidc.sub);
  return json({ ok: true, rotation });
};
