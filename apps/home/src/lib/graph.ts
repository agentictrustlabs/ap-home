// ============================================================================
// Trust-graph model + builders (ported from the impact app, spec-adapted).
// ----------------------------------------------------------------------------
// The graph draws TWO distinct relationship classes, kept visually separate:
//
//  • CONTROL/CUSTODY — the human custodian controls a smart agent (holds its
//    keys). It is the ONLY edge crossing the human↔agent boundary; it is NOT
//    authority and never appears between two smart agents.
//
//  • AUTHORITY & TRUST — everything BETWEEN smart agents: delegation,
//    entitlements, stewardship, membership, payment mandates, and trust
//    assertions. This is where the trust graph is actually built.
//
// Unlike impact (which shipped seed-backed preview graphs), this port is
// LIVE-only: the person view is built from the member's real managed-agent
// tree (useManagedAgents → /connect/related-orgs vault, MAM-D7). No seed data.
// ============================================================================

export type EdgeClass = 'control' | 'authority';

export type EdgeKind =
  | 'control' // custodian (human) → person SA — custody/control of keys
  | 'delegation' // SA → SA — scoped authority (ERC-7710 leaf)
  | 'entitlement' // SA → SA — a granted credential/capability
  | 'stewardship' // SA → SA — an agent manages/stewards another (person → org)
  | 'membership' // person SA → org SA — belongs to (authority-only, spec 318)
  | 'assertion' // org/person SA → org SA — trust attestation / corroboration
  | 'payment'; // treasury SA → payee SA — payment mandate

export const EDGE_CLASS: Record<EdgeKind, EdgeClass> = {
  control: 'control',
  delegation: 'authority',
  entitlement: 'authority',
  stewardship: 'authority',
  membership: 'authority',
  assertion: 'authority',
  payment: 'authority',
};

/** A node kind, plus the synthetic "custodian" (the connected human controlling a SA). */
export type GNodeKind = 'custodian' | 'person' | 'org' | 'service' | 'more';

/** The connected human custodian, shown distinctly from the smart agents. */
export const CUSTODIAN_ID = 'custodian:you';

export interface GNode {
  id: string;
  position: { x: number; y: number };
  data: {
    refId: string;
    kind: GNodeKind;
    name: string;
    sub: string;
    focus?: boolean;
    /** de-emphasized (e.g. a sibling org on an org-scoped view) — rendered faded. */
    dim?: boolean;
  };
}
export interface GEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  label: string;
  weight: number;
  /** mirrors the source/target node dim — a dimmed sibling's edge fades with it. */
  dim?: boolean;
}

export interface GView {
  nodes: GNode[];
  edges: GEdge[];
}

/** Evenly spread `count` coordinates around `mid`, `gap` apart. */
function spread(count: number, mid: number, gap: number): number[] {
  const start = mid - ((count - 1) * gap) / 2;
  return Array.from({ length: count }, (_, i) => start + i * gap);
}

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// ── LIVE person view ──────────────────────────────────────────────────────────
/** The connected member's REAL relationships, assembled from the session profile
 *  + managed-agent tree (never seed). The person SA is the profile's agent address,
 *  each org agent is a node, and the person→org grant is the authority edge. */
export interface LivePerson {
  /** display name for the person node (name label, or 'You'). */
  name: string;
  /** the full agent name (sub-line on the person node), or a short address. */
  agentName: string;
  /** the person SA address — the graph's own id for the person node. */
  personSA: string;
  /** Every agent this person holds a relationship with — organizations AND services.
   *
   *  This was `orgs` and was built from an org-class-only filter, which meant a workspace, treasury or
   *  registry agent — things a person very much stewards — simply did not exist in their trust graph.
   *  The graph's whole claim is "who holds keys vs who granted authority"; silently dropping a class of
   *  agent made it answer that question wrongly, not partially. */
  agents: {
    agent: string;
    name: string | null;
    /** ADR-0046 class — decides the node kind and its sub-label. Typed as the whole closed trichotomy
     *  rather than narrowed to two: `agentClassOf` returns an `AgentType`, and widening the field is
     *  honest where a cast would just be asserting that today's kind list never yields a person. */
    cls: GNodeKind & ('person' | 'org' | 'service');
    /** The subclass word to show (team / church / circle / treasury / workspace …), when it says more
     *  than the class does. */
    kindWord?: string;
    /** spec 318 — 'steward' (custodial, default) draws a stewardship edge;
     *  'member' (authority-only) draws a membership edge instead. */
    /** 'self' — another person of the same custodian: it is them, under a different name. */
    relationship?: 'steward' | 'member' | 'self';
    /** The agent this one hangs under in the tree (the person for a person-treasury or an org; the org for an
     *  org-treasury or a team) — what decides which ring it sits on when the graph centres on an agent. */
    parent?: string;
  }[];
}

