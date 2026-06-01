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

/** Verify a delegation was signed by `delegator` (ERC-1271) and is in its timestamp window.
 *
 *  Returns the canonical EIP-712 digest on success — same bytes the on-chain
 *  DelegationManager computes. Callers use the digest as a lookup key for binding
 *  the delegation to its originally-authorized client (silent-reauth gate; SEC-002).
 *
 *  SEC-011 (revised 2026-06-01): `isDeployed` is BOUNDED-retried, not polled. A
 *  just-enrolled SA briefly lags multi-node RPC views (the bundler-included node
 *  surfaces the deploy receipt + AccountDeployed event before read replicas catch
 *  up), so up to 4 retries × 500ms is the "bounded retry of the same call" allowed
 *  by ADR-0013. This is well below the 12–15s polling SEC-011's original wording
 *  was concerned about and avoids surfacing a `retry shortly` UX error for what is
 *  actually a replica-lag race during /oidc/grant (mid-onboarding, no relying-app
 *  retry loop present). At /token time the SA SHOULD already be visible, so the
 *  same bounded budget there is cheap (almost always satisfied on the first call).
 *  Fail-closed if not visible after the retry budget. */
export async function verifyDelegation(
  env: { RPC_URL?: string },
  d: IncomingDelegation,
): Promise<{ ok: true; digest: Hex } | { ok: false; reason: string }> {
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
  // ERC-1271 needs the delegator SA deployed + RPC-visible. SEC-011 (revised):
  // bounded retry of the SAME `isDeployed` call to ride out brief multi-node read-
  // replica lag (the bundler returns the receipt from the included node before
  // every replica has the block). Budget: 4 attempts × 500ms = max 2s, well below
  // the 12-15s polling the original wording rejected.
  let deployed = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await accounts.isDeployed(d.delegator)) {
      deployed = true;
      break;
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 500));
  }
  if (!deployed) {
    return { ok: false, reason: 'delegator account not yet deployed (retry shortly)' };
  }
  try {
    const ok = await accounts.isValidSignature(d.delegator, digest, d.signature);
    return ok ? { ok: true, digest } : { ok: false, reason: 'ERC-1271 verification failed against the delegator' };
  } catch (e) {
    return { ok: false, reason: `ERC-1271 call failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
