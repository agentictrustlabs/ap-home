'use client';
// Trust-graph renderer (ported from the impact app, spec-adapted for demo-sso-next).
// React Flow draws the member's LIVE relationship graph: the human custodian (control,
// dotted/muted, off the agent plane) → their person SA → each managed org (authority,
// bold/weighted). Impact's seed-backed preview/org builders were intentionally dropped —
// this component only ever renders a LivePerson built from the managed-agent tree.
// Styling: impact's tg-* CSS shipped in its globals; here it is scoped inline (a <style>
// block below) and remapped onto this app's --color-* / --radius-* tokens so the portal
// stylesheet stays untouched.
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { useSession } from '../../context/session';
import { useManagedAgents } from '../portal/ManagedAgents';
import { listManagedAgentsFor } from '../../connect-client';
import { fetchRoster } from '../../lib/recipient-directory';
import { participantType } from '../../home/roster-contract';
import { nameLabel } from '../../lib/domain';
import { agentClassOf, kindWordOf } from '../../lib/agent-class';
import { workspaceGovernorOf } from '../../lib/recipient-directory';

/** The word under an agent's node: its subclass when that says more than the class does (`kindWordOf`). */
import {
  buildAgentGraphLive,
  buildCenteredGraph,
  byRole,
  ringItemOf,
  clusterPeople,
  CLUSTER_PEOPLE_ID,
  CUSTODIAN_ID as CUSTODIAN,
  MORE_ID,
  type CenteredItem,
  CUSTODIAN_ID,
  EDGE_KIND_STYLE,
  NODE_KIND_LABEL,
  type GNodeKind,
  type LivePerson,
  buildMultiLevelView,
  applyGraphFilters,
  presentSubKinds,
  presentEdgeKinds,
  type GraphFilters,
  type EdgeKind,
  type GView,
} from '../../lib/graph';
import { layoutElk, type LayoutDirection } from '../../lib/graph-layout';

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// ── Live-graph assembly + page furniture, shared by /trust-graph and the org-scoped
//    /org/[org]/trust-graph (Next route files may only export route members, so the
//    shared pieces live here beside the renderer rather than on either page). ─────

/** Build the LIVE person graph input from the session + managed-agent tree (MAM-D7). */
export function useLivePerson(): { live: LivePerson | null; loaded: boolean } {
  const { session, phase, agentAddress, agentName } = useSession();
  const { agents, loaded } = useManagedAgents(session?.token ?? null);
  const live = useMemo<LivePerson | null>(() => {
    if (phase !== 'authed' || !agentAddress) return null;
    return {
      name: agentName ? nameLabel(agentName) : 'You',
      agentName: agentName ?? shortAddr(agentAddress),
      personSA: agentAddress,
      // EVERY managed agent, both classes. Filtering to org-class here is what kept workspaces,
      // treasuries and registry agents out of the graph entirely.
      agents: agents.map((o) => {
        // A workspace's governor is the organization its link hangs under (the owner's rule, 2026-10-02): drawn
        // beside it, and the person's membership hangs there rather than on the coordinator.
        const governedBy = workspaceGovernorOf(o, agents);
        return {
          agent: o.agent,
          name: o.name ? nameLabel(o.name) : null,
          cls: agentClassOf(o.kind),
          kindWord: kindWordOf(o.kind),
          relationship: o.relationship,
          ...(o.parent ? { parent: String(o.parent).toLowerCase() } : {}),
          ...(governedBy ? { governedBy } : {}),
        };
      }),
    };
  }, [phase, agentAddress, agentName, agents]);
  return { live, loaded };
}

/** The two relationship classes, kept visually distinct (mirrors the legend split). `collapsible` folds it into a
 *  one-line disclosure so the full-page graph keeps its height. */
export function ClassExplainer({ collapsible }: { collapsible?: boolean } = {}) {
  const cards = (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '.8rem', marginBottom: collapsible ? 0 : '1rem', marginTop: collapsible ? '.6rem' : 0 }}>
      <div className="manage-card" style={{ borderLeft: '3px dashed var(--color-border-strong)' }}>
        <div className="dash-section"><h2 style={{ margin: 0 }}>Control · custody</h2></div>
        <p className="manage-card-blurb" style={{ marginTop: 4 }}>
          <strong>You → your agent.</strong> The human custodian holds the keys to their person
          agent. A control link — not authority — shown dotted &amp; muted, crossing the
          person↔agent line only once.
        </p>
      </div>
      <div className="manage-card" style={{ borderLeft: '3px solid var(--color-amber-500)' }}>
        <div className="dash-section"><h2 style={{ margin: 0 }}>Authority &amp; trust · agent → agent</h2></div>
        <p className="manage-card-blurb" style={{ marginTop: 4 }}>
          <strong>Between smart agents.</strong> Stewardship, membership, delegations &amp; payment
          mandates — drawn bold and weighted. This is where the trust graph is built.
        </p>
      </div>
    </div>
  );
  if (!collapsible) return cards;
  return (
    <details style={{ marginBottom: '.7rem' }}>
      <summary style={{ cursor: 'pointer', fontSize: '.82rem', color: 'var(--color-text-muted)', fontWeight: 600 }}>
        What the links mean — control (you → your agent) vs authority (agent → agent)
      </summary>
      {cards}
    </details>
  );
}

