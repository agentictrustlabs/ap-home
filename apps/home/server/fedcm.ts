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
import type { Address, CredentialPrincipal } from '@agenticprimitives/types';
import { whitelabel } from '../src/whitelabel/config';
import { getClient, isAllowedRelyingOrigin } from '../src/lib/oidc-clients';
import { CONNECT_DOMAIN } from '../src/lib/domain';
import { signBridgeCall } from './_lib/bridge-hmac';
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
interface HomeSession { sub: string; name: string | null; via: string; custodyToken: string; principal: CredentialPrincipal }
type VerifyHome = { ok: true; session: HomeSession } | { ok: false; reason: string };

async function verifyHomeSession(env: FnContext['env'], request: Request): Promise<VerifyHome> {
  const sso = readSso(request);
  if (!sso) return { ok: false, reason: 'no_ap_sso_cookie' }; // cookie not sent (SameSite) OR not signed in
  const token = sso.token;
  const { jwks, directory } = await getServer(env);
  const keys = await importJwks(jwks);
  // CN-1: the home accepts a session minted by THIS request origin OR any of its own Connect
  // origins (the personal-subdomain wildcard). Pass that allowlist predicate so the verifier
  // enforces the issuer binding (expectedIss is now required).
  const reqOrigin = resolveOrigin(request, env);
  const expectedIss = (iss: string) => iss === reqOrigin || isOwnConnectOrigin(iss);
  // The home session token's aud is the home's own; if a session was minted with a different aud, retry
  // with the token's own aud (the signature is still verified, so this can't be forged).
  let v = await verifyAgentSession(token, { keys, expectedAud: HOME_AUD, expectedIss });
  if (!v.ok) {
    const selfAud = decodeAud(token);
    if (selfAud && selfAud !== HOME_AUD) v = await verifyAgentSession(token, { keys, expectedAud: selfAud, expectedIss });
  }
  if (!v.ok) return { ok: false, reason: `session_verify_failed:${v.reason ?? 'unknown'}` };
  const session = v.session;
  let name: string | null = null;
  try {
    const view = await directory.agent(session.sub);
    name = view?.facets?.name ?? null;
  } catch {
    name = null;
  }
  // Return the VERIFIED `principal` (kind + role, from the signed AgentSession) so the grant endpoint
  // routes custody on cryptographically-trusted data — NOT the client-controlled `via` cookie field
  // (H-1). `via` is kept only as a display/label hint.
  return { ok: true, session: { sub: session.sub, name, via: sso.via, custodyToken: sso.token, principal: session.principal } };
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

  // ADR-0031/0032: the FedCM token is a THIN identity bootstrap — the same AgentSession id_token the
  // relying app already verifies — and NOTHING else. The scoped person→client delegation is issued by
  // the SEPARATE substrate grant endpoint (`/fedcm/grant`, below), authorized by THIS id_token, after
  // the chooser. FedCM is the identity adapter; it is NEVER the capability/delegation substrate.
  const sl = loginStatusHeader('logged-in');
  return json(buildTokenResponse(idToken), 200, { ...cors, [sl.name]: sl.value });
};

// ─── Substrate grant: id_token → scoped delegation (ADR-0032) ─────────────────

/** CORS for the credentialed `/fedcm/grant` POST (echo the exact RP origin + credentials). Mirrors the
 *  assertion CORS — the call is a normal cross-site credentialed fetch from the relying app. */
function grantCors(rpOrigin: string): Record<string, string> {
  return assertionCorsHeaders(rpOrigin);
}

/** CORS preflight for `/fedcm/grant` (JSON body → non-simple request → preflighted). */
export const onFedcmGrantOptions = ({ request }: FnContext): Response => {
  const rpOrigin = request.headers.get('origin') ?? '';
  // L-1: only advertise CORS to a REGISTERED relying origin.
  return new Response(null, {
    status: 204,
    headers: {
      ...(isAllowedRelyingOrigin(rpOrigin) ? grantCors(rpOrigin) : {}),
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
    },
  });
};

