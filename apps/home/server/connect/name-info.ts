// GET /connect/name-info?name=<agent-name> → does the workspace exist, and which
// custody credentials does it have? Drives the connect UI: show "passkey" and/or
// "wallet" based on the agent's ACTUAL on-chain custodian set.
//   { exists: false, name } | { exists: true, name, agent, hasEoa, hasPasskey }
import { AgentNamingClient } from '@agenticprimitives/agent-naming';
import { AgentAccountClient } from '@agenticprimitives/agent-account';
import { json, type FnContext } from '../_lib/server-broker';
import { CHAIN_ID, CONTRACTS, DEFAULT_RPC_URL } from '../../src/lib/chain';

function fullName(name: string): string {
  const n = name.trim().toLowerCase();
  return n.endsWith('.demo.agent') ? n : `${n.replace(/\.+$/, '')}.demo.agent`;
}

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const raw = new URL(request.url).searchParams.get('name');
  if (!raw || !raw.trim()) return json({ error: 'name required' }, 400);
  const name = fullName(raw);
  const rpcUrl = env.RPC_URL ?? DEFAULT_RPC_URL;

  const naming = new AgentNamingClient({
    rpcUrl,
    chainId: CHAIN_ID,
    registry: CONTRACTS.agentNameRegistry,
    universalResolver: CONTRACTS.agentNameUniversalResolver,
  });
  const agent = await naming.resolveName(name);
  if (!agent) return json({ exists: false, name });

  const accounts = new AgentAccountClient({
    rpcUrl,
    chainId: CHAIN_ID,
    entryPoint: CONTRACTS.entryPoint,
    factory: CONTRACTS.agentAccountFactory,
  });
  // custodianCount() = external (EOA/SIWE/contract) custodians + registered passkeys
  // (each passkey is a first-class custodian on-chain). So the EOA-only count is the
  // difference; a passkey-direct account has custodianCount == passkeyCount and 0 EOAs.
  const [custodianCount, pkCount] = await Promise.all([
    accounts.custodianCount(agent),
    accounts.passkeyCount(agent),
  ]);
  const eoaCount = custodianCount - pkCount;
  return json({ exists: true, name, agent, hasEoa: eoaCount > 0n, hasPasskey: pkCount > 0n });
};
