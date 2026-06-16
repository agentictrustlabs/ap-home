// GET /me/profile      → basic profile (any valid AgentSession; login-grade OK)
// GET /me/sensitive    → sensitive PII (custody-grade only; else 403 step-up)
//
// The demo's "person MCP": served from the Connect origin, it verifies the
// SAME-origin AgentSession against the broker's published JWKS (connect's
// importJwks + verifyAgentSession — app-layer verify per spec 227 §7/U1), then
// gates on the session's assurance (P1-E). Token via `Authorization: Bearer` or
// `?token=`. Exact `aud` match (P1-F); fail-closed everywhere.
import { importJwks, verifyAgentSession, verifyIdToken } from '@agenticprimitives/connect';
import { AgentAccountClient } from '@agenticprimitives/agent-account';
import type { Address } from '@agenticprimitives/types';
import { getServer, json, type FnContext } from '../_lib/server-broker';
import { basicProfile, sensitivePii } from '../../src/lib/pii';
import { CONNECT_DOMAIN } from '../../src/lib/domain';
import { CHAIN_ID, CONTRACTS, DEFAULT_RPC_URL } from '../../src/lib/chain';
import { whitelabel } from '../../src/whitelabel/config';

/** Parse the SA address out of a CAIP-10 `eip155:<chain>:0x…` subject; null if it isn't one. */
function addressFromSub(sub: string | undefined): Address | null {
  if (!sub || !/^eip155:\d+:0x[0-9a-fA-F]{40}$/.test(sub)) return null;
  return sub.split(':').pop() as Address;
}

/** The person MCP's own audience (same-origin demo; the server-client mints with this aud). */
const AUD = 'demo-sso';

/** Registered relying-app audiences (their OIDC `client_id`s). Used ONLY by the `owner-profile` route to
 *  recognize an owner-op ceremony (content-signer / subscription-collect) from the relying-app id_token it
 *  forwards, when no same-origin demo-sso cookie is present. Recognition only ROUTES the ceremony; the real
 *  authorization is the owner-signed delegation leaf + each owner-gated a2a call's own verifyIdToken. */
const RELYING_APP_AUDS: string[] = whitelabel.relyingApps.map((a) => a.client_id);

