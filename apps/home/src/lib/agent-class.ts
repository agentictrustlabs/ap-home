// ADR-0046 — every Smart Agent is a Person, an Organization, or a Service (PROV-O's trichotomy).
// App-level kinds map DOWN to a class, never up into the enum: treasury is a SERVICE ROLE.
// New service-shaped kinds default to 'service' — the class set is closed, the role set is open.
import type { AgentType } from '@agenticprimitives/types';
import type { AgentKind, ManagedAgent } from '../connect-client';

/** Classify an app-level managed-agent kind into the closed Person/Org/Service set. */
export function agentClassOf(kind: AgentKind): AgentType {
  return kind === 'org' ? 'org' : 'service';
}

/** The service ROLE an app-level kind carries (open set; label-only, never branched as a class). */
export function serviceRoleOf(kind: AgentKind): string {
  return kind === 'person-treasury' || kind === 'org-treasury' ? 'treasury' : kind;
}

/**
 * The authority lineage of a managed agent, walked through `parent` links back to the person —
 * the custody chain the agents were spawned under (person → [org →] service). Rendered under
 * the agent's name in the workspace switcher so a person's treasury and an org's treasury read
 * differently: "you → treasury" vs "you → acme → treasury".
 */
export function authorityLineage(agent: ManagedAgent, all: ManagedAgent[], youLabel: string, personSa?: string): string[] {
  const lc = (s: string) => s.toLowerCase();
  const you = personSa ? lc(personSa) : '';
  const chain: string[] = [];
  let parent = agent.parent;
  for (let hop = 0; hop < 4; hop += 1) {
    if (!parent || (you && lc(parent) === you)) break; // person SA — even if also listed as an org
    const p = all.find((a) => lc(a.agent) === lc(parent));
    if (!p) break;
    chain.unshift(p.name || 'unnamed');
    parent = p.parent;
  }
  return [youLabel, ...chain];
}
