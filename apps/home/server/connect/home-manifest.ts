// /connect/home-manifest — publish + read the person's signed HomeManifestV1 (spec 310 W2).
//
// GET  ?label=<label>          → { manifest: HomeManifestV1 | null }   (public read)
// POST { label, manifest }     → { ok: true }                          (home session required)
//
// Fail-closed publish gates (every one must pass, in order — ADR-0013, one
// mechanism per check, no fallbacks):
//   1. structure     — validateHomeManifest(manifest) is clean (@agenticprimitives/home)
//   2. session⇔owner — the manifest.owner IS the session's person SA
//   3. label⇔owner   — reverseResolve(person) on-chain; its first label must equal `label`
//                      (stops publishing under someone else's subdomain)
//   4. proof         — ERC-1271 against the owner SA over the re-derived digest
//                      (the same raw-or-EIP-191 path delegations use)
// The stored manifest is served verbatim by /.well-known/agentic-home on the
// person's subdomain. Consumers still run isManifestCurrent — serving ≠ trust.
import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import { validateHomeManifest, type HomeManifestV1 } from '@agenticprimitives/home';
import { AgentNamingClient } from '@agenticprimitives/agent-naming';
import { AgentAccountClient } from '@agenticprimitives/agent-account';
import type { Address, Hex } from '@agenticprimitives/types';
import { getServer, resolveOrigin, ownIssuer, type FnContext } from '../_lib/server-broker';
import { isAllowedClientOrigin } from '../../src/lib/oidc-clients';
import { CHAIN_ID, CONTRACTS, DEFAULT_RPC_URL } from '../../src/lib/chain';
import { nameLabel } from '../../src/lib/domain';
import { homeManifestDigest, homeCaip10 } from '../../src/home/manifest';
import { appendControlEvent } from './control-events';

const KEY = (label: string): string => `home-manifest:${label.toLowerCase()}`;

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

/** Verify the home-session token and return the person SA (lowercased), or null. */
async function personFrom(request: Request, env: FnContext['env']): Promise<string | null> {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  const { jwks } = await getServer(env);
  const keys = await importJwks(jwks);
  const v = await verifyAgentSession(token, { keys, expectedAud: env.DEMO_SSO_AUD ?? 'demo-sso', expectedIss: ownIssuer(request, env) });
  if (!v.ok) return null;
  return (v.session.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase() || null;
}

const LABEL_RE = /^[a-z0-9-]{1,63}$/;

export async function readStoredManifest(env: FnContext['env'], label: string): Promise<HomeManifestV1 | null> {
  if (!LABEL_RE.test(label)) return null;
  const raw = await env.AUTH_CODES.get(KEY(label));
  return raw ? (JSON.parse(raw) as HomeManifestV1) : null;
}

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const label = (new URL(request.url).searchParams.get('label') ?? '').trim().toLowerCase();
  if (!LABEL_RE.test(label)) return jsonCors({ error: 'label required' }, request, 400);
  return jsonCors({ manifest: await readStoredManifest(env, label) }, request);
};

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const person = await personFrom(request, env);
  if (!person) return jsonCors({ error: 'home session required' }, request, 401);

  const body = (await request.json().catch(() => null)) as { label?: string; manifest?: HomeManifestV1 } | null;
  const label = (body?.label ?? '').trim().toLowerCase();
  const manifest = body?.manifest;
  if (!LABEL_RE.test(label) || !manifest) return jsonCors({ error: 'label + manifest required' }, request, 400);

  // 1. Structure (fail-closed schema gate from @agenticprimitives/home).
  const structural = validateHomeManifest(manifest);
  if (structural.length > 0) return jsonCors({ error: 'invalid manifest', details: structural }, request, 400);

  // 2. The session's person SA must BE the manifest owner (facet of self only).
  if (manifest.owner.toLowerCase() !== homeCaip10(person as Address).toLowerCase()) {
    return jsonCors({ error: 'manifest owner must be your agent' }, request, 403);
  }

  // 3. Label ⇔ owner: the person's on-chain primary name must carry this label
  //    (one mechanism: reverseResolve, forward-confirmed on-chain — ADR-0012).
  const naming = new AgentNamingClient({
    rpcUrl: env.RPC_URL ?? DEFAULT_RPC_URL,
    chainId: CHAIN_ID,
    registry: CONTRACTS.agentNameRegistry,
    universalResolver: CONTRACTS.agentNameUniversalResolver,
  });
  const name = await naming.reverseResolve(person as Address);
  if (!name || nameLabel(name) !== label) {
    return jsonCors({ error: 'label does not resolve to your agent' }, request, 403);
  }

  // 4. Proof: ERC-1271 against the owner SA over the RE-DERIVED digest (never
  //    trust a client-supplied digest; the signature can't cover itself).
  const { proof, ...draft } = manifest;
  const digest = homeManifestDigest(draft);
  const accounts = new AgentAccountClient({
    rpcUrl: env.RPC_URL ?? DEFAULT_RPC_URL,
    chainId: CHAIN_ID,
    entryPoint: CONTRACTS.entryPoint,
    factory: CONTRACTS.agentAccountFactory,
  });
  let ok = false;
  try {
    ok = await accounts.isValidSignature(person as Address, digest, proof.signature as Hex);
  } catch {
    ok = false;
  }
  if (!ok) return jsonCors({ error: 'manifest proof failed ERC-1271 verification' }, request, 403);

  // spec 323 W2.2 — the AUTHORITATIVE master is the person's vault `home.manifest` (their
  // InteractionsDO), so any Home the person uses reads/updates the same signed manifest. The
  // label-keyed KV is a PUBLIC SERVE cache for /.well-known/agentic-home; the eventual portable
  // public serve is an opt-in projection to the discovery read-tier (ADR-0040 amendment §"Home
  // manifest projection" + the external indexer). Master write is best-effort (409 = the person's
  // interactions plane isn't enabled yet — the KV serve copy still works meanwhile).
  const bearer = (request.headers.get('authorization') ?? '').slice(7);
  const { writeCapabilityRecord } = await import('../lib/capability-record');
  await writeCapabilityRecord(env, person, bearer, 'home.manifest', manifest);
  await env.AUTH_CODES.put(KEY(label), JSON.stringify(manifest));
  // Manifest (re)publication is a Home lifecycle fact on the control-plane
  // timeline (spec 310 W4).
  await appendControlEvent(env, person as Address, 'home-rotated', []);
  return jsonCors({ ok: true }, request);
};
