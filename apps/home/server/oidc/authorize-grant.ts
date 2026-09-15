// POST /oidc/authorize-grant — server-minted enrollment-grant record (spec 230 §4.2,
// closing the SEC-001 gap that ADR-0019's "scoped delegation as the only relying-site
// authority" depended on).
//
// The relying app redirects the user to `<home>/?client_id=&redirect_uri=&state=&nonce=
// &code_challenge=&agent_name=&delegation_template=...`. The home SPA parses those
// params and POSTs them HERE first, BEFORE running the ROOT-credential ceremony. We:
//
//   1. validate the params against the OIDC client registry (client_id exists,
//      redirect_uri exact-matches, delegation_template is in the client's allowed list,
//      code_challenge_method is S256),
//   2. mint a fresh server-side `grant_id`, stash the bound record under it with a
//      10-minute TTL (`oidc-grant:<id>` → { client_id, redirect_uri, agent_name,
//      delegate (from REGISTRY — anti-spoof), code_challenge, nonce, template, exp_ms }),
//   3. return { grant_id, delegate } so the SPA knows the canonical delegate address to
//      use when constructing the delegation.
//
// /oidc/grant then accepts ONLY { grant_id, delegation }; the delegation is verified
// against the bound record + the registered delegate. An attacker with a leaked
// delegation cannot replay it at /oidc/grant — there is no bound grant_id, and any
// fresh `authorize-grant` they create still binds to the REGISTERED delegate, which
// the leaked delegation must match.
//
// SEC-001 closure.

import { getServer, json, resolveOrigin, type FnContext } from '../_lib/server-broker';
import { clientAllowsRedirect, clientAllowsTemplate, getClientDelegate } from '../../src/lib/oidc-clients';
// Curated white-label entries AND member-registered ones, in that order (server/_lib/oidc-registry.ts).
import { resolveClient, isAllowedRelyingOriginAsync } from '../_lib/oidc-registry';
import { sharesProfileName } from '../../src/lib/new-member';
import { sharesEmailClaim } from '../../src/whitelabel/provisioning';

const GRANT_TTL_SEC = 600; // 10 min — covers ceremony + one retry

