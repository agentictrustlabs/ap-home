// GET /connect/org-invite/lookup?token=… → { org, orgName } for a valid, unexpired invite (the redeem
// page reads it). The token IS the secret; no session needed (you hold the link). KV holds ONLY the
// token→org pointer (no PII); the org name is public (reverse-resolved on-chain).
import { AgentNamingClient } from '@agenticprimitives/agent-naming';
import type { Address } from '@agenticprimitives/types';
import type { FnContext } from '../_lib/server-broker';
import { CHAIN_ID, CONTRACTS, DEFAULT_RPC_URL } from '../../src/lib/chain';
import { nameLabel } from '../../src/lib/domain';

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' };
const json = (b: unknown, s = 200): Response =>
  new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', ...cors } });

export const onRequestOptions = async (): Promise<Response> => new Response(null, { status: 204, headers: cors });

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const token = (new URL(request.url).searchParams.get('token') ?? '').trim();
  if (!/^[a-f0-9]{40,80}$/.test(token)) return json({ error: 'invalid token' }, 400);
  const raw = await env.AUTH_CODES.get(`orginvite:${token}`);
  if (!raw) return json({ error: 'this invitation has expired or was already used' }, 404);
  const { org } = JSON.parse(raw) as { org: string };
  const orgName = await new AgentNamingClient({
    rpcUrl: env.RPC_URL ?? DEFAULT_RPC_URL, chainId: CHAIN_ID,
    registry: CONTRACTS.agentNameRegistry, universalResolver: CONTRACTS.agentNameUniversalResolver,
  }).reverseResolve(org as Address).then((n) => (n ? nameLabel(n) : null)).catch(() => null);
  return json({ ok: true, org, orgName: orgName ?? org });
};
