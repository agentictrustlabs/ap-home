// What a rename can actually be, given the naming contracts.
//
// `PermissionlessSubregistry.claimedBy` is write-once with no release: an SA gets one label per root,
// permanently. `AgentNameRegistry.setPrimaryName` is freely changeable and `setPrimaryName(0)` clears it.
// So the moves available to an agent are:
//
//   present(node)  — switch which held name is public         (always, for a node it holds)
//   clear()        — present no name at all                   (always)
//   claim(tld)     — take a name under a root it has not used (only then)
//
// There is deliberately no `rename(label)`: a new label under a root the agent already used reverts
// on-chain, and `claimName` short-circuits it into a no-op that returns the OLD name. Keeping that rule
// here — rather than inside the card — is what lets it be tested against the contract's actual shape.
export interface HeldRoot {
  tld: string;
  node: `0x${string}`;
  name: string | null;
  /** false = the legacy untyped parent, which states no agent type (spec 346). */
  typed: boolean;
}

/** The suffix this agent may still claim: the one its TYPE entitles it to, if unused. `null` otherwise.
 *
 *  Only the type's own suffix is ever offered. A suffix names the derived agent type on chain, so
 *  handing a person `.org` because it happens to be free would mint a name its own type record
 *  contradicts — and the registry fails that closed. An empty answer is an answer. */
export function claimableSuffix<T extends { tld: string }>(
  typedForKind: T | undefined,
  held: readonly HeldRoot[],
): T | null {
  if (!typedForKind) return null;
  return held.some((h) => h.tld === typedForKind.tld) ? null : typedForKind;
}

/** Is this held node the one the agent currently presents? Case-insensitive: node hex casing varies by
 *  source (a contract read vs. a locally computed namehash), and comparing raw strings silently showed
 *  "Present this one" next to the name already being presented. */
export function isPresented(node: `0x${string}`, primary: `0x${string}` | null): boolean {
  return !!primary && primary.toLowerCase() === node.toLowerCase();
}

/** Whether clearing the public name would take away a name the agent could not get back by presenting
 *  something else — i.e. it holds exactly this one. Used to word the confirmation honestly. */
export function clearingLeavesNoName(held: readonly HeldRoot[]): boolean {
  return held.length <= 1;
}
