// /connect/directory — PROXY to the community's InteractionsDO (spec 322 W2.3b). Listings live in
// the org vault's `directory.data`, written ONLY by the community's serialized execution point
// (which validates structure AND re-verifies the ERC-1271 proof at publish and at every gate —
// the ADR-0025 gates move with it). The Home keeps: session extraction, the on-chain LABEL
// resolution at publish (a naming read), the spec-313 §4 subject-stewardship attach (a steward
// publishing an ORG's listing), control-plane events, and the member-link projection upkeep.
// Retires at W5.
//
// Wire shapes preserved:
//   GET  ?communityId=… → { listings } (member/steward-gated by the DO; the UI's join card
//        already tolerates a non-ok roster read)
//   POST { action:'publish', listing } | { action:'revoke', communityId } → { ok } | { error }
import { AgentNamingClient } from '@agenticprimitives/agent-naming';
import type { Address } from '@agenticprimitives/types';
import type { DirectoryListingV1 } from '@agenticprimitives/fabric/messaging';
import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import { getServer, ownIssuer, type FnContext } from '../_lib/server-broker';
import { isAllowedClientOrigin } from '../../src/lib/oidc-clients';
import { CHAIN_ID, CONTRACTS, DEFAULT_RPC_URL } from '../../src/lib/chain';
import { nameLabel } from '../../src/lib/domain';
import { callInteractions, stewardWireFor, memberAccessWireFor } from './channels';
import { removeOrgMemberLink } from './membership';
import { appendControlEvent } from './control-events';

export interface IndexedListing {
  listing: DirectoryListingV1;
  /** The subject's claimed subdomain label — resolved on-chain at publish. */
  label: string;
}

function cors(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  return origin && isAllowedClientOrigin(origin)
    ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization, content-type', vary: 'Origin' }
    : {};
}
const jsonCors = (body: unknown, request: Request, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors(request) } });

export const onRequestOptions = async ({ request }: FnContext): Promise<Response> =>
  new Response(null, { status: 204, headers: cors(request) });

async function personFrom(request: Request, env: FnContext['env']): Promise<{ person: string; token: string } | null> {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  const { jwks } = await getServer(env);
  const keys = await importJwks(jwks);
  const v = await verifyAgentSession(token, { keys, expectedAud: env.DEMO_SSO_AUD ?? 'demo-sso', expectedIss: ownIssuer(request, env) });
  if (!v.ok) return null;
  const person = (v.session.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase();
  return person ? { person, token } : null;
}

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const who = await personFrom(request, env);
  if (!who) return jsonCors({ error: 'home session required' }, request, 401);
  const communityId = (new URL(request.url).searchParams.get('communityId') ?? '').trim().toLowerCase();
  if (!communityId) return jsonCors({ error: 'communityId required' }, request, 400);
  const stewardship = await stewardWireFor(env, who.person, communityId, who.token);
  const r = await callInteractions(env, communityId, 'directory.list', {
    session: who.token, ...(stewardship ? { stewardship } : {}),
  });
  if (r.status === 409) return jsonCors({ listings: [] }, request); // storage not enabled — empty roster
  return jsonCors(r.status === 200 ? { listings: r.body.listings ?? [] } : r.body, request, r.status);
};

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const who = await personFrom(request, env);
  if (!who) return jsonCors({ error: 'home session required' }, request, 401);
  const body = (await request.json().catch(() => null)) as
    | { action?: string; listing?: DirectoryListingV1; communityId?: string }
    | null;

  if (body?.action === 'revoke') {
    const communityId = (body.communityId ?? '').trim().toLowerCase();
    if (!communityId) return jsonCors({ error: 'communityId required' }, request, 400);
    const r = await callInteractions(env, communityId, 'directory.revoke', { session: who.token });
    if (r.status === 200) {
      // Leaving revokes the AUTHORITY-ONLY member link too (never a steward link — spec 318).
      await removeOrgMemberLink(env, who.person, communityId);
      await appendControlEvent(env, who.person as Address, 'grant-revoked', [], who.token).catch(() => undefined); // listing = the membership consent (closed event union)
    }
    return jsonCors(r.body, request, r.status);
  }

  if (body?.action === 'publish' && body.listing) {
    const communityId = (body.listing.context?.id ?? '').trim().toLowerCase();
    if (!communityId) return jsonCors({ error: 'listing context required' }, request, 400);
    const subjectAddr = body.listing.subject.match(/0x[0-9a-fA-F]{40}$/)?.[0]?.toLowerCase() as Address | undefined;
    if (!subjectAddr) return jsonCors({ error: 'listing subject must be an EVM agent' }, request, 400);
    // Label resolution stays Home-side (a naming READ; the DO validates + proof-verifies).
    const naming = new AgentNamingClient({
      rpcUrl: env.RPC_URL ?? DEFAULT_RPC_URL, chainId: CHAIN_ID,
      registry: CONTRACTS.agentNameRegistry, universalResolver: CONTRACTS.agentNameUniversalResolver,
    });
    const name = await naming.reverseResolve(subjectAddr).catch(() => null);
    // Delivery is name-addressed — a listing without a claimed name is unreachable.
    if (!name) return jsonCors({ error: 'claim a public name before joining — listings are name-addressed' }, request, 409);
    // spec 313 §4 — a steward publishing an ORG's listing attaches the SUBJECT's stewardship wire.
    const subjectStewardship = subjectAddr !== who.person ? await stewardWireFor(env, who.person, subjectAddr, who.token) : null;
    // SEC-H1 — a SELF-join must carry the org's authorization: the org→you member-access grant (from
    // an invite) OR your stewardship wire (steward self-card). The DO requires one; it re-verifies
    // both on-chain, so these are just artifact lookups.
    const selfMemberAccess = subjectAddr === who.person ? await memberAccessWireFor(env, communityId, who.person) : null;
    const selfStewardship = subjectAddr === who.person ? await stewardWireFor(env, who.person, communityId, who.token) : null;
    const r = await callInteractions(env, communityId, 'directory.publish', {
      session: who.token,
      listing: body.listing,
      label: nameLabel(name),
      ...(subjectStewardship ? { subjectStewardship } : {}),
      ...(selfMemberAccess ? { memberAccess: selfMemberAccess } : {}),
      ...(selfStewardship ? { stewardship: selfStewardship } : {}),
    });
    if (r.status === 200) {
      await appendControlEvent(env, who.person as Address, 'grant-issued', [], who.token).catch(() => undefined); // listing = the membership consent (closed event union)
    }
    return jsonCors(r.body, request, r.status);
  }

  return jsonCors({ error: 'unknown action' }, request, 400);
};
