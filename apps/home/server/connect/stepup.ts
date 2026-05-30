// POST /connect/stepup { googleToken, kind, aud, ...proof } → step a login-grade
// Google session UP to a custody-grade session for the SAME agent it's bound to.
//
// The target agent is taken from the verified Google AgentSession (googleToken.sub) —
// NOT from a client-supplied id — so a Google login can only ever step up into its ONE
// bound agent. The custody credential must prove it controls THAT agent on-chain:
//   - siwe-eoa: verify SIWE → recovered EOA must be isCustodian(agent, eoa)
//   - passkey:  isValidSignature(agent, challenge, blob) — the passkey is a custodian
// On success, mint a custody-grade AgentSession for the agent. If the credential is NOT
// a custodian of that agent → 403 (add it first from a custody session).
import { verify as verifySiwe, parseMessage } from '@agenticprimitives/connect-auth/siwe';
import { mintAgentSession, verifyAgentSession, importJwks } from '@agenticprimitives/connect';
import { AgentAccountClient } from '@agenticprimitives/agent-account';
import { addressOf } from '@agenticprimitives/identity-directory-adapters';
import type { CredentialPrincipal, Hex } from '@agenticprimitives/types';
import { getServer, json, resolveOrigin, type FnContext } from '../_lib/server-broker';
import { CHAIN_ID, CONTRACTS, DEFAULT_RPC_URL } from '../../src/lib/chain';

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const body = (await request.json().catch(() => null)) as
    | {
        googleToken?: string;
        kind?: 'siwe-eoa' | 'passkey';
        aud?: string;
        message?: string;
        signature?: string;
        credentialIdDigest?: string;
        challenge?: string;
      }
    | null;
  if (!body?.googleToken || !body.kind || !body.aud) {
    return json({ error: 'googleToken, kind, aud required' }, 400);
  }
  // SEC-024: gate iss through the Host allowlist.
  const iss = resolveOrigin(request, env);
  const { signer, jwks } = await getServer(env);

  // The target agent is bound to the verified Google session — not client-chosen.
  const keys = await importJwks(jwks);
  const g = await verifyAgentSession(body.googleToken, { keys, expectedIss: iss, expectedAud: body.aud });
  if (!g.ok) return json({ error: 'invalid Google session' }, 401);
  const agentId = g.session.sub;
  const agent = addressOf(agentId);

  const accounts = new AgentAccountClient({
    rpcUrl: env.RPC_URL ?? DEFAULT_RPC_URL,
    chainId: CHAIN_ID,
    entryPoint: CONTRACTS.entryPoint,
    factory: CONTRACTS.agentAccountFactory,
  });

  let principal: CredentialPrincipal;

  if (body.kind === 'siwe-eoa') {
    if (!body.message || !body.signature) return json({ error: 'message + signature required' }, 400);
    let nonce: string;
    try {
      nonce = parseMessage(body.message).nonce;
    } catch {
      return json({ error: 'malformed SIWE message' }, 400);
    }
    const nKey = `nonce:${nonce}`;
    if (!(await env.AUTH_CODES.get(nKey))) return json({ error: 'unknown or expired nonce' }, 400);
    await env.AUTH_CODES.delete(nKey);
    const v = verifySiwe(body.message, body.signature as Hex, { allowedDomains: [new URL(request.url).host], expectedNonce: nonce });
    if (!v.ok) return json({ error: `SIWE verify failed: ${v.reason}` }, 401);
    if (!(await accounts.isCustodian(agent, v.address))) {
      return json({ error: 'this wallet is not a custodian of your workspace — add it first' }, 403);
    }
    principal = { kind: 'siwe-eoa', id: v.address, assurance: 'onchain-confirmed', role: 'custody-grade' };
  } else {
    if (!body.credentialIdDigest || !body.challenge || !body.signature) {
      return json({ error: 'credentialIdDigest, challenge, signature required' }, 400);
    }
    const cKey = `pkchallenge:${body.challenge}`;
    if (!(await env.AUTH_CODES.get(cKey))) return json({ error: 'unknown or expired challenge' }, 400);
    await env.AUTH_CODES.delete(cKey);
    // isValidSignature against the agent proves the passkey is a registered custodian of it.
    if (!(await accounts.isValidSignature(agent, body.challenge as Hex, body.signature as Hex))) {
      return json({ error: 'this passkey is not a custodian of your workspace — add it first' }, 403);
    }
    principal = { kind: 'passkey', id: body.credentialIdDigest, assurance: 'onchain-confirmed', role: 'custody-grade' };
  }

  const token = await mintAgentSession(
    { sub: agentId, principal, assurance: 'onchain-confirmed', aud: body.aud, iss, ttlSeconds: 3600 },
    signer,
  );
  return json({ status: 'issued', token });
};