/** The id of the overflow node that stands for the agents a ring does not show. */
export const MORE_ID = 'more:ring';

/**
 * THE GRAPH CENTRED ON ONE AGENT (owner, 2026-10-01: "center on the selected agent and graph out from there").
 *
 * The centre sits in the middle. Its own agents — the ones whose `parent` is the centre (for the person herself,
 * everything she holds directly) — ring it, stewards before members. Who HOLDS the centre is a small, faded chain
 * above it: the custodian, and for a persona or an organization the person agent between them, so a person with
 * forty organizations no longer fills the canvas when the question is one of her personas. A ring longer than
 * `maxRing` ends in a "+N more" node; clicking it shows them all.
 */
export function buildAgentGraphLive(p: LivePerson, opts: { center: string; showAll?: boolean; maxRing?: number }): GView {
  const personId = p.personSA;
  const center = opts.center.toLowerCase();
  const isPerson = center === personId.toLowerCase();
  const maxRing = Math.max(3, opts.maxRing ?? 12);
  const self = p.agents.find((a) => a.agent.toLowerCase() === center) ?? null;
  const word = (o: LivePerson['agents'][number]) => o.kindWord ?? (o.cls === 'service' ? 'service' : o.cls === 'person' ? 'person' : 'organization');

  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  // The centre.
  if (isPerson) nodes.push({ id: personId, position: { x: 0, y: 0 }, data: { refId: personId, kind: 'person', name: p.name, sub: p.agentName, focus: true } });
  else nodes.push({ id: self?.agent ?? opts.center, position: { x: 0, y: 0 }, data: { refId: self?.agent ?? opts.center, kind: self?.cls ?? 'org', name: self?.name || shortAddr(opts.center), sub: self ? (self.relationship === 'member' ? `${word(self)} · member` : word(self)) : 'agent', focus: true } });
  const centerId = nodes[0]!.id;

  // Who holds the centre — small and above, never the subject.
  if (isPerson) {
    nodes.push({ id: CUSTODIAN_ID, position: { x: 0, y: -250 }, data: { refId: CUSTODIAN_ID, kind: 'custodian', name: 'You', sub: 'passkey custodian' } });
    edges.push({ id: 'e:control-you', source: CUSTODIAN_ID, target: personId, kind: 'control', label: 'holds keys', weight: 1 });
  } else {
    nodes.push({ id: CUSTODIAN_ID, position: { x: -220, y: -270 }, data: { refId: CUSTODIAN_ID, kind: 'custodian', name: 'You', sub: 'passkey custodian', dim: true } });
    nodes.push({ id: personId, position: { x: 220, y: -270 }, data: { refId: personId, kind: 'person', name: p.name, sub: p.agentName, dim: true } });
    edges.push({ id: 'e:control-you', source: CUSTODIAN_ID, target: personId, kind: 'control', label: 'holds keys', weight: 1, dim: true });
    const rel = self?.relationship ?? 'steward';
    edges.push(rel === 'self'
      ? { id: `e:self-${centerId}`, source: personId, target: centerId, kind: 'control', label: 'same custodian', weight: 1, dim: true }
      : { id: `e:${rel === 'member' ? 'member' : 'stew'}-${centerId}`, source: personId, target: centerId, kind: rel === 'member' ? 'membership' : 'stewardship', label: rel === 'member' ? 'member of' : 'stewards', weight: rel === 'member' ? 0.5 : 0.8, dim: true });
  }

  // The ring: the centre's own agents.
  const children = p.agents
    .filter((o) => o.agent.toLowerCase() !== center && (isPerson ? (!o.parent || o.parent.toLowerCase() === center) : o.parent?.toLowerCase() === center))
    .sort((a, b) => (a.relationship === 'member' ? 1 : 0) - (b.relationship === 'member' ? 1 : 0) || (a.name ?? a.agent).localeCompare(b.name ?? b.agent));
  const overflow = !opts.showAll && children.length > maxRing;
  const shown = overflow ? children.slice(0, maxRing - 1) : children;
  const slots = shown.length + (overflow ? 1 : 0);
  const radius = Math.max(300, Math.round(slots * 34));
  // Leave the top for the holders: slots sweep from 35° past the top, round to 325°.
  const at = (i: number) => { const t = slots <= 1 ? Math.PI / 2 : ((35 + (290 * i) / (slots - 1)) * Math.PI) / 180 - Math.PI / 2 + Math.PI; return { x: Math.round(Math.cos(t) * radius), y: Math.round(Math.sin(t) * radius) }; };
  shown.forEach((o, i) => {
    const member = o.relationship === 'member';
    nodes.push({ id: o.agent, position: at(i), data: { refId: o.agent, kind: o.cls, name: o.name || shortAddr(o.agent), sub: member ? `${word(o)} · member` : o.relationship === 'self' ? `${word(o)} · another name of yours` : word(o) } });
    edges.push(o.relationship === 'self'
      ? { id: `e:self-${o.agent}`, source: centerId, target: o.agent, kind: 'control', label: 'same custodian', weight: 1 }
      : { id: `e:${member ? 'member' : 'stew'}-${o.agent}`, source: centerId, target: o.agent, kind: member ? 'membership' : 'stewardship', label: member ? 'member of' : 'stewards', weight: member ? 0.5 : 0.8 });
  });
  if (overflow) {
    const rest = children.length - shown.length;
    nodes.push({ id: MORE_ID, position: at(slots - 1), data: { refId: MORE_ID, kind: 'more', name: `+${rest} more`, sub: 'click to show them all' } });
    edges.push({ id: 'e:more', source: centerId, target: MORE_ID, kind: 'stewardship', label: `${rest} not drawn`, weight: 0.3, dim: true });
  }
  return { nodes, edges };
}

