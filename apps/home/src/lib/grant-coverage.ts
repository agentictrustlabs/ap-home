// WHAT THE INTERACTIONS GRANT IS MISSING — the additive scopes (spec 442 §4.1, 444 W3, 363 W4, 338 §7 …).
//
// An additive scope is deliberately NOT in the runtime's REQUIRED_SCOPES: putting it there would stale every grant in
// the estate and 409 the whole interactions plane for want of one record. The cost of that choice is that `/status`
// says `current: true` for a grant that is refused `record_scope_denied` on the new record, and nothing re-issues it
// (2026-10-16: a person's first ask to scripture-resolver.svc failed because her grant predated
// `vault:identity.pairwise-secret`). The Home knows the list it would sign NOW; the DO reports what the stored grant
// names (`recordScopes`). The difference is what a re-issue would add — reported, and acted on by the enable path.
import { interactionsGrantScopes } from '@agenticprimitives/fabric/interactions';
import { INTERACTIONS_APP_SCOPES } from '@ap-home/shared';

/** Every resource an interactions grant signed by this Home today names. */
export function interactionsGrantResources(mcpServerId: string): string[] {
  return [...new Set(interactionsGrantScopes(mcpServerId, INTERACTIONS_APP_SCOPES).flatMap((g) => g.resources))].sort();
}

/** The resources a grant issued now would carry that the stored grant does not. `null` when the DO did not say what
 *  its grant covers (a runtime predating `recordScopes`, or no grant) — unknown is not "missing". */
export function missingGrantScopes(issued: readonly string[], held: readonly string[] | undefined | null): string[] | null {
  if (!Array.isArray(held) || held.length === 0) return null;
  const have = new Set(held);
  return issued.filter((r) => !have.has(r));
}
