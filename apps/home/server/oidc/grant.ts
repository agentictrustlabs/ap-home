// POST /oidc/grant — redeem a server-minted enrollment grant for an OIDC authorization
// code (spec 230 §4.2; SEC-001 + SEC-002 closure).
//
// The home SPA at /authorize first POSTs to /oidc/authorize-grant to obtain a `grant_id`
// bound to the validated client registry + the registered delegate. The SPA then runs
// the ROOT-credential ceremony to sign a delegation whose `delegate` equals that
// registered delegate. It POSTs HERE with { grant_id, delegation, org? }. We:
//
//   1. enforce same-origin (Origin === iss): non-SPA callers are rejected.
//   2. look up the bound grant by `grant_id` and DELETE it (single-use).
//   3. verify the supplied delegation — ERC-1271 against the delegator, the timestamp
//      window — and reject if its delegate, agent-name resolution, or template don't
//      match the stored grant.
//   4. mint the id_token + a single-use authorization code bound to the grant's PKCE
//      challenge + client_id + redirect_uri, AND record `oidc-deleg:<digest> → client_id`
//      so the silent-reauth path at /token cannot mint id_tokens for the wrong client
//      (SEC-002).
//
// The OIDC code (not the token) is what travels back in the redirect/popup; /token does
// the PKCE exchange.

import { mintIdToken, newAuthCode } from '@agenticprimitives/connect';
import { toCanonicalAgentId } from '@agenticprimitives/identity-directory-adapters';
import { getServer, json, resolveOrigin, type FnContext } from '../_lib/server-broker';
import { verifyDelegation, type IncomingDelegation } from '../_lib/verify-delegation';
import { CHAIN_ID } from '../../src/lib/chain';
import type { StoredEnrollmentGrant } from './authorize-grant';

const ID_TOKEN_TTL = 3600; // session-usable for the demo (the relying app treats it as the session)
const CODE_TTL_MS = 300_000; // 5 min PKCE exchange window
const DELEG_BIND_TTL_SEC = 3600; // matches id_token TTL; renewed on each silent re-auth grant

