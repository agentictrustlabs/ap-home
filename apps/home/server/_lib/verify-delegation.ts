// Server-side delegation verification (spec 230 silent re-auth / ADR-0019 runtime auth).
// Mirrors demo-a2a's verifyDelegation: the CANONICAL hashDelegation (CAVEAT_TYPEHASH excludes
// `args`, audit F-1) + ERC-1271 against the delegator SA + the timestamp-caveat window. Used by
// /token's delegation grant to mint an id_token from a held, live delegation WITHOUT a fresh
// passkey ceremony — "holds a live, unrevoked, in-window delegation → login-grade session".
import { hashDelegation } from '@agenticprimitives/delegation';
import { AgentAccountClient } from '@agenticprimitives/agent-account';
import type { Address, Hex } from '@agenticprimitives/types';
import { CHAIN_ID, CONTRACTS, DEFAULT_RPC_URL } from '../../src/lib/chain';

export interface IncomingDelegation {
  delegator: Address;
  delegate: Address;
  authority: Hex;
  caveats: { enforcer: Address; terms: Hex; args?: Hex }[];
  salt: string;
  signature: Hex;
}

/** Verify a delegation was signed by `delegator` (ERC-1271) and is in its timestamp window. */
export async function verifyDelegation(
  env: { RPC_URL?: string },
  d: IncomingDelegation,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!d?.delegator || !d.signature || !Array.isArray(d.caveats)) return { ok: false, reason: 'malformed delegation' };

  // Timestamp window (TimestampEnforcer terms = abi.encode(uint128 validAfter, uint128 validUntil)).
  const now = Math.floor(Date.now() / 1000);
  for (const c of d.caveats) {
    if (c.enforcer.toLowerCase() === CONTRACTS.timestampEnforcer.toLowerCase()) {
      try {
        const b = c.terms.startsWith('0x') ? c.terms.slice(2) : c.terms;
        const validAfter = parseInt(b.slice(0, 64), 16);
        const validUntil = parseInt(b.slice(64, 128), 16);
        if (now < validAfter) return { ok: false, reason: 'delegation not yet valid' };
        if (now >= validUntil) return { ok: false, reason: 'delegation expired' };
      } catch {
        /* malformed terms — fall through to the signature check */
      }
    }
  }

  const digest = hashDelegation(
    {
      delegator: d.delegator,
      delegate: d.delegate,
      authority: d.authority,
      caveats: d.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: (c.args ?? '0x') as Hex })),
      salt: BigInt(d.salt),
      signature: d.signature,
    },
    CHAIN_ID,
    CONTRACTS.delegationManager as Address,
  );

  const accounts = new AgentAccountClient({
    rpcUrl: env.RPC_URL ?? DEFAULT_RPC_URL,
    chainId: CHAIN_ID,
    entryPoint: CONTRACTS.entryPoint,
    factory: CONTRACTS.agentAccountFactory,
  });
  // ERC-1271 needs the delegator SA deployed + RPC-visible. Just-enrolled users hit post-deploy
  // lag, so poll briefly (returns immediately once deployed — fast for the common returning case).
  for (let i = 0; i < 6; i++) {
    if (await accounts.isDeployed(d.delegator)) break;
    if (i === 5) return { ok: false, reason: 'delegator account not yet deployed' };
    await new Promise((r) => setTimeout(r, 2500));
  }
  try {
    const ok = await accounts.isValidSignature(d.delegator, digest, d.signature);
    return ok ? { ok: true } : { ok: false, reason: 'ERC-1271 verification failed against the delegator' };
  } catch (e) {
    return { ok: false, reason: `ERC-1271 call failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
