// POST /connect/enroll { kind, id, agent } → record a credential->agent facet in
// the KV indexer (so future logins resolve). Self-verifying (P0-C for the demo):
// only a facet that is ALREADY TRUE on-chain is recorded — siwe-eoa/hardware must
// pass isCustodian(agent, id); passkey must pass hasPasskey(agent, digest). You
// cannot enroll a credential against an agent you do not actually control on-chain.
// (OIDC links — not on-chain-verifiable — are out of scope here; they require a
// custody-grade AgentSession of the agent, a later endpoint.)
import { AgentAccountClient } from '@agenticprimitives/agent-account';
import { toCanonicalAgentId } from '@agenticprimitives/identity-directory-adapters';
import type { Address, CredentialPrincipal, Hex } from '@agenticprimitives/types';
import { json, type FnContext } from '../_lib/server-broker';
import { recordCredentialFacet } from '../../src/lib/kv-indexer';
import { CHAIN_ID, CONTRACTS, DEFAULT_RPC_URL } from '../../src/lib/chain';

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const body = (await request.json().catch(() => null)) as
    | { kind?: string; id?: string; agent?: string }
    | null;
  if (!body?.kind || !body.id || !body.agent) return json({ error: 'kind, id, agent required' }, 400);

  const agent = toCanonicalAgentId(CHAIN_ID, body.agent as Address);
  const accounts = new AgentAccountClient({
    rpcUrl: env.RPC_URL ?? DEFAULT_RPC_URL,
    chainId: CHAIN_ID,
    entryPoint: CONTRACTS.entryPoint,
    factory: CONTRACTS.agentAccountFactory,
  });

  let confirmed = false;
  if (body.kind === 'siwe-eoa' || body.kind === 'hardware') {
    confirmed = await accounts.isCustodian(body.agent as Address, body.id as Address);
  } else if (body.kind === 'passkey') {
    confirmed = await accounts.hasPasskey(body.agent as Address, body.id as Hex);
  } else {
    return json({ error: `cannot self-verify a ${body.kind} facet on-chain` }, 403);
  }
  if (!confirmed) return json({ error: 'credential is not an on-chain custodian of that agent' }, 403);

  const principal = { kind: body.kind, id: body.id, assurance: 'asserted', role: 'custody-grade' } as CredentialPrincipal;
  await recordCredentialFacet(env.AUTH_CODES, principal, agent);
  return json({ ok: true, agent });
};
