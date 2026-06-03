// GET /connect/delegated-orgs?delegate=<agent>&sig=<hex>  (spec 246 §5)
//
// Delegate-control-authorized: a grantee agent (e.g. the JP broker org SA) lists the
// orgs that delegated scoped access to it. The caller proves control of `delegate` by
// signing the fixed challenge `keccak256("delegated-orgs:<delegate>")` with a custodian
// of that SA; we verify via the SA's ERC-1271 `isValidSignature`. The index carries org
// metadata + the org→delegate delegation only — no person identity (ADR-0025).
import { createPublicClient, http, keccak256, toBytes, type Hex } from 'viem';
import { type FnContext } from '../_lib/server-broker';
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
  const delegate = (url.searchParams.get('delegate') ?? '').toLowerCase();
  const sig = (url.searchParams.get('sig') ?? '') as Hex;
  if (!/^0x[0-9a-f]{40}$/.test(delegate) || !sig.startsWith('0x')) {
    return jsonCors({ error: 'delegate (0x…40) + sig required' }, request, 400);
  }

  // Verify the caller controls `delegate` (ERC-1271 over the fixed per-delegate challenge).
  const challenge = keccak256(toBytes(`delegated-orgs:${delegate}`));
  const client = createPublicClient({ transport: http(env.RPC_URL ?? 'https://sepolia.base.org') });
  let valid = false;
  try {
    const r = (await client.readContract({
      address: delegate as Hex,
      abi: ERC1271_ABI,
      functionName: 'isValidSignature',
      args: [challenge, sig],
    })) as string;
    valid = r === ERC1271_MAGIC;
  } catch {
    valid = false;
  }
  if (!valid) return jsonCors({ error: 'not authorized for delegate (ERC-1271 check failed)' }, request, 401);

  const orgs = JSON.parse((await env.AUTH_CODES.get(`delegated-idx:${delegate}`)) ?? '[]') as Array<Record<string, unknown>>;
  return jsonCors({ orgs }, request);
};
