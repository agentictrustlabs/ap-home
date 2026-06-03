// POST /connect/siwe { message, signature, aud } → resolve the EOA to its
// canonical agent and issue an AgentSession, or signal bootstrap.
//
// SIWE is verified IN THIS FUNCTION (connect-auth ECDSA path). The EOA → SA
// mapping is DETERMINISTIC (factory CREATE2 of `{ mode:0, custodians:[eoa],
// salt:0 }` — the same spec demo-a2a's eoa deploy uses), so resolution is: derive
// the SA, then confirm on-chain (`isDeployed` + `isCustodian`). If it already
// exists (possibly created via another demo) → RECONNECT (issue a custody-grade
// session + record the facet). If not → bootstrap. This is one mechanism (derive +
// on-chain confirm), and it fixes the AA25 "re-deploy an existing SA" failure.
import { verify as verifySiwe, parseMessage } from '@agenticprimitives/connect-auth/siwe';
import { mintAgentSession } from '@agenticprimitives/connect';
import { AgentAccountClient } from '@agenticprimitives/agent-account';
import { toCanonicalAgentId } from '@agenticprimitives/identity-directory-adapters';
import type { Address, CredentialPrincipal, Hex } from '@agenticprimitives/types';
import { getServer, type FnContext } from '../_lib/server-broker';
import { recordCredentialFacet } from '../../src/lib/kv-indexer';
import { CHAIN_ID, CONTRACTS, DEFAULT_RPC_URL } from '../../src/lib/chain';
import { isAllowedClientOrigin } from '../../src/lib/oidc-clients';

// CORS-enabled (spec 247) so a relying app (demo-jp) can drive a one-click SIWE
// handoff cross-origin — only for registered relying-app origins.
function cors(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  return origin && isAllowedClientOrigin(origin)
    ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type', vary: 'Origin' }
    : {};
}
function json(body: unknown, request: Request, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors(request) } });
}

export const onRequestOptions = async ({ request }: FnContext): Promise<Response> =>
  new Response(null, { status: 204, headers: cors(request) });

/** Poll isDeployed a few times to ride out Base Sepolia's post-deploy RPC lag
 *  (returns immediately when already deployed — no cost for the reconnect case). */
async function isDeployedSoon(accounts: AgentAccountClient, sa: Address): Promise<boolean> {
  for (let i = 0; i < 6; i++) {
    if (await accounts.isDeployed(sa)) return true;
    if (i < 5) await new Promise((r) => setTimeout(r, 2500));
  }
  return false;
}

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const body = (await request.json().catch(() => null)) as
    | { message?: string; signature?: string; aud?: string }
    | null;
  if (!body?.message || !body.signature || !body.aud) {
    return json({ error: 'message, signature, aud required' }, request, 400);
  }
  const url = new URL(request.url);
  const iss = url.origin;

  // Single-use nonce (consume before verifying signature).
  let parsedNonce: string;
  try {
    parsedNonce = parseMessage(body.message).nonce;
  } catch {
    return json({ error: 'malformed SIWE message' }, request, 400);
  }
  const nonceKey = `nonce:${parsedNonce}`;
  if (!(await env.AUTH_CODES.get(nonceKey))) return json({ error: 'unknown or expired nonce' }, request, 400);
  await env.AUTH_CODES.delete(nonceKey);

  const v = verifySiwe(body.message, body.signature as Hex, {
    allowedDomains: [url.host],
    expectedNonce: parsedNonce,
  });
  if (!v.ok) return json({ error: `SIWE verify failed: ${v.reason}` }, request, 401);

  const eoa = v.address;
  const principal: CredentialPrincipal = {
    kind: 'siwe-eoa',
    id: eoa,
    assurance: 'onchain-confirmed',
    role: 'custody-grade',
  };

  // Derive the deterministic SA for this EOA (mode 0, salt 0, custodian = eoa) and
  // confirm on-chain. Already deployed + custodian → reconnect; else → bootstrap.
  const accounts = new AgentAccountClient({
    rpcUrl: env.RPC_URL ?? DEFAULT_RPC_URL,
    chainId: CHAIN_ID,
    entryPoint: CONTRACTS.entryPoint,
    factory: CONTRACTS.agentAccountFactory,
  });
  let sa: Address;
  try {
    sa = await accounts.getAddressForAgentAccount({ mode: 0, custodians: [eoa], salt: 0n });
  } catch (e) {
    return json({ error: 'SA address derivation failed', detail: String(e) }, request, 502);
  }

  if ((await isDeployedSoon(accounts, sa)) && (await accounts.isCustodian(sa, eoa))) {
    // Reconnect: the canonical SA already exists on-chain.
    const sub = toCanonicalAgentId(CHAIN_ID, sa);
    const { signer } = await getServer(env);
    // DEMO-ONLY (spec 247): the demo-jp operator agents (Pete/Jill) get a ~10-year
    // session so their "Sign in at impact-agent.me" link from the demo dashboard is
    // always valid. This is a deliberate, scoped weakening of ONLY these two demo
    // person agents — NEVER do this for real users. See apps/demo-jp/docs/operator-recovery.md.
    const DEMO_LONG_LIVED_EOAS = new Set([
      '0x0376aac07ad725e01357b1725b5cec61ae10473c', // Jill — demo-jp JP broker operator
      '0xe05fcc23807536bee418f142d19fa0d21bb0cff7', // Pete — demo-jp Global Church operator
    ]);
    const ttlSeconds = DEMO_LONG_LIVED_EOAS.has(eoa.toLowerCase()) ? 60 * 60 * 24 * 365 * 10 : 3600;
    const token = await mintAgentSession(
      { sub, principal, assurance: 'onchain-confirmed', aud: body.aud, iss, ttlSeconds },
      signer,
    );
    await recordCredentialFacet(env.AUTH_CODES, principal, sub); // future resolves + reverse-name
    return json({ status: 'issued', token, agent: sa }, request);
  }

  // No SA yet for this EOA → bootstrap (deploy a fresh person SA).
  return json({ status: 'bootstrap', address: eoa }, request);
};
