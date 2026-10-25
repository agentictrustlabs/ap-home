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
import { hashDelegation, type StandingWireV1 } from '@agenticprimitives/delegation';
import { buildActAsMeSet, signActAsMeSet, PAYMENT_CAPABILITY, type ActChoice } from '../../src/lib/act-as-me';
import type { Address, CredentialPrincipal, Hex } from '@agenticprimitives/types';
import { privateKeyToAccount } from 'viem/accounts';
import { getServer, resolveOrigin, type FnContext } from '../_lib/server-broker';
import { demoCustodianAddress, demoPersonaFor, listDemoPersonas, signDigestAsDemoPersona } from '../_lib/demo-custody';
import { issueAskAsMeDelegation, issueSiteDelegation, toWire } from '../../src/lib/delegation';
import { issueReadGrant } from '../../src/lib/read-grant-build';
import { MCP_SERVER_ID } from '../../src/lib/inbox-delivery';
import { callInteractions } from './channels';
import { recordCredentialFacet } from '../../src/lib/kv-indexer';
import { clientAllowsTemplate, getClient } from '../../src/lib/oidc-clients';
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
  const body = (await request.json().catch(() => null)) as { handle?: string; sa?: string; as?: string; client_id?: string; delegation_template?: string; /** Spec 397 §11 — the act set a persona pre-authorizes (the live gate). */ act?: unknown } | null;
  const clientId = (body?.client_id ?? '').trim();
  const client = clientId ? getClient(clientId) : null;
  if (!client) return json({ error: 'a registered client_id is required' }, 400);

  let key = (body?.sa ?? body?.handle ?? '').trim();
  // Spec 426 — THE SESSION SEAM asks the Home only "a session for this principal at this client"; the Home
  // resolves the CUSTODIAN (the self-agent relationship is a Home fact, never a map in the runtime). When `as`
  // is given with NO custodian, find the seeded account whose Home lists `as` as a name of its own, and act as
  // that account — exactly the `related:<custodian>:<persona>` self-link the normal `{sa, as}` path validates.
  const wantsAs = (body?.as ?? '').trim().toLowerCase();
  if (!key && /^0x[0-9a-f]{40}$/.test(wantsAs)) {
    for (const p of listDemoPersonas(env)) {
      const raw = await env.AUTH_CODES.get(`related:${p.sa.toLowerCase()}:${wantsAs}`);
      if (!raw) continue;
      try {
        const l = JSON.parse(raw) as { kind?: string; relationship?: string; status?: string };
        if ((l.kind ?? '').toLowerCase() === 'person' && (l.relationship ?? '').toLowerCase() === 'self' && l.status !== 'deleted' && l.status !== 'inactive') { key = p.sa; break; }
      } catch { /* skip a malformed link */ }
    }
    if (!key) return json({ error: 'no demo account steers that principal' }, 404);
  }
  if (!key) return json({ error: 'handle or sa required' }, 400);
  const persona = demoPersonaFor(env, key);
  if (!persona) return json({ error: 'unknown demo account' }, 404);

  // SIGN IN AS ANOTHER NAME OF THE SAME DEMO PERSON (persona.ttl pn:PersonaAgent — a trail name, a professional
  // name, a character in a play). `as` names a person-class agent this demo person chartered under themselves,
  // recorded in THEIR Home as `kind: person, relationship: self` by the charter ceremony, and custodied by the same
  // seeded key — so the same signer signs for it. The id_token's subject becomes the persona; the roster entry is
  // only the custodian. An address the person's own tree does not list as a name of theirs is somebody else, and is
  // refused: this never lets a demo account act as a second human.
  const asRaw = (body?.as ?? '').trim().toLowerCase();
  let actingSa = persona.sa as Address;
  let actingName: string | undefined = persona.name;
  if (asRaw) {
    if (!/^0x[0-9a-f]{40}$/.test(asRaw)) return json({ error: 'as must be an agent address' }, 400);
    const raw = await env.AUTH_CODES.get(`related:${persona.sa.toLowerCase()}:${asRaw}`);
    const link = raw ? (JSON.parse(raw) as { kind?: string; relationship?: string; orgName?: string; status?: string }) : null;
    if (!link || (link.kind ?? '').toLowerCase() !== 'person' || (link.relationship ?? '').toLowerCase() !== 'self') {
      return json({ error: 'not another name of this demo person — their Home lists no person-class agent of theirs at that address' }, 403);
    }
    if (link.status === 'deleted' || link.status === 'inactive') return json({ error: 'that name is retired' }, 403);
    actingSa = asRaw as Address;
    actingName = link.orgName || actingName;
  }
  const sa = actingSa;
  const sub = toCanonicalAgentId(CHAIN_ID, sa);
  const iss = resolveOrigin(request, env);
  const { signer } = await getServer(env);
  const signHash = (digest: Hex): Promise<Hex> => signDigestAsDemoPersona(persona, digest);

  // The authority half: the person's own site-login delegation to THIS app's registered delegate,
  // signed by their custodian — the same artifact the consent screen produces for a real user.
  // Spec 397 — a client whose registration names the `ask-as-me` template (the Home MCP) gets THAT delegation:
  // person → the client's key, pinned to harness.ask. A template the registry does not allow the client is refused.
  const template = (body?.delegation_template ?? '').trim();
  if (template && !clientAllowsTemplate(client, template)) return json({ error: `delegation_template "${template}" not allowed for ${clientId}` }, 400);
  const askDelegate = (client.ask_delegate ?? client.delegate) as Address; // spec 397: the app's asking key, when it has one
  const isAsk = template === 'ask-as-me' || template === 'act-as-me';
  const delegation = isAsk
    ? await issueAskAsMeDelegation(sa, askDelegate, signHash)
    : await issueSiteDelegation(sa, client.delegate as Address, signHash, SITE_DELEGATION_TTL);
  const digest = hashDelegation(delegation, CHAIN_ID, CONTRACTS.delegationManager);
  // Spec 397 §11 — the ACT SET for a demo persona: `act` names the capabilities (and a payment's treasury, payee and
  // cap); the persona's custodian key signs each standing wire — the same key custodies the persona's treasury, so a
  // payment wire's ERC-1271 check at her agent passes for the same reason a treasury mandate's does. The live gate
  // is the only caller; a browser goes through ActAsMeConsent.
  let actSet: StandingWireV1[] | undefined;
  if (template === 'act-as-me') {
    const act = body?.act as { capabilities?: unknown; payment?: { treasury?: string; payee?: string; asset?: string; maxAmount?: string } } | undefined;
    const caps = Array.isArray(act?.capabilities) ? act!.capabilities.filter((c): c is string => typeof c === 'string' && !!c.trim()) : [];
    if (caps.length === 0) return json({ error: 'act-as-me needs act.capabilities (one wire per capability)' }, 400);
    const pay = act?.payment;
    const choices: ActChoice[] = caps.map((c) => (c === PAYMENT_CAPABILITY
      ? { capability: c, payment: { treasury: String(pay?.treasury ?? '') as Address, payee: String(pay?.payee ?? '') as Address, asset: String(pay?.asset ?? CONTRACTS.mockUsdc) as Address, maxAmount: BigInt(String(pay?.maxAmount ?? '0')) } }
      : { capability: c }));
    try {
      const set = buildActAsMeSet(sa, client.delegate as Address, choices);
      actSet = await signActAsMeSet(set, { mode: 'each', sign: (_delegator, d) => signHash(d) });
    } catch (e) { return json({ error: e instanceof Error ? e.message : 'the act set could not be built' }, 400); }
  }
  // Spec 397 W4 — a person-level app wire (ask-as-me) is listed under Connected assistants like a browser-made one,
  // so the demo persona can see and REVOKE what their assistant holds. A rebuildable pointer; the chain is the record.
  if (isAsk) {
    const key = `app-grants:${sa.toLowerCase()}`;
    const rows = JSON.parse((await env.AUTH_CODES.get(key)) ?? '[]') as Array<{ clientId: string }>;
    const next = rows.filter((r) => r.clientId !== clientId);
    next.unshift({ clientId, template, delegate: template === 'act-as-me' ? client.delegate : askDelegate, delegation: toWire(delegation), issuedAt: Date.now(), ...(actSet ? { wires: actSet } : {}) } as never);
    await env.AUTH_CODES.put(key, JSON.stringify(next.slice(0, 50)));
  }

  // The identity half. Binding the digest to this client keeps silent re-auth (/token
  // grant_type=delegation) working for the demo session exactly as it does for a real one — and
  // keeps it FAILING for any other client, so a demo delegation can't be replayed sideways.
  const idToken = await mintIdToken({ iss, sub, aud: clientId, agentName: actingName, ttlSeconds: ID_TOKEN_TTL }, signer);
  await env.AUTH_CODES.put(
    `oidc-deleg:${digest.toLowerCase()}`,
    JSON.stringify({ client_id: clientId, agent_name: actingName }),
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

  // Spec 412 W6 — the client's declared READ GRANT, minted here as a demo persona's custodian would in the browser:
  // person → the interactions service SA, the registry's record families, stored on the persona's own object under the
  // client id via the home session just minted. Best-effort and said; the sign-in stands without it.
  if (client.read_grant?.resources?.length) {
    try {
      const serviceSA = (process.env.NEXT_PUBLIC_INTERACTIONS_SERVICE_SA as string | undefined)?.trim() as Address | undefined;
      if (!serviceSA) throw new Error('no interactions service agent is provisioned');
      const grant = await issueReadGrant({ personSA: sa, serviceSA, resources: client.read_grant.resources, server: MCP_SERVER_ID, signHash });
      const put = await callInteractions(env, sa, 'readgrant.put', { session: homeSession, clientId, delegation: toWire(grant) });
      if (put.status >= 400 || put.body.ok === false) console.warn(`[demo-signin] read grant for ${clientId} not stored: ${String(put.body.error ?? put.status)}`);
    } catch (e) { console.warn(`[demo-signin] read grant for ${clientId} not issued:`, e instanceof Error ? e.message : String(e)); }
  }

  return json({
    ok: true,
    sub,
    agent: sa,
    handle: persona.handle,
    ...(asRaw ? { as: sa, custodian: persona.sa } : {}),
    agent_name: actingName ?? null,
    blurb: persona.blurb ?? '',
    id_token: idToken,
    expires_in: ID_TOKEN_TTL,
    delegation: toWire(delegation),
    ...(actSet ? { delegations: actSet } : {}),
    homeSession,
    homeSessionExpiresIn: HOME_SESSION_TTL,
  });
};