interface GrantBody {
  grant_id?: string;
  delegation?: IncomingDelegation;
  org?: unknown;
  /** spec 270 v4 W2 — the DEL-001 leaf the home signed for the relying app's session key. */
  sessionDelegation?: unknown;
}

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  // SEC-001 (origin check): /oidc/grant is reachable ONLY from the home SPA. A
  // non-browser caller, or a cross-origin browser caller, is rejected here.
  const iss = resolveOrigin(request, env);
  const reqOrigin = request.headers.get('origin');
  if (!reqOrigin || reqOrigin !== iss) {
    return json({ error: 'grant must be called from the home origin' }, 403);
  }

  const body = (await request.json().catch(() => null)) as GrantBody | null;
  if (!body?.grant_id || !body.delegation) {
    return json({ error: 'grant_id + delegation required' }, 400);
  }

  // Look up the server-bound grant (single-use: delete-after-read).
  const grantKey = `oidc-grant:${body.grant_id}`;
  const raw = await env.AUTH_CODES.get(grantKey);
  await env.AUTH_CODES.delete(grantKey);
  if (!raw) return json({ error: 'invalid or already-used grant_id' }, 400);
  const grant = JSON.parse(raw) as StoredEnrollmentGrant;

  // Delegate binding: the supplied delegation's `delegate` MUST equal the delegate
  // recorded at /authorize-grant time (which came from the OIDC client registry, NOT
  // from the request). This closes the "attacker chooses delegate" attack.
  if (body.delegation.delegate.toLowerCase() !== grant.delegate.toLowerCase()) {
    return json({ error: 'delegation delegate does not match the registered client delegate' }, 401);
  }

  // ERC-1271 + timestamp-window verification. On success returns the canonical EIP-712
  // digest, which we use as the silent-reauth binding key.
  const v = await verifyDelegation(env, body.delegation);
  if (!v.ok) return json({ error: `delegation proof failed: ${v.reason}` }, 401);

  // Mint the id_token bound to the grant's client + nonce + agent_name.
  const sub = toCanonicalAgentId(CHAIN_ID, body.delegation.delegator);
  const { signer } = await getServer(env);
  const idToken = await mintIdToken(
    {
      iss,
      sub,
      aud: grant.client_id,
      nonce: grant.nonce || undefined,
      agentName: grant.agent_name,
      ttlSeconds: ID_TOKEN_TTL,
    },
    signer,
  );

  // SEC-002 closure: bind the canonical delegation digest to its originating client.
  // /token grant_type=delegation re-verifies that any silent-reauth request with this
  // delegation matches this client_id, so a leaked delegation can't be replayed to
  // mint id_tokens for a DIFFERENT relying app.
  await env.AUTH_CODES.put(
    `oidc-deleg:${v.digest.toLowerCase()}`,
    JSON.stringify({ client_id: grant.client_id, agent_name: grant.agent_name }),
    { expirationTtl: DELEG_BIND_TTL_SEC },
  );

  // ADR-0025 / spec 246: persist the private related-agent link into the person's
  // vault (Connect-home KV) during this authenticated, home-origin-only ceremony.
  // `requestedBy` is the SERVER-authoritative client_id (not from the request body).
  // The relying app later reads it back via /connect/related-orgs (person-session-auth).
  const orgPayload = body.org as {
    orgAgent?: string; orgName?: string; person?: string; purpose?: string;
    proofHash?: string; credential?: unknown; brokerDelegation?: { delegate?: string } | null;
    membershipDelegation?: unknown; stewardshipDelegation?: unknown;
  } | null;
  if (orgPayload?.orgAgent && orgPayload.person) {
    const person = orgPayload.person.toLowerCase();
    const org = orgPayload.orgAgent.toLowerCase();
    const link = {
      orgAgent: orgPayload.orgAgent,
      orgName: orgPayload.orgName ?? '',
      purpose: orgPayload.purpose ?? 'related-org',
      requestedBy: grant.client_id,
      siteDelegation: body.delegation,
      brokerDelegation: orgPayload.brokerDelegation ?? null,
      // spec 246 — person↔org read delegations: membership (person→org, org reads its
      // member) + stewardship (org→person, person reads/oversees the org).
      membershipDelegation: orgPayload.membershipDelegation ?? null,
      stewardshipDelegation: orgPayload.stewardshipDelegation ?? null,
      proofHash: orgPayload.proofHash ?? null,
      credential: orgPayload.credential ?? null,
      createdAt: Date.now(),
    };
    await env.AUTH_CODES.put(`related:${person}:${org}`, JSON.stringify(link));
    const idxKey = `related-idx:${person}`;
    const idx = JSON.parse((await env.AUTH_CODES.get(idxKey)) ?? '[]') as string[];
    if (!idx.includes(org)) { idx.push(org); await env.AUTH_CODES.put(idxKey, JSON.stringify(idx)); }
    const bd = orgPayload.brokerDelegation;
    if (bd?.delegate) {
      const dKey = `delegated-idx:${bd.delegate.toLowerCase()}`;
      const dIdx = JSON.parse((await env.AUTH_CODES.get(dKey)) ?? '[]') as Array<{ orgAgent: string; orgName: string; delegation: unknown }>;
      if (!dIdx.some((x) => x.orgAgent.toLowerCase() === org)) {
        dIdx.push({ orgAgent: orgPayload.orgAgent, orgName: orgPayload.orgName ?? '', delegation: bd });
        await env.AUTH_CODES.put(dKey, JSON.stringify(dIdx));
      }
    }
  }

  // Stash the grant under a single-use code, BOUND to the PKCE challenge + client + redirect.
  const code = newAuthCode();
  await env.AUTH_CODES.put(
    `oidc:${code}`,
    JSON.stringify({
      id_token: idToken,
      delegation: body.delegation,
      sessionDelegation: body.sessionDelegation ?? null,
      org: body.org ?? null,
      code_challenge: grant.code_challenge,
      client_id: grant.client_id,
      redirect_uri: grant.redirect_uri,
    }),
    { expirationTtl: Math.ceil(CODE_TTL_MS / 1000) },
  );
  return json({ code });
};
