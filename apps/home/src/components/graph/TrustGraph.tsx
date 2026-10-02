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
import { useEffect, useMemo, useState } from 'react';
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
  CUSTODIAN_ID as CUSTODIAN,
  MORE_ID,
  type CenteredItem,
  CUSTODIAN_ID,
  EDGE_KIND_STYLE,
  NODE_KIND_LABEL,
  type GNodeKind,
  type LivePerson,
} from '../../lib/graph';

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

/** The two relationship classes, kept visually distinct (mirrors the legend split). */
export function ClassExplainer() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '.8rem', marginBottom: '1rem' }}>
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
}

/** The graph canvas card — React Flow needs a fixed-height positioned parent. */
export function GraphCard({ live, focusAgent }: { live: LivePerson; focusAgent?: string }) {
  return (
    <div className="manage-card" style={{ height: 'min(72vh, 720px)', overflow: 'hidden', padding: 0 }}>
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
};

function Glyph({ kind, name }: { kind: GNodeKind; name: string }) {
  return (
    <span className="tg-glyph" style={{ background: GLYPH_BG[kind] }} aria-hidden>
      {kind === 'more' ? '…' : (name[0] ?? '?').toUpperCase()}
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
function useCenteredGraph(live: LivePerson, center: string, showAll: boolean): { g: ReturnType<typeof buildCenteredGraph>; reading: boolean; note: string | null } {
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
      return buildCenteredGraph({ center: { id: self?.agent ?? center, kind: 'person', name: self?.name || center.slice(0, 10), sub: `${self?.kindWord ?? 'person'} · another name of yours` }, above: [{ ...custodian, dim: false }, sibling], ring: [...fetched.ring, ...held], showAll });
    }
    // An organization-class or service agent: its stewards above (You among them when the roster names you), its
    // members and what it holds around it. The tree's own row, when it says you steward or belong, stays as a faded holder.
    const me = live.personSA.toLowerCase();
    const above: CenteredItem[] = fetched.stewards.map((st) => (st.id.toLowerCase() === me ? { ...st, name: `${live.name} (you)`, dim: true } : { ...st, dim: true }));
    if (self && !above.some((a) => a.id.toLowerCase() === me)) above.push({ id: live.personSA, kind: 'person', name: `${live.name} (you)`, sub: live.agentName, dim: true, edge: self.relationship === 'member' ? { kind: 'membership', label: 'member of', weight: 0.5, toCenter: true } : { kind: 'stewardship', label: 'stewards', weight: 0.8, toCenter: true } });
    const word = self?.kindWord ?? (self?.cls === 'service' ? 'service' : 'organization');
    return buildCenteredGraph({ center: { id: self?.agent ?? center, kind: self?.cls ?? 'org', name: self?.name || center.slice(0, 10), sub: word }, above, ring: [...fetched.ring, ...held], showAll });
  }, [live, center, showAll, fetched, isPerson, isPersona, self]);
  return { g, reading, note };
}

export default function TrustGraph({ live, focusAgent }: { live: LivePerson; focusAgent?: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  // THE CENTRE is the agent this page is about (the persona, organization or service in the route), or the person
  // herself at her own home. A long ring ends in "+N more" until it is clicked.
  const center = (focusAgent ?? live.personSA).toLowerCase();
  const [showAll, setShowAll] = useState(false);
  const { g, reading, note } = useCenteredGraph(live, center, showAll);
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

  const nodes: Node<NodeData>[] = g.nodes.map((n) => ({
    id: n.id,
    type: 'trust',
    position: n.position,
    data: n.data,
    selected: n.id === selected,
  }));

  const edges: Edge[] = g.edges.map((e) => {
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
        key={`${center}:${showAll ? 'all' : 'ring'}`}
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

      <Legend />
      {(reading || note) && (
        <div className="tg-pill" style={{ position: 'absolute', top: 10, left: 10, zIndex: 5 }} data-testid="trust-graph-status">{reading ? 'Reading its records…' : note}</div>
      )}
      {selected && (
        <Inspector
          meta={g.nodes.find((n) => n.id === selected)?.data ?? null}
          agentName={live.agentName}
          centerHref={(() => { const m = g.nodes.find((n) => n.id === selected)?.data; return m ? centerHref(m) : null; })()}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

// ── Legend — derives straight from EDGE_KIND_STYLE so it never drifts ─────────
function LegendRow({ color, dashed, dotted, label, faint }: { color: string; dashed?: boolean; dotted?: boolean; label: string; faint?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', fontSize: '.74rem' }}>
      <span style={{ width: 22, height: 0, borderTop: `2px ${dotted ? 'dotted' : dashed ? 'dashed' : 'solid'} ${color}` }} />
      <span style={{ color: faint ? 'var(--color-text-faint)' : 'var(--color-text-muted)' }}>{label}</span>
    </div>
  );
}

function Legend() {
  const entries = Object.values(EDGE_KIND_STYLE);
  const control = entries.filter((s) => s.cls === 'control');
  const authority = entries.filter((s) => s.cls === 'authority');
  return (
    <div className="tg-legend">
      <div className="tg-eyebrow" style={{ color: 'var(--color-text-faint)' }}>Control · custody</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '.3rem', marginBottom: '.6rem' }}>
        {control.map((st) => (
          <LegendRow key={st.label} color={st.color} dashed={st.dashed} dotted={st.dotted} label={st.label} faint />
        ))}
      </div>
      <div className="tg-eyebrow">Authority &amp; trust · agent → agent</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '.3rem' }}>
        {authority.map((st) => (
          <LegendRow key={st.label} color={st.color} dashed={st.dashed} label={st.label} />
        ))}
      </div>
    </div>
  );
}

// ── Inspector — LIVE nodes only (custodian / your person SA / an org you hold) ─
function Inspector({ meta, agentName, centerHref, onClose }: { meta: NodeData | null; agentName: string; centerHref?: string | null; onClose: () => void }) {
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
.tg-inspector {
  position: absolute; top: 14px; right: 14px; z-index: 6;
  width: 320px; max-width: calc(100% - 28px); max-height: calc(100% - 28px); overflow-y: auto;
  background: var(--color-surface); border: 1px solid var(--color-border);
  border-radius: var(--radius-12); box-shadow: 0 10px 30px rgba(28, 25, 23, .14);
}
`;
