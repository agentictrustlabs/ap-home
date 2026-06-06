// GET /oidc/youversion/callback?code=...&state=...  (YouVersion's redirect_uri target)
//
// The real OIDC callback, mirroring server/oidc/google/callback.ts: retrieve the stashed PKCE/state
// context, exchange the code for tokens + verify the id_token (connect-auth/youversion — RS256/JWKS,
// alg-pinned, nonce), then treat the verified (iss, sub) as a credential facet, resolve it to a
// canonical agent (KMS custody for the Personal Home, spec 235), issue an aud-bound AgentSession, and
// deliver it via the §4a single-use code. YouVersion is a PUBLIC PKCE client (no client_secret) and is
// KMS-custodied exactly like Google — the demo-a2a bridge derives the custodian from (iss, sub), so the
// only differences from the Google handler are the provider module, the env vars, and `via=youversion`.
import { completeLogin, oidcFacetId } from '@agenticprimitives/connect-auth/youversion';
import { newAuthCode, validateRedirectUri, importJwks, verifyAgentSession, mintAgentSession } from '@agenticprimitives/connect';
import type { CanonicalAgentId, CredentialPrincipal } from '@agenticprimitives/types';
import { recordOidcFacet, readOidcFacet, readRotation } from '../../../src/lib/kv-indexer';
import { signBridgeCall } from '../../_lib/bridge-hmac';
import { CONNECT_DOMAIN } from '../../../src/lib/domain';
import { getServer, json, resolveOrigin, type Env, type FnContext } from '../../_lib/server-broker';

/** App-layer return-URL policy (mirrors the Google handler): trust this site's own apex + per-handle
 *  `https://<label>.<CONNECT_DOMAIN>/` portal homes (spec 232) in addition to REDIRECT_URI_ALLOWLIST. */
function isOwnPortalReturn(rpRedirect: string): boolean {
  try {
    const u = new URL(rpRedirect);
    if (u.protocol !== 'https:') return false;
    if (u.pathname !== '/' && u.pathname !== '') return false;
    if (u.search || u.hash) return false;
    const h = u.hostname.toLowerCase();
    if (h === CONNECT_DOMAIN) return true;
    const suffix = '.' + CONNECT_DOMAIN;
    if (h.endsWith(suffix)) return /^[a-z0-9-]+$/.test(h.slice(0, -suffix.length));
    return false;
  } catch {
    return false;
  }
}

/** Ask demo-a2a (the master holder) for this subject's KMS-custodied SA (spec 235 §5). Derive-only,
 *  bridge-authenticated. Identical to the Google handler — the custodian derives from (iss, sub), so the
 *  YouVersion issuer yields a distinct home from the same person's Google home. */