/** POST /fedcm/grant (credentialed, JSON `{ id_token, client_id }`). The SUBSTRATE step that follows a
 *  FedCM assertion (ADR-0031/0032). The relying app presents the THIN id_token it just received, and we:
 *
 *  1. Verify that id_token is one WE minted for THIS client. This is the authorization — NOT the cookie.
 *     `ap_sso` is `SameSite=None`, so a bare credentialed POST is CSRF-harvestable by any site; only a
 *     site the user actually picked in the browser's FedCM chooser holds an `aud`-bound id_token (the
 *     browser binds `aud` to the requesting origin, and we re-check `Origin ∈ client origins`).
 *  2. Read the home session from the cookie purely to reach CUSTODY (the Google `via` + custody token),
 *     and require it to be the SAME subject as the id_token.
 *  3. Custody boundary: a SERVER-custodied member (Google/KMS) gets the `person → client.delegate` site
 *     delegation minted server-side via the bridge-authenticated demo-a2a KMS sign — ZERO device prompt.
 *     A DEVICE-custodied member (passkey/wallet) gets `needs_device_credential` and the relying app
 *     falls back to the popup, where the device signs the delegation (we cannot sign a device key here).
 *
 *  The delegation is the substrate's scoped, revocable, value-0 authority object — issued HERE, never as
 *  a FedCM payload. */
