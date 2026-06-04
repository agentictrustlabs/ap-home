// Relying-site delegation issuance (ADR-0019). The central auth (this origin), with the
// person's ROOT passkey, issues a caveated, redeemer-bound ERC-7710 delegation from the
// person SA to the relying site's DELEGATE smart account. The site is a delegate, never a
// custodian of the person SA. Signed off-chain (EIP-712 `hashDelegation`) by the ROOT
// passkey via the same WebAuthn path that signs UserOps; the SA's ERC-1271 validates it at
// redemption. No new contracts — DelegationManager + enforcers are deployed.
import {
  type Delegation,
  type Caveat,
  buildCaveat,
  encodeTimestampTerms,
  encodeAllowedTargetsTerms,
  encodeValueTerms,
  hashDelegation,
  ROOT_AUTHORITY,
} from '@agenticprimitives/delegation';
import type { Address, Hex } from '@agenticprimitives/types';
import { CHAIN_ID, CONTRACTS } from './chain';

type SignHash = (hash: Hex) => Promise<Hex>;

/** Wire form of a Delegation (bigint salt → string) for transport over postMessage / URL. */
export interface DelegationWire {
  delegator: Address;
  delegate: Address;
  authority: Hex;
  caveats: Caveat[];
  salt: string;
  signature: Hex;
}
export const toWire = (d: Delegation): DelegationWire => ({ ...d, salt: d.salt.toString() });

/** Least-privilege caveats for a relying site: time-boxed, value 0, scoped to the on-chain
 *  targets a relying site needs to act on the person's behalf (naming + relationship). */
function siteCaveats(validUntil: number): Caveat[] {
  return [
    buildCaveat(CONTRACTS.timestampEnforcer, encodeTimestampTerms(0, validUntil)),
    buildCaveat(CONTRACTS.valueEnforcer, encodeValueTerms(0n)),
    buildCaveat(
      CONTRACTS.allowedTargetsEnforcer,
      encodeAllowedTargetsTerms([
        CONTRACTS.agentRelationship,
        CONTRACTS.agentNameRegistry,
        CONTRACTS.permissionlessSubregistry,
      ]),
    ),
  ];
}

/** spec 253 — the approved-hash sentinel signature. A delegation carrying this 1-byte wire
 *  signature is NOT signed off-chain; instead its delegator SA pre-approved the EIP-712 digest
 *  in the ApprovedHashRegistry (inside the delegator's own userOp), and the SA's ERC-1271
 *  `isValidSignature` honors it via the `0x03` branch. Lets an org batch all of its outbound
 *  grants' approvals into one deploy userOp — one passkey instead of one-per-grant. */
export const APPROVED_HASH_SENTINEL: Hex = '0x03';

/** Build the unsigned delegation struct (shared by the signed + approved-hash variants). */
function buildSiteDelegation(delegator: Address, delegateSA: Address, validitySeconds: number): Delegation {
  const validUntil = Math.floor(Date.now() / 1000) + validitySeconds;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let salt = 0n;
  for (const b of bytes) salt = (salt << 8n) | BigInt(b);
  return {
    delegator,
    delegate: delegateSA,
    authority: ROOT_AUTHORITY,
    caveats: siteCaveats(validUntil),
    salt,
    signature: '0x',
  };
}

/** Issue `personAgent → delegateSA` with the default site caveats, signed by the ROOT
 *  credential (`signHash`). `delegate` is the relying site's delegate SA so redemption is
 *  bound to that account (DelegationManager requires `delegate == msg.sender`). */
export async function issueSiteDelegation(
  personAgent: Address,
  delegateSA: Address,
  signHash: SignHash,
  validitySeconds = 60 * 60 * 24 * 365,
): Promise<Delegation> {
  const d = buildSiteDelegation(personAgent, delegateSA, validitySeconds);
  const digest = hashDelegation(d, CHAIN_ID, CONTRACTS.delegationManager);
  d.signature = await signHash(digest); // ROOT passkey signs the EIP-712 delegation digest
  return d;
}

/** spec 253 — build a `delegator → delegateSA` site delegation WITHOUT an off-chain signature.
 *  Returns the delegation (wire signature = the `0x03` sentinel) plus its EIP-712 `digest`, so
 *  the caller batches `approvedHashRegistry.approveHash(digest)` into the DELEGATOR's own userOp.
 *  The digest excludes the signature field, so it is identical to what the relayer + on-chain
 *  redeem recompute. The delegator MUST be the account whose userOp runs the `approveHash`
 *  (i.e. the org being deployed) — only the org can approve hashes under its own address. */
export function buildApprovedSiteDelegation(
  delegator: Address,
  delegateSA: Address,
  validitySeconds = 60 * 60 * 24 * 365,
): { delegation: Delegation; digest: Hex } {
  const d = buildSiteDelegation(delegator, delegateSA, validitySeconds);
  const digest = hashDelegation(d, CHAIN_ID, CONTRACTS.delegationManager);
  d.signature = APPROVED_HASH_SENTINEL; // validated via the SA's approved-hash ERC-1271 branch
  return { delegation: d, digest };
}
