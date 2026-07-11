// SEC-H2 — server-side stewardship verification. `controlsOrg` (invite / remove) used to trust the
// `relationship` field of the `related:<person>:<org>` KV link, which the person can WRITE via
// /connect/related-orgs — so anyone could fabricate a steward link and invite/remove members of an
// org they don't steward. This verifies the org→person stewardship delegation ON-CHAIN instead: the
// person cannot forge the ORG's ERC-1271 signature, so the wire's SOURCE (the untrusted KV link) no
// longer matters. Mirrors the DO's isSteward (SEC-C1): delegator/delegate bind + stewardship caveat
// shape (governance allowedTargets, never a vault-record-scope data grant) + ERC-1271 + unrevoked.
import { createPublicClient, http, type Hex } from 'viem';
import { VAULT_RECORD_SCOPE_ENFORCER } from '@agenticprimitives/delegation';
import type { Address } from '@agenticprimitives/types';
import { CONTRACTS, DEFAULT_RPC_URL } from '../../src/lib/chain';
import { verifyDelegation, type IncomingDelegation } from './verify-delegation';

const IS_REVOKED_ABI = [
  { type: 'function', name: 'isRevoked', stateMutability: 'view', inputs: [{ name: 'delegationHash', type: 'bytes32' }], outputs: [{ name: 'revoked', type: 'bool' }] },
] as const;

/** True iff `wire` is a genuine, live org→person STEWARDSHIP delegation. Fail-closed everywhere. */
export async function verifyStewardship(
  env: { RPC_URL?: string },
  org: string,
  person: string,
  wire: IncomingDelegation | null | undefined,
): Promise<boolean> {
  if (!wire?.signature || !Array.isArray(wire.caveats)) return false;
  if (wire.delegator?.toLowerCase() !== org.toLowerCase()) return false;
  if (wire.delegate?.toLowerCase() !== person.toLowerCase()) return false;
  // Stewardship caveat shape (SEC-C1 parity): a governance allowedTargets caveat AND no
  // vault-record-scope caveat — so a member-access / data grant can't be replayed as stewardship.
  const enf = (c: { enforcer?: string }): string => (c.enforcer ?? '').toLowerCase();
  const hasGovernance = wire.caveats.some((c) => enf(c) === CONTRACTS.allowedTargetsEnforcer.toLowerCase());
  const hasRecordScope = wire.caveats.some((c) => enf(c) === VAULT_RECORD_SCOPE_ENFORCER.toLowerCase());
  if (!hasGovernance || hasRecordScope) return false;
  // ERC-1271 (org signed) + timestamp window.
  const v = await verifyDelegation(env, wire);
  if (!v.ok) return false;
  // Unrevoked on-chain.
  try {
    const client = createPublicClient({ transport: http(env.RPC_URL ?? DEFAULT_RPC_URL) });
    const revoked = (await client.readContract({
      address: CONTRACTS.delegationManager as Address,
      abi: IS_REVOKED_ABI,
      functionName: 'isRevoked',
      args: [v.digest as Hex],
    })) as boolean;
    return !revoked;
  } catch {
    return false; // fail-closed on chain-read failure
  }
}
