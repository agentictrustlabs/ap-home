// Org-wire verification (SEC-H1 / SEC-C1) — the TAIL that four call sites repeated.
//
// WHAT MOVED AND WHAT DID NOT, because the distinction is the whole point:
//
//   MOVED   delegator/delegate identity, caveat evaluation, revocation, signature.
//           Generic. `delegation.verifyLiveDelegation` decides all of it.
//
//   STAYED  which caveat SHAPE counts as member-access vs stewardship, and which contracts a
//           stewardship wire must pin. That is app authorization policy — `hasStewardshipShape` is a
//           POSITIVE identity test (allowedTargets present, allowedMethods ABSENT, record-scope
//           ABSENT, targets pin the governance registries), and no generic "required enforcers" list
//           can express "these must be absent" or "these terms must name those addresses".
//           Pushing it into the substrate would have flattened it into something weaker.
//
// The four blocks were NOT missing revocation — a correction to the audit that reported them as a
// partial verify. They each checked `isRevoked`. What they were is four chances to forget it.

import { verifyLiveDelegation, type Delegation, type EnforcerAddressMap } from '@agenticprimitives/delegation';
import type { Address, Hex } from '@agenticprimitives/types';

/** The wire shape an org delegation arrives as (bigint salt is a decimal string over JSON). */
export interface IncomingWire {
  delegator: string;
  delegate: string;
  authority: Hex;
  caveats: { enforcer: string; terms: Hex; args?: Hex }[];
  salt: string;
  signature: Hex;
}

export interface OrgWireChecks {
  /** EIP-712 delegation digest. */
  digest: (d: Delegation) => Hex;
  /** ERC-1271 / 6492 / ECDSA against the delegator. */
  erc1271: (signer: Address, digest: Hex, sig: Hex) => Promise<boolean>;
  /** `DelegationManager.isRevoked`. */
  isRevoked: (digest: Hex) => Promise<boolean>;
}

/**
 * Read every enforcer this Worker knows, so `evaluateCaveats` recognizes what real wires carry.
 *
 * An address missing here makes its caveat UNKNOWN, and unknown is a DENY — correct in principle and
 * a live outage in practice if a legitimate wire carries one. Every optional slot is populated when
 * configured for exactly that reason.
 */
export function enforcersFromEnv(env: Record<string, string | undefined>): EnforcerAddressMap {
  const addr = (v: string | undefined): Address | undefined =>
    /^0x[0-9a-fA-F]{40}$/.test(v ?? '') ? (v!.toLowerCase() as Address) : undefined;
  const req = (v: string | undefined): Address => addr(v) ?? ('0x' + '0'.repeat(40)) as Address;
  return {
    delegationManager: req(env.DELEGATION_MANAGER),
    timestamp: req(env.TIMESTAMP_ENFORCER),
    value: req(env.VALUE_ENFORCER),
    allowedTargets: req(env.ALLOWED_TARGETS_ENFORCER),
    allowedMethods: req(env.ALLOWED_METHODS_ENFORCER),
    ...(addr(env.QUORUM_ENFORCER) ? { recovery: addr(env.QUORUM_ENFORCER) } : {}),
    ...(addr(env.PAYMENT_ENFORCER) ? { payment: addr(env.PAYMENT_ENFORCER) } : {}),
  };
}

/** Wire → `Delegation`. Kept here so the four call sites stop each writing the same cast. */
export function toDelegation(wire: IncomingWire): Delegation {
  return {
    delegator: wire.delegator as Address,
    delegate: wire.delegate as Address,
    authority: wire.authority,
    caveats: wire.caveats.map((c) => ({ enforcer: c.enforcer as Address, terms: c.terms, args: (c.args ?? '0x') as Hex })),
    salt: BigInt(wire.salt),
    signature: wire.signature,
  } as Delegation;
}

/**
 * Verify an org wire is FROM `expectedDelegator` TO `expectedDelegate`, live and genuinely signed.
 *
 * Returns false on every failure path — the callers are boolean gates and must not learn why (the
 * reason would tell a prober which of several wires it is missing).
 *
 * SHAPE IS THE CALLER'S JOB. This says the wire is live and authentic; it says nothing about whether
 * it is a member-access grant or a stewardship grant. Call it AFTER the shape test, never instead.
 */
export async function verifyOrgWire(input: {
  wire: IncomingWire | undefined;
  expectedDelegator: string;
  expectedDelegate: Address;
  enforcers: EnforcerAddressMap;
  checks: OrgWireChecks;
  now?: number;
}): Promise<boolean> {
  const w = input.wire;
  if (!w?.signature || !w.delegator || !w.delegate) return false;

  let delegation: Delegation;
  try {
    delegation = toDelegation(w);
  } catch {
    return false; // BigInt(salt) on garbage
  }

  const r = await verifyLiveDelegation({
    delegation,
    expectedDelegator: input.expectedDelegator as Address,
    expectedDelegate: input.expectedDelegate,
    enforcers: input.enforcers,
    now: input.now ?? Math.floor(Date.now() / 1000),
    checks: {
      delegationDigest: input.checks.digest,
      isRevoked: async (d) => input.checks.isRevoked(input.checks.digest(d)),
      verifySignature: async ({ signer, digest, signature }) =>
        input.checks.erc1271(signer, digest, signature),
    },
  });
  return r.ok;
}
