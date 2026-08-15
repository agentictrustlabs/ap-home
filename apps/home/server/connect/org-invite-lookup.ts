// GET /connect/org-invite/lookup?token=…&o=<org> → { org, orgName } for a valid, unexpired invite
// (the redeem page reads it). spec 323 W2.3 — SELF-DESCRIBING: the org rides the link; the invite
// record lives in the ORG VAULT (`org.invite:<token>`), so any Home validates it without a
// demo-sso-next KV pointer. The token IS the secret (you hold the link); no session needed.
import { AgentNamingClient } from '@agenticprimitives/agent-naming';
import type { Address } from '@agenticprimitives/types';
import type { FnContext } from '../_lib/server-broker';
import { CHAIN_ID, CONTRACTS, DEFAULT_RPC_URL } from '../../src/lib/chain';
import { nameLabel } from '../../src/lib/domain';
import { orgVault } from '../lib/org-vault';
import { invitedAgentFromGrant } from '../../src/lib/email-invite-home';

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' };
const json = (b: unknown, s = 200): Response =>
  new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', ...cors } });

export const onRequestOptions = async (): Promise<Response> => new Response(null, { status: 204, headers: cors });

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const url = new URL(request.url);
  const token = (url.searchParams.get('token') ?? '').trim();
  const org = (url.searchParams.get('o') ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{40,80}$/.test(token)) return json({ error: 'invalid token' }, 400);
  if (!/^0x[0-9a-f]{40}$/.test(org)) return json({ error: 'invite link missing its organization' }, 400);
  // Validate against the org vault (delegation-gated read of the org's own tracking record).
  const vault = await orgVault(env, org);
  const rec = vault
    ? ((await vault.get(`org.invite:${token}`)) as {
        expiresAt?: number;
        status?: string;
        returnUrl?: string;
        appName?: string;
        memberAccessDelegation?: { delegate?: string };
      } | null)
    : null;
  if (!rec) return json({ error: 'this invitation has expired or was already used' }, 404);
  if (typeof rec.expiresAt === 'number' && rec.expiresAt < Date.now()) return json({ error: 'this invitation has expired' }, 404);
  const orgName = await new AgentNamingClient({
    rpcUrl: env.RPC_URL ?? DEFAULT_RPC_URL, chainId: CHAIN_ID,
    registry: CONTRACTS.agentNameRegistry, universalResolver: CONTRACTS.agentNameUniversalResolver,
  }).reverseResolve(org as Address).then((n) => (n ? nameLabel(n) : null)).catch(() => null);
  // The grant's delegate is who this link admits. The redeem page compares it to the restored
  // session so a different signed-in home is told to sign out — not offered Accept as them.
  const invitedAgent = invitedAgentFromGrant(rec.memberAccessDelegation);
  // `returnUrl`/`appName` (when the invite was raised from a relying app) tell the redeem page where
  // the invitee continues after joining — the URL was origin-checked against that app at invite time.
  return json({
    ok: true,
    org,
    orgName: orgName ?? org,
    ...(invitedAgent ? { invitedAgent } : {}),
    ...(rec.returnUrl ? { returnUrl: rec.returnUrl, appName: rec.appName ?? null } : {}),
  });
};
