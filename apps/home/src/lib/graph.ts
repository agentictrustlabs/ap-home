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
  | 'governance' // org SA → workspace SA — the organization that governs a workspace (aporg:governedBy)
  | 'assertion' // org/person SA → org SA — trust attestation / corroboration
  | 'payment'; // treasury SA → payee SA — payment mandate

export const EDGE_CLASS: Record<EdgeKind, EdgeClass> = {
  control: 'control',
  delegation: 'authority',
  entitlement: 'authority',
  stewardship: 'authority',
  membership: 'authority',
  governance: 'authority',
  assertion: 'authority',
  payment: 'authority',
};

/** A node kind, plus the synthetic "custodian" (the connected human controlling a SA). */
export type GNodeKind = 'custodian' | 'person' | 'org' | 'service';

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
    /** A WORKSPACE'S GOVERNOR (the owner's rule, 2026-10-02; `org.ttl` §2): the organization agent that governs
     *  this workspace (`aporg:governedBy`). A `.workspace` agent is a service that coordinates and holds no
     *  members, so the graph draws the organization beside it with a `governs` edge and hangs the person's
     *  MEMBERSHIP on the organization — a membership edge into a workspace would draw a roster it cannot hold.
     *  The person's STEWARDSHIP of the workspace stays on the workspace: custody of the coordinator is real.
     *  Lowercase address; absent for everything that is not a governed workspace. */
    governedBy?: string;
  }[];
}

export function buildPersonGraphLive(p: LivePerson, opts?: { focusAgent?: string }): GView {
  const personId = p.personSA;
  const focusAgent = opts?.focusAgent?.toLowerCase();
  const lc = (a: string) => a.toLowerCase();
  const nameOf = (a: string) => p.agents.find((o) => lc(o.agent) === lc(a))?.name || shortAddr(a);
  // GOVERNORS THE PERSON HOLDS NO LINK TO are still drawn: a member of a workspace whose organization never
  // linked them sees the organization their membership is actually on, named by its address.
  const unlinkedGovernors = [...new Set(p.agents.map((o) => o.governedBy && lc(o.governedBy)).filter((g): g is string => !!g && !p.agents.some((o) => lc(o.agent) === g)))];
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
  const ys = spread(p.agents.length + unlinkedGovernors.length, 360, 230);
  p.agents.forEach((o, i) => {
    const isFocus = !!focusAgent && lc(o.agent) === focusAgent;
    const word = o.kindWord ?? (o.cls === 'service' ? 'service' : o.cls === 'person' ? 'person' : 'organization');
    // A governed workspace says so under its name: it coordinates, its organization governs.
    const shape = o.governedBy ? `${word} · governed by ${nameOf(o.governedBy)}` : word;
    nodes.push({
      id: o.agent,
      position: { x: 430, y: ys[i]! },
      data: {
        refId: o.agent,
        kind: o.cls,
        name: o.name || shortAddr(o.agent),
        sub: o.relationship === 'member' ? `${shape} · member` : shape,
        focus: isFocus,
        // On an agent-scoped view, siblings stay for context but fade back.
        dim: !!focusAgent && !isFocus,
      },
    });
  });
  unlinkedGovernors.forEach((g, i) => {
    nodes.push({
      id: g,
      position: { x: 430, y: ys[p.agents.length + i]! },
      data: { refId: g, kind: 'org', name: shortAddr(g), sub: 'organization · governs a workspace of yours', dim: !!focusAgent },
    });
  });
  // The person's own edges. A MEMBERSHIP of a governed workspace hangs on the GOVERNOR, because that is where the
  // record is; a second edge to the same organization (the person also linked to it as a member) is one edge.
  const seen = new Set<string>();
  const own: GEdge[] = [];
  for (const o of p.agents) {
    const member = o.relationship === 'member';
    const target = member && o.governedBy ? lc(o.governedBy) : o.agent;
    const key = `${member ? 'member' : 'stew'}:${lc(target)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    own.push({
      id: `e:${member ? 'member' : 'stew'}-${target}`,
      source: personId,
      target,
      kind: member ? 'membership' : 'stewardship',
      label: member ? 'member of' : 'stewards',
      weight: member ? 0.5 : 0.8,
      dim: !!focusAgent && lc(o.agent) !== focusAgent && lc(target) !== focusAgent,
    });
  }
  const edges: GEdge[] = [
    // The custody/control edge: the connected human → their person Smart Agent.
    // The ONLY edge crossing the human↔agent boundary; never between two agents.
    { id: 'e:control-you', source: CUSTODIAN_ID, target: personId, kind: 'control', label: 'holds keys', weight: 1 },
    ...own,
    // ORGANIZATION → WORKSPACE: the governance the workspace's authority derives from (aporg:governedBy). Drawn
    // between two agents because that is what it is; never a person's edge.
    ...p.agents.filter((o) => !!o.governedBy).map((o): GEdge => ({
      id: `e:governs-${o.agent}`,
      source: lc(o.governedBy!),
      target: o.agent,
      kind: 'governance',
      label: 'governs',
      weight: 0.8,
      dim: !!focusAgent && lc(o.agent) !== focusAgent && lc(o.governedBy!) !== focusAgent,
    })),
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
  governance: { color: '#4f7a5a', dashed: false, label: 'Governs (organization → workspace)', cls: 'authority' },
  assertion: { color: '#10b981', dashed: false, label: 'Trust assertion', cls: 'authority' },
  payment: { color: '#f59e0b', dashed: true, label: 'Payment mandate', cls: 'authority' },
};

export const NODE_KIND_LABEL: Record<GNodeKind, string> = {
  custodian: 'You (custodian)',
  person: 'Person agent',
  org: 'Organization agent',
  service: 'Service agent',
};
