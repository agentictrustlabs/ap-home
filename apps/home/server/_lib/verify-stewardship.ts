// SEC-H2 — server-side stewardship verification. `controlsOrg` (invite / remove) used to trust the
// `relationship` field of the `related:<person>:<org>` KV link, which the person can WRITE via
// /connect/related-orgs — so anyone could fabricate a steward link and invite/remove members of an
// org they don't steward. This verifies the org→person stewardship delegation ON-CHAIN instead: the
// person cannot forge the ORG's ERC-1271 signature, so the wire's SOURCE (the untrusted KV link) no
// longer matters. Mirrors the DO's isSteward: delegator/delegate bind + the POSITIVE oversight-delegation
// shape (one definition, in `@agenticprimitives/context`) + ERC-1271 + unrevoked.
import { createPublicClient, http, type Hex } from 'viem';
import { oversightShapeCheck } from '@ap-home/shared/oversight-check';
import type { Address } from '@agenticprimitives/types';
import { CHAIN_ID, CONTRACTS, DEFAULT_RPC_URL, OVERSIGHT_CONTRACTS } from '../../src/lib/chain';
import { verifyDelegation, type IncomingDelegation } from './verify-delegation';

const IS_REVOKED_ABI = [
  { type: 'function', name: 'isRevoked', stateMutability: 'view', inputs: [{ name: 'delegationHash', type: 'bytes32' }], outputs: [{ name: 'revoked', type: 'bool' }] },
] as const;

/** Shape only — signature and revocation are checked below, by this file's own chain reads. */
const isOversightShape = oversightShapeCheck(OVERSIGHT_CONTRACTS, { chainId: CHAIN_ID, delegationManager: CONTRACTS.delegationManager });

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
  // POSITIVE identity (spec 445, audit RUNC-1 / STEWARD-SHAPE-CONFUSION-1). This used to ask what the wire was
  // NOT ("an allowedTargets caveat and no record scope") — which an organization's payment mandate and its A2A
  // message grant also are not, so either read as stewardship here. The one definition is the package's
  // (`chainStewardshipCheck` over the ontology's OVERSIGHT_DELEGATION): every caveat is allowedTargets ·
  // timestamp · value, the targets are the governance contracts `siteCaveats` mints and nothing else.
  if (!(await isOversightShape({ org, person, wire }))) return false;
  // ERC-1271 (org signed) + timestamp window.
  const v = await verifyDelegation(env, wire);
  if (!v.ok) return false;
  // Unrevoked on-chain.
  try {
    const client = createPublicClient({ transport: http((env.RPC_URL || DEFAULT_RPC_URL)) });
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
