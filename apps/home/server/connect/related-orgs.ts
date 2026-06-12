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
// (importJwks / verifyAgentSession / getServer / resolveOrigin are also used by the
//  spec-275 session-authorized POST branch below — same verifier as the GET.)

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
      membershipDelegation?: unknown; stewardshipDelegation?: unknown;
    };
    if (clientId && link.requestedBy !== clientId) continue; // relying-app view is scoped
    const l = link as typeof link & { kind?: string; parent?: string };
    orgs.push({
      orgAgent: link.orgAgent,
      orgName: link.orgName,
      purpose: link.purpose,
      requestedBy: link.requestedBy,
      createdAt: link.createdAt ?? null,
      delegation: link.siteDelegation,
      proofHash: link.proofHash,
      // spec 246 person↔org read delegations: membership = person→org (org reads its
      // member); stewardship = org→person (person reads/oversees the org).
      membershipDelegation: link.membershipDelegation ?? null,
      stewardshipDelegation: link.stewardshipDelegation ?? null,
      // spec 275: the agent kind + its parent in the member's agent tree. Legacy org
      // links (no kind) default to a person-parented 'org' so the tree still renders.
      kind: l.kind ?? 'org',
      parent: l.parent ?? person,
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
    // spec 271 (W0a) — the recoverable custody descriptor for the org SA (private; salt + custody kind,
    // NO owner identifier). Persisted so an authenticated owner can later reconstruct the org's custodian.
    custody?: unknown;
    // spec 275 — managed-agent metadata: kind ∈ {person-treasury,org,org-treasury} and the
    // PARENT this agent hangs under in the member's tree (person SA, or an org SA the person controls).
    kind?: string;
    parent?: string;
  } | null;
  const person = (body?.person ?? '').toLowerCase();
  const org = (body?.orgAgent ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(person) || !/^0x[0-9a-f]{40}$/.test(org)) {
    return jsonCors({ error: 'person, orgAgent (0x…40) required' }, request, 400);
  }

  // Two explicit, caller-SELECTED auth methods (not a fallback chain — ADR-0013):
  //   • Bearer home-session token  → the person manages their OWN agent tree (spec 275).
  //   • `sig` (ERC-1271 over the   → an external custodian (e.g. demo-jp operator) registers
  //     fixed per-person challenge)   a person→org link it already governs (spec 247).
  const auth = request.headers.get('authorization') ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const sig = (body?.sig ?? '') as Hex;

  if (bearer) {
    // Home-session path: the token's `sub` IS the authority; it must equal `person`.
    const iss = resolveOrigin(request, env);
    const homeAud = env.DEMO_SSO_AUD ?? 'demo-sso';
    const { jwks } = await getServer(env);
    const keys = await importJwks(jwks);
    const v = await verifyAgentSession(bearer, { keys, expectedAud: homeAud, expectedIss: iss });
    if (!v.ok) return jsonCors({ error: `invalid session token: ${v.reason}` }, request, 401);
    const sessionPerson = (v.session.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase();
    if (!sessionPerson || sessionPerson !== person) {
      return jsonCors({ error: 'session does not control this person' }, request, 401);
    }
    // spec 275 MAM-D6: an org-treasury's PARENT must be an org the person already controls
    // (present in their tree) — never an arbitrary address. Person-parented kinds are implicitly fine.
    const parent = (body?.parent ?? person).toLowerCase();
    if (parent !== person) {
      const ownIdx = JSON.parse((await env.AUTH_CODES.get(`related-idx:${person}`)) ?? '[]') as string[];
      if (!ownIdx.includes(parent)) {
        return jsonCors({ error: 'parent is not an agent you control' }, request, 401);
      }
    }
  } else {
    // ERC-1271 control-of-person proof (existing spec-247 external-custodian path).
    if (!sig.startsWith('0x')) return jsonCors({ error: 'sig or Bearer session required' }, request, 400);
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
  }

  const link = {
    orgAgent: org,
    orgName: body?.orgName ?? '',
    purpose: body?.purpose ?? '',
    requestedBy: body?.requestedBy ?? '',
    siteDelegation: body?.siteDelegation ?? null,
    proofHash: body?.proofHash ?? null,
    // spec 271 (W0a) — persist the recoverable custody descriptor when the caller supplies one. Stored in
    // the same person-scoped KV the owner controls; read back by recoverCustodian (W0b).
    custody: body?.custody ?? null,
    // spec 275 — agent kind + parent (defaults keep legacy org links person-parented).
    kind: body?.kind ?? 'org',
    parent: (body?.parent ?? person).toLowerCase(),
    createdAt: Date.now(),
  };
  // Index the WHOLE tree under the person (root) so the home renders org-treasuries too (MAM-D7).
  await env.AUTH_CODES.put(`related:${person}:${org}`, JSON.stringify(link));
  const idx = JSON.parse((await env.AUTH_CODES.get(`related-idx:${person}`)) ?? '[]') as string[];
  if (!idx.includes(org)) {
    idx.push(org);
    await env.AUTH_CODES.put(`related-idx:${person}`, JSON.stringify(idx));
  }
  return jsonCors({ ok: true }, request);
};