/** The graph canvas card — React Flow needs a fixed-height positioned parent. */
export function GraphCard({ live, focusAgent, fill }: { live: LivePerson; focusAgent?: string; fill?: boolean }) {
  // `fill` (the full-bleed trust-graph pages): take the page height so the diagram is as large as the screen allows,
  // never the narrow 72vh box used when the graph sits under prose. The subtracted header/legend band keeps the whole
  // card on screen without a page scroll.
  const height = fill ? 'calc(100vh - 200px)' : 'min(72vh, 720px)';
  return (
    <div className="manage-card" style={{ height, minHeight: fill ? 420 : undefined, overflow: 'hidden', padding: 0 }}>
      <TrustGraph live={live} focusAgent={focusAgent} />
    </div>
  );
}

type NodeData = { refId: string; kind: GNodeKind; name: string; sub: string; focus?: boolean; dim?: boolean };

// ── Tiny local UI atoms (impact's Glyph/Pill live in its own ui kit — not ported) ──
const GLYPH_BG: Record<GNodeKind, string> = {
  custodian: 'var(--color-surface-sunken)',
  person: 'var(--color-amber-100)',
  org: 'var(--color-sage-100)',
  service: '#ede9fe',
  more: 'var(--color-surface-raised)',
  cluster: 'var(--color-sage-100)',
};

