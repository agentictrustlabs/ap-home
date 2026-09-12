// GET /me/profile      → basic profile (any valid AgentSession; login-grade OK)
// GET /me/sensitive    → sensitive PII (custody-grade only; else 403 step-up)
//
// The demo's "person MCP": served from the Connect origin, it verifies the
// SAME-origin AgentSession against the broker's published JWKS (connect's
// importJwks + verifyAgentSession — app-layer verify per spec 227 §7/U1), then
// gates on the session's assurance (P1-E). Token via `Authorization: Bearer` or
// `?token=`. Exact `aud` match (P1-F); fail-closed everywhere.
import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import { AgentAccountClient } from '@agenticprimitives/agent-account';
import type { Address } from '@agenticprimitives/types';
import { getServer, json, type FnContext } from '../_lib/server-broker';
import { isOwnConnectOrigin } from '../_lib/origin';
import { basicProfile, sensitivePii } from '../../src/lib/pii';
import { CHAIN_ID, CONTRACTS, DEFAULT_RPC_URL } from '../../src/lib/chain';

/** Parse the SA address out of a CAIP-10 `eip155:<chain>:0x…` subject; null if it isn't one. */
function addressFromSub(sub: string | undefined): Address | null {
  if (!sub || !/^eip155:\d+:0x[0-9a-fA-F]{40}$/.test(sub)) return null;
  return sub.split(':').pop() as Address;
}

/** The person MCP's own audience (same-origin demo; the server-client mints with this aud). */
const AUD = 'demo-sso';

// isOwnConnectOrigin moved to server/_lib/origin.ts (shared with every /connect/* session
// verifier via ownIssuer) — the Google-session cross-origin rationale lives there now.

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const url = new URL(request.url);
  const iss = url.origin; // the Connect origin that issued the token
  const bearer = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const token = bearer || url.searchParams.get('token') || '';
  if (!token) return json({ error: 'AgentSession bearer token required' }, 401);

  const { jwks, directory } = await getServer(env);
  const keys = await importJwks(jwks);

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
    let deployedError: string | undefined;
    const addr = addressFromSub(session.sub);
    if (addr) {
      // `||`, not `??`: a Vercel secret stored EMPTY ("") is not an absent variable, and an empty rpcUrl fails every
      // read — which this endpoint then reported as "not deployed", trapping a deployed member at secure-home.
      const rpcUrl = env.RPC_URL || DEFAULT_RPC_URL;
      try {
        const accounts = new AgentAccountClient({ rpcUrl, chainId: CHAIN_ID, entryPoint: CONTRACTS.entryPoint, factory: CONTRACTS.agentAccountFactory });
        deployed = await accounts.isDeployed(addr);
      } catch (e) {
        // ADR-0013 — a failed read is SAID, never read as an answer. The gate keeps the member out of the portal
        // (it cannot know) but shows the reason and a retry instead of a "You're in." that leads nowhere.
        deployed = false;
        deployedError = `the chain could not be read (${e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160)})`;
        console.warn('[me/profile] isDeployed failed:', deployedError);
      }
    }
    return json({ profile: basicProfile(session, name, deployed, deployedError) });
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
