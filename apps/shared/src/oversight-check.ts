// IS THIS WIRE THE ORGANIZATION'S OVERSIGHT DELEGATION — by what it IS (spec 445; audit RUNC-1).
//
// ONE definition of stewardship in this repository: `@agenticprimitives/context` `chainStewardshipCheck`, which
// reads the ontology's `OVERSIGHT_DELEGATION` (every caveat is allowedTargets · timestamp · value, each at most
// once; the targets name every governance contract and nothing outside the declared set; the window is current;
// the value is zero). Nothing here re-implements that test.
//
// Server-side only (it imports the context package). The pure target lists are in `./oversight-targets.ts`.
import { chainStewardshipCheck } from '@agenticprimitives/context';
import { oversightCheckInputs, type OversightContracts } from './oversight-targets';

type Addr = `0x${string}`;

/**
 * The SHAPE verdict alone: is `wire`, from `org` to `person`, an oversight delegation by its caveats?
 *
 * IT PROVES NO SIGNATURE AND NO LIVENESS. The package's check is asked with a chain that answers "signed, not
 * revoked", so what comes back is exactly its binding test (delegator = org, delegate = person) and its positive
 * caveat test. Two callers keep their own chain verification because they already have one with behaviour the
 * package's does not carry — the interactions object's memoised `verifyWire`, the Home server's bounded-retry
 * `verifyDelegation` — and MUST run it after this returns true. A caller with no such path uses
 * `chainStewardshipCheck` itself (the runtime's standing reads do).
 */
export function oversightShapeCheck(
  contracts: OversightContracts,
  /** The estate's delegation domain. The package hashes the wire before it asks the chain, and refuses a wire
   *  that does not hash — so a malformed wire is not stewardship here either. */
  domain: { chainId: number; delegationManager: string | undefined; now?: () => number },
): (input: { org: string; person: string; wire: unknown }) => Promise<boolean> {
  const check = chainStewardshipCheck({
    ...oversightCheckInputs(contracts),
    ...(domain.now ? { now: domain.now } : {}),
    chainId: domain.chainId,
    delegationManager: (domain.delegationManager ?? '') as Addr,
    // Never called on a chain: the stub below is the only reader.
    validator: '0x0000000000000000000000000000000000000001',
    validatorAbi: [],
    isRevokedAbi: [],
    readContract: (async (args: { functionName?: string }) => args.functionName === 'isValidSig') as never,
  });
  return ({ org, person, wire }) => check({ org: org as Addr, person: person as Addr, wire });
}
