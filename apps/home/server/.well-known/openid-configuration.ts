// GET /.well-known/openid-configuration — OIDC discovery (spec 230 §4.1).
//
// `issuer` MUST equal the serving origin (the person's OP). Read from the request Host so
// it is correct for the apex demo origin AND each per-person *.impact-agent.io
// subdomain (spec 229 P5) with no code change. Code only (no implicit flow); S256 PKCE.
import { json, resolveOrigin, type FnContext } from '../_lib/server-broker';

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const iss = resolveOrigin(request, env); // subdomain-correct OP issuer behind the router (spec 231)
  return json({
    issuer: iss,
    // The authorization UI is the SPA at the origin root (it renders the consent + runs the
    // ROOT-passkey ceremony from the OIDC query params), so the endpoint is the root.
    authorization_endpoint: `${iss}/`,
    token_endpoint: `${iss}/token`,
    jwks_uri: `${iss}/jwks`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['ES256'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['openid', 'profile', 'agent'],
    claims_supported: ['sub', 'aud', 'iss', 'exp', 'iat', 'nonce', 'agent_name', 'canonical_agent_id'],
  });
};
