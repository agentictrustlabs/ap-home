// GET /connect/related-orgs?client_id=<id>  (spec 246 / ADR-0025)
//
// Person-session-authorized: the relying app presents the connected person's id_token
// (Authorization: Bearer, or ?id_token=). We verify it against the broker JWKS, pin the
// audience to the calling `client_id`, extract the person SA from the session `sub`, and
// return that person's related-agent links scoped to this client_id — from the private
// Connect-home vault (KV). person↔org never travels as public graph state.
import { createPublicClient, http, keccak256, toBytes, type Hex } from 'viem';
import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import { getServer, resolveOrigin, type FnContext } from '../_lib/server-broker';
import { isAllowedClientOrigin } from '../../src/lib/oidc-clients';

const ERC1271_MAGIC = '0x1626ba7e';
const ERC1271_ABI = [
  { type: 'function', name: 'isValidSignature', stateMutability: 'view', inputs: [{ type: 'bytes32' }, { type: 'bytes' }], outputs: [{ type: 'bytes4' }] },
] as const;

function cors(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  return origin && isAllowedClientOrigin(origin)
    ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization, content-type', vary: 'Origin' }
    : {};
}
function jsonCors(body: unknown, request: Request, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors(request) } });
}

export const onRequestOptions = async ({ request }: FnContext): Promise<Response> =>
  new Response(null, { status: 204, headers: cors(request) });

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const url = new URL(request.url);
  // `client_id` present → a RELYING app's scoped view (orgs it requested; token aud = client_id).
  // `client_id` absent  → the PERSON's OWN home view (ALL their orgs; token aud = the home aud).
  const clientId = url.searchParams.get('client_id');
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : url.searchParams.get('id_token') ?? '';
  if (!token) return jsonCors({ error: 'id_token required' }, request, 400);

  const iss = resolveOrigin(request, env);
  const homeAud = env.DEMO_SSO_AUD ?? 'demo-sso';
  const { jwks } = await getServer(env);
  const keys = await importJwks(jwks);
  const v = await verifyAgentSession(token, { keys, expectedAud: clientId ?? homeAud, expectedIss: iss });
  if (!v.ok) return jsonCors({ error: `invalid session token: ${v.reason}` }, request, 401);

  const person = (v.session.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase();
  if (!person) return jsonCors({ error: 'no person address in token sub' }, request, 401);

  const idx = JSON.parse((await env.AUTH_CODES.get(`related-idx:${person}`)) ?? '[]') as string[];
  const orgs: Array<Record<string, unknown>> = [];
  for (const org of idx) {
    const raw = await env.AUTH_CODES.get(`related:${person}:${org}`);
    if (!raw) continue;
    const link = JSON.parse(raw) as {
      orgAgent: string; orgName: string; purpose: string; requestedBy: string;
      siteDelegation: unknown; proofHash: string | null; createdAt?: number;
    };
    if (clientId && link.requestedBy !== clientId) continue; // relying-app view is scoped
    orgs.push({
      orgAgent: link.orgAgent,
      orgName: link.orgName,
      purpose: link.purpose,
      requestedBy: link.requestedBy,
      createdAt: link.createdAt ?? null,
      delegation: link.siteDelegation,
      proofHash: link.proofHash,
    });
  }
  return jsonCors({ orgs }, request);
};

// POST /connect/related-orgs  (spec 247) — register a person→org link the person
// already governs (e.g. demo-jp's operator orgs, created outside the Connect
// org-create ceremony). Authorized by CONTROL OF THE PERSON SA: the caller signs
// the fixed challenge `keccak256("related-orgs:write:<person>")` with a custodian
// of the person SA; we verify via ERC-1271. Writes the same KV the GET reads, so
// the link surfaces in /you's existing related-orgs query — no new data source.
export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const body = (await request.json().catch(() => null)) as {
    person?: string; orgAgent?: string; orgName?: string; purpose?: string;
    requestedBy?: string; sig?: string; siteDelegation?: unknown; proofHash?: string | null;
  } | null;
  const person = (body?.person ?? '').toLowerCase();
  const org = (body?.orgAgent ?? '').toLowerCase();
  const sig = (body?.sig ?? '') as Hex;
  if (!/^0x[0-9a-f]{40}$/.test(person) || !/^0x[0-9a-f]{40}$/.test(org) || !sig.startsWith('0x')) {
    return jsonCors({ error: 'person, orgAgent (0x…40) + sig required' }, request, 400);
  }

  // Control-of-person proof (ERC-1271 over the fixed per-person challenge).
  const challenge = keccak256(toBytes(`related-orgs:write:${person}`));
  const client = createPublicClient({ transport: http(env.RPC_URL ?? 'https://sepolia.base.org') });
  let valid = false;
  try {
    const r = (await client.readContract({
      address: person as Hex,
      abi: ERC1271_ABI,
      functionName: 'isValidSignature',
      args: [challenge, sig],
    })) as string;
    valid = r === ERC1271_MAGIC;
  } catch {
    valid = false;
  }
  if (!valid) return jsonCors({ error: 'not authorized for person (ERC-1271 check failed)' }, request, 401);

  const link = {
    orgAgent: org,
    orgName: body?.orgName ?? '',
    purpose: body?.purpose ?? '',
    requestedBy: body?.requestedBy ?? '',
    siteDelegation: body?.siteDelegation ?? null,
    proofHash: body?.proofHash ?? null,
    createdAt: Date.now(),
  };
  await env.AUTH_CODES.put(`related:${person}:${org}`, JSON.stringify(link));
  const idx = JSON.parse((await env.AUTH_CODES.get(`related-idx:${person}`)) ?? '[]') as string[];
  if (!idx.includes(org)) {
    idx.push(org);
    await env.AUTH_CODES.put(`related-idx:${person}`, JSON.stringify(idx));
  }
  return jsonCors({ ok: true }, request);
};
