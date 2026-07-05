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
import type { CanonicalAgentId, CredentialPrincipal } from '@agenticprimitives/types';
import { recordOidcFacet, readOidcFacet, readRotation } from '../../../src/lib/kv-indexer';
import { signBridgeCall } from '../../_lib/bridge-hmac';
import { CONNECT_DOMAIN } from '../../../src/lib/domain';
import { isSocialCustodyAud, isAllowedRelyingOrigin } from '../../../src/lib/oidc-clients';
import { getServer, json, resolveOrigin, type Env, type FnContext } from '../../_lib/server-broker';

/**
 * App-layer (ADR-0021) return-URL policy: in addition to the exact-match
 * REDIRECT_URI_ALLOWLIST (CN-1, the generic broker primitive), trust THIS site's own portal
 * homes — the apex and per-handle `https://<label>.<CONNECT_DOMAIN>/` homes (spec 232) — so
 * Google onboarding works from any of our subdomains without enumerating each. Strict: https
 * only, a SINGLE DNS label (no dots), root path, no query/fragment — the suffix is our own
 * registrable domain, so this is not an open redirect.
 */
// SSO-OIDC-REDIRECT-FAILOPEN-1 / SSO-OIDC-BOOTSTRAP-EMAIL-LEAK-2 (2026-07-05 completeness audit): fail-CLOSED
// redirect validation. Accept a return URL ONLY if it matches the env allowlist, the relying-client
// registry, OR our own portal. An EMPTY REDIRECT_URI_ALLOWLIST must NOT bypass the check — doing so
// 302'd the auth code (issued path) or the victim's verified email (bootstrap path) to any attacker URL.
function redirectAllowed(allowlist: string | undefined, rpRedirect: string): boolean {
  const allow = (allowlist ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return validateRedirectUri(allow, rpRedirect) || isAllowedRelyingOrigin(rpRedirect) || isOwnPortalReturn(rpRedirect);
}

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

/**
 * Ask demo-a2a (the master holder) for this Google subject's KMS-custodied SA
 * (spec 235 §5). Derive-only, server-to-server, bridge-secret authenticated.
 * Returns the CAIP-10 agent id. The broker can't derive it itself (no master).
 */
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
    // SEC-010: per-call HMAC envelope replaces the bearer secret. A compromise of the
    // shared key now yields short-window replay only — bounded by BRIDGE_FRESHNESS_MS
    // at the receiver, with single-use nonces preventing intra-window replay.
    const envelope = await signBridgeCall({
      secret: env.A2A_CUSTODY_BRIDGE_SECRET,
      audience: 'custody.google.resolve',
      payload: { iss: oidcIss, sub: oidcSub, rotation },
    });
    const res = await fetch(`${env.A2A_CUSTODY_URL.replace(/\/$/, '')}/custody/oidc/resolve`, {
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
  // SEC-024: gate iss through the Host allowlist (the broker NEVER signs sessions with
  // a foreign Host — even on the Google callback path).
  const iss = resolveOrigin(request, env);

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

  // OIDC LOGIN: resolve the (iss,sub)->agent facet from the indexer (recorded at
  // link-time P0-C, or at KMS-custody bootstrap below). OIDC has no on-chain presence,
  // so it does NOT go through the directory's on-chain confirmCandidates.
  const oidcIss = result.principal.iss;
  const oidcSub = result.principal.sub;
  const custodyAud = env.DEMO_SSO_AUD ?? 'demo-sso';
  // Google × KMS custody is offered for the Personal-Home aud AND for clients explicitly flagged
  // `socialCustody` in the registry (spec 294 — self-contained demos like demo-web that bootstrap their own
  // SA). Other relying-app auds stay login-grade — their members onboard via the Personal Home (spec 235).
  const custodyEligible = isSocialCustodyAud(stash.aud, custodyAud);
  // Per-subject rotation (spec 235 §5b): which KMS home this Google account opens now. demo-a2a
  // derives `SA(iss,sub,rotation)` deterministically — derive-only here, no on-chain effect.
  const rotation = await readRotation(env.AUTH_CODES, oidcIss, oidcSub);
  const derived = custodyEligible
    ? await resolveKmsAgent(env, oidcIss, oidcSub, rotation)
    : ({ ok: false, reason: 'not eligible' } as const);

  let agent: CanonicalAgentId | null = null;
  let custodyGrade = false;

  if (custodyEligible && derived.ok) {
    // Personal-Home Google = the KMS-custodied home at the CURRENT rotation. Record/refresh the
    // facet to it (idempotent; after a rotation bump the old facet is stale → this points at the
    // new home). Custody-grade: C_sub is a real on-chain custodian (demo-a2a's gate re-verifies).
    await recordOidcFacet(env.AUTH_CODES, oidcIss, oidcSub, derived.agentId);
    agent = derived.agentId;
    custodyGrade = true;
  } else {
    // Relying-app (login-grade) path, OR custody unconfigured/unreachable: resolve the existing
    // (iss,sub)->agent facet (passkey/wallet-linked or a prior KMS home). Login-grade; bootstrap
    // notice if there's no linked agent yet.
    agent = await readOidcFacet(env.AUTH_CODES, oidcIss, oidcSub);
    if (!agent) {
      // Only 302 the email-carrying bootstrap notice to a VALIDATED redirect (fail-closed); otherwise
      // return the bootstrap status inline without leaking the email to an unvalidated URL.
      if (stash.rpRedirect && redirectAllowed(env.REDIRECT_URI_ALLOWLIST, stash.rpRedirect)) {
        const dest = new URL(stash.rpRedirect);
        dest.searchParams.set('connect_status', 'bootstrap');
        dest.searchParams.set('via', 'google');
        if (result.principal.email) dest.searchParams.set('email', result.principal.email);
        return new Response(null, { status: 302, headers: { location: dest.toString() } });
      }
      return json({ status: 'bootstrap', oidcSubject: principal.id, email: result.principal.email });
    }
  }

  // Mint the session. Custody-grade (onchain-confirmed) for a KMS-custodied SA;
  // login-grade (asserted) otherwise (ADR-0017 / spec 227 §5).
  const sessionPrincipal: CredentialPrincipal = custodyGrade
    ? { kind: 'oidc', id: oidcFacetId(oidcIss, oidcSub), assurance: 'onchain-confirmed', role: 'custody-grade' }
    : principal;
  const token = await mintAgentSession(
    {
      sub: agent,
      principal: sessionPrincipal,
      assurance: custodyGrade ? 'onchain-confirmed' : 'asserted',
      // A custody-grade session is HOME-level custody authority (the KMS custodian = the person's home
      // identity), so it carries the home/custody aud — which demo-a2a's `/custody/*` gate verifies
      // (expectedAud = DEMO_SSO_AUD). For the Personal Home aud this is a no-op; for a `socialCustody`
      // client (spec 294, e.g. demo-web) it lets the SAME custody gate accept the session. Login-grade
      // sessions stay bound to the requesting relying-app aud.
      aud: custodyGrade ? custodyAud : stash.aud,
      iss,
      ttlSeconds: 3600,
      // Carry the rotation so demo-a2a's gate derives the matching per-subject key (spec 235 §5b).
      ...(custodyGrade ? { rotation } : {}),
    },
    signer,
  );

  // §4a / CN-9: stash under a single-use code; deliver the CODE, not the token. The code-exchange aud is
  // the REQUESTING client (stash.aud) — distinct from the session's internal (home) aud for custody clients.
  const authCode = newAuthCode();
  await env.AUTH_CODES.put(`code:${authCode}`, JSON.stringify({ token, aud: stash.aud }), { expirationTtl: 120 });

  if (stash.rpRedirect) {
    // SSO-OIDC-REDIRECT-FAILOPEN-1: fail-closed — an empty allowlist no longer bypasses the check.
    if (!redirectAllowed(env.REDIRECT_URI_ALLOWLIST, stash.rpRedirect)) {
      return json({ error: 'redirect_uri not allowed (CN-1)' }, 400);
    }
    const dest = new URL(stash.rpRedirect);
    dest.searchParams.set('code', authCode);
    return new Response(null, { status: 302, headers: { location: dest.toString() } });
  }
  return json({ status: 'issued', code: authCode });
};
