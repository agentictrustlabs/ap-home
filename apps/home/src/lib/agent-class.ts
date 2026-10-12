// ADR-0046 — every Smart Agent is a Person, an Organization, or a Service (PROV-O's trichotomy).
// App-level kinds map DOWN to a class, never up into the enum: treasury is a SERVICE ROLE.
// New service-shaped kinds default to 'service' — the class set is closed, the role set is open.
import type { AgentType } from '@agenticprimitives/types';
import type { AgentKind, ManagedAgent } from '../connect-client';

/** Classify an app-level managed-agent kind into the closed Person/Org/Service set. */
export function agentClassOf(kind: AgentKind): AgentType {
  // ANOTHER PERSON OF YOURS IS A PERSON. It is the one kind whose class is not org and not service, and it
  // is the reason this function could not simply be "org, else service" any more.
  if (kind === 'person') return 'person';
  // A team IS an organization (at:Team ⊑ at:Organization) — org-class with a distinct kind word.
  return kind === 'org' || kind === 'team' || kind === 'circle' || kind === 'church' || kind === 'household' ? 'org' : 'service';
}

/** The KIND WORD a row shows for an org-class agent — the subclass, not the class. */
export function orgKindWordOf(kind: AgentKind): string {
  return kind === 'team' || kind === 'circle' || kind === 'church' || kind === 'household' ? kind : 'organization';
}

/**
 * THE ONE WORD A ROW SHOWS for any kind — the subclass where that says more than the class does, and
 * "person" for another person of yours. Exported because two surfaces had grown the same expression
 * independently and a person would have rendered as an empty string in both: `serviceRoleOf` returns no
 * role for a person, correctly, and neither caller had a branch for that.
 */
export function kindWordOf(kind: AgentKind): string {
  if (kind === 'person') return 'person';
  return agentClassOf(kind) === 'org' ? orgKindWordOf(kind) : serviceRoleOf(kind);
}

/** The service ROLE an app-level kind carries (open set; label-only, never branched as a class). */
export function serviceRoleOf(kind: AgentKind): string {
  // A PERSON CARRIES NO SERVICE ROLE. The role set labels service-class agents; handing a person one would
  // declare `atl:serviceRole` on a person SA and fail the typed claim closed (spec 346 §3.6).
  if (kind === 'person') return '';
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
  // A GOVERNED WORKSPACE is parented by the person, so the parent walk stops at "you" and loses the org it
  // belongs to (spec 344/424). Surface the GOVERNOR at the front of the chain so the row reads "you → <org>" —
  // the governance relationship, which `parent` does not carry. Absent for an org or a standalone workspace.
  if (agent.governor) {
    const g = all.find((a) => lc(a.agent) === lc(agent.governor!));
    const gName = g?.name || 'unnamed';
    if (!chain.includes(gName)) chain.unshift(gName);
  }
  return [youLabel, ...chain];
}


/** One agent a person can charter, in the words the picker shows: what it is, and the suffix it claims.
 *  Ordered as a person meets them — the counterparty-facing things first, the plumbing after. */
export interface CreatableKind {
  kind: AgentKind;
  label: string;
  blurb: string;
  /** A name is required for anything counterparty-facing; plumbing may be named later. */
  nameRequired: boolean;
}

const FROM_PERSON: CreatableKind[] = [
  { kind: 'person', label: 'Another person of yours', blurb: 'A name of your own for one part of your life — a trail name, a pen name, a character in a game. Its own agent, its own vault, custodied by you; one of your people is the one your home opens as.', nameRequired: true },
  { kind: 'org', label: 'Organization', blurb: 'An organization you control — its own Smart Agent and name.', nameRequired: true },
  { kind: 'team', label: 'Team', blurb: 'A team under you. A team IS an organization, with a narrower remit.', nameRequired: true },
  { kind: 'workspace', label: 'Workspace', blurb: 'A coordinator for work across people and teams.', nameRequired: true },
  { kind: 'service', label: 'Service agent', blurb: 'A service that acts on its own — a bot, a bridge, an app\u2019s agent.', nameRequired: true },
  { kind: 'circle', label: 'Circle', blurb: 'A small group that meets.', nameRequired: true },
  { kind: 'church', label: 'Church', blurb: 'A congregation.', nameRequired: true },
  { kind: 'household', label: 'Household', blurb: 'Your family\u2019s own agent — the people you live with as its members, with their roles and kinship.', nameRequired: true },
  { kind: 'person-treasury', label: 'Personal treasury', blurb: 'Holds and spends value on your behalf.', nameRequired: false },
];

const FROM_ORG: CreatableKind[] = [
  { kind: 'team', label: 'Team', blurb: 'A team inside this organization.', nameRequired: true },
  { kind: 'workspace', label: 'Workspace', blurb: 'A coordinator for this organization\u2019s work.', nameRequired: true },
  { kind: 'service', label: 'Service agent', blurb: 'A service this organization runs.', nameRequired: true },
  { kind: 'org-treasury', label: 'Treasury', blurb: 'Holds and spends this organization\u2019s value.', nameRequired: false },
];

/**
 * What can be chartered here, filtered to the suffixes this CHAIN has a root for. A kind whose typed root
 * is not provisioned is not offered: it would deploy an agent that cannot claim the name that gives it its
 * type, which is worse than not offering it (spec 346 §3.6 — the suffix and the on-chain `atl:agentType`
 * must agree, or a typed claim fails closed).
 */
export function creatableKinds(under: 'person' | 'org', claimable: (k: AgentKind) => boolean): CreatableKind[] {
  return (under === 'person' ? FROM_PERSON : FROM_ORG).filter((c) => claimable(c.kind));
}

/** THE KINDS BORN WITH THEIR PLANES. A chartered agent that keeps records of its own — an organization's channels, a
 *  team's or workspace's roster and artifacts, a service's Library — needs its vault key, delivery grant and
 *  interactions grant from the moment it exists; the Ask-chartered genesis mints them for every child kind, and the
 *  portal's charter enables the same three (`enableAgentPlanes`). A treasury holds money, not records, and a person's
 *  planes are the onboarding ceremony's. Found twice: a service with no planes (2026-10-09) and a workspace with no vault
 *  (Gather27, 2026-10-06). */
export const KINDS_BORN_WITH_PLANES: ReadonlySet<string> = new Set(['org', 'team', 'workspace', 'service']);
