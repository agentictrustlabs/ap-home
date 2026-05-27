// GET /oidc/google/callback?code=...&state=...  (Google's redirect_uri target)
//
// The real OIDC callback: retrieve the stashed PKCE/state context, exchange the
// code for tokens + verify the id_token (connect-auth — RS256/JWKS, alg-pinned,
// email_verified, nonce), then treat the verified (iss, sub) as a LOGIN-GRADE
// credential facet, resolve it to a canonical agent via the directory, issue an
// aud-bound AgentSession, and deliver it via the §4a single-use code.
//
// NOTE: the OIDC subject is keyed on (iss, sub) — never email (CN-3). The agent
// is RESOLVED via the directory; it is not derived from the email.
import { completeLogin, oidcFacetId } from '@agenticprimitives/connect-auth/google';
import { newAuthCode, validateRedirectUri, importJwks, verifyAgentSession, mintAgentSession } from '@agenticprimitives/connect';
import type { CredentialPrincipal } from '@agenticprimitives/types';
import { recordOidcFacet, readOidcFacet } from '../../../src/lib/kv-indexer';
import { getServer, json, type FnContext } from '../../_lib/server-broker';

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URI) {
    return json({ error: 'Google OIDC not configured. See OIDC-SETUP.md.' }, 503);
  }
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return json({ error: 'code + state required' }, 400);

  // Retrieve + consume the stashed PKCE/state context (single-use).
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

  // Token exchange (client_secret server-side) + id_token verification.
  const result = await completeLogin({
    code,
    returnedState: state,
    expectedState: state,
    expectedNonce: stash.nonce,
    codeVerifier: stash.codeVerifier,
    redirectUri: env.GOOGLE_REDIRECT_URI,
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
  });
  if (!result.ok) return json({ error: `OIDC verification failed: ${result.reason}` }, 401);

  const principal: CredentialPrincipal = {
    kind: 'oidc',
    id: oidcFacetId(result.principal.iss, result.principal.sub),
    assurance: 'asserted',
    role: 'login-grade',
  };

  const { signer, jwks } = await getServer(env);
  const iss = new URL(request.url).origin; // the Connect origin = this serving origin

  // ── LINK this Google subject to an EXISTING agent (P0-C) ────────────
  // Authorized by a custody-grade AgentSession of that agent (stash.linkToken).
  // Records (iss,sub)->agent in the indexer; issues no session. Redirects back.
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
      return back('link_failed', { reason: 'a custody-grade session is required to link Google' });
    }
    await recordOidcFacet(env.AUTH_CODES, result.principal.iss, result.principal.sub, v.session.sub);
    return back('linked', { email: result.principal.email ?? '' });
  }

  // OIDC LOGIN: resolve the (iss,sub)->agent facet DIRECTLY from the indexer (it was
  // recorded at link-time, P0-C). OIDC has no on-chain presence, so it does NOT go
  // through the directory's on-chain confirmCandidates (which would drop it, P0-B) —
  // it resolves at `asserted` and issues a LOGIN-GRADE session (ADR-0017 / spec 227 §5).
  const agent = await readOidcFacet(env.AUTH_CODES, result.principal.iss, result.principal.sub);
  if (!agent) {
    // No agent linked to this Google subject yet → bootstrap. Redirect BACK to the app
    // with a status (never dead-end on a JSON page) so the UI can explain "create a
    // workspace with a wallet/passkey, then link Google".
    if (stash.rpRedirect) {
      const dest = new URL(stash.rpRedirect);
      dest.searchParams.set('connect_status', 'bootstrap');
      dest.searchParams.set('via', 'google');
      if (result.principal.email) dest.searchParams.set('email', result.principal.email);
      return new Response(null, { status: 302, headers: { location: dest.toString() } });
    }
    return json({ status: 'bootstrap', oidcSubject: principal.id, email: result.principal.email });
  }

  // Linked → mint a LOGIN-GRADE session for the agent (assurance 'asserted').
  const token = await mintAgentSession(
    { sub: agent, principal, assurance: 'asserted', aud: stash.aud, iss, ttlSeconds: 3600 },
    signer,
  );

  // §4a / CN-9: stash under a single-use code; deliver the CODE, not the token.
  const authCode = newAuthCode();
  await env.AUTH_CODES.put(`code:${authCode}`, JSON.stringify({ token, aud: stash.aud }), { expirationTtl: 120 });

  if (stash.rpRedirect) {
    const allow = (env.REDIRECT_URI_ALLOWLIST ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (allow.length && !validateRedirectUri(allow, stash.rpRedirect)) {
      return json({ error: 'redirect_uri not allowed (CN-1)' }, 400);
    }
    const dest = new URL(stash.rpRedirect);
    dest.searchParams.set('code', authCode);
    return new Response(null, { status: 302, headers: { location: dest.toString() } });
  }
  return json({ status: 'issued', code: authCode });
};