export const onFedcmGrant = async ({ request, env }: FnContext): Promise<Response> => {
  const rpOrigin = request.headers.get('origin') ?? '';
  // L-1: reflect CORS ONLY for a REGISTERED relying origin — never echo `Access-Control-Allow-Origin` to
  // an arbitrary caller. (The exact client_id↔origin match is still enforced below; this is the coarse
  // gate so an unknown origin can't read any response body.)
  const cors = isAllowedRelyingOrigin(rpOrigin) ? grantCors(rpOrigin) : {};
  const body = (await request.json().catch(() => null)) as { id_token?: string; client_id?: string } | null;

  // M-3 (audit AC-0032): this is the only NEW browser-reachable authority-issuance surface, so EVERY
  // decision leaves a structured broker-side trail (the bridge sign leg emits `key-custody.sign` on the
  // a2a side; this is the broker-side complement). The subject (CAIP-10 SA address) is the canonical
  // PUBLIC identifier (ADR-0010), not PII — safe to log. Replays (id_token within TTL) are visible here.
  const audit = (outcome: string, extra: Record<string, unknown> = {}): void => {
    try {
      console.log(JSON.stringify({ evt: 'fedcm.grant', outcome, rpOrigin, client_id: body?.client_id ?? null, ...extra }));
    } catch {
      /* never let logging break the response */
    }
  };

  if (!body?.id_token || !body?.client_id) {
    audit('reject', { reason: 'missing_id_token_or_client_id' });
    return json({ error: 'id_token + client_id required' }, 400, cors);
  }

  // The RP must be a registered client, and the request Origin one of its registered origins.
  const client = getClient(body.client_id);
  if (!client) {
    audit('reject', { reason: 'unknown_client' });
    return json({ error: 'unauthorized_client' }, 400, cors);
  }
  const clientOrigins = new Set(
    client.redirect_uris.map((u) => {
      try { return new URL(u).origin; } catch { return ''; }
    }),
  );
  if (!rpOrigin || !clientOrigins.has(rpOrigin)) {
    audit('reject', { reason: 'origin_not_registered' });
    return json({ error: 'unauthorized_client' }, 403, cors);
  }

  // 1. The id_token must be one WE minted for THIS client (proof of the browser-mediated FedCM chooser).
  const { jwks } = await getServer(env);
  const keys = await importJwks(jwks);
  const iss = resolveOrigin(request, env);
  const v = await verifyAgentSession(body.id_token, { keys, expectedAud: body.client_id, expectedIss: iss });
  if (!v.ok) {
    audit('reject', { reason: `id_token_invalid:${v.reason ?? 'unknown'}` });
    return json({ error: `id_token_invalid:${v.reason ?? 'unknown'}` }, 401, cors);
  }
  const tokenSub = v.session.sub;

  // 2. The cookie home session (custody) must be the SAME subject as the id_token.
  const home = await verifyHomeSession(env, request);
  if (!home.ok) {
    audit('reject', { reason: `no_session:${home.reason}`, sub: tokenSub });
    return json({ error: `no_session:${home.reason}` }, 401, cors);
  }
  const hs = home.session;
  if (hs.sub.toLowerCase() !== tokenSub.toLowerCase()) {
    audit('reject', { reason: 'subject_mismatch', sub: tokenSub, cookieSub: hs.sub });
    return json({ error: 'subject_mismatch' }, 403, cors);
  }

  const addr = addressFromSub(hs.sub);
  if (!addr) {
    audit('reject', { reason: 'sub_not_caip10', sub: hs.sub });
    return json({ error: `sub_not_caip10:${hs.sub}` }, 400, cors);
  }
  if (!client.delegate) {
    audit('reject', { reason: 'client_has_no_delegate', sub: hs.sub });
    return json({ error: 'client_has_no_delegate' }, 409, cors);
  }

  // 3. Custody boundary (H-1) — decide on the VERIFIED principal (kind + role, from the signed
  //    AgentSession), NOT the client-controlled cookie `via`. Only a custody-grade OIDC credential
  //    (Google/YouVersion, KMS-custodied) is signable server-side; device credentials (passkey/wallet)
  //    and login-grade sessions must sign on-device → popup fallback. The demo-a2a bridge re-verifies
  //    custody-grade independently, so this is the trusted FIRST gate, not the only one.
  const serverCustodied = hs.principal.kind === 'oidc' && hs.principal.role === 'custody-grade';
  if (!serverCustodied) {
    audit('needs_device_credential', { sub: hs.sub, kind: hs.principal.kind, role: hs.principal.role ?? null });
    return json({ needs_device_credential: true, via: hs.via.toLowerCase() || 'unknown' }, 200, cors);
  }

  // M-2: consume the id_token's one-time `nonce` (unique per FedCM ceremony) so a captured id_token can't
  // be replayed for a second delegation within its TTL. Best-effort single-use via KV.
  const nonce = (v.session as unknown as { nonce?: string }).nonce;
  if (!nonce) {
    audit('reject', { reason: 'id_token_missing_nonce', sub: hs.sub });
    return json({ error: 'id_token_missing_nonce' }, 401, cors);
  }
  const nonceKey = `fedcm-grant-nonce:${nonce}`;
  if (await env.AUTH_CODES.get(nonceKey)) {
    audit('reject', { reason: 'nonce_replayed', sub: hs.sub });
    return json({ error: 'nonce_replayed' }, 409, cors);
  }
  await env.AUTH_CODES.put(nonceKey, '1', { expirationTtl: ID_TOKEN_TTL });

  if (!env.A2A_CUSTODY_URL || !env.A2A_CUSTODY_BRIDGE_SECRET) {
    audit('error', { reason: 'custody_bridge_not_configured', sub: hs.sub });
    return json({ error: 'custody_bridge_not_configured' }, 503, cors);
  }
  try {
    // Bridge-authenticated, CONSTRAINED sign: the worker BUILDS the person→delegate site delegation and
    // C_sub signs THAT (never an arbitrary hash). The custody token proves the member; the HMAC envelope
    // proves the broker. A broker compromise can at worst mint a scoped, value-0, revocable delegation.
    const envelope = await signBridgeCall({
      secret: env.A2A_CUSTODY_BRIDGE_SECRET,
      audience: 'custody.google.sign-delegation',
      payload: { custodyToken: hs.custodyToken, delegate: client.delegate, sender: addr },
    });
    const res = await fetch(`${env.A2A_CUSTODY_URL.replace(/\/$/, '')}/custody/google/sign-site-delegation`, {
      method: 'POST',
      headers: envelope.headers,
      body: envelope.body,
    });
    const out = (await res.json().catch(() => ({}))) as { ok?: boolean; delegation?: unknown; error?: string };
    if (!res.ok || !out.ok || !out.delegation) {
      audit('error', { reason: `bridge_sign_failed:${out.error ?? res.status}`, sub: hs.sub, delegate: client.delegate });
      return json({ error: out.error ?? `sign HTTP ${res.status}` }, 502, cors);
    }
    audit('granted', { sub: hs.sub, delegate: client.delegate });
    const sl = loginStatusHeader('logged-in');
    return json({ delegation: out.delegation }, 200, { ...cors, [sl.name]: sl.value });
  } catch (e) {
    audit('error', { reason: `grant_threw:${e instanceof Error ? e.message : String(e)}`, sub: hs.sub });
    return json({ error: `grant_failed:${e instanceof Error ? e.message : String(e)}` }, 500, cors);
  }
};
