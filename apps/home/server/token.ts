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
import { getServer, jsonCors, preflight, resolveOrigin, type FnContext } from './_lib/server-broker';
import { verifyDelegation, type IncomingDelegation } from './_lib/verify-delegation';
import { getClient, clientAllowsRedirect } from '../src/lib/oidc-clients';
import { CHAIN_ID } from '../src/lib/chain';

const ID_TOKEN_TTL = 3600;

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

export const onRequestOptions = ({ request }: FnContext): Response => preflight(request);

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const body = (await request.json().catch(() => ({}))) as TokenBody;

  // ── Delegation grant — silent re-auth (spec 230 / ADR-0019; SEC-002 closure) ──
  // A relying site that already HOLDS a live, in-window delegation gets a fresh id_token
  // with NO popup/passkey ceremony. The broker verifies (a) the delegation ERC-1271s
  // against the delegator + is in window, (b) its `delegate` matches the registered
  // delegate for the requested client_id, AND (c) the delegation was ORIGINALLY granted
  // for THIS client (the `oidc-deleg:<digest>` binding written at /oidc/grant time —
  // closes cross-client replay).
  if ((body.grant_type === 'delegation' || (body.delegation && !body.code)) && body.client_id) {
    const client = getClient(body.client_id);
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
    const bind = JSON.parse(bindRaw) as { client_id: string; agent_name?: string };
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
        agentName: body.agent_name ?? bind.agent_name,
        ttlSeconds: ID_TOKEN_TTL,
      },
      signer,
    );
    // Refresh the binding window so a steadily-used delegation doesn't fall off the
    // cliff mid-session (same TTL semantics as the id_token).
    await env.AUTH_CODES.put(bindKey, bindRaw, { expirationTtl: ID_TOKEN_TTL });
    return jsonCors({ id_token: idToken, token_type: 'Bearer', expires_in: ID_TOKEN_TTL, delegation: body.delegation }, request);
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
      settlementHash?: string;
      org: unknown;
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
        expires_in: ID_TOKEN_TTL,
        delegation: grant.delegation ?? undefined,
        sessionDelegation: grant.sessionDelegation ?? undefined, // spec 270 v4 W2 — the DEL-001 leaf
        paymentDelegation: grant.paymentDelegation ?? undefined, // spec 272/243 — x402 payment delegation
        settlementHash: grant.settlementHash ?? undefined, // spec 272 — first-charge settlement (ceremony)
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
