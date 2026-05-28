// GET /connect/link/status?agent=0x..&digest=0x.. — the NEW device polls until
// its key is a registered passkey on-chain (i.e. the original device approved +
// addPasskey landed). One on-chain read, no fallback (spec 233 P2 / ADR-0013).
import { json, type FnContext } from '../_lib/server-broker';
import { AgentAccountClient } from '@agenticprimitives/agent-account';
import type { Address, Hex } from '@agenticprimitives/types';
import { CHAIN_ID, CONTRACTS, DEFAULT_RPC_URL } from '../../src/lib/chain';

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const B32 = /^0x[0-9a-fA-F]{64}$/;

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const u = new URL(request.url);
  const agent = u.searchParams.get('agent');
  const digest = u.searchParams.get('digest');
  if (!agent || !ADDR.test(agent)) return json({ error: 'valid agent required' }, 400);
  if (!digest || !B32.test(digest)) return json({ error: 'valid digest required' }, 400);
  const accounts = new AgentAccountClient({
    rpcUrl: env.RPC_URL ?? DEFAULT_RPC_URL,
    chainId: CHAIN_ID,
    entryPoint: CONTRACTS.entryPoint,
    factory: CONTRACTS.agentAccountFactory,
  });
  const enrolled = await accounts.hasPasskey(agent as Address, digest as Hex);
  return json({ enrolled });
};
