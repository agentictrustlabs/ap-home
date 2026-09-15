// POST /token — single-use code exchange (CN-9; the token never appears in a URL).
//
// Two grants share this endpoint (the demo's two relying flows):
//
//   1. OIDC authorization_code + PKCE (spec 230 §4.3) — the relying app (demo-org) sends
//      { grant_type, code, code_verifier, client_id, redirect_uri }. We verify the PKCE
//      binding + the client/redirect bound at grant time, then return
//      { id_token, token_type, expires_in, delegation, org? }. Identity in the id_token;
//      authority in the delegation sidecar (ADR-0019). Cross-origin → CORS for the client.
//
//   2. Legacy code-exchange — the demo-sso self-login (Google / simulated /authorize) sends
//      { code, aud } and gets { agentSession }.
import { verifyPkceS256, mintIdToken } from '@agenticprimitives/connect';
import { toCanonicalAgentId } from '@agenticprimitives/identity-directory-adapters';
import { getServer, jsonCors as jsonCorsBase, preflight, resolveOrigin, type FnContext } from './_lib/server-broker';
import { verifyDelegation, type IncomingDelegation } from './_lib/verify-delegation';
import { clientAllowsRedirect } from '../src/lib/oidc-clients';
// Curated white-label entries AND member-registered ones (server/_lib/oidc-registry.ts).
import { resolveClient, isAllowedRelyingOriginAsync } from './_lib/oidc-registry';
import { CHAIN_ID } from '../src/lib/chain';
import { idTokenTtl } from './_lib/session-ttl';
import { nameClaimForIdToken } from '../src/lib/new-member';


interface TokenBody {
  grant_type?: string;
  code?: string;
  code_verifier?: string;
  client_id?: string;
  redirect_uri?: string;
  aud?: string;
  // Silent re-auth (ADR-0019): a held, live delegation → an id_token, no passkey ceremony.
  delegation?: IncomingDelegation;
  agent_name?: string;
}

