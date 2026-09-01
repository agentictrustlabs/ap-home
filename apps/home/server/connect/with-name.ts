// POST /connect/with-name { name, kind, aud, ...proof } → connect to the agent that
// OWNS the given agent-service name, by proving control with a custody credential.
//
// The agent is the on-chain owner of `<name>` (resolveName) — server-resolved, not
// client-supplied. The credential must control that agent on-chain (siwe →
// isCustodian; passkey → isValidSignature). The agent NAME is the stable identity;
// any custodian credential proves it. On success → custody-grade session for the agent.
import { verify as verifySiwe, parseMessage } from '@agenticprimitives/connect-auth/siwe';
import { mintAgentSession } from '@agenticprimitives/connect';
import { AgentAccountClient } from '@agenticprimitives/agent-account';
import { AgentNamingClient } from '@agenticprimitives/agent-naming';
import { toCanonicalAgentId } from '@agenticprimitives/identity-directory-adapters';
import type { CredentialPrincipal, Hex } from '@agenticprimitives/types';
import { getServer, json, resolveOrigin, type FnContext } from '../_lib/server-broker';
import { recordCredentialFacet } from '../../src/lib/kv-indexer';
import { CHAIN_ID, CONTRACTS, DEFAULT_RPC_URL } from '../../src/lib/chain';
import { qualifiedAgentName as fullName } from '../../src/lib/domain';



const onRequestPostImpl = async ({ request, env }: FnContext): Promise<Response> => {
  const body = (await request.json().catch(() => null)) as
    | {
        name?: string;
        kind?: 'siwe-eoa' | 'passkey';
        aud?: string;
        message?: string;
        signature?: string;
        credentialIdDigest?: string;
        challenge?: string;
      }
    | null;
  if (!body?.name || !body.kind || !body.aud) return json({ error: 'name, kind, aud required' }, 400);
  // SEC-024: gate iss through the Host allowlist.
  const iss = resolveOrigin(request, env);
  const rpcUrl = env.RPC_URL ?? DEFAULT_RPC_URL;

  // Resolve the name → its owning agent (on-chain; server-authoritative).
  const name = fullName(body.name);
  const naming = new AgentNamingClient({
    rpcUrl,
    chainId: CHAIN_ID,
    registry: CONTRACTS.agentNameRegistry,
    universalResolver: CONTRACTS.agentNameUniversalResolver,
  });
  const agent = await naming.resolveName(name);
  if (!agent) return json({ error: `no workspace named "${name}"` }, 404);

  const accounts = new AgentAccountClient({
    rpcUrl,
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
      return json({ error: `that wallet is not a custodian of ${name}` }, 403);
    }
    principal = { kind: 'siwe-eoa', id: v.address, assurance: 'onchain-confirmed', role: 'custody-grade' };
  } else {
    if (!body.credentialIdDigest || !body.challenge || !body.signature) {
      return json({ error: 'credentialIdDigest, challenge, signature required' }, 400);
    }
    const cKey = `pkchallenge:${body.challenge}`;
    if (!(await env.AUTH_CODES.get(cKey))) return json({ error: 'unknown or expired challenge' }, 400);
    await env.AUTH_CODES.delete(cKey);
    const verdict = await accounts.verifySignature(agent, body.challenge as Hex, body.signature as Hex);
    if (verdict.unavailable) {
      // The chain did not answer. Reporting that as "not a custodian" accuses a credential that may be
      // perfectly good, and sends the member off replacing passkeys to fix an RPC outage. 503, not 403 —
      // this is not a decision about them (ADR-0013: an unavailable answer is not a negative one).
      return json(
        { error: 'could not check that passkey against the network right now', detail: `chain read failed: ${verdict.unavailable}. Nothing is wrong with your passkey — try again in a moment.` },
        503,
      );
    }
    if (!verdict.valid) {
      // AUTHORIZATION IS THE LINE ABOVE and nothing below changes it — these reads only choose the
      // sentence. `isValidSignature` returning false covered three unrelated situations under one
      // message ("that passkey is not a custodian"), which reads as "your passkey is wrong" even when
      // the credential is simply one this account never registered — the common case after a create
      // whose add-userOp did not land, since the discoverable picker offers it anyway (2026-09-01).
      // The digest is CLIENT-SUPPLIED and is used here for wording only, never to grant.
      const [registered, count] = await Promise.all([
        body.credentialIdDigest ? accounts.hasPasskey(agent, body.credentialIdDigest as Hex) : Promise.resolve(null),
        accounts.passkeyCount(agent),
      ]);
      const detail =
        registered === false
          ? `The passkey you used is not one of the ${count ?? 'registered'} registered on ${name}. It exists on this device but was never added to the account — sign in with the credential that opened this home (email, phone or wallet), then add this passkey from Settings.`
          : `The signature was rejected on chain. If your device skipped its PIN or biometric check, use a phone passkey instead.`;
      return json({ error: `that passkey is not a custodian of ${name}`, detail }, 403);
    }
    principal = { kind: 'passkey', id: body.credentialIdDigest, assurance: 'onchain-confirmed', role: 'custody-grade' };
  }

  const sub = toCanonicalAgentId(CHAIN_ID, agent);
  const { signer } = await getServer(env);
  const token = await mintAgentSession(
    { sub, principal, assurance: 'onchain-confirmed', aud: body.aud, iss, ttlSeconds: 3600 },
    signer,
  );
  await recordCredentialFacet(env.AUTH_CODES, principal, sub);
  return json({ status: 'issued', token, name });
};

export const onRequestPost = async (ctx: FnContext): Promise<Response> => {
  try {
    return await onRequestPostImpl(ctx);
  } catch (e) {
    // An unhandled throw here (an RPC read on env.RPC_URL, the broker signer, etc.) would otherwise
    // return an EMPTY 500 that breaks the client's response.json(). Surface it as JSON instead.
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[with-name] 500:', msg, e instanceof Error ? e.stack : '');
    return json({ error: `connect failed: ${msg}` }, 500);
  }
};
