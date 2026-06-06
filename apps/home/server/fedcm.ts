// FedCM IdP — the DISCOVERABLE SURFACE (spec 264 Phase 1b; ADR-0031). These are the endpoints the
// browser fetches FIRST to learn the IdP: the eTLD+1 well-known, the provider config, the per-RP client
// metadata, and the login redirect. They are pure shape (the verified post-145 `fedcm-idp` builders +
// the whitelabel brand + the request origin) — NO session, NO key, NO signing. The credentialed
// accounts + the signed id-assertion endpoints (which reuse the broker session + signer) are the next
// step, gated on a live-Chrome verification.
//
// FedCM is an ADAPTER over the authority substrate, FedCM-first not FedCM-only: relying apps reach this
// only when the browser supports FedCM (feature-detected via `browser-identity.chooseSignIn`), else the
// spec-259 popup/redirect fallback. The assertion this IdP will mint is a THIN identity bootstrap (the
// same AgentSession id_token the relying app already verifies); the substrate issues the
// capability/delegation AFTER (ADR-0031).
import { buildWebIdentity, buildProviderConfig } from '@agenticprimitives/fedcm-idp';
import { whitelabel } from '../src/whitelabel/config';
import { resolveOrigin, type FnContext } from './_lib/server-broker';

/** FedCM endpoint paths (relative to the IdP origin). Kept in one place so config + well-known agree. */
const PATHS = {
  config: '/fedcm/config.json',
  accounts: '/fedcm/accounts',
  assertion: '/fedcm/assertion',
  login: '/fedcm/login',
  clientMetadata: '/fedcm/client-metadata',
  disconnect: '/fedcm/disconnect',
} as const;

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

/** GET /.well-known/web-identity — served from the IdP eTLD+1; declares the (single) config URL. Carries
 *  `accounts_endpoint` + `login_url` too (required from Chrome 145 when a `client_metadata_endpoint` is
 *  configured, which our config ships). */
export const onWebIdentity = ({ request, env }: FnContext): Response => {
  const origin = resolveOrigin(request, env);
  return json(
    buildWebIdentity(`${origin}${PATHS.config}`, {
      accountsEndpoint: `${origin}${PATHS.accounts}`,
      loginUrl: `${origin}${PATHS.login}`,
    }),
  );
};

/** GET /fedcm/config.json — the provider config the browser reads to find the accounts/assertion/login/
 *  metadata/disconnect endpoints + branding. */
export const onConfig = ({ request, env }: FnContext): Response => {
  const origin = resolveOrigin(request, env);
  return json(
    buildProviderConfig({
      accountsEndpoint: `${origin}${PATHS.accounts}`,
      idAssertionEndpoint: `${origin}${PATHS.assertion}`,
      loginUrl: `${origin}${PATHS.login}`,
      clientMetadataEndpoint: `${origin}${PATHS.clientMetadata}`,
      disconnectEndpoint: `${origin}${PATHS.disconnect}`,
      branding: { name: whitelabel.brand.name },
    }),
  );
};

/** GET /fedcm/client-metadata?client_id=… — the browser shows the RP's ToS/privacy links if returned. We
 *  don't host per-RP legal pages in the demo, so we return an empty (valid) object — the chooser simply
 *  shows no links. (The `client_id` query is present but unused here.) */
export const onClientMetadata = (_ctx: FnContext): Response => {
  return json({});
};

/** GET /fedcm/login — opened by the browser when the user must (re)authenticate at the IdP. Redirect to
 *  the credential-first entry (the spec-259 surface: Google / passkey / wallet). After sign-in the home
 *  sets `Set-Login: logged-in` (openSession), and the browser re-fetches the accounts endpoint. */
export const onLogin = ({ request, env }: FnContext): Response => {
  const origin = resolveOrigin(request, env);
  return Response.redirect(`${origin}/`, 302);
};