// The preflight must answer for member-registered origins too. Resolving the verdict here (one
// KV read) and handing it to the sync helper keeps `corsHeaders` synchronous for its ~200 other
// call sites, which is the only reason this endpoint reads a little unusual.
export const onRequestOptions = async ({ request, env }: FnContext): Promise<Response> =>
  preflight(request, await isAllowedRelyingOriginAsync(env, request.headers.get('Origin') ?? ''));

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  // Resolve the CORS verdict ONCE for this request — including the member-registered registry —
  // and shadow `jsonCors` with a bound form, so every response below reflects the same decision
  // without threading a flag through twenty call sites.
  const dynamicOrigin = await isAllowedRelyingOriginAsync(env, request.headers.get('Origin') ?? '');
  const jsonCors = (body: unknown, req: Request, status = 200): Response =>
    jsonCorsBase(body, req, status, dynamicOrigin);

  // One lifetime for this request: the minted token, and any KV binding that must not outlive it.
  const ttl = idTokenTtl(env);
  const body = (await request.json().catch(() => ({}))) as TokenBody;

  // ── Delegation grant — silent re-auth (spec 230 / ADR-0019; SEC-002 closure) ──
  // A relying site that already HOLDS a live, in-window delegation gets a fresh id_token
  // with NO popup/passkey ceremony. The broker verifies (a) the delegation ERC-1271s
  // against the delegator + is in window, (b) its `delegate` matches the registered
  // delegate for the requested client_id, AND (c) the delegation was ORIGINALLY granted
  // for THIS client (the `oidc-deleg:<digest>` binding written at /oidc/grant time —
  // closes cross-client replay).
  if ((body.grant_type === 'delegation' || (body.delegation && !body.code)) && body.client_id) {
    const client = await resolveClient(env, body.client_id);
    if (!client) return jsonCors({ error: `unknown client_id "${body.client_id}"` }, request, 400);
    if (body.redirect_uri && !clientAllowsRedirect(client, body.redirect_uri)) {
      return jsonCors({ error: 'redirect_uri not allowed for client' }, request, 400);
    }
    if (!body.delegation) return jsonCors({ error: 'delegation required' }, request, 400);

    // (b) Delegate binding: cheap reject before the on-chain ERC-1271 round-trip.
    if (body.delegation.delegate.toLowerCase() !== client.delegate.toLowerCase()) {
      return jsonCors({ error: 'delegation delegate does not match the registered client delegate' }, request, 401);
    }

    // (a) ERC-1271 + window.
    const v = await verifyDelegation(env, body.delegation);
    if (!v.ok) return jsonCors({ error: `delegation invalid: ${v.reason}` }, request, 400);

    // (c) Client binding (SEC-002): the canonical EIP-712 digest must map to THIS client.
    const bindKey = `oidc-deleg:${v.digest.toLowerCase()}`;
    const bindRaw = await env.AUTH_CODES.get(bindKey);
    if (!bindRaw) {
      // This delegation was never minted through /oidc/grant on this broker (or the
      // binding has expired). Force the client to re-enroll instead of silently
      // accepting an unknown delegation.
      return jsonCors({ error: 'no enrollment binding for this delegation; re-enroll required' }, request, 401);
    }
    const bind = JSON.parse(bindRaw) as { client_id: string; agent_name?: string; profile_name?: string; profile_email?: string };
    if (bind.client_id !== body.client_id) {
      return jsonCors({ error: 'delegation was issued for a different client; re-enroll required' }, request, 401);
    }

    const iss = resolveOrigin(request, env);
    const { signer } = await getServer(env);
    const idToken = await mintIdToken(
      {
        iss,
        sub: toCanonicalAgentId(CHAIN_ID, body.delegation.delegator),
        aud: body.client_id,
        // Same rule as /oidc/grant: the `<label>.me` handle when there is one, the member's human
        // profile name when there isn't, nothing when there is neither.
        agentName: nameClaimForIdToken(body.agent_name ?? bind.agent_name, bind.profile_name),
        // Whatever /oidc/grant was permitted to mint, this mints too — the binding is the record of
        // what that client was allowed, and re-deciding it here from a request body would be a
        // second gate that could disagree with the first.
        ...(bind.profile_email ? { email: bind.profile_email } : {}),
        ttlSeconds: ttl,
      },
      signer,
    );
    // Refresh the binding window so a steadily-used delegation doesn't fall off the
    // cliff mid-session (same TTL semantics as the id_token).
    await env.AUTH_CODES.put(bindKey, bindRaw, { expirationTtl: ttl });
    return jsonCors(
      {
        id_token: idToken,
        token_type: 'Bearer',
        expires_in: ttl,
        delegation: body.delegation,
        // Same distinct field the authorization_code branch returns, so an app reads the human name
        // the same way on a refresh as on the first connect.
        ...(bind.profile_name ? { profile_name: bind.profile_name } : {}),
      },
      request,
    );
  }

  // ── OIDC authorization_code grant (spec 230) ──
  if (body.grant_type === 'authorization_code' || body.code_verifier) {
    if (!body.code || !body.code_verifier || !body.client_id || !body.redirect_uri) {
      return jsonCors({ error: 'code, code_verifier, client_id, redirect_uri required' }, request, 400);
    }
    const key = `oidc:${body.code}`;
    const raw = await env.AUTH_CODES.get(key);
    await env.AUTH_CODES.delete(key); // single-use, regardless of outcome
    if (!raw) return jsonCors({ error: 'invalid or already-used code' }, request, 400);
    const grant = JSON.parse(raw) as {
      id_token: string;
      delegation: unknown;
      sessionDelegation?: unknown;
      paymentDelegation?: unknown;
      pullDelegation?: unknown;
      settlementHash?: string;
      treasury?: string | null;
      selfVaultGrant?: unknown;
      org: unknown;
      /** The member's human profile name, when the client is registry-scoped for `profile`. */
      profile_name?: string;
      code_challenge: string;
      client_id: string;
      redirect_uri: string;
    };
    if (grant.client_id !== body.client_id) return jsonCors({ error: 'client_id mismatch' }, request, 400);
    if (grant.redirect_uri !== body.redirect_uri) return jsonCors({ error: 'redirect_uri mismatch' }, request, 400);
    if (!(await verifyPkceS256(body.code_verifier, grant.code_challenge))) {
      return jsonCors({ error: 'PKCE verification failed' }, request, 400);
    }
    return jsonCors(
      {
        id_token: grant.id_token,
        token_type: 'Bearer',
        expires_in: ttl,
        delegation: grant.delegation ?? undefined,
        sessionDelegation: grant.sessionDelegation ?? undefined, // spec 270 v4 W2 — the DEL-001 leaf
        paymentDelegation: grant.paymentDelegation ?? undefined, // spec 272/243 — x402 payment delegation
        pullDelegation: grant.pullDelegation ?? undefined, // spec 272 recurring — standing subscription pull mandate
        settlementHash: grant.settlementHash ?? undefined, // spec 272 — first-charge settlement (ceremony)
        selfVaultGrant: grant.selfVaultGrant ?? undefined, // spec 345 — the person's own scoped vault grant
        // The member's HUMAN name (what they are called), for a client the registry scopes for
        // `profile`. Present as its own field so an app can tell it apart from the `agent_name`
        // CLAIM, which carries the `<label>.me` handle when there is one and falls back to this
        // name when there isn't (see /oidc/grant). Omitted entirely for every unscoped client.
        ...(grant.profile_name ? { profile_name: grant.profile_name } : {}),
        // PRIVACY: the person-treasury ADDRESS is intentionally NOT returned to the relying app. The home
        // owns the treasury question during a purchase; the app gates on access/subscription, not the wallet.
        ...(grant.org ? { org: grant.org } : {}),
      },
      request,
    );
  }

  // ── Legacy code-exchange (demo-sso self-login: Google / simulated) ──
  if (!body.code || !body.aud) return jsonCors({ error: 'code + aud are required' }, request, 400);
  const key = `code:${body.code}`;
  const raw = await env.AUTH_CODES.get(key);
  await env.AUTH_CODES.delete(key);
  if (!raw) return jsonCors({ error: 'invalid or already-used code' }, request, 400);
  const { token, aud } = JSON.parse(raw) as { token: string; aud: string };
  if (aud !== body.aud) return jsonCors({ error: 'aud mismatch' }, request, 400);
  return jsonCors({ agentSession: token }, request);
};