/**
 * Is `origin` one of THIS site's own Connect origins (ADR-0021 app policy)? The apex + per-handle
 * `https://<label>.<CONNECT_DOMAIN>` homes (spec 232). A Google session is minted on the central
 * origin (the Google callback runs there) but consumed on the member's subdomain — same broker
 * key + JWKS, same registrable domain — so its `iss` is trusted here even when it isn't the exact
 * request origin. https + a single DNS label only.
 */
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

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const url = new URL(request.url);
  const iss = url.origin; // the Connect origin that issued the token
  const bearer = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const token = bearer || url.searchParams.get('token') || '';
  if (!token) return json({ error: 'AgentSession bearer token required' }, 401);

  const { jwks, directory } = await getServer(env);
  const keys = await importJwks(jwks);

  // OWNER-OP RECOGNITION (spec 266 content-signer / spec 272 subscription-collect): the bearer is a
  // RELYING-APP OIDC id_token (aud = the app's client_id), forwarded by the ceremony when no same-origin
  // demo-sso cookie is present at the ceremony origin. It is a plain id_token (mintIdToken: iss/sub/aud/
  // agent_name) — NOT an AgentSession — so verify it with verifyIdToken against the token's OWN aud,
  // gated to a REGISTERED relying app + an own-Connect issuer. Return the owner profile so the ceremony
  // can recognize + custody-route. This only ROUTES — the real authorization is the owner-signed SA→key
  // delegation leaf (only the SA's custodian can produce it) + each owner-gated a2a call's verifyIdToken.
  if (url.pathname.replace(/^\/me\/?/, '') === 'owner-profile') {
    let pre: { iss?: string; aud?: string };
    try { pre = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')); } catch { return json({ error: 'malformed token' }, 401); }
    if (!pre.iss || !(pre.iss === iss || isOwnConnectOrigin(pre.iss))) return json({ error: 'issuer not trusted' }, 401);
    if (!pre.aud || !RELYING_APP_AUDS.includes(pre.aud)) return json({ error: 'aud is not a registered relying app' }, 401);
    const rv = await verifyIdToken(token, { keys, expectedIss: pre.iss, expectedAud: pre.aud });
    if (!rv.ok) return json({ error: `invalid owner token: ${rv.reason}` }, 401);
    const addr = addressFromSub(rv.claims.sub);
    if (!addr) return json({ error: 'token sub is not a CAIP-10 SA' }, 401);
    let deployed = false;
    try {
      deployed = await new AgentAccountClient({ rpcUrl: env.RPC_URL ?? DEFAULT_RPC_URL, chainId: CHAIN_ID, entryPoint: CONTRACTS.entryPoint, factory: CONTRACTS.agentAccountFactory }).isDeployed(addr);
    } catch { deployed = false; }
    let nm: string | null = (rv.claims as { agent_name?: string }).agent_name ?? null;
    if (!nm) { try { nm = (await directory.agent(rv.claims.sub))?.facets?.name ?? null; } catch { nm = null; } }
    // The OIDC id_token carries no credential kind. Owner-op SERVICE-AGENT custodians sign the SA→key leaf
    // CLIENT-SIDE via their wallet (SIWE/EOA) — route to the wallet signer. (passkey/social owner-op
    // custodians would need the credential carried explicitly; not used by the demo's service agents.)
    return json({ profile: { agent: rv.claims.sub, name: nm, credential: 'siwe-eoa', access: 'standard', deployed } });
  }

  // Verify signature/alg/aud/exp/owner (the alg-pin rejects HS256 BrokerSession tokens), then
  // accept the issuer if it's the request origin OR one of our own Connect origins — a Google
  // session is minted on the central origin but consumed on the member's per-handle subdomain.
  const v = await verifyAgentSession(token, { keys, expectedAud: AUD, expectedIss: (i) => i === iss || isOwnConnectOrigin(i) });
  if (!v.ok) return json({ error: `invalid AgentSession: ${v.reason}` }, 401);
  const session = v.session;
  if (session.iss !== iss && !isOwnConnectOrigin(session.iss)) {
    return json({ error: 'invalid AgentSession: issuer not trusted' }, 401);
  }

  // Best-effort .demo.agent name for the basic profile (on-chain reverse-resolve).
  let name: string | null = null;
  try {
    const view = await directory.agent(session.sub);
    name = view?.facets?.name ?? null;
  } catch {
    name = null;
  }

  const route = url.pathname.replace(/^\/me\/?/, '');
  if (route === '' || route === 'profile') {
    // spec 257 Phase 1.5 — is the SA actually deployed? A fresh Google session's `sub` is a
    // counterfactual SA; the portal gate routes to secure-home only while this is false. A nameless
    // deployed home reads `{ deployed: true, name: null }` → portal. Single read (ADR-0012); a
    // false default on RPC error is safe (the gate's secure-home call is idempotent for an
    // already-deployed SA — it short-circuits) and never traps a deployed member.
    let deployed = false;
    const addr = addressFromSub(session.sub);
    if (addr) {
      try {
        const accounts = new AgentAccountClient({
          rpcUrl: env.RPC_URL ?? DEFAULT_RPC_URL,
          chainId: CHAIN_ID,
          entryPoint: CONTRACTS.entryPoint,
          factory: CONTRACTS.agentAccountFactory,
        });
        deployed = await accounts.isDeployed(addr);
      } catch {
        deployed = false;
      }
    }
    return json({ profile: basicProfile(session, name, deployed) });
  }
  if (route === 'sensitive') {
    const pii = sensitivePii(session);
    if (!pii) {
      return json(
        {
          error: 'step_up_required',
          reason:
            'Your contact details are protected — confirm with your device (a custody-grade sign-in) to view them. (ADR-0017 / CN-2)',
          access: session.assurance,
        },
        403,
      );
    }
    return json({ sensitive: pii });
  }
  return json({ error: 'unknown route' }, 404);
};
