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
import {
  buildWebIdentity,
  buildProviderConfig,
  buildAccountsResponse,
  buildTokenResponse,
  buildErrorResponse,
  assertionCorsHeaders,
  loginStatusHeader,
  isWebIdentityRequest,
  parseAssertionRequest,
  type FedcmAccount,
} from '@agenticprimitives/fedcm-idp';
import { importJwks, verifyAgentSession, mintIdToken } from '@agenticprimitives/connect';
import type { Address } from '@agenticprimitives/types';
import { whitelabel } from '../src/whitelabel/config';
import { getClient } from '../src/lib/oidc-clients';
import { CONNECT_DOMAIN } from '../src/lib/domain';
import { givePermission, type Via, type Auth } from '../src/home/onboarding';
import type { Home } from '../src/home/types';
import { resolveOrigin, getServer, type FnContext } from './_lib/server-broker';

/** The home's own audience (same-origin demo; mirrors server/me/handler.ts `AUD`). */
const HOME_AUD = 'demo-sso';
const ID_TOKEN_TTL = 3600;

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

// ─── Credentialed endpoints: the signed-in agent + the thin signed assertion ──

/** The cross-subdomain SSO session cookie (lib/sso-cookie.ts: `ap_sso = enc(JSON {t,v})`). FedCM sends
 *  it credentialed; we read the AgentSession token + the credential `via` from it. `v` is `'Google' |
 *  'passkey' | 'wallet'` (case as stored). */
function readSso(request: Request): { token: string; via: string } | null {
  const cookie = request.headers.get('cookie');
  if (!cookie) return null;
  const m = cookie.match(/(?:^|;\s*)ap_sso=([^;]*)/);
  if (!m || !m[1]) return null;
  try {
    const o = JSON.parse(decodeURIComponent(m[1])) as { t?: string; v?: string };
    return o?.t ? { token: o.t, via: o.v ?? '' } : null;
  } catch {
    return null;
  }
}

/** Parse the SA address from a CAIP-10 `eip155:<chain>:0x…` subject; null otherwise (mirrors me/handler). */
function addressFromSub(sub: string): Address | null {
  return /^eip155:\d+:0x[0-9a-fA-F]{40}$/.test(sub) ? (sub.split(':').pop() as Address) : null;
}

/** Read an AgentSession's own `aud` WITHOUT trusting it (signature is verified separately). Lets us
 *  verify a session minted with a non-home aud (the signature still can't be forged). */
function decodeAud(token: string): string | null {
  try {
    const p = token.split('.')[1];
    if (!p) return null;
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as { aud?: string };
    return typeof claims.aud === 'string' ? claims.aud : null;
  } catch {
    return null;
  }
}

/** This site's own Connect origins (apex + per-handle subdomains, spec 232) — mirrors server/me/handler. */
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

/** Verify the home session from the `ap_sso` cookie (signature/exp/owner via the broker JWKS, then a
 *  trusted issuer), and resolve the signed-in agent's `sub` (CAIP-10 SA address) + display name. Returns
 *  `null` when there is no valid session — the caller returns 401, which makes FedCM open `login_url`. */
interface HomeSession { sub: string; name: string | null; via: string; custodyToken: string }
type VerifyHome = { ok: true; session: HomeSession } | { ok: false; reason: string };

async function verifyHomeSession(env: FnContext['env'], request: Request): Promise<VerifyHome> {
  const sso = readSso(request);
  if (!sso) return { ok: false, reason: 'no_ap_sso_cookie' }; // cookie not sent (SameSite) OR not signed in
  const token = sso.token;
  const { jwks, directory } = await getServer(env);
  const keys = await importJwks(jwks);
  // The home session token's aud is the home's own; if a session was minted with a different aud, retry
  // with the token's own aud (the signature is still verified, so this can't be forged).
  let v = await verifyAgentSession(token, { keys, expectedAud: HOME_AUD });
  if (!v.ok) {
    const selfAud = decodeAud(token);
    if (selfAud && selfAud !== HOME_AUD) v = await verifyAgentSession(token, { keys, expectedAud: selfAud });
  }
  if (!v.ok) return { ok: false, reason: `session_verify_failed:${v.reason ?? 'unknown'}` };
  const session = v.session;
  const reqOrigin = resolveOrigin(request, env);
  if (session.iss !== reqOrigin && !isOwnConnectOrigin(session.iss)) {
    return { ok: false, reason: `issuer_untrusted:${session.iss}` };
  }
  let name: string | null = null;
  try {
    const view = await directory.agent(session.sub);
    name = view?.facets?.name ?? null;
  } catch {
    name = null;
  }
  // `via` + the custody token let the assertion endpoint mint the scoped delegation in the SAME ceremony
  // (the `ap_sso` cookie is readable ONLY here, same-origin — never by a cross-origin grant).
  return { ok: true, session: { sub: session.sub, name, via: sso.via, custodyToken: sso.token } };
}

/** GET /fedcm/accounts (credentialed). Verify `Sec-Fetch-Dest: webidentity`, read the home session, and
 *  return the signed-in agent(s). `id` is the canonical agent id (CAIP-10 SA address — the stable key,
 *  ADR-0010), never a name. `401` when not signed in → the browser opens `login_url`. */