export function buildPersonGraphLive(p: LivePerson, opts?: { focusAgent?: string }): GView {
  const personId = p.personSA;
  const focusAgent = opts?.focusAgent?.toLowerCase();
  // The connected human custodian sits ABOVE the person SA they control — visually
  // off the agent-to-agent plane where all the authority edges live.
  const nodes: GNode[] = [
    { id: CUSTODIAN_ID, position: { x: 70, y: 90 }, data: { refId: CUSTODIAN_ID, kind: 'custodian', name: 'You', sub: 'passkey custodian' } },
    {
      id: personId,
      position: { x: 70, y: 360 },
      data: { refId: personId, kind: 'person', name: p.name, sub: p.agentName, focus: !focusAgent },
    },
  ];
  const ys = spread(p.agents.length, 360, 230);
  p.agents.forEach((o, i) => {
    const isFocus = !!focusAgent && o.agent.toLowerCase() === focusAgent;
    const word = o.kindWord ?? (o.cls === 'service' ? 'service' : o.cls === 'person' ? 'person' : 'organization');
    nodes.push({
      id: o.agent,
      position: { x: 430, y: ys[i]! },
      data: {
        refId: o.agent,
        kind: o.cls,
        name: o.name || shortAddr(o.agent),
        sub: o.relationship === 'member' ? `${word} · member` : word,
        focus: isFocus,
        // On an agent-scoped view, siblings stay for context but fade back.
        dim: !!focusAgent && !isFocus,
      },
    });
  });
  const edges: GEdge[] = [
    // The custody/control edge: the connected human → their person Smart Agent.
    // The ONLY edge crossing the human↔agent boundary; never between two agents.
    { id: 'e:control-you', source: CUSTODIAN_ID, target: personId, kind: 'control', label: 'holds keys', weight: 1 },
    ...p.agents.map((o): GEdge => {
      const member = o.relationship === 'member';
      return {
        id: `e:${member ? 'member' : 'stew'}-${o.agent}`,
        source: personId,
        target: o.agent,
        kind: member ? 'membership' : 'stewardship',
        label: member ? 'member of' : 'stewards',
        weight: member ? 0.5 : 0.8,
        dim: !!focusAgent && o.agent.toLowerCase() !== focusAgent,
      };
    }),
  ];
  return { nodes, edges };
}

// ── Edge styling (one entry per EdgeKind — the legend derives from this) ──────
export interface EdgeStyle {
  color: string;
  dashed: boolean;
  /** finely dotted — reserved for the control/custody class so it reads as "not authority". */
  dotted?: boolean;
  label: string;
  cls: EdgeClass;
}

export const EDGE_KIND_STYLE: Record<EdgeKind, EdgeStyle> = {
  // Control / custody — human → agent. Deliberately muted + dotted so it never
  // competes with (or looks like) authority between agents.
  control: { color: '#64748b', dashed: true, dotted: true, label: 'Holds keys (you → your agent)', cls: 'control' },
  // Authority & trust — agent → agent. Saturated, weighted, the focus of the graph.
  delegation: { color: '#7c3aed', dashed: true, label: 'Delegation', cls: 'authority' },
  entitlement: { color: '#0891b2', dashed: false, label: 'Entitlement', cls: 'authority' },
  stewardship: { color: '#d97706', dashed: false, label: 'Stewardship', cls: 'authority' },
  membership: { color: '#a8a29e', dashed: false, label: 'Membership', cls: 'authority' },
  assertion: { color: '#10b981', dashed: false, label: 'Trust assertion', cls: 'authority' },
  payment: { color: '#f59e0b', dashed: true, label: 'Payment mandate', cls: 'authority' },
};

export const NODE_KIND_LABEL: Record<GNodeKind, string> = {
  custodian: 'You (custodian)',
  person: 'Person agent',
  org: 'Organization agent',
  service: 'Service agent',
  more: 'More agents',
};
