// POST /authorize — begin the SSO flow at the Connect origin.
//
// Body: { credential: CredentialPrincipal, aud: string, redirectUri?: string }.
// (In production the `credential` is the result of connect-auth verifying a
// passkey/OIDC ceremony; here it is passed in / simulated — the broker still
// runs the real resolution + issuance + gates.)
//
// §4a (CN-1/9): validate redirect_uri against the allowlist, then DO NOT return
// the token — mint it, stash it under a single-use, short-TTL code (KV), and
// return the code. The relying site exchanges the code at /token server-side.

import { newAuthCode, validateRedirectUri } from '@agenticprimitives/connect';
import type { CredentialPrincipal } from '@agenticprimitives/types';
import { issueForRelyingSite } from '../src/lib/broker-core';
import { getServer, json, resolveOrigin, type FnContext } from './_lib/server-broker';

interface AuthorizeBody {
  credential?: CredentialPrincipal;
  aud?: string;
  redirectUri?: string;
}

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const body = (await request.json().catch(() => ({}))) as AuthorizeBody;
  if (!body.credential || !body.aud) return json({ error: 'credential + aud are required' }, 400);

  // CN-1: exact-match redirect_uri allowlist (if configured for this deploy).
  if (body.redirectUri && env.REDIRECT_URI_ALLOWLIST) {
    const allow = env.REDIRECT_URI_ALLOWLIST.split(',').map((s) => s.trim());
    if (!validateRedirectUri(allow, body.redirectUri)) return json({ error: 'redirect_uri not allowed' }, 400);
  }

  const { signer, directory } = await getServer(env);
  const iss = resolveOrigin(request, env); // subdomain-correct Connect origin behind the router (spec 231)
  const outcome = await issueForRelyingSite(directory, signer, body.credential, body.aud, iss);

  if (outcome.status === 'bootstrap') return json({ status: 'bootstrap' });
  if (outcome.status === 'disambiguate') return json({ status: 'disambiguate', agents: outcome.agents });
  if (outcome.status === 'rejected') return json({ status: 'rejected', reason: outcome.reason }, 403);

  // §4a / CN-9: single-use, short-TTL code — the token never rides in the redirect.
  const code = newAuthCode();
  await env.AUTH_CODES.put(`code:${code}`, JSON.stringify({ token: outcome.token, aud: body.aud }), { expirationTtl: 120 });
  return json({ status: 'issued', code });
};
