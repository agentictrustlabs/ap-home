// GET /connect/reverse-name?address=0x… → the agent's primary name, or null.
//   { address, name: string | null }
// Single on-chain read via AgentNamingClient.reverseResolve (reverseResolveString;
// forward-confirmed on-chain — ADR-0012/0013, no log scan, no fallback).
import { AgentNamingClient } from '@agenticprimitives/agent-naming';
import { json, type FnContext } from '../_lib/server-broker';
import { CHAIN_ID, CONTRACTS, DEFAULT_RPC_URL } from '../../src/lib/chain';
import type { Address } from '@agenticprimitives/types';

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const raw = (new URL(request.url).searchParams.get('address') ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(raw)) return json({ error: 'address (0x…40) required' }, 400);

  const naming = new AgentNamingClient({
    rpcUrl: env.RPC_URL ?? DEFAULT_RPC_URL,
    chainId: CHAIN_ID,
    registry: CONTRACTS.agentNameRegistry,
    universalResolver: CONTRACTS.agentNameUniversalResolver,
  });
  const name = await naming.reverseResolve(raw as Address);
  return json({ address: raw, name: name ?? null });
};