interface AuthorizeGrantBody {
  client_id?: string;
  redirect_uri?: string;
  agent_name?: string;
  delegation_template?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  nonce?: string;
  /** The member's HUMAN name ("Rich Pedersen") off their own private profile, read by the home SPA
   *  over their session — the server cannot read it, the record is sealed under the member's KEK.
   *  Honoured ONLY for a client the REGISTRY scopes for `profile` (see below); silently dropped
   *  otherwise, so a tampered SPA cannot hand a member's name to an app that was never permitted
   *  it. This is not a handle: accounts on this path stay nameless in the naming service. */
  profile_name?: string;
  /** The member's verified email, read the same way over their own session and honoured ONLY for a
   *  client the REGISTRY names it for (idTokenClaims). Same reason as the name: the server cannot
   *  read the vault record, and a tampered SPA must not be able to hand an address to an app that
   *  was never permitted one. */
  profile_email?: string;
}

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  // SEC-001 (origin check): only the home SPA can mint enrollment grants. A foreign
  // origin posting here is rejected. Browsers attach Origin on every cross-origin
  // POST; for same-origin POSTs Origin is also attached. Missing/mismatched Origin
  // means non-SPA caller.
  const iss = resolveOrigin(request, env);
  const reqOrigin = request.headers.get('origin');
  if (!reqOrigin || reqOrigin !== iss) {
    return json({ error: 'authorize-grant must be called from the home origin' }, 403);
  }

  const body = (await request.json().catch(() => null)) as AuthorizeGrantBody | null;
  // spec 257 §11: `agent_name` is OPTIONAL (name-deferred Google connect). Every OTHER field —
  // client_id, redirect_uri, code_challenge, delegation_template — stays REQUIRED, and the
  // registry/redirect/template/origin checks below are unchanged (only the NAME became optional).
  if (!body?.client_id || !body.redirect_uri || !body.code_challenge || !body.delegation_template) {
    return json({ error: 'client_id + redirect_uri + code_challenge + delegation_template required' }, 400);
  }
  if (body.code_challenge_method && body.code_challenge_method !== 'S256') {
    return json({ error: 'code_challenge_method must be S256' }, 400);
  }

  // Client registry — exact redirect + allowed template (CN-1, spec 230 §6).
  const client = await resolveClient(env, body.client_id);
  if (!client) return json({ error: `unknown client_id "${body.client_id}"` }, 400);
  if (!clientAllowsRedirect(client, body.redirect_uri)) {
    return json({ error: 'redirect_uri not allowed for client' }, 400);
  }
  if (!clientAllowsTemplate(client, body.delegation_template)) {
    return json({ error: `delegation_template "${body.delegation_template}" not allowed` }, 400);
  }
  // SEC-005: defense in depth — the redirect_uri's origin must ALSO be in the global
  // relying-origins allowlist (which is derived from this same registry, so this is a
  // sanity check; failure means the registry itself is misconfigured).
  if (!(await isAllowedRelyingOriginAsync(env, body.redirect_uri))) {
    return json({ error: 'redirect_uri origin not in allowlist' }, 400);
  }

  // Mint the grant. Same code shape as the existing single-use auth codes.
  const { signer } = await getServer(env); // touch to require BROKER_PRIVATE_JWK upfront
  void signer;
  const grant_id = generateGrantId();
  const exp_ms = Date.now() + GRANT_TTL_SEC * 1000;
  await env.AUTH_CODES.put(
    `oidc-grant:${grant_id}`,
    JSON.stringify({
      client_id: body.client_id,
      redirect_uri: body.redirect_uri,
      agent_name: body.agent_name ?? '',
      // spec: `profile` scope. The gate is the CURATED registry entry, not a `scope=` request
      // parameter: request scopes are attacker-supplied and this broker parses none today, so
      // deriving permission from one would let any origin that can form a URL ask for a member's
      // name. Same rule as the app's name and logo at consent — registry, never the URL.
      profile_name: sharesProfileName(client) ? (body.profile_name ?? '').trim().slice(0, 80) : '',
      // Same rule for the member's email, gated on the registry's `idTokenClaims` rather than a
      // requested scope, and for the same reason: a request parameter is attacker-supplied, so
      // deriving permission from one would let any origin that can form a URL ask for a contact
      // address. 254 is the practical ceiling on an address.
      profile_email: sharesEmailClaim(client) ? (body.profile_email ?? '').trim().toLowerCase().slice(0, 254) : '',
      // SEC-001 anti-spoof: the delegate this grant binds to is taken FROM THE REGISTRY,
      // not from the request. The SPA reads this back in the response and uses it when
      // constructing the delegation; /oidc/grant verifies the supplied delegation's
      // delegate equals this stored value.
      delegate: getClientDelegate(client),
      code_challenge: body.code_challenge,
      nonce: body.nonce ?? '',
      delegation_template: body.delegation_template,
      exp_ms,
    }),
    { expirationTtl: GRANT_TTL_SEC },
  );
  return json({ grant_id, delegate: getClientDelegate(client), expires_in: GRANT_TTL_SEC });
};

function generateGrantId(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Shape of a stored enrollment grant — exported so /oidc/grant can read it. */
export interface StoredEnrollmentGrant {
  client_id: string;
  redirect_uri: string;
  agent_name: string;
  /** The member's human profile name, when the client is registry-scoped for `profile`. '' otherwise. */
  profile_name?: string;
  /** The member's email, when the client's registry entry names the claim. '' otherwise. */
  profile_email?: string;
  delegate: `0x${string}`;
  code_challenge: string;
  nonce: string;
  delegation_template: string;
  exp_ms: number;
}
