// POST /connect/passkey/claim { credentialIdDigest, agent }  (NO session)
//
// Spec 410 §1.2 step 5 — THE MOVED PASSKEY, CLAIMED AT ITS NEW HOME. A Home-to-Home move adds a passkey registered
// at the NEW Home to the person's account, signed at the OLD one. The new Home then has to resolve that passkey to
// her agent at sign-in — the mapping `/connect/passkey/link` records — but she has no session here yet: the passkey
// is what would give her one. So this claim is gated by the ON-CHAIN FACT ALONE: the agent must actually hold the
// passkey (`hasPasskey`), which only its owner could have caused. The mapping is public by construction anyway
// (custody membership is on-chain-derivable, ADR-0040); indexing it early lets nobody act — the login path
// re-verifies `hasPasskey` and the ERC-1271 proof of possession before issuing anything.
//
// Not yet mined ⇒ 409, and the page asks again; never recorded on a promise.
import { AgentAccountClient } from '@agenticprimitives/agent-account';
import { toCanonicalAgentId } from '@agenticprimitives/identity-directory-adapters';
import type { Address, Hex, CredentialPrincipal } from '@agenticprimitives/types';
import type { FnContext } from '../_lib/server-broker';
import { recordCredentialFacet } from '../../src/lib/kv-indexer';
import { CHAIN_ID, CONTRACTS, DEFAULT_RPC_URL } from '../../src/lib/chain';

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' };
const json = (b: unknown, s = 200): Response => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', ...cors } });

export const onRequestOptions = async (): Promise<Response> => new Response(null, { status: 204, headers: cors });

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const body = (await request.json().catch(() => null)) as { credentialIdDigest?: string; agent?: string } | null;
  const digest = (body?.credentialIdDigest ?? '') as Hex;
  const agent = (body?.agent ?? '') as Address;
  if (!/^0x[0-9a-fA-F]{64}$/.test(digest) || !/^0x[0-9a-fA-F]{40}$/.test(agent)) return json({ error: 'credentialIdDigest (32-byte) + agent (address) required' }, 400);
  const accounts = new AgentAccountClient({ rpcUrl: (env.RPC_URL || DEFAULT_RPC_URL), chainId: CHAIN_ID, entryPoint: CONTRACTS.entryPoint, factory: CONTRACTS.agentAccountFactory });
  let holds = false;
  try { holds = await accounts.hasPasskey(agent, digest); } catch (e) { return json({ error: `the chain could not be read: ${e instanceof Error ? e.message : String(e)}` }, 502); }
  if (!holds) return json({ error: 'the agent does not hold this passkey on chain yet — finish the move at your old Home, then try again' }, 409);
  const principal: CredentialPrincipal = { kind: 'passkey', id: digest, assurance: 'onchain-confirmed', role: 'custody-grade' };
  await recordCredentialFacet(env.AUTH_CODES, principal, toCanonicalAgentId(CHAIN_ID, agent));
  return json({ ok: true });
};
