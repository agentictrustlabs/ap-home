// GET /oidc/youversion/start?aud=<relying-site>&redirect_uri=<rp-callback>
//
// Begin the real YouVersion Platform OIDC flow at the Connect origin. Generates PKCE + state + nonce
// (connect-auth/youversion), stashes them under `state` (single-use, short TTL), and 302-redirects the
// browser to YouVersion. YouVersion is a PUBLIC PKCE client — there is no client secret anywhere.
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
    // spec 265 — request `read_highlights` (publicly-confirmed endpoint scope) so the access_token can read
    // the member's highlights. notes/bookmarks/saved-verses scope literals are pending Portal confirmation
    // and will be appended here once known; the substrate (KMS custody/refresh/read-proxy) doesn't depend
    // on the names. write_* scopes are intentionally NOT requested (read-only access for now).
    scope: 'openid profile email read_highlights',
  });

  // Stash the PKCE verifier + nonce + relying-site context, keyed on `state`.
  await env.AUTH_CODES.put(
    `oidc:${state}`,
    JSON.stringify({ codeVerifier, nonce, aud, rpRedirect, linkToken }),
    { expirationTtl: 600 },
  );

  return new Response(null, { status: 302, headers: { location: authUrl } });
};
