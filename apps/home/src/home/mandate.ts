// Mandate issuance from the Home approval surface (spec 310 W5 / 309 §6.2).
//
// Doctrine-honest mapping: the AUTHORITY is a scoped `delegation` token the
// person signs (person SA → requesting agent, time-boxed, value 0); the
// `InteractionMandateV1` is the signed statement of intent that REFERENCES it
// by hash. Two artifacts, two signatures, same ROOT credential. Scope terms
// come from the ap-scope vocabulary (spec 308) so external verifiers can read
// them mechanically.
import {
  buildCaveat,
  encodeTimestampTerms,
  encodeValueTerms,
} from '@agenticprimitives/delegation';
import type { InteractionCaseV1, InteractionMandateV1 } from '@agenticprimitives/fabric/interactions';
import { canonicalizeMessage, sha256Hex32 } from '@agenticprimitives/fabric/messaging';
import type { Address, Hex } from '@agenticprimitives/types';
import { CONTRACTS } from '../lib/chain';
import { issueScopedDelegation, toWire, type DelegationWire } from '../lib/delegation';
import { delegationRefHash } from './control-plane';
import { homeCaip10 } from './manifest';

type SignHash = (hash: Hex) => Promise<Hex>;

export type MandateUnsigned = Omit<InteractionMandateV1, 'signature'>;

/** Canonical digest the principal signs — recomputed server-side, never trusted
 *  from the wire (same rule as the Home manifest digest). */
export async function mandateDigest(draft: MandateUnsigned): Promise<Hex> {
  return sha256Hex32(canonicalizeMessage(draft));
}

export interface IssuedMandate {
  mandate: InteractionMandateV1;
  delegation: DelegationWire;
}

/**
 * Issue authority + intent for an approved access-request case:
 *  1. sign a scoped delegation person SA → requester (timestamp + value-0
 *     caveats — least privilege, revocable on-chain like every other grant);
 *  2. sign the mandate that references it by hash.
 */
export async function issueMandateForCase(
  c: InteractionCaseV1,
  person: Address,
  signHash: SignHash,
  opts?: { validitySeconds?: number; resource?: string; purpose?: string },
): Promise<IssuedMandate> {
  const requester = c.requester.match(/0x[0-9a-fA-F]{40}$/)?.[0] as Address | undefined;
  if (!requester) throw new Error('case requester is not an EVM agent');

  const validitySeconds = opts?.validitySeconds ?? 60 * 60 * 24 * 30;
  const validUntil = Math.floor(Date.now() / 1000) + validitySeconds;
  const caveats = [
    buildCaveat(CONTRACTS.timestampEnforcer, encodeTimestampTerms(0, validUntil)),
    buildCaveat(CONTRACTS.valueEnforcer, encodeValueTerms(0n)),
  ];
  const delegation = toWire(await issueScopedDelegation(person, requester, caveats, signHash));

  const draft: MandateUnsigned = {
    version: 'ap.interaction.mandate.v1',
    mandateId: `mand_${globalThis.crypto.randomUUID()}`,
    principal: homeCaip10(person),
    actingAgent: c.requester,
    allowedActions: ['apscope:read'],
    resourceScope: {
      resource: opts?.resource ?? 'apscope:pii',
      purpose: opts?.purpose ?? 'apscope:fulfillment',
    },
    constraints: { expiresAt: new Date(validUntil * 1000).toISOString(), onwardSharingAllowed: false },
    delegationHash: delegationRefHash(delegation) as InteractionMandateV1['delegationHash'],
  };
  const signature = await signHash(await mandateDigest(draft));
  return {
    mandate: { ...draft, signature: { signer: draft.principal, scheme: 'erc1271', signature } },
    delegation,
  };
}