function Glyph({ kind, name }: { kind: GNodeKind; name: string }) {
  return (
    <span className="tg-glyph" style={{ background: GLYPH_BG[kind] }} aria-hidden>
      {kind === 'more' ? '…' : kind === 'cluster' ? '\u{1F465}' : (name[0] ?? '?').toUpperCase()}
    </span>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return <span className="tg-pill">{children}</span>;
}

function TrustNode({ data, selected }: NodeProps<Node<NodeData>>) {
  return (
    <div className={`tg-node kind-${data.kind} ${selected || data.focus ? 'sel' : ''} ${data.dim ? 'dim' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <Handle type="target" position={Position.Top} />
      <div style={{ display: 'flex', alignItems: 'center', gap: '.55rem' }}>
        <Glyph kind={data.kind} name={data.name} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: '.82rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {data.name}
          </div>
          <div style={{ fontSize: '.68rem', color: 'var(--color-text-faint)' }}>{data.sub}</div>
        </div>
      </div>
      <Handle type="source" position={Position.Right} />
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const nodeTypes = { trust: TrustNode };

/**
 * WHAT THE CENTRE IS MADE OF, from its own records (owner, 2026-10-01: "the trust graph building out is the key part
 * of the game — the interconnection of agents"). The person herself: her tree. A PERSONA of hers: the persona's own
 * links (what she stewards and belongs to), read by her custodian. An ORGANIZATION, team, circle, church or service:
 * its roster — every member with their role — plus what it holds in the tree. Nothing is inferred from a name.
 */
function useCenteredGraph(live: LivePerson, center: string, showAll: boolean, showPeople: boolean): { g: ReturnType<typeof buildCenteredGraph>; reading: boolean; note: string | null } {
  const { session } = useSession();
  const token = session?.token ?? null;
  const self = useMemo(() => live.agents.find((a) => a.agent.toLowerCase() === center) ?? null, [live.agents, center]);
  const isPerson = center === live.personSA.toLowerCase();
  const isPersona = self?.relationship === 'self';
  const [fetched, setFetched] = useState<{ for: string; ring: CenteredItem[]; stewards: CenteredItem[] } | null>(null);
  const [reading, setReading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!token || isPerson) { setFetched(null); setNote(null); return; }
    let on = true;
    setReading(true); setNote(null);
    (async () => {
      try {
        if (isPersona) {
          const rows = await listManagedAgentsFor(token, center, 'any');
          const ring = rows
            .filter((o) => o.agent.toLowerCase() !== center && o.agent.toLowerCase() !== live.personSA.toLowerCase())
            .map((o) => ringItemOf({ agent: o.agent, name: o.name ? nameLabel(o.name) : null, cls: agentClassOf(o.kind), kindWord: kindWordOf(o.kind), relationship: o.relationship }))
            .sort(byRole);
          if (on) setFetched({ for: center, ring, stewards: [] });
        } else {
          const members = await fetchRoster(token, center);
          const ring: CenteredItem[] = [];
          const stewards: CenteredItem[] = [];
          for (const m of members) {
            const t = participantType(m.publicName);
            const kind: GNodeKind = t === 'organization' ? 'org' : t === 'service' ? 'service' : 'person';
            const role = (m.role ?? '').toLowerCase();
            const steward = /steward|founder|owner|lead/.test(role);
            const item: CenteredItem = { id: m.address, kind, name: m.displayName, sub: role ? role : t === 'unknown' ? 'member' : t, edge: steward ? { kind: 'stewardship', label: 'stewards', weight: 0.8, toCenter: true } : { kind: 'membership', label: 'member of', weight: 0.5, toCenter: true } };
            (steward ? stewards : ring).push(item);
          }
          if (on) setFetched({ for: center, ring: ring.sort((a, b) => a.name.localeCompare(b.name)), stewards: stewards.sort((a, b) => a.name.localeCompare(b.name)) });
        }
      } catch (e) {
        if (on) { setFetched({ for: center, ring: [], stewards: [] }); setNote(`Could not read ${isPersona ? 'this person\'s links' : 'the roster'}: ${e instanceof Error ? e.message : String(e)}`); }
      } finally { if (on) setReading(false); }
    })();
    return () => { on = false; };
  }, [token, center, isPerson, isPersona, live.personSA]);

  const g = useMemo(() => {
    if (isPerson || !fetched || fetched.for !== center) return buildAgentGraphLive(live, { center, showAll });
    const held = live.agents.filter((o) => o.agent.toLowerCase() !== center && o.parent?.toLowerCase() === center).map((o) => ({ ...ringItemOf(o), edge: { kind: 'stewardship' as const, label: 'holds', weight: 0.6 } }));
    const custodian: CenteredItem = { id: CUSTODIAN, kind: 'custodian', name: 'You', sub: 'passkey custodian', edge: { kind: 'control', label: 'holds keys', weight: 1, toCenter: true } };
    if (isPersona) {
      // A persona is yours directly: You hold its keys. Your default name is a sibling, not a holder.
      const sibling: CenteredItem = { id: live.personSA, kind: 'person', name: live.name, sub: `${live.agentName} · another name of yours`, edge: { kind: 'control', label: 'same custodian', weight: 1, toCenter: true } };
      return buildCenteredGraph({ center: { id: self?.agent ?? center, kind: 'person', name: self?.name || center.slice(0, 10), sub: `${self?.kindWord ?? 'person'} · another name of yours` }, above: [{ ...custodian, dim: false }, sibling], ring: clusterPeople([...fetched.ring, ...held], { expanded: showPeople }), showAll, ...(showPeople ? { maxRing: 80 } : {}) });
    }
    // An organization-class or service agent: its stewards above (You among them when the roster names you), its
    // members and what it holds around it. The tree's own row, when it says you steward or belong, stays as a faded holder.
    const me = live.personSA.toLowerCase();
    const above: CenteredItem[] = fetched.stewards.map((st) => (st.id.toLowerCase() === me ? { ...st, name: `${live.name} (you)`, dim: true } : { ...st, dim: true }));
    if (self && !above.some((a) => a.id.toLowerCase() === me)) above.push({ id: live.personSA, kind: 'person', name: `${live.name} (you)`, sub: live.agentName, dim: true, edge: self.relationship === 'member' ? { kind: 'membership', label: 'member of', weight: 0.5, toCenter: true } : { kind: 'stewardship', label: 'stewards', weight: 0.8, toCenter: true } });
    const word = self?.kindWord ?? (self?.cls === 'service' ? 'service' : 'organization');
    // THE WORKSPACE THIS ORGANIZATION GOVERNS (owner's rule, 2026-10-02): a `.workspace` service whose `governedBy`
    // points at this org. It is a service the person holds, so its `parent` is the person, not the org — it would
    // never land in `held`; it is added here with the distinct `governs` edge so the org↔workspace link is drawn.
    const held2 = new Set(held.map((h) => h.id.toLowerCase()));
    const governed: CenteredItem[] = live.agents
      .filter((o) => o.governedBy?.toLowerCase() === center && o.agent.toLowerCase() !== center && !held2.has(o.agent.toLowerCase()))
      .map((o) => ({ id: o.agent, kind: o.cls, name: o.name ? nameLabel(o.name) : o.agent.slice(0, 10), sub: `${o.kindWord ?? o.cls} · governed workspace`, edge: { kind: 'governance' as const, label: 'governs', weight: 0.8 } }));
    return buildCenteredGraph({ center: { id: self?.agent ?? center, kind: self?.cls ?? 'org', name: self?.name || center.slice(0, 10), sub: word }, above, ring: clusterPeople([...governed, ...held, ...fetched.ring], { expanded: showPeople }), showAll, ...(showPeople ? { maxRing: 80 } : {}) });
  }, [live, center, showAll, showPeople, fetched, isPerson, isPersona, self]);
  return { g, reading, note };
}

// ── CLICK-TO-EXPAND (owner, 2026-10-02: "yes" — reach the 3rd and 4th levels on the org and persona pages too) ─
// Depth 1–4 walks the PERSON'S OWN tree, whose rows carry `parent`. An organization or persona page is built from
// that agent's roster/links fetched one level at a time, so there the tree is not in hand. Expanding a node here
// fetches ITS children the same way the centre's were fetched, and splices them in UNDER that node — expand a
// child in turn and you are three, four levels deep. Read-only; the same reads the roster view already makes.
type ExpItem = CenteredItem & { subKind?: string };

/** The children of one agent on the graph: a persona's managed agents, or an org/service's roster. Mirrors
 *  `useCenteredGraph`'s own fetch, so an expanded node holds exactly what centring on it would show. */
async function fetchChildrenOf(token: string, agentId: string, kind: GNodeKind, personSA: string): Promise<ExpItem[]> {
  const self = agentId.toLowerCase();
  const me = personSA.toLowerCase();
  if (kind === 'person') {
    const rows = await listManagedAgentsFor(token, agentId, 'any');
    return rows
      .filter((o) => o.agent.toLowerCase() !== self && o.agent.toLowerCase() !== me)
      .map((o) => {
        const cls = agentClassOf(o.kind);
        const kindWord = kindWordOf(o.kind);
        return { ...ringItemOf({ agent: o.agent, name: o.name ? nameLabel(o.name) : null, cls, kindWord, relationship: o.relationship }), subKind: kindWord ?? cls };
      })
      .sort(byRole);
  }
  // org / service — its roster (members + stewards), every edge pointing INTO this node.
  const members = await fetchRoster(token, agentId);
  return members
    .filter((m) => m.address.toLowerCase() !== self)
    .map((m) => {
      const t = participantType(m.publicName);
      const nKind: GNodeKind = t === 'organization' ? 'org' : t === 'service' ? 'service' : 'person';
      const role = (m.role ?? '').toLowerCase();
      const steward = /steward|founder|owner|lead/.test(role);
      return { id: m.address, kind: nKind, name: m.displayName, sub: role ? role : t === 'unknown' ? 'member' : t, edge: steward ? { kind: 'stewardship' as const, label: 'stewards', weight: 0.8, toCenter: true } : { kind: 'membership' as const, label: 'member of', weight: 0.5, toCenter: true } };
    })
    .sort((a, b) => (a.edge.kind === 'membership' ? 1 : 0) - (b.edge.kind === 'membership' ? 1 : 0) || a.name.localeCompare(b.name));
}

/** Splice every expanded node's children into the base view, under that node. A child already on the view (the
 *  centre reached it another way) is not duplicated. Returns a fresh unpositioned view for ELK. */
function mergeExpanded(base: GView, expanded: Record<string, ExpItem[]>): GView {
  const nodes = [...base.nodes];
  const edges = [...base.edges];
  const present = new Set(nodes.map((n) => n.id.toLowerCase()));
  for (const [parentId, items] of Object.entries(expanded)) {
    if (!present.has(parentId)) continue; // its parent is not (or no longer) on the view
    for (const it of items) {
      if (present.has(it.id.toLowerCase())) continue;
      present.add(it.id.toLowerCase());
      nodes.push({ id: it.id, position: { x: 0, y: 0 }, data: { refId: it.id, kind: it.kind, name: it.name, sub: it.sub, ...(it.subKind ? { subKind: it.subKind } : {}) } });
      const toCenter = it.edge.toCenter ?? false;
      edges.push({ id: `e:exp:${parentId}:${it.edge.kind}-${it.id}`, source: toCenter ? it.id : parentId, target: toCenter ? parentId : it.id, kind: it.edge.kind, label: it.edge.label, weight: it.edge.weight ?? 0.8 });
    }
  }
  return { nodes, edges };
}

export default function TrustGraph({ live, focusAgent }: { live: LivePerson; focusAgent?: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  // THE CENTRE is the agent this page is about (the persona, organization or service in the route), or the person
  // herself at her own home. A long ring ends in "+N more" until it is clicked.
  const center = (focusAgent ?? live.personSA).toLowerCase();
  const isPerson = center === live.personSA.toLowerCase();
  const [showAll, setShowAll] = useState(false);
  const [showPeople, setShowPeople] = useState(false);
  // FILTERS + DEPTH (owner, 2026-10-02). Depth walks the person's own tree (the data carries `parent`); the two
  // filter axes hide a class/subtype of agent, or a kind of relationship. The sets list what is HIDDEN.
  const [depth, setDepth] = useState(1);
  const [direction, setDirection] = useState<LayoutDirection>('DOWN');
  const [hiddenNodeKinds, setHiddenNodeKinds] = useState<ReadonlySet<GNodeKind>>(new Set());
  const [hiddenSubKinds, setHiddenSubKinds] = useState<ReadonlySet<string>>(new Set());
  const [hiddenEdgeKinds, setHiddenEdgeKinds] = useState<ReadonlySet<EdgeKind>>(new Set());
  // Click-to-expand: children fetched for a node (keyed by lowercased id), and the node currently fetching.
  const { session } = useSession();
  const token = session?.token ?? null;
  const [expanded, setExpanded] = useState<Record<string, ExpItem[]>>({});
  const [expanding, setExpanding] = useState<string | null>(null);
  const { g, reading, note } = useCenteredGraph(live, center, showAll, showPeople);
  // A new centre resets the view to its ring, one level, nothing filtered, nothing expanded.
  useEffect(() => { setShowAll(false); setShowPeople(false); setDepth(1); setHiddenNodeKinds(new Set()); setHiddenSubKinds(new Set()); setHiddenEdgeKinds(new Set()); setExpanded({}); setExpanding(null); }, [center]);
  // Changing depth re-walks the person's tree, which can re-draw or drop the nodes expansions hung under — start clean.
  useEffect(() => { setExpanded({}); setExpanding(null); }, [depth]);

  const toggleExpand = useCallback((nodeId: string, kind: GNodeKind) => {
    const id = nodeId.toLowerCase();
    if (expanded[id]) { setExpanded((e) => { const next = { ...e }; delete next[id]; return next; }); return; }
    if (!token || kind === 'custodian' || kind === 'more' || kind === 'cluster') return;
    setExpanding(id);
    void fetchChildrenOf(token, nodeId, kind, live.personSA)
      .then((items) => setExpanded((e) => ({ ...e, [id]: items })))
      .catch(() => setExpanded((e) => ({ ...e, [id]: [] })))
      .finally(() => setExpanding((cur) => (cur === id ? null : cur)));
  }, [expanded, token, live.personSA]);

  // The centre's own tree out to `depth` (person centre only — that is where `live.agents` holds the descendants);
  // otherwise the single-level centred view the roster/persona read produced.
  const rawView = useMemo<GView>(() => (isPerson && depth > 1 ? buildMultiLevelView(live, { center, depth }) : g), [isPerson, depth, live, center, g]);
  // Splice in whatever nodes the person expanded by clicking — this is how the org/persona pages reach deeper levels.
  const expandedView = useMemo<GView>(() => (Object.keys(expanded).length ? mergeExpanded(rawView, expanded) : rawView), [rawView, expanded]);
  const filters = useMemo<GraphFilters>(() => ({ nodeKinds: hiddenNodeKinds, subKinds: hiddenSubKinds, edgeKinds: hiddenEdgeKinds }), [hiddenNodeKinds, hiddenSubKinds, hiddenEdgeKinds]);
  const filtered = useMemo<GView>(() => applyGraphFilters(expandedView, filters), [expandedView, filters]);

  // ELK lays the filtered view out (async). Keep the last laid view until the next is ready so the canvas never
  // blanks; a failed layout keeps the input positions.
  const [laid, setLaid] = useState<GView>(filtered);
  useEffect(() => { let on = true; void layoutElk(filtered, { direction }).then((v) => { if (on) setLaid(v); }); return () => { on = false; }; }, [filtered, direction]);
  const personaOf = (id: string) => live.agents.find((a) => a.agent.toLowerCase() === id.toLowerCase());
  // Where "centre the graph here" goes for a ring node: its own trust-graph page, when this Home has one for it.
  const centerHref = (meta: NodeData): string | null => {
    const id = meta.refId.toLowerCase();
    if (id === center || id === CUSTODIAN || id === MORE_ID) return null;
    const row = personaOf(id);
    if (meta.kind === 'org') return `/org/${encodeURIComponent(meta.refId)}/trust-graph`;
    if (meta.kind === 'service') return `/service/${encodeURIComponent(meta.refId)}/trust-graph`;
    if (meta.kind === 'person' && row?.relationship === 'self') return `/as/${encodeURIComponent(meta.refId)}/trust-graph`;
    if (meta.kind === 'person' && id === live.personSA.toLowerCase()) return '/trust-graph';
    return null;
  };

  const nodes: Node<NodeData>[] = laid.nodes.map((n) => ({
    id: n.id,
    type: 'trust',
    position: n.position,
    data: n.data,
    selected: n.id === selected,
  }));

  const edges: Edge[] = laid.edges.map((e) => {
    const st = EDGE_KIND_STYLE[e.kind];
    const isControl = st.cls === 'control';
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label,
      // only AUTHORITY edges animate + carry weight; control stays quiet.
      animated: !isControl && (e.kind === 'payment' || e.kind === 'delegation'),
      style: {
        stroke: st.color,
        strokeWidth: isControl ? 1.4 : 1.6 + e.weight,
        strokeDasharray: st.dotted ? '1 6' : st.dashed ? '6 4' : undefined,
        opacity: e.dim ? 0.3 : isControl ? 0.75 : 1,
      },
      labelStyle: { fontSize: 10, fill: isControl ? 'var(--color-text-faint)' : 'var(--color-text-muted)', fontWeight: 600 },
      labelBgStyle: { fill: 'var(--color-surface)', fillOpacity: 0.9 },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 4,
      markerEnd: { type: MarkerType.ArrowClosed, color: st.color, width: 15, height: 15 },
    };
  });

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <style>{TG_CSS}</style>
      <ReactFlow
        key={`${center}:${depth}:${direction}:${laid.nodes.length}x${laid.edges.length}`}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.4}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, n) => { if (n.id === MORE_ID) { setShowAll(true); setSelected(null); } else setSelected(n.id); }}
        onPaneClick={() => setSelected(null)}
        nodesDraggable
        className="trustgraph"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color="var(--color-border)" />
        <Controls showInteractive={false} />
      </ReactFlow>

      <FilterPanel
        rawView={rawView}
        isPerson={isPerson}
        depth={depth}
        setDepth={setDepth}
        direction={direction}
        setDirection={setDirection}
        hiddenNodeKinds={hiddenNodeKinds}
        setHiddenNodeKinds={setHiddenNodeKinds}
        hiddenSubKinds={hiddenSubKinds}
        setHiddenSubKinds={setHiddenSubKinds}
        hiddenEdgeKinds={hiddenEdgeKinds}
        setHiddenEdgeKinds={setHiddenEdgeKinds}
      />
      {(reading || note) && (
        <div className="tg-pill" style={{ position: 'absolute', top: 10, left: 10, zIndex: 5 }} data-testid="trust-graph-status">{reading ? 'Reading its records…' : note}</div>
      )}
      {selected && (() => {
        const meta = laid.nodes.find((n) => n.id === selected)?.data ?? null;
        const id = selected.toLowerCase();
        const expandable = !!meta && selected !== center && (meta.kind === 'org' || meta.kind === 'service' || meta.kind === 'person');
        return (
          <Inspector
            meta={meta}
            agentName={live.agentName}
            centerHref={meta ? centerHref(meta) : null}
            expandable={expandable}
            isExpanded={!!expanded[id]}
            expanding={expanding === id}
            expandedCount={expanded[id]?.length}
            onToggleExpand={() => meta && toggleExpand(selected, meta.kind)}
            onClose={() => setSelected(null)}
          />
        );
      })()}
    </div>
  );
}

// ── Filter panel (owner, 2026-10-02: "filter based on all the types of agents and types of relationships
//    and allow for it to expand to 3rd and 4th levels") ────────────────────────────────────────────────
// Collapsible, bottom-left (where the read-only legend sat). It IS the legend now: every relationship row shows
// its colour and toggles that relationship on the canvas. Agent types toggle by class and by subtype. Depth
// walks the person's own tree. Nothing here is authority — it only changes what is drawn.

function toggleIn<T>(set: ReadonlySet<T>, v: T): ReadonlySet<T> {
  const next = new Set(set);
  if (next.has(v)) next.delete(v); else next.add(v);
  return next;
}

function Chip({ on, onClick, children, swatch }: { on: boolean; onClick: () => void; children: React.ReactNode; swatch?: { color: string; dashed?: boolean; dotted?: boolean } }) {
  return (
    <button type="button" className={`tg-chip ${on ? '' : 'off'}`} onClick={onClick} aria-pressed={on}>
      {swatch && <span className="tg-chip-swatch" style={{ borderTop: `2px ${swatch.dotted ? 'dotted' : swatch.dashed ? 'dashed' : 'solid'} ${swatch.color}` }} />}
      {children}
    </button>
  );
}

const CLASS_CHIPS: { kind: GNodeKind; label: string }[] = [
  { kind: 'person', label: 'People' },
  { kind: 'org', label: 'Organizations' },
  { kind: 'service', label: 'Services' },
];

function FilterPanel({
  rawView, isPerson, depth, setDepth, direction, setDirection,
  hiddenNodeKinds, setHiddenNodeKinds, hiddenSubKinds, setHiddenSubKinds, hiddenEdgeKinds, setHiddenEdgeKinds,
}: {
  rawView: GView; isPerson: boolean;
  depth: number; setDepth: (n: number) => void;
  direction: LayoutDirection; setDirection: (d: LayoutDirection) => void;
  hiddenNodeKinds: ReadonlySet<GNodeKind>; setHiddenNodeKinds: (s: ReadonlySet<GNodeKind>) => void;
  hiddenSubKinds: ReadonlySet<string>; setHiddenSubKinds: (s: ReadonlySet<string>) => void;
  hiddenEdgeKinds: ReadonlySet<EdgeKind>; setHiddenEdgeKinds: (s: ReadonlySet<EdgeKind>) => void;
}) {
  const [open, setOpen] = useState(true);
  // Only the agent types and relationships actually on the view get a chip — the subtypes that appear, and the
  // relationships that are drawn (so the panel is a true legend for THIS graph, not a fixed catalogue).
  const subKinds = useMemo(() => presentSubKinds(rawView).filter((s) => !CLASS_CHIPS.some((c) => c.label.toLowerCase().startsWith(s))), [rawView]);
  const edgeKinds = useMemo(() => presentEdgeKinds(rawView), [rawView]);
  const classesPresent = useMemo(() => new Set(rawView.nodes.map((n) => n.data.kind)), [rawView]);

  return (
    <div className="tg-legend tg-filters">
      <button type="button" className="tg-filters-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="tg-eyebrow" style={{ margin: 0 }}>Filters &amp; legend</span>
        <span style={{ opacity: 0.6, fontSize: '.8rem' }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="tg-filters-body">
          {isPerson && (
            <div className="tg-filter-row">
              <span className="tg-filter-label">Depth</span>
              <div className="tg-seg">
                {[1, 2, 3, 4].map((d) => (
                  <button key={d} type="button" className={`tg-seg-btn ${depth === d ? 'on' : ''}`} onClick={() => setDepth(d)}>{d}</button>
                ))}
              </div>
            </div>
          )}
          <div className="tg-filter-row">
            <span className="tg-filter-label">Layout</span>
            <div className="tg-seg">
              <button type="button" className={`tg-seg-btn ${direction === 'DOWN' ? 'on' : ''}`} onClick={() => setDirection('DOWN')} title="Levels stack top to bottom">↓ Levels</button>
              <button type="button" className={`tg-seg-btn ${direction === 'RIGHT' ? 'on' : ''}`} onClick={() => setDirection('RIGHT')} title="Levels flow left to right">→ Across</button>
            </div>
          </div>

          <div className="tg-eyebrow" style={{ marginTop: '.5rem' }}>Agent types</div>
          <div className="tg-chips">
            {CLASS_CHIPS.filter((c) => classesPresent.has(c.kind)).map((c) => (
              <Chip key={c.kind} on={!hiddenNodeKinds.has(c.kind)} onClick={() => setHiddenNodeKinds(toggleIn(hiddenNodeKinds, c.kind))}>{c.label}</Chip>
            ))}
          </div>
          {subKinds.length > 0 && (
            <div className="tg-chips" style={{ marginTop: '.35rem' }}>
              {subKinds.map((s) => (
                <Chip key={s} on={!hiddenSubKinds.has(s)} onClick={() => setHiddenSubKinds(toggleIn(hiddenSubKinds, s))}>{s}</Chip>
              ))}
            </div>
          )}

          <div className="tg-eyebrow" style={{ marginTop: '.6rem' }}>Relationships</div>
          <div className="tg-chips">
            {edgeKinds.map((k) => {
              const st = EDGE_KIND_STYLE[k];
              return (
                <Chip key={k} on={!hiddenEdgeKinds.has(k)} onClick={() => setHiddenEdgeKinds(toggleIn(hiddenEdgeKinds, k))} swatch={{ color: st.color, dashed: st.dashed, dotted: st.dotted }}>{st.label.replace(/ \(.*\)$/, '')}</Chip>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Inspector — LIVE nodes only (custodian / your person SA / an org you hold) ─
function Inspector({ meta, agentName, centerHref, onClose, expandable, isExpanded, expanding, expandedCount, onToggleExpand }: { meta: NodeData | null; agentName: string; centerHref?: string | null; onClose: () => void; expandable?: boolean; isExpanded?: boolean; expanding?: boolean; expandedCount?: number; onToggleExpand?: () => void }) {
  if (!meta) return null;
  return (
    <div className="tg-inspector">
      <div style={{ padding: '.9rem 1rem', borderBottom: '1px solid var(--color-border)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '.6rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', minWidth: 0 }}>
            <Glyph kind={meta.kind} name={meta.name} />
            <div style={{ minWidth: 0 }}>
              <strong style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{meta.name}</strong>
              <div style={{ fontSize: '.74rem', color: 'var(--color-text-faint)' }}>{meta.sub}</div>
            </div>
          </div>
          <button type="button" className="btn-ghost" style={{ width: 'auto', padding: '.15rem .5rem', fontSize: '.8rem' }} onClick={onClose}>✕</button>
        </div>
      </div>
      <div style={{ padding: '.9rem 1rem', display: 'flex', flexDirection: 'column', gap: '.8rem' }}>
        {expandable && onToggleExpand && (
          <button type="button" className="btn-ghost" style={{ width: 'auto', alignSelf: 'flex-start', fontSize: '.82rem' }} onClick={onToggleExpand} disabled={expanding} data-testid="trust-graph-expand">
            {expanding ? 'Reading its agents…' : isExpanded ? `Collapse${expandedCount ? ` (${expandedCount})` : ''}` : 'Expand — show its agents here'}
          </button>
        )}
        {centerHref && <a className="btn-primary" href={centerHref} style={{ width: 'auto', display: 'inline-block', fontSize: '.82rem' }} data-testid="trust-graph-center-here">Centre the graph on {meta.name} →</a>}
        <InspectorBody meta={meta} agentName={agentName} />
      </div>
    </div>
  );
}

function InspectorBody({ meta, agentName }: { meta: NodeData; agentName: string }) {
  // The connected human custodian (synthetic node — not an on-chain agent).
  if (meta.refId === CUSTODIAN_ID) {
    return (
      <>
        <Pill>control · custody</Pill>
        <p style={{ margin: 0, fontSize: '.84rem', color: 'var(--color-text-muted)' }}>
          This is <strong>you</strong> — the human who holds the keys to your person agent
          (<code className="tg-mono">{agentName}</code>).
        </p>
        <p style={{ margin: 0, fontSize: '.8rem', color: 'var(--color-text-faint)' }}>
          Custody is a <strong>control</strong> relationship, not authority. It is the only link
          that crosses from a person to an agent. Everything else in this graph is
          <strong> authority between smart agents</strong> — stewardship, membership, delegations —
          which is where trust is actually built.
        </p>
      </>
    );
  }
  // An org agent the person stewards (or belongs to, spec 318 member relationships).
  if (meta.kind === 'org') {
    const member = meta.sub.includes('member');
    return (
      <>
        <Pill>{NODE_KIND_LABEL.org}</Pill>
        <p style={{ margin: 0, fontSize: '.84rem', color: 'var(--color-text-muted)' }}>
          <strong>{meta.name}</strong> — an organization you{' '}
          <strong>{member ? 'belong to' : 'steward'}</strong>.{' '}
          {member
            ? 'A membership grant: authority-only visibility (channels, switcher), never custodial control.'
            : 'You hold its stewardship grant: the authority to act as its custodian.'}
        </p>
        <code className="tg-mono" style={{ color: 'var(--color-text-faint)' }}>{meta.refId}</code>
      </>
    );
  }
  // The person SA itself — the root of the member's agent tree.
  return (
    <>
      <Pill>your person agent</Pill>
      <p style={{ margin: 0, fontSize: '.84rem', color: 'var(--color-text-muted)' }}>
        <strong>{meta.name}</strong> — the smart agent your custodian controls. Authority to your
        organizations flows from here as <strong>stewardship</strong> (agent → agent).
      </p>
      <code className="tg-mono" style={{ color: 'var(--color-text-faint)' }}>{meta.refId}</code>
    </>
  );
}

// ── Scoped styles — impact's tg-* rules remapped to this app's design tokens ──
const TG_CSS = `
.trustgraph {
  width: 100%; height: 100%;
  background: radial-gradient(800px 500px at 30% 0%, var(--color-surface-raised) 0%, transparent 60%), var(--color-surface-sunken);
}
.trustgraph .react-flow__attribution { display: none; }
.trustgraph .react-flow__handle { opacity: 0; }
.tg-node {
  border-radius: var(--radius-16); border: 1.5px solid var(--color-border-strong);
  background: var(--color-surface); box-shadow: 0 2px 8px rgba(28, 25, 23, .06);
  padding: .7rem .85rem; width: 188px;
  transition: box-shadow .15s ease, transform .12s ease, border-color .15s ease, opacity .15s ease;
}
.tg-node:hover { box-shadow: 0 6px 18px rgba(28, 25, 23, .1); transform: translateY(-1px); }
.tg-node.sel { border-color: var(--color-amber-500); box-shadow: 0 0 0 3px var(--color-amber-100), 0 6px 18px rgba(28, 25, 23, .1); }
.tg-node.dim { opacity: .45; }
.tg-node.kind-person { border-top: 4px solid var(--color-amber-500); }
.tg-node.kind-org { border-top: 4px solid var(--color-sage-500); }
.tg-node.kind-service { border-top: 4px solid #8b5cf6; }
/* the overflow node — "+N more": dashed, quiet, a door rather than an agent */
.tg-node.kind-more { border: 1.5px dashed var(--color-border-strong); background: var(--color-surface-raised); width: 150px; cursor: pointer; }
.tg-node.kind-cluster { border: 1.5px dashed var(--color-sage-500, #5b8c6e); background: var(--color-sage-100); width: 150px; cursor: pointer; }
/* the custodian (human) node — dashed, muted, off the agent plane */
.tg-node.kind-custodian {
  border: 1.5px dashed var(--color-border-strong);
  background: repeating-linear-gradient(45deg, var(--color-surface-raised), var(--color-surface-raised) 8px, var(--color-surface-sunken) 8px, var(--color-surface-sunken) 16px);
  width: 168px;
}
.tg-glyph {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 26px; height: 26px; border-radius: 50%;
  font-size: .72rem; font-weight: 800; color: var(--color-text-body);
  border: 1px solid var(--color-border);
}
.tg-pill {
  display: inline-block; width: fit-content;
  padding: .12rem .55rem; border-radius: 999px;
  background: var(--color-surface-sunken); border: 1px solid var(--color-border);
  font-size: .7rem; font-weight: 700; color: var(--color-text-muted);
}
.tg-eyebrow {
  font-size: .66rem; font-weight: 800; text-transform: uppercase; letter-spacing: .07em;
  color: var(--color-text-muted); margin-bottom: .4rem;
}
.tg-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .7rem; word-break: break-all; }
.tg-legend {
  position: absolute; bottom: 14px; left: 14px; z-index: 5;
  background: color-mix(in srgb, var(--color-surface) 92%, transparent);
  border: 1px solid var(--color-border); border-radius: var(--radius-8);
  padding: .7rem .85rem; box-shadow: 0 2px 8px rgba(28, 25, 23, .06);
  backdrop-filter: blur(6px);
}
.tg-filters { width: 232px; max-width: calc(100% - 28px); max-height: calc(100% - 28px); overflow-y: auto; padding: .55rem .7rem; }
.tg-filters-head { display: flex; align-items: center; justify-content: space-between; width: 100%; background: none; border: 0; padding: 0; cursor: pointer; color: inherit; }
.tg-filters-body { margin-top: .5rem; }
.tg-filter-row { display: flex; align-items: center; justify-content: space-between; gap: .5rem; margin-bottom: .4rem; }
.tg-filter-label { font-size: .72rem; font-weight: 700; color: var(--color-text-muted); }
.tg-seg { display: inline-flex; border: 1px solid var(--color-border); border-radius: 999px; overflow: hidden; }
.tg-seg-btn { background: var(--color-surface); border: 0; padding: .2rem .5rem; font-size: .72rem; font-weight: 700; color: var(--color-text-muted); cursor: pointer; }
.tg-seg-btn + .tg-seg-btn { border-left: 1px solid var(--color-border); }
.tg-seg-btn.on { background: var(--color-amber-500); color: #fff; }
.tg-chips { display: flex; flex-wrap: wrap; gap: .3rem; }
.tg-chip { display: inline-flex; align-items: center; gap: .32rem; padding: .18rem .5rem; border-radius: 999px; border: 1px solid var(--color-border); background: var(--color-surface); font-size: .72rem; font-weight: 600; color: var(--color-text-body); cursor: pointer; text-transform: capitalize; }
.tg-chip:hover { border-color: var(--color-border-strong); }
.tg-chip.off { opacity: .4; text-decoration: line-through; }
.tg-chip-swatch { width: 14px; height: 0; flex: none; }
.tg-inspector {
  position: absolute; top: 14px; right: 14px; z-index: 6;
  width: 320px; max-width: calc(100% - 28px); max-height: calc(100% - 28px); overflow-y: auto;
  background: var(--color-surface); border: 1px solid var(--color-border);
  border-radius: var(--radius-12); box-shadow: 0 10px 30px rgba(28, 25, 23, .14);
}
`;
