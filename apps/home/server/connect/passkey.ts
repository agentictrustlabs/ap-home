// POST /connect/passkey { credentialIdDigest, pubKeyX, pubKeyY, challenge, signature, aud }
// → resolve the passkey to its DETERMINISTIC SA on-chain + verify proof-of-possession,
// then issue an AgentSession (or signal bootstrap).
//
// Like /connect/siwe, resolution is deterministic: the SA address is the CREATE2 of
// `{ custodians:[], passkey:{credentialIdDigest,x,y}, salt:0 }` (the spec demo-a2a's
// passkey-direct deploy uses). Confirm on-chain (isDeployed + hasPasskey, with a short
// poll for post-deploy RPC lag), prove possession (isValidSignature over the single-use
// challenge), then RECONNECT (mint a custody-grade session + record the facet). If the
// SA doesn't exist yet → bootstrap. No KV facet needed — so an SA created in any flow is
// recognized, and a freshly-deployed one isn't re-deployed (no AA25).
import { mintAgentSession } from '@agenticprimitives/connect';
import { AgentAccountClient } from '@agenticprimitives/agent-account';
import { toCanonicalAgentId } from '@agenticprimitives/identity-directory-adapters';
import type { Address, CredentialPrincipal, Hex } from '@agenticprimitives/types';
import { getServer, json, resolveOrigin, type FnContext } from '../_lib/server-broker';
import { recordCredentialFacet } from '../../src/lib/kv-indexer';
import { CHAIN_ID, CONTRACTS, DEFAULT_RPC_URL } from '../../src/lib/chain';

/** Poll isDeployed a few times to ride out Base Sepolia's post-deploy RPC lag. */
async function isDeployedSoon(accounts: AgentAccountClient, sa: Address): Promise<boolean> {
  for (let i = 0; i < 6; i++) {
    if (await accounts.isDeployed(sa)) return true;
    if (i < 5) await new Promise((r) => setTimeout(r, 2500));
  }
  return false;
}

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const body = (await request.json().catch(() => null)) as
    | { credentialIdDigest?: string; pubKeyX?: string; pubKeyY?: string; challenge?: string; signature?: string; aud?: string }
    | null;
  if (!body?.credentialIdDigest || !body.pubKeyX || !body.pubKeyY || !body.challenge || !body.signature || !body.aud) {
    return json({ error: 'credentialIdDigest, pubKeyX, pubKeyY, challenge, signature, aud required' }, 400);
  }
  // SEC-024: gate iss through the Host allowlist (closes the gap SEC-006 left on the
  // Connect-auth code path; the broker must NEVER sign sessions with a foreign Host).
  const iss = resolveOrigin(request, env);

  // Single-use challenge.
  const key = `pkchallenge:${body.challenge}`;
  if (!(await env.AUTH_CODES.get(key))) return json({ error: 'unknown or expired challenge' }, 400);
  await env.AUTH_CODES.delete(key);

  const principal: CredentialPrincipal = {
    kind: 'passkey',
    id: body.credentialIdDigest,
    assurance: 'onchain-confirmed',
    role: 'custody-grade',
  };

  const accounts = new AgentAccountClient({
    rpcUrl: env.RPC_URL ?? DEFAULT_RPC_URL,
    chainId: CHAIN_ID,
    entryPoint: CONTRACTS.entryPoint,
    factory: CONTRACTS.agentAccountFactory,
  });

  // Derive the deterministic passkey SA (mode 0, no custodians, passkey set, salt 0).
  let sa: Address;
  try {
    sa = await accounts.getAddressForAgentAccount({
      mode: 0,
      custodians: [],
      passkey: { credentialIdDigest: body.credentialIdDigest as Hex, x: BigInt(body.pubKeyX), y: BigInt(body.pubKeyY) },
      salt: 0n,
    });
  } catch (e) {
    return json({ error: 'SA address derivation failed', detail: String(e) }, 502);
  }

  if (!(await isDeployedSoon(accounts, sa))) return json({ status: 'bootstrap' });
  if (!(await accounts.hasPasskey(sa, body.credentialIdDigest as Hex))) return json({ status: 'bootstrap' });

  // Proof-of-possession: the registered passkey must have signed THIS challenge.
  const valid = await accounts.isValidSignature(sa, body.challenge as Hex, body.signature as Hex);
  if (!valid) return json({ error: 'passkey signature invalid (proof-of-possession failed)' }, 401);

  const sub = toCanonicalAgentId(CHAIN_ID, sa);
  const { signer } = await getServer(env);
  const token = await mintAgentSession(
    { sub, principal, assurance: 'onchain-confirmed', aud: body.aud, iss, ttlSeconds: 3600 },
    signer,
  );
  await recordCredentialFacet(env.AUTH_CODES, principal, sub);
  return json({ status: 'issued', token, agent: sa });
};