async function resolveKmsAgent(
  env: Env,
  oidcIss: string,
  oidcSub: string,
  rotation: number,
): Promise<{ ok: true; agentId: CanonicalAgentId } | { ok: false; reason: string }> {
  if (!env.A2A_CUSTODY_URL || !env.A2A_CUSTODY_BRIDGE_SECRET) {
    return { ok: false, reason: 'custody not configured' };
  }
  try {
    const envelope = await signBridgeCall({
      secret: env.A2A_CUSTODY_BRIDGE_SECRET,
      audience: 'custody.google.resolve',
      payload: { iss: oidcIss, sub: oidcSub, rotation },
    });
    const res = await fetch(`${env.A2A_CUSTODY_URL.replace(/\/$/, '')}/custody/google/resolve`, {
      method: 'POST',
      headers: envelope.headers,
      body: envelope.body,
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; agentId?: string; error?: string };
    if (!res.ok || !body.ok || !body.agentId) return { ok: false, reason: body.error ?? `resolve HTTP ${res.status}` };
    return { ok: true, agentId: body.agentId as CanonicalAgentId };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'resolve failed' };
  }
}

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  if (!env.YOUVERSION_CLIENT_ID || !env.YOUVERSION_REDIRECT_URI) {
    return json({ error: 'YouVersion OIDC not configured.' }, 503);
  }
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return json({ error: 'code + state required' }, 400);

  const stashKey = `oidc:${state}`;
  const stashRaw = await env.AUTH_CODES.get(stashKey);
  await env.AUTH_CODES.delete(stashKey);
  if (!stashRaw) return json({ error: 'unknown or expired state' }, 400);
  const stash = JSON.parse(stashRaw) as {
    codeVerifier: string;
    nonce: string;
    aud: string;
    rpRedirect?: string;
    linkToken?: string;
  };

  // Token exchange (PUBLIC PKCE — NO client secret) + id_token verification.
  const result = await completeLogin({
    code,
    returnedState: state,
    expectedState: state,
    expectedNonce: stash.nonce,
    codeVerifier: stash.codeVerifier,
    redirectUri: env.YOUVERSION_REDIRECT_URI,
    clientId: env.YOUVERSION_CLIENT_ID,
  });
  if (!result.ok) return json({ error: `OIDC verification failed: ${result.reason}` }, 401);

  const principal: CredentialPrincipal = {
    kind: 'oidc',
    id: oidcFacetId(result.principal.iss, result.principal.sub),
    assurance: 'asserted',
    role: 'login-grade',
  };

  const { signer, jwks } = await getServer(env);
  const iss = resolveOrigin(request, env);

  // ── LINK this YouVersion subject to an EXISTING agent (P0-C) ──
  if (stash.linkToken) {
    const back = (status: string, extra: Record<string, string> = {}): Response => {
      if (!stash.rpRedirect) return json({ status, ...extra }, status === 'linked' ? 200 : 400);
      const dest = new URL(stash.rpRedirect);
      dest.searchParams.set('connect_status', status);
      for (const [k, val] of Object.entries(extra)) dest.searchParams.set(k, val);
      return new Response(null, { status: 302, headers: { location: dest.toString() } });
    };
    const keys = await importJwks(jwks);
    const v = await verifyAgentSession(stash.linkToken, { keys, expectedIss: iss, expectedAud: stash.aud });
    if (!v.ok) return back('link_failed', { reason: 'invalid session' });
    if (v.session.assurance !== 'onchain-confirmed') {
      return back('link_failed', { reason: 'a custody-grade session is required to link YouVersion' });
    }
    await recordOidcFacet(env.AUTH_CODES, result.principal.iss, result.principal.sub, v.session.sub);
    return back('linked', { email: result.principal.email ?? '' });
  }

  const oidcIss = result.principal.iss;
  const oidcSub = result.principal.sub;
  const custodyAud = env.DEMO_SSO_AUD ?? 'demo-sso';
  // KMS custody is offered ONLY for the Personal-Home aud (spec 235); relying-app auds stay login-grade.
  const custodyEligible = stash.aud === custodyAud;
  const rotation = await readRotation(env.AUTH_CODES, oidcIss, oidcSub);
  const derived = custodyEligible
    ? await resolveKmsAgent(env, oidcIss, oidcSub, rotation)
    : ({ ok: false, reason: 'not eligible' } as const);

  let agent: CanonicalAgentId | null = null;
  let custodyGrade = false;

  if (custodyEligible && derived.ok) {
    await recordOidcFacet(env.AUTH_CODES, oidcIss, oidcSub, derived.agentId);
    agent = derived.agentId;
    custodyGrade = true;
  } else {
    agent = await readOidcFacet(env.AUTH_CODES, oidcIss, oidcSub);
    if (!agent) {
      if (stash.rpRedirect) {
        const dest = new URL(stash.rpRedirect);
        dest.searchParams.set('connect_status', 'bootstrap');
        dest.searchParams.set('via', 'youversion');
        if (result.principal.email) dest.searchParams.set('email', result.principal.email);
        return new Response(null, { status: 302, headers: { location: dest.toString() } });
      }
      return json({ status: 'bootstrap', oidcSubject: principal.id, email: result.principal.email });
    }
  }

  const sessionPrincipal: CredentialPrincipal = custodyGrade
    ? { kind: 'oidc', id: oidcFacetId(oidcIss, oidcSub), assurance: 'onchain-confirmed', role: 'custody-grade' }
    : principal;
  const token = await mintAgentSession(
    {
      sub: agent,
      principal: sessionPrincipal,
      assurance: custodyGrade ? 'onchain-confirmed' : 'asserted',
      aud: stash.aud,
      iss,
      ttlSeconds: 3600,
      ...(custodyGrade ? { rotation } : {}),
    },
    signer,
  );

  // §4a / CN-9: stash under a single-use code; deliver the CODE, not the token. `via=youversion` tells
  // the client which credential opened the session (KMS-custodied, like Google).
  const authCode = newAuthCode();
  await env.AUTH_CODES.put(`code:${authCode}`, JSON.stringify({ token, aud: stash.aud }), { expirationTtl: 120 });

  if (stash.rpRedirect) {
    const allow = (env.REDIRECT_URI_ALLOWLIST ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (allow.length && !validateRedirectUri(allow, stash.rpRedirect) && !isOwnPortalReturn(stash.rpRedirect)) {
      return json({ error: 'redirect_uri not allowed (CN-1)' }, 400);
    }
    const dest = new URL(stash.rpRedirect);
    dest.searchParams.set('code', authCode);
    dest.searchParams.set('via', 'youversion');
    return new Response(null, { status: 302, headers: { location: dest.toString() } });
  }
  return json({ status: 'issued', code: authCode, via: 'youversion' });
};
