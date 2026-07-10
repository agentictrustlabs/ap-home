// POST /connect/passkey/link { credentialIdDigest, agent }  (Bearer session)
//
// Index a passkey → home mapping so passkey sign-in can resolve a SECONDARY passkey — one added as a
// custodian to a KMS/social home (phone/email/google) whose SA is NOT derived from the passkey. Without
// this, /connect/passkey derives SA = f(passkey) and lands on the wrong (passkey-direct) address.
//
// Gated twice, so it only indexes a REAL, owner-authorized custodian: (1) the Bearer session must control
// `agent`; (2) `agent` must ACTUALLY hold the passkey on-chain (AgentAccountClient.hasPasskey). The facet
// is asserted-grade evidence; the login path re-verifies hasPasskey + ERC-1271 PoP before issuing.
import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import { AgentAccountClient } from '@agenticprimitives/agent-account';
import { toCanonicalAgentId } from '@agenticprimitives/identity-directory-adapters';
import type { Address, Hex, CredentialPrincipal } from '@agenticprimitives/types';
import { getServer, ownIssuer, type FnContext } from '../_lib/server-broker';
import { recordCredentialFacet } from '../../src/lib/kv-indexer';
import { CHAIN_ID, CONTRACTS, DEFAULT_RPC_URL } from '../../src/lib/chain';

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization' };
const json = (b: unknown, s = 200): Response =>
  new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', ...cors } });

export const onRequestOptions = async (): Promise<Response> => new Response(null, { status: 204, headers: cors });

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return json({ error: 'session required' }, 401);

  const body = (await request.json().catch(() => null)) as { credentialIdDigest?: string; agent?: string } | null;
  const digest = (body?.credentialIdDigest ?? '') as Hex;
  const agent = (body?.agent ?? '') as Address;
  if (!/^0x[0-9a-fA-F]{64}$/.test(digest) || !/^0x[0-9a-fA-F]{40}$/.test(agent)) {
    return json({ error: 'credentialIdDigest (32-byte) + agent (address) required' }, 400);
  }

  // (1) The session must control the target agent.
  const { jwks } = await getServer(env);
  const keys = await importJwks(jwks);
  const v = await verifyAgentSession(token, { keys, expectedAud: env.DEMO_SSO_AUD ?? 'demo-sso', expectedIss: ownIssuer(request, env) });
  if (!v.ok) return json({ error: 'invalid session' }, 401);
  if ((v.session.sub.split(':').pop() ?? '').toLowerCase() !== agent.toLowerCase()) {
    return json({ error: 'session does not control this agent' }, 403);
  }

  // (2) On-chain gate: the agent must actually hold this passkey (owner-authorized custodian, mined).
  const accounts = new AgentAccountClient({
    rpcUrl: env.RPC_URL ?? DEFAULT_RPC_URL, chainId: CHAIN_ID, entryPoint: CONTRACTS.entryPoint, factory: CONTRACTS.agentAccountFactory,
  });
  if (!(await accounts.hasPasskey(agent, digest))) {
    return json({ error: 'agent does not hold this passkey on-chain yet (still mining?)' }, 409);
  }

  const principal: CredentialPrincipal = { kind: 'passkey', id: digest, assurance: 'onchain-confirmed', role: 'custody-grade' };
  await recordCredentialFacet(env.AUTH_CODES, principal, toCanonicalAgentId(CHAIN_ID, agent));
  return json({ ok: true });
};
