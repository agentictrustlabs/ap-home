// THE AGENT'S PLAYBOOK, AT RUN ADMISSION — spec 354 §4.3 / K3 behavioral half.
//
// An agent assigned an archetype holds an `archetype.assignment` record in its own vault: the compiled
// AgentHarnessDefinitionV1, pinned by digest. This loads it, VERIFIES the digest (an assignment is only
// as trustworthy as the definition it names actually being the one that was approved), and hands back
// what the Ask needs — which capabilities this agent's playbook offers.
//
// Behavior honesty, authority unchanged (spec 354 §1): narrowing the OFFERED tools to the playbook's
// capabilities changes what the agent will PLAN, never what a mandate permits. A treasury with the
// Bookkeeper playbook stops OFFERING payments; the payment gate would have refused one anyway. Removing
// the offer touches no authority — that is the whole point, and the reason this lives in tool selection,
// never near the verifier.
//
// NO ASSIGNMENT ⇒ NO NARROWING (spec 354 §4.3): the bare harness stands, its buttons still work, and the
// Ask offers everything the surface allows. A playbook refines; its absence is not a restriction.
import { validateAgentHarnessDefinition, definitionDigest, type AgentHarnessDefinitionV1 } from '@agenticprimitives/capability-claims';

export interface PlaybookScope {
  archetypeId: string;
  archetypeVersion: string;
  digest: string;
  /** The capability ids this playbook's tools declare — the set the Ask narrows its offers to. */
  capabilityIds: Set<string>;
  /** The behavioral prose, for the planner's system prompt. */
  instructions: string;
}

/** The assignment record as written to the agent's vault. The definition is EMBEDDED and its digest
 *  re-derived and checked here — tamper-evident without a cross-Worker fetch (the K3-full version
 *  resolves the definition from the corpus BY digest; the embed is the honest interim, and the digest
 *  check is identical either way). */
interface AssignmentRecord {
  type: 'ap.archetype-assignment.v1';
  archetypeId: string;
  archetypeVersion: string;
  definitionDigest: string;
  definition: AgentHarnessDefinitionV1;
}

/**
 * Load the acting agent's playbook, or null when it has none / the record does not verify.
 *
 * A record that fails to verify is treated as ABSENT, not as an error that strands the ask: a corrupt or
 * tampered assignment must not be able to silently WIDEN behavior, and it must not be able to break an
 * agent that could otherwise answer. So an unverifiable playbook falls back to the bare harness, and
 * says why in the log — the safe direction on both counts.
 */
export async function loadPlaybook(
  readSubjectRecord: ((subject: string, recordType: string) => Promise<unknown>) | undefined,
  agent: string,
): Promise<PlaybookScope | null> {
  if (!readSubjectRecord) return null;
  const raw = await readSubjectRecord(agent, 'archetype.assignment').catch(() => null);
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Partial<AssignmentRecord>;
  if (rec.type !== 'ap.archetype-assignment.v1' || !rec.definition || !rec.definitionDigest) return null;

  // The definition IS the identity: the embedded body must hash to the pinned digest, and the pinned
  // digest is what an approval ceremony signed off on.
  const derived = definitionDigest(rec.definition);
  if (derived !== rec.definitionDigest) {
    console.log(`[playbook] ${agent}: assignment digest mismatch (pinned ${rec.definitionDigest.slice(0, 12)}…, definition hashes to ${derived.slice(0, 12)}…) — ignoring, bare harness stands`);
    return null;
  }
  const check = validateAgentHarnessDefinition(rec.definition);
  if (!check.ok) {
    console.log(`[playbook] ${agent}: definition invalid (${check.errors[0]}) — ignoring`);
    return null;
  }
  return {
    archetypeId: rec.definition.archetypeId,
    archetypeVersion: rec.definition.archetypeVersion,
    digest: derived,
    capabilityIds: new Set(rec.definition.tools.map((t) => t.capability?.id ?? t.id)),
    instructions: rec.definition.instructions,
  };
}
