// GET /oidc/google/start?aud=<relying-site>&redirect_uri=<rp-callback>
//
// Begin the real Google OIDC flow at the Connect origin. Generates PKCE + state +
// nonce (connect-auth), stashes them under `state` (single-use, short TTL), and
// 302-redirects the browser to Google. The client SECRET is never used here —
// only on the callback (token exchange).
import { beginLogin } from '@agenticprimitives/connect-auth/google';
import { json, type FnContext } from '../../_lib/server-broker';

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_REDIRECT_URI) {
    return json({ error: 'Google OIDC not configured (set GOOGLE_CLIENT_ID + GOOGLE_REDIRECT_URI). See OIDC-SETUP.md.' }, 503);
  }
  const url = new URL(request.url);
  const aud = url.searchParams.get('aud'); // the relying site (its client_id)
  const rpRedirect = url.searchParams.get('redirect_uri') ?? undefined; // where to deliver the code
  // Optional: a custody-grade AgentSession token to LINK this Google subject to an
  // existing agent (instead of login/bootstrap). Verified in the callback (P0-C).
  const linkToken = url.searchParams.get('link_token') ?? undefined;
  if (!aud) return json({ error: 'aud query param required (the relying site)' }, 400);

  const { authUrl, codeVerifier, state, nonce } = beginLogin({
    clientId: env.GOOGLE_CLIENT_ID,
    redirectUri: env.GOOGLE_REDIRECT_URI,
    prompt: 'select_account',
  });

  // Stash the PKCE verifier + nonce + relying-site context, keyed on `state`.
  await env.AUTH_CODES.put(
    `oidc:${state}`,
    JSON.stringify({ codeVerifier, nonce, aud, rpRedirect, linkToken }),
    { expirationTtl: 600 },
  );

  return new Response(null, { status: 302, headers: { location: authUrl } });
};
