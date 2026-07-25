// DEMO ACCOUNTS — one registry of demo people, shared by every relying app.
//
//   GET  /connect/demo-personas   → { personas: [{handle, sa, name, blurb, custodian, custodies}] }
//   POST /connect/demo-signin { handle|sa, client_id }
//        → { sub, agent_name, id_token, delegation, homeSession }
//   PUT  /connect/demo-sign   { handle|agent, digest }   (Bearer DEMO_SIGNER_SECRET)
//        → { signature }   — for ceremonies an app runs on their behalf (org deploy, admissions)
//
// Why this lives at the HOME. A demo person (Nathan, David…) is a real on-chain Smart Agent whose
// custodian is a seeded EOA. Apps used to hold that key so they could mint the persona a session —
// which meant every app kept a copy of the same secret, and the persona's OWN Home could not sign
// anything (no wallet there, only an opener bridge back to whichever tab launched it). Moving the
// keys here inverts it: the app holds no key, asks for a session, and gets exactly what a real OIDC
// sign-in returns — an `id_token` (so Home-run flows like org invites and the inbox work for demo
// users too) plus the site-login `delegation` (the authority). `homeSession` is the same person's
// Home session: append it as `…/#session=<token>` and they land in their own portal, signed in.
//
// Cross-app by construction: the registry is keyed by Smart Agent, so Nathan is the SAME person —
// same vault, same relationships, same org memberships — in every app that asks for him.
//
// Boundaries: OFF unless DEMO_PERSONA_KEYS is set; only the listed SAs resolve; the delegate comes
// from the CLIENT REGISTRY (never the request); and these are demo keys only — a real person's
// custody never lives here. Anyone who can reach this endpoint can act as a demo person, which is
// what "sign in as Nathan" means; keep real accounts out of the registry.
import { mintAgentSession, mintIdToken } from '@agenticprimitives/connect';
import { toCanonicalAgentId } from '@agenticprimitives/identity-directory-adapters';
import { hashDelegation } from '@agenticprimitives/delegation';
import type { Address, CredentialPrincipal, Hex } from '@agenticprimitives/types';
import { privateKeyToAccount } from 'viem/accounts';
import { getServer, resolveOrigin, type FnContext } from '../_lib/server-broker';
import { demoCustodianAddress, demoPersonaFor, listDemoPersonas, signDigestAsDemoPersona } from '../_lib/demo-custody';
import { issueSiteDelegation, toWire } from '../../src/lib/delegation';
import { recordCredentialFacet } from '../../src/lib/kv-indexer';
import { getClient } from '../../src/lib/oidc-clients';
import { CHAIN_ID, CONTRACTS } from '../../src/lib/chain';

const ID_TOKEN_TTL = 3600;
const HOME_SESSION_TTL = 12 * 3600;
const DELEG_BIND_TTL_SEC = 60 * 60 * 24 * 30;
const SITE_DELEGATION_TTL = 12 * 3600;

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization' };
const json = (b: unknown, s = 200): Response =>
  new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', ...cors } });

export const onRequestOptions = async (): Promise<Response> => new Response(null, { status: 204, headers: cors });

/** The roster an app renders on its "step in as a demo user" screen, plus what an app needs to run
 *  ceremonies FOR these people: `custodian` is the on-chain custodian EOA (public — a gasless deploy
 *  names it in `custodians: [...]`), `custodies` is the seed's list of orgs they hold. Never keys. */
export const onRequestGet = async ({ env }: FnContext): Promise<Response> =>
  json({
    ok: true,
    personas: listDemoPersonas(env).map((p) => ({
      handle: p.handle,
      sa: p.sa,
      name: p.name ?? p.handle,
      blurb: p.blurb ?? '',
      custodian: demoCustodianAddress(p),
      ...(p.custodies ? { custodies: p.custodies } : {}),
    })),
  });

/** POST /connect/demo-sign — the SERVER-TO-SERVER signer, for ceremonies an app runs on a demo
 *  person's behalf where there is no person session to authenticate: deploying their org gasless,
 *  the vault-key ceremony, minting the org-acting wires an admission needs. Same custodian, same
 *  EIP-191 digest signature; the app just no longer holds the key.
 *
 *  Gated by `DEMO_SIGNER_SECRET` (a shared secret between the Home and its demo apps) because there
 *  is no user in the loop — unlike /connect/persona-sign, which is gated by the person's OWN Home
 *  session. Unset ⇒ the route is off. Only registry accounts sign; a digest for anyone else 404s. */
