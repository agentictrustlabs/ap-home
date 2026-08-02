// Server-side delegation verification (spec 230 silent re-auth / ADR-0019 runtime auth).
//
// THE DECISION LIVES IN `delegation.verifyLiveDelegation`. This file supplies only the app's chain
// reads — the retry policy for a just-deployed SA, and the approved-hash retry — which are genuinely
// app concerns and genuinely not the substrate's.
//
// IT USED TO DECIDE HERE, AND LOST THREE THINGS DOING SO (audit 2026-08-02):
//   1. NO revocation check. A revoked delegation minted a login-grade session.
//   2. NO caveat evaluation beyond timestamp. Every other caveat was ignored rather than fail-closed.
//   3. A `catch` around the timestamp decode that FELL THROUGH to the signature check — so malformed
//      terms meant no window was enforced at all.
// Its comment also described the terms as `abi.encode(uint128, uint128)` while the encoder emits
// `uint256` — the hazard of hand-decoding bytes one package away from the code that writes them.
import {
  hashDelegation,
  verifyLiveDelegation,
  type Delegation,
  type EnforcerAddressMap,
} from '@agenticprimitives/delegation';
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

  const delegation: Delegation = {
    delegator: d.delegator,
    delegate: d.delegate,
    authority: d.authority,
    caveats: d.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: (c.args ?? '0x') as Hex })),
    salt: BigInt(d.salt),
    signature: d.signature,
  };
  const digest = hashDelegation(delegation, CHAIN_ID, CONTRACTS.delegationManager as Address);

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
  // ── The decision: window + caveats + revocation, all in one place ────────
  // Signature verification is deferred to the retry-wrapped ERC-1271 call below (the app's concern),
  // so the port here reports "verified" and lets that code make the actual call. Everything the
  // hand-rolled version dropped — revocation, malformed-term denial, unknown-enforcer denial — is
  // decided by the substrate.
  const enforcers: EnforcerAddressMap = {
    delegationManager: CONTRACTS.delegationManager as Address,
    timestamp: CONTRACTS.timestampEnforcer as Address,
    value: CONTRACTS.valueEnforcer as Address,
    allowedTargets: CONTRACTS.allowedTargetsEnforcer as Address,
    allowedMethods: CONTRACTS.allowedMethodsEnforcer as Address,
  };

  const live = await verifyLiveDelegation({
    delegation,
    enforcers,
    now: Math.floor(Date.now() / 1000),
    checks: {
      delegationDigest: () => digest,
      isRevoked: async () => isRevokedOnChain(env, digest),
      // The ERC-1271 call needs the app's deploy/approved-hash retry budget, so it happens below
      // rather than here. Reporting `true` is not a bypass — the call still gates the return.
      verifySignature: async () => true,
    },
  });
  if (!live.ok) return { ok: false, reason: live.reason };

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
  // B4 (approved-hash grants): an `0x03` delegation validates via the SA's ERC-1271 `0x03` branch →
  // `ApprovedHashRegistry.isApproved`, which depends on the `approveHash` userOp (batched by givePermission
  // moments earlier) being RPC-visible. Like the `isDeployed` check above, ride out brief read-replica lag
  // with a BOUNDED retry of the SAME `isValidSignature` call (ADR-0013 — same call, not a weaker mechanism).
  // A normal signed (ECDSA/1271) delegation is self-contained, so it needs no retry (attempts = 1).
  const approvedHash = d.signature.toLowerCase() === '0x03';
  const attempts = approvedHash ? 5 : 1;
  let lastErr = '';
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      if (await accounts.isValidSignature(d.delegator, digest, d.signature)) return { ok: true, digest };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, 600));
  }
  return { ok: false, reason: lastErr ? `ERC-1271 call failed: ${lastErr}` : 'ERC-1271 verification failed against the delegator' };
}


/** `DelegationManager.isRevoked(digest)`. Fail-CLOSED: an unreadable chain has not said "live". */
async function isRevokedOnChain(env: { RPC_URL?: string }, digest: Hex): Promise<boolean> {
  const { createPublicClient, http } = await import('viem');
  try {
    const client = createPublicClient({ transport: http(env.RPC_URL ?? DEFAULT_RPC_URL) });
    return (await client.readContract({
      address: CONTRACTS.delegationManager as Address,
      abi: [
        {
          type: 'function',
          name: 'isRevoked',
          stateMutability: 'view',
          inputs: [{ name: 'delegationHash', type: 'bytes32' }],
          outputs: [{ name: '', type: 'bool' }],
        },
      ] as const,
      functionName: 'isRevoked',
      args: [digest],
    })) as boolean;
  } catch {
    return true;
  }
}
