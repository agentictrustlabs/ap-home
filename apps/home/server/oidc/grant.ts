// POST /oidc/grant — the authorization-endpoint grant (spec 230 §4.2).
//
// The SPA at /authorize runs the ROOT-passkey ceremony + on-chain work + signs the delegation
// client-side, then calls this to turn the result into an OIDC authorization CODE. We:
//   1. gate client_id + redirect_uri + delegation_template against the registry (§6),
//   2. use the SIGNED DELEGATION as proof-of-possession — verify it (ERC-1271 against the
//      delegator + window). The ROOT passkey just signed it, so it IS a fresh credential proof;
//      this removes a separate passkey-assertion prompt. sub = the delegator (CAIP-10).
//   3. mint the OIDC id_token (sub, aud = client_id, nonce echoed),
//   4. stash {id_token, delegation, org} under a single-use code BOUND to the PKCE
//      code_challenge + client_id + redirect_uri, and return { code }.
// The code (not the token) travels back in the redirect/popup; /token does the PKCE exchange.
import { mintIdToken, newAuthCode } from '@agenticprimitives/connect';
import { toCanonicalAgentId } from '@agenticprimitives/identity-directory-adapters';
import { getServer, json, resolveOrigin, type FnContext } from '../_lib/server-broker';
import { verifyDelegation, type IncomingDelegation } from '../_lib/verify-delegation';
import { CHAIN_ID } from '../../src/lib/chain';
import { getClient, clientAllowsRedirect, clientAllowsTemplate } from '../../src/lib/oidc-clients';

const ID_TOKEN_TTL = 3600; // session-usable for the demo (the relying app treats it as the session)
const CODE_TTL_MS = 300_000; // 5 min exchange window

interface GrantBody {
  client_id?: string;
  redirect_uri?: string;
  nonce?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  agent_name?: string;
  delegation_template?: string;
  delegation?: IncomingDelegation; // signed client-side; doubles as the proof-of-possession
  org?: unknown; // opaque org payload for the org-create template
}

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const body = (await request.json().catch(() => null)) as GrantBody | null;
  if (!body?.client_id || !body.redirect_uri || !body.code_challenge || !body.delegation_template || !body.delegation) {
    return json({ error: 'client_id + redirect_uri + code_challenge + delegation_template + delegation required' }, 400);
  }
  // §8.4: S256 PKCE only.
  if (body.code_challenge_method && body.code_challenge_method !== 'S256') {
    return json({ error: 'code_challenge_method must be S256' }, 400);
  }
  // §6: client registry — exact redirect + allowed template.
  const client = getClient(body.client_id);
  if (!client) return json({ error: `unknown client_id "${body.client_id}"` }, 400);
  if (!clientAllowsRedirect(client, body.redirect_uri)) return json({ error: 'redirect_uri not allowed for client' }, 400);
  if (!clientAllowsTemplate(client, body.delegation_template)) return json({ error: `delegation_template "${body.delegation_template}" not allowed` }, 400);

  // Proof-of-possession = the freshly-signed delegation (ERC-1271 against its delegator + window).
  const v = await verifyDelegation(env, body.delegation);
  if (!v.ok) return json({ error: `delegation proof failed: ${v.reason}` }, 401);

  const iss = resolveOrigin(request, env); // subdomain-correct OP issuer behind the router (spec 231)
  const sub = toCanonicalAgentId(CHAIN_ID, body.delegation.delegator);
  const { signer } = await getServer(env);
  const idToken = await mintIdToken(
    { iss, sub, aud: body.client_id, nonce: body.nonce, agentName: body.agent_name, ttlSeconds: ID_TOKEN_TTL },
    signer,
  );

  // Stash the grant under a single-use code, BOUND to the PKCE challenge + client + redirect.
  const code = newAuthCode();
  await env.AUTH_CODES.put(
    `oidc:${code}`,
    JSON.stringify({
      id_token: idToken,
      delegation: body.delegation,
      org: body.org ?? null,
      code_challenge: body.code_challenge,
      client_id: body.client_id,
      redirect_uri: body.redirect_uri,
    }),
    { expirationTtl: Math.ceil(CODE_TTL_MS / 1000) },
  );
  return json({ code });
};
