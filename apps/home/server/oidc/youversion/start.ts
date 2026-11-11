// GET /oidc/youversion/start?aud=<relying-site>&redirect_uri=<rp-callback>
//
// Begin the real YouVersion Platform OIDC flow at the Connect origin. Generates PKCE + state + nonce
// (connect-auth/youversion), stashes them under `state` (single-use, short TTL), and 302-redirects the
// browser to YouVersion. YouVersion is a PUBLIC PKCE client — there is no client secret anywhere.
import { markLoginStart } from '../../_lib/recognition';
import { beginLogin } from '@agenticprimitives/connect-auth/youversion';
import { json, type FnContext } from '../../_lib/server-broker';

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  if (!env.YOUVERSION_CLIENT_ID || !env.YOUVERSION_REDIRECT_URI) {
    return json({ error: 'YouVersion OIDC not configured (set YOUVERSION_CLIENT_ID + YOUVERSION_REDIRECT_URI).' }, 503);
  }
  const url = new URL(request.url);
  const aud = url.searchParams.get('aud'); // the relying site (its client_id)
  const rpRedirect = url.searchParams.get('redirect_uri') ?? undefined; // where to deliver the code
  // Optional: a custody-grade AgentSession token to LINK this YouVersion subject to an existing agent
  // (instead of login/bootstrap). Verified in the callback (P0-C).
  const linkToken = url.searchParams.get('link_token') ?? undefined;
  if (!aud) return json({ error: 'aud query param required (the relying site)' }, 400);

  const { authUrl, codeVerifier, state, nonce } = beginLogin({
    clientId: env.YOUVERSION_CLIENT_ID,
    redirectUri: env.YOUVERSION_REDIRECT_URI,
    // spec 265 — sign-in is IDENTITY only. `read_highlights` is NOT an OIDC scope (YouVersion silently
    // drops it here); highlights access is granted through the separate Data Exchange consent flow
    // (GET /connect/youversion/data-exchange → approval page → callback). See spec 265 W5.
    scope: 'openid profile email',
  });

  // Stash the PKCE verifier + nonce + relying-site context, keyed on `state`.
  // Spec 445 (connect-auth): this IS the single-use login-attempt record `completeLogin` takes — it carries
  // `state`, `redirectUri` and `createdAtMs` (the attempt's age is checked against the clock, not just the TTL),
  // beside the relying-site context the callback needs.
  await env.AUTH_CODES.put(
    `oidc:${state}`,
    JSON.stringify({ state, codeVerifier, nonce, redirectUri: env.YOUVERSION_REDIRECT_URI, createdAtMs: Date.now(), aud, rpRedirect, linkToken }),
    { expirationTtl: 600 },
  );

  return markLoginStart(new Response(null, { status: 302, headers: { location: authUrl } }), { request, env }, state);
};
