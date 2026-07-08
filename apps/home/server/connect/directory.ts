// /connect/directory — the Home's community directory (spec 312 §4.4 / W3).
//
//   GET  ?communityId=…            → { listings } (session required — community
//                                     visibility; there is NO anonymous roster)
//   POST { action:'publish', listing } → verify + index (self-publish only)
//   POST { action:'revoke', communityId } → remove own listing
//
// ADR-0025 gates, fail-closed:
//   1. structural validation (validateDirectoryListing — subject-signed shape)
//   2. subject MUST be the session person (you can only list yourself)
//   3. ERC-1271 over the RE-DERIVED digest against the subject SA
//   4. subject must have a claimed on-chain name (delivery needs a label);
//      the label is resolved server-side and stored alongside the listing.
import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import { AgentAccountClient } from '@agenticprimitives/agent-account';
import { AgentNamingClient } from '@agenticprimitives/agent-naming';
import { isListingCurrent, validateDirectoryListing, type DirectoryListingV1 } from '@agenticprimitives/home';
import type { Address, Hex } from '@agenticprimitives/types';
import { getServer, resolveOrigin, type FnContext } from '../_lib/server-broker';
import { isAllowedClientOrigin } from '../../src/lib/oidc-clients';
import { CHAIN_ID, CONTRACTS, DEFAULT_RPC_URL } from '../../src/lib/chain';
import { nameLabel } from '../../src/lib/domain';
import { homeCaip10 } from '../../src/home/manifest';
import { listingDigest } from '../../src/home/directory';
import { appendControlEvent } from './control-events';

const KEY = (communityId: string): string => `directory:${communityId.toLowerCase()}`;

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

async function personFrom(request: Request, env: FnContext['env']): Promise<string | null> {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  const { jwks } = await getServer(env);
  const keys = await importJwks(jwks);
  const v = await verifyAgentSession(token, { keys, expectedAud: env.DEMO_SSO_AUD ?? 'demo-sso', expectedIss: resolveOrigin(request, env) });
  if (!v.ok) return null;
  return (v.session.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase() || null;
}

async function readIndex(env: FnContext['env'], communityId: string): Promise<IndexedListing[]> {
  const raw = await env.AUTH_CODES.get(KEY(communityId));
  return raw ? (JSON.parse(raw) as IndexedListing[]) : [];
}

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const person = await personFrom(request, env);
  if (!person) return jsonCors({ error: 'home session required' }, request, 401);
  const communityId = (new URL(request.url).searchParams.get('communityId') ?? '').trim().toLowerCase();
  if (!communityId) return jsonCors({ error: 'communityId required' }, request, 400);
  const now = new Date().toISOString();
  const listings = (await readIndex(env, communityId)).filter((l) => isListingCurrent(l.listing, now));
  return jsonCors({ listings }, request);
};

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const person = await personFrom(request, env);
  if (!person) return jsonCors({ error: 'home session required' }, request, 401);
  const body = (await request.json().catch(() => null)) as
    | { action?: string; listing?: DirectoryListingV1; communityId?: string }
    | null;

  if (body?.action === 'revoke') {
    const communityId = (body.communityId ?? '').trim().toLowerCase();
    if (!communityId) return jsonCors({ error: 'communityId required' }, request, 400);
    const me = homeCaip10(person as Address).toLowerCase();
    const rows = (await readIndex(env, communityId)).filter((l) => l.listing.subject.toLowerCase() !== me);
    await env.AUTH_CODES.put(KEY(communityId), JSON.stringify(rows));
    return jsonCors({ ok: true }, request);
  }

  if (body?.action === 'publish' && body.listing) {
    const listing = body.listing;
    const errors = validateDirectoryListing(listing);
    if (errors.length > 0) return jsonCors({ error: `invalid listing: ${errors.join(', ')}` }, request, 400);
    const me = homeCaip10(person as Address);
    if (listing.subject.toLowerCase() !== me.toLowerCase()) {
      return jsonCors({ error: 'you can only publish a listing for your own agent' }, request, 403);
    }

    // ERC-1271 over the re-derived digest — never a client-supplied digest.
    const { proof, ...draft } = listing;
    const digest = await listingDigest(draft);
    const accounts = new AgentAccountClient({
      rpcUrl: env.RPC_URL ?? DEFAULT_RPC_URL,
      chainId: CHAIN_ID,
      entryPoint: CONTRACTS.entryPoint,
      factory: CONTRACTS.agentAccountFactory,
    });
    let verified = false;
    try {
      verified = await accounts.isValidSignature(person as Address, digest, proof.signature as Hex);
    } catch {
      verified = false;
    }
    if (!verified) return jsonCors({ error: 'listing signature failed ERC-1271 verification' }, request, 403);

    // Delivery is name-addressed — a listing without a claimed name is unreachable.
    const naming = new AgentNamingClient({
      rpcUrl: env.RPC_URL ?? DEFAULT_RPC_URL,
      chainId: CHAIN_ID,
      registry: CONTRACTS.agentNameRegistry,
      universalResolver: CONTRACTS.agentNameUniversalResolver,
    });
    const name = await naming.reverseResolve(person as Address);
    if (!name) return jsonCors({ error: 'claim a name first — directory entries are name-addressed' }, request, 409);

    const communityId = listing.context.id.trim().toLowerCase();
    const rows = (await readIndex(env, communityId)).filter(
      (l) => l.listing.subject.toLowerCase() !== me.toLowerCase(),
    );
    rows.push({ listing, label: nameLabel(name) });
    await env.AUTH_CODES.put(KEY(communityId), JSON.stringify(rows));
    // Timeline row: publishing a listing is a visibility grant the person made.
    await appendControlEvent(env, person as Address, 'grant-issued');
    return jsonCors({ ok: true }, request);
  }

  return jsonCors({ error: 'unknown action' }, request, 400);
};