export const onAccounts = async ({ request, env }: FnContext): Promise<Response> => {
  if (!isWebIdentityRequest(request.headers.get('sec-fetch-dest'))) {
    return json({ error: 'not a FedCM request' }, 400);
  }
  const home = await verifyHomeSession(env, request);
  if (!home.ok) {
    // `reason` is a diagnostic (no_ap_sso_cookie / session_verify_failed:… / issuer_untrusted:…) — visible
    // in the FedCM accounts Network response so a 401 can be pinpointed without server logs.
    return json({ error: 'not signed in', reason: home.reason }, 401);
  }
  const account: FedcmAccount = {
    id: home.session.sub,
    name: home.session.name ?? 'Your Impact account', // ≥1 of name/email/username/tel; we provide name
  };
  return json(buildAccountsResponse([account]));
};

/** CORS preflight for the credentialed assertion POST (echo the exact RP origin + credentials). */
export const onAssertionOptions = ({ request }: FnContext): Response => {
  const rpOrigin = request.headers.get('origin') ?? '';
  return new Response(null, {
    status: 204,
    headers: {
      ...assertionCorsHeaders(rpOrigin),
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
    },
  });
};

/** POST /fedcm/assertion (credentialed, form-encoded). Verify `Sec-Fetch-Dest`, the RP `Origin` against
 *  the registered client, and that the chosen account is the signed-in one; then mint the THIN id_token
 *  (the SAME AgentSession the relying app already verifies) with the FedCM nonce bound in. The deep
 *  capability/delegation object is issued by the SUBSTRATE after this (ADR-0031) — never here. */
export const onAssertion = async ({ request, env }: FnContext): Promise<Response> => {
  const rpOrigin = request.headers.get('origin') ?? '';
  const cors = assertionCorsHeaders(rpOrigin);
  if (!isWebIdentityRequest(request.headers.get('sec-fetch-dest'))) {
    return json(buildErrorResponse('invalid_request'), 400, cors);
  }
  const form = Object.fromEntries(new URLSearchParams(await request.text().catch(() => '')));
  const parsed = parseAssertionRequest(form);
  if (!parsed) return json(buildErrorResponse('invalid_request'), 400, cors);

  // Origin must be a registered origin of the client (the IdP can't learn the RP otherwise).
  const client = getClient(parsed.clientId);
  if (!client) return json(buildErrorResponse('unauthorized_client'), 400, cors);
  const clientOrigins = new Set(
    client.redirect_uris.map((u) => {
      try { return new URL(u).origin; } catch { return ''; }
    }),
  );
  if (!rpOrigin || !clientOrigins.has(rpOrigin)) {
    return json(buildErrorResponse('unauthorized_client'), 400, cors);
  }

  // The chosen account must be the signed-in one.
  const home = await verifyHomeSession(env, request);
  if (!home.ok) return json({ ...buildErrorResponse('access_denied'), reason: home.reason }, 401, cors);
  const hs = home.session;
  if (parsed.accountId.toLowerCase() !== hs.sub.toLowerCase()) {
    return json(buildErrorResponse('invalid_request'), 400, cors);
  }

  const { signer } = await getServer(env);
  const iss = resolveOrigin(request, env);
  const idToken = await mintIdToken(
    {
      iss,
      sub: hs.sub as Parameters<typeof mintIdToken>[0]['sub'],
      aud: parsed.clientId,
      ttlSeconds: ID_TOKEN_TTL,
      nonce: parsed.nonce,
      agentName: hs.name ?? undefined,
    },
    signer,
  );

  // Spec 264 §VII / ADR-0031: FedCM bootstraps IDENTITY (the thin id_token). For a relying app that needs
  // a scoped grant in the SAME ceremony (e.g. demo-gs's vault reads), mint the person→client delegation
  // HERE — the only point with custody access (the `ap_sso` cookie is SameSite=Lax, unreadable from a
  // cross-origin grant). Best-effort: a credential we can't sign with server-side (e.g. a passkey member)
  // → no delegation, and the relying app falls back to the popup. The delegation is still the substrate's
  // scoped, revocable authority object — just delivered alongside the bootstrap because custody is here.
  let delegation: unknown = null;
  let delegationError: string | undefined; // surfaced in the packed token for diagnosis (DevTools)
  const addr = addressFromSub(hs.sub);
  const viaLower = hs.via.toLowerCase();
  if (!addr) {
    delegationError = `sub_not_caip10:${hs.sub}`;
  } else if (!client.delegate) {
    delegationError = 'client_has_no_delegate';
  } else if (viaLower !== 'google' && viaLower !== 'wallet' && viaLower !== 'passkey') {
    delegationError = `unsupported_via:${viaLower || '(empty)'}`;
  } else {
    try {
      const auth: Auth | undefined = viaLower === 'google' ? { token: hs.custodyToken } : undefined;
      const perm = await givePermission({ address: addr, name: hs.name ?? '' } as Home, client.delegate, viaLower as Via, auth);
      if (perm.ok) delegation = perm.grant;
      else delegationError = `give_permission_failed:${perm.error}`;
    } catch (e) {
      delegationError = `give_permission_threw:${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // FedCM returns a single opaque `token` string; pack {id_token, delegation?} so the relying app gets
  // identity + the grant in one round-trip (it JSON-parses the token). On a delegation-mint failure we
  // pack `delegation_error` (visible in the assertion Network response) so the cause is diagnosable; the
  // relying app then has no grant → falls back to the popup.
  const packed = JSON.stringify(
    delegation ? { id_token: idToken, delegation } : { id_token: idToken, delegation_error: delegationError ?? 'unknown' },
  );
  const sl = loginStatusHeader('logged-in');
  return json(buildTokenResponse(packed), 200, { ...cors, [sl.name]: sl.value });
};
