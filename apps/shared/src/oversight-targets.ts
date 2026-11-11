// THE OVERSIGHT (STEWARDSHIP) WIRE'S TARGETS — one list for the code that MINTS the wire and the code that
// RECOGNISES it (spec 445; audit RUNC-1, ledger STEWARD-SHAPE-CONFUSION-1).
//
// An organization's oversight delegation to its steward is the "site wire": [timestamp, value 0, allowedTargets].
// Two apps mint it (the Home's `siteCaveats`, the runtime's `siteGrantCaveats`) and three places recognise it
// (the runtime's standing reads, the interactions object's `isSteward`, the Home server's `verifyStewardship`).
// Recognition is POSITIVE (`@agenticprimitives/context` `chainStewardshipCheck`): the wire must name every
// governance contract and nothing outside the declared set. So the minter and the recogniser must agree on that
// set by construction — a target added to the mint and not here makes every newly minted steward a non-steward.
//
// This module is PURE (strings in, strings out) so the browser bundle that mints can import it. The recogniser
// itself lives in `./oversight-check.ts`, which pulls in the context package and is server-side only.

/** The contract addresses the oversight wire is built from, as each app's configuration names them. */
export interface OversightContracts {
  allowedTargetsEnforcer?: string | undefined;
  timestampEnforcer?: string | undefined;
  valueEnforcer?: string | undefined;
  /** Governance: the relationship registry. REQUIRED on every oversight wire. */
  agentRelationship?: string | undefined;
  /** Governance: the name registry. REQUIRED on every oversight wire. */
  agentNameRegistry?: string | undefined;
  /** The untyped legacy subregistry. The mint has always named it third; a wire MAY name it, need not. */
  permissionlessSubregistry?: string | undefined;
  /** Addresses that wires minted in the PAST may still name (a subregistry since retired). Never minted. */
  retiredTargets?: readonly (string | undefined)[] | undefined;
}

/** The governance contracts EVERY oversight wire must name. */
export function oversightGovernanceTargets(c: OversightContracts): [string | undefined, string | undefined] {
  return [c.agentRelationship, c.agentNameRegistry];
}

/** Contracts an oversight wire may ALSO name. A target in neither list ⇒ the wire is not stewardship. */
export function oversightAlsoPermittedTargets(c: OversightContracts): (string | undefined)[] {
  return [c.permissionlessSubregistry, ...(c.retiredTargets ?? [])].filter((t) => !!t);
}

/** What the MINT writes into allowedTargets, in the order it has always written it (a resume rebuilds the wire
 *  byte for byte, so the order is part of the wire): relationship, name registry, then the subregistry when this
 *  deployment still configures one. By construction a subset of governance ∪ alsoPermitted. */
export function oversightMintTargets(c: OversightContracts): string[] {
  return [c.agentRelationship, c.agentNameRegistry, c.permissionlessSubregistry].filter((t): t is string => !!t);
}

/** The inputs `chainStewardshipCheck` needs to recognise the wire, derived from the same contracts. */
export function oversightCheckInputs(c: OversightContracts): {
  allowedTargetsEnforcer: string | undefined;
  timestampEnforcer: string | undefined;
  valueEnforcer: string | undefined;
  governanceTargets: (string | undefined)[];
  alsoPermittedTargets: (string | undefined)[];
} {
  return {
    allowedTargetsEnforcer: c.allowedTargetsEnforcer,
    timestampEnforcer: c.timestampEnforcer,
    valueEnforcer: c.valueEnforcer,
    governanceTargets: oversightGovernanceTargets(c),
    alsoPermittedTargets: oversightAlsoPermittedTargets(c),
  };
}

/** The runtime's Worker bindings → `OversightContracts`. (The Home reads its `CONTRACTS` map instead.) */
export function oversightContractsFromEnv(env: {
  ALLOWED_TARGETS_ENFORCER?: string; TIMESTAMP_ENFORCER?: string; VALUE_ENFORCER?: string;
  AGENT_RELATIONSHIP?: string; AGENT_NAME_REGISTRY?: string; PERMISSIONLESS_SUBREGISTRY?: string;
}): OversightContracts {
  return {
    allowedTargetsEnforcer: env.ALLOWED_TARGETS_ENFORCER,
    timestampEnforcer: env.TIMESTAMP_ENFORCER,
    valueEnforcer: env.VALUE_ENFORCER,
    agentRelationship: env.AGENT_RELATIONSHIP,
    agentNameRegistry: env.AGENT_NAME_REGISTRY,
    permissionlessSubregistry: env.PERMISSIONLESS_SUBREGISTRY,
  };
}