export const onRequestPut = async ({ request, env }: FnContext): Promise<Response> => {
  const secret = env.DEMO_SIGNER_SECRET;
  if (!secret) return json({ error: 'demo signer not enabled' }, 404);
  if ((request.headers.get('authorization') ?? '') !== `Bearer ${secret}`) return json({ error: 'unauthorized' }, 401);
  const body = (await request.json().catch(() => null)) as { handle?: string; agent?: string; digest?: string } | null;
  const persona = demoPersonaFor(env, (body?.agent ?? body?.handle ?? '').trim());
  if (!persona) return json({ error: 'unknown demo account' }, 404);
  const digest = (body?.digest ?? '').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(digest)) return json({ error: 'digest must be a 32-byte hex string' }, 400);
  try {
    return json({ ok: true, handle: persona.handle, agent: persona.sa, custodian: demoCustodianAddress(persona), signature: await signDigestAsDemoPersona(persona, digest as Hex) });
  } catch (e) {
    return json({ error: `could not sign: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }
};

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const body = (await request.json().catch(() => null)) as { handle?: string; sa?: string; client_id?: string } | null;
  const clientId = (body?.client_id ?? '').trim();
  const client = clientId ? getClient(clientId) : null;
  if (!client) return json({ error: 'a registered client_id is required' }, 400);

  const key = (body?.sa ?? body?.handle ?? '').trim();
  if (!key) return json({ error: 'handle or sa required' }, 400);
  const persona = demoPersonaFor(env, key);
  if (!persona) return json({ error: 'unknown demo account' }, 404);

  const sa = persona.sa as Address;
  const sub = toCanonicalAgentId(CHAIN_ID, sa);
  const iss = resolveOrigin(request, env);
  const { signer } = await getServer(env);
  const signHash = (digest: Hex): Promise<Hex> => signDigestAsDemoPersona(persona, digest);

  // The authority half: the person's own site-login delegation to THIS app's registered delegate,
  // signed by their custodian — the same artifact the consent screen produces for a real user.
  const delegation = await issueSiteDelegation(sa, client.delegate as Address, signHash, SITE_DELEGATION_TTL);
  const digest = hashDelegation(delegation, CHAIN_ID, CONTRACTS.delegationManager);

  // The identity half. Binding the digest to this client keeps silent re-auth (/token
  // grant_type=delegation) working for the demo session exactly as it does for a real one — and
  // keeps it FAILING for any other client, so a demo delegation can't be replayed sideways.
  const idToken = await mintIdToken({ iss, sub, aud: clientId, agentName: persona.name, ttlSeconds: ID_TOKEN_TTL }, signer);
  await env.AUTH_CODES.put(
    `oidc-deleg:${digest.toLowerCase()}`,
    JSON.stringify({ client_id: clientId, agent_name: persona.name }),
    { expirationTtl: DELEG_BIND_TTL_SEC },
  );

  // The Home half: a custody-grade session for the same person, minted against the credential that
  // actually custodies them (their seeded EOA) — so their portal behaves like any wallet home, and
  // /connect/persona-sign can satisfy the ceremonies that would otherwise want a wallet prompt.
  const principal: CredentialPrincipal = {
    kind: 'siwe-eoa',
    id: privateKeyToAccount(persona.privateKey).address,
    assurance: 'onchain-confirmed',
    role: 'custody-grade',
  };
  const homeSession = await mintAgentSession(
    { sub, principal, assurance: 'onchain-confirmed', aud: env.DEMO_SSO_AUD ?? 'demo-sso', iss, ttlSeconds: HOME_SESSION_TTL },
    signer,
  );
  await recordCredentialFacet(env.AUTH_CODES, principal, sub).catch(() => undefined);

  return json({
    ok: true,
    sub,
    agent: sa,
    handle: persona.handle,
    agent_name: persona.name ?? null,
    blurb: persona.blurb ?? '',
    id_token: idToken,
    expires_in: ID_TOKEN_TTL,
    delegation: toWire(delegation),
    homeSession,
    homeSessionExpiresIn: HOME_SESSION_TTL,
  });
};
