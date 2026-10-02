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

/** One agent drawn around (or above) the centre, with the edge that joins it. `toCenter` points the arrow at the
 *  centre ("member of", "holds keys"); otherwise the centre points at it ("stewards", "holds"). */
export interface CenteredItem {
  id: string;
  kind: GNodeKind;
  name: string;
  sub: string;
  edge: { kind: EdgeKind; label: string; weight?: number; toCenter?: boolean };
  dim?: boolean;
}

export interface CenteredInput {
  center: { id: string; kind: GNodeKind; name: string; sub: string };
  /** Who holds or stewards the centre: a small, faded chain drawn above it (custodian first). */
  above: CenteredItem[];
  /** The centre's own agents: its members, what it stewards, what it holds. */
  ring: CenteredItem[];
  showAll?: boolean;
  maxRing?: number;
}

/**
 * THE GRAPH CENTRED ON ONE AGENT (owner, 2026-10-01: "center on the selected agent and graph out from there").
 * The centre in the middle; what it is made of around it; who holds it small and above. A ring longer than
 * `maxRing` ends in a "+N more" door (`MORE_ID`); clicking it shows them all. Pure; the data is the caller's.
 */
export function buildCenteredGraph(i: CenteredInput): GView {
  const maxRing = Math.max(3, i.maxRing ?? 12);
  const nodes: GNode[] = [{ id: i.center.id, position: { x: 0, y: 0 }, data: { refId: i.center.id, kind: i.center.kind, name: i.center.name, sub: i.center.sub, focus: true } }];
  const edges: GEdge[] = [];
  const edgeOf = (it: CenteredItem, dim: boolean): GEdge => ({
    id: `e:${it.edge.kind}-${it.id}`,
    source: it.edge.toCenter ? it.id : i.center.id, target: it.edge.toCenter ? i.center.id : it.id,
    kind: it.edge.kind, label: it.edge.label, weight: it.edge.weight ?? 0.8, ...(dim ? { dim: true } : {}),
  });
  // Above: spread across the top, chained left to right only by the edges the caller gave.
  const ax = i.above.length <= 1 ? [0] : i.above.map((_, k) => Math.round(-220 + (440 * k) / (i.above.length - 1)));
  i.above.forEach((it, k) => {
    nodes.push({ id: it.id, position: { x: ax[k]!, y: -260 }, data: { refId: it.id, kind: it.kind, name: it.name, sub: it.sub, dim: it.dim !== false } });
    edges.push(edgeOf(it, it.dim !== false));
  });
  // The ring, with the door.
  const overflow = !i.showAll && i.ring.length > maxRing;
  const shown = overflow ? i.ring.slice(0, maxRing - 1) : i.ring;
  const slots = shown.length + (overflow ? 1 : 0);
  const radius = Math.max(300, Math.round(slots * 34));
  const at = (k: number) => { const t = slots <= 1 ? Math.PI / 2 : ((35 + (290 * k) / (slots - 1)) * Math.PI) / 180 - Math.PI / 2 + Math.PI; return { x: Math.round(Math.cos(t) * radius), y: Math.round(Math.sin(t) * radius) }; };
  shown.forEach((it, k) => {
    nodes.push({ id: it.id, position: at(k), data: { refId: it.id, kind: it.kind, name: it.name, sub: it.sub, ...(it.dim ? { dim: true } : {}) } });
    edges.push(edgeOf(it, !!it.dim));
  });
  if (overflow) {
    const rest = i.ring.length - shown.length;
    nodes.push({ id: MORE_ID, position: at(slots - 1), data: { refId: MORE_ID, kind: 'more', name: `+${rest} more`, sub: 'click to show them all' } });
    edges.push({ id: 'e:more', source: i.center.id, target: MORE_ID, kind: 'stewardship', label: `${rest} not drawn`, weight: 0.3, dim: true });
  }
  return { nodes, edges };
}

const wordOf = (o: LivePerson['agents'][number]) => o.kindWord ?? (o.cls === 'service' ? 'service' : o.cls === 'person' ? 'person' : 'organization');

/** A tree row as a ring item: what the centre stewards, belongs to, or (a persona) is another name of. */
export function ringItemOf(o: LivePerson['agents'][number]): CenteredItem {
  const member = o.relationship === 'member';
  if (o.relationship === 'self') return { id: o.agent, kind: o.cls, name: o.name || shortAddr(o.agent), sub: `${wordOf(o)} · another name of yours`, edge: { kind: 'control', label: 'same custodian', weight: 1 } };
  return { id: o.agent, kind: o.cls, name: o.name || shortAddr(o.agent), sub: member ? `${wordOf(o)} · member` : wordOf(o), edge: member ? { kind: 'membership', label: 'member of', weight: 0.5, toCenter: true } : { kind: 'stewardship', label: 'stewards', weight: 0.8 } };
}

/** Stewards before members, then by name. */
export const byRole = (a: CenteredItem, b: CenteredItem): number => (a.edge.kind === 'membership' ? 1 : 0) - (b.edge.kind === 'membership' ? 1 : 0) || a.name.localeCompare(b.name);

/** The person's OWN view from her tree: the custodian above, every direct agent in the ring. Other centres are
 *  composed by the surface from their own records (a roster, a persona's links) and handed to `buildCenteredGraph`. */
export function buildAgentGraphLive(p: LivePerson, opts: { center: string; showAll?: boolean; maxRing?: number }): GView {
  const personId = p.personSA;
  const center = opts.center.toLowerCase();
  const isPerson = center === personId.toLowerCase();
  const self = p.agents.find((a) => a.agent.toLowerCase() === center) ?? null;
  const custodian: CenteredItem = { id: CUSTODIAN_ID, kind: 'custodian', name: 'You', sub: 'passkey custodian', edge: { kind: 'control', label: 'holds keys', weight: 1, toCenter: true }, dim: !isPerson };
  if (isPerson) {
    const ring = p.agents.filter((o) => o.agent.toLowerCase() !== center && (!o.parent || o.parent.toLowerCase() === center)).map(ringItemOf).sort(byRole);
    return buildCenteredGraph({ center: { id: personId, kind: 'person', name: p.name, sub: p.agentName }, above: [{ ...custodian, dim: false }], ring, showAll: opts.showAll, maxRing: opts.maxRing });
  }
  const rel = self?.relationship ?? 'steward';
  const personAbove: CenteredItem = rel === 'self'
    ? { id: personId, kind: 'person', name: p.name, sub: `${p.agentName} · another name of yours`, edge: { kind: 'control', label: 'same custodian', weight: 1, toCenter: true } }
    : { id: personId, kind: 'person', name: p.name, sub: p.agentName, edge: rel === 'member' ? { kind: 'membership', label: 'member of', weight: 0.5 } : { kind: 'stewardship', label: 'stewards', weight: 0.8 } };
  const ring = p.agents.filter((o) => o.agent.toLowerCase() !== center && o.parent?.toLowerCase() === center).map(ringItemOf).sort(byRole);
  return buildCenteredGraph({
    center: { id: self?.agent ?? opts.center, kind: self?.cls ?? 'org', name: self?.name || shortAddr(opts.center), sub: self ? (rel === 'member' ? `${wordOf(self)} · member` : wordOf(self)) : 'agent' },
    above: [custodian, personAbove], ring, showAll: opts.showAll, maxRing: opts.maxRing,
  });
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
