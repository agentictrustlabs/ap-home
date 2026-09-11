// Org-wire verification — what STAYED here after spec 399 W0 promoted the tail (SEC-H1 / SEC-C1).
//
//   MOVED   delegator/delegate identity, caveat evaluation, revocation, signature — `verifyDelegationWire`
//           in `@agenticprimitives/a2a` (over `delegation.verifyLiveDelegation`). Generic; every A2A service
//           repeats it.
//   STAYED  which caveat SHAPE counts as member-access vs stewardship, and which contracts a stewardship
//           wire must pin (`hasStewardshipShape` in interactions-do — a POSITIVE identity test no generic
//           "required enforcers" list can express), and THIS deployment's enforcer addresses, below.
import type { EnforcerAddressMap } from '@agenticprimitives/delegation';
import type { Address } from '@agenticprimitives/types';

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
