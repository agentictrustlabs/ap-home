// AUTO-LAYOUT FOR THE TRUST GRAPH (owner, 2026-10-02: "not a very good diagram tool … this view is really
// important … it can be very busy").
//
// The graph used to hand-place its one ring with trigonometry, which overlapped nodes and their labels as soon
// as the ring got long and could not lay out a second or third level at all. ELK (the Eclipse Layout Kernel,
// pure JS via `elkjs`) does real layered layout: levels stack, edges route around nodes, nothing collides, and
// an arbitrary depth lays out for free. We keep React Flow — it renders the custom nodes, the inspector and the
// "centre here" navigation; only the POSITIONS move here. Pure data in, positioned data out; nothing here reads
// authority or records.
import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { GView } from './graph';

const elk = new ELK();

/** The on-screen size of a `TrustNode` (the card the renderer draws), so ELK reserves the right room. */
const NODE_W = 196;
const NODE_H = 58;

export type LayoutDirection = 'DOWN' | 'RIGHT';
/** The layout the panel offers: `across` is the fixed class arrangement below (the default); `down`/`right` are
 *  ELK's layered layouts. */
export type GraphLayout = 'across' | 'down' | 'right';

/**
 * The "ACROSS" layout (owner, 2026-10-03): the SELECTED/centre agent in the MIDDLE, PEOPLE in a column to its
 * LEFT, ORGANIZATIONS in a column to its RIGHT, SERVICES in a column BELOW — every group ordered vertically. A
 * fixed, legible arrangement by agent class (people ↔ orgs across the person, services beneath), not a force or
 * layered graph. Pure data in, positioned data out; synchronous (no ELK). Reads only node kind + id.
 */
export function layoutAcross(view: GView, centerId: string | null): GView {
  if (view.nodes.length === 0) return view;
  const GAP = NODE_H + 30;   // vertical spacing within a column
  const COL = 340;           // left/right column offset from the centre
  const BELOW = 150;         // where the services column starts, below the centre
  const centre = centerId ? view.nodes.find((n) => n.id === centerId) : null;
  const rest = view.nodes.filter((n) => n.id !== centre?.id);
  const of = (k: string) => rest.filter((n) => n.data.kind === k);
  const people = of('person');
  const orgs = of('org');
  // services + any other kind (treasuries, teams surfaced as their own node) share the column below the centre
  const below = [...of('service'), ...rest.filter((n) => !['person', 'org', 'service'].includes(n.data.kind))];
  const colY = (i: number, n: number) => (i - (n - 1) / 2) * GAP; // a vertical column, centred on y = 0
  const place = new Map<string, { x: number; y: number }>();
  people.forEach((n, i) => place.set(n.id, { x: -COL, y: colY(i, people.length) }));
  orgs.forEach((n, i) => place.set(n.id, { x: COL, y: colY(i, orgs.length) }));
  below.forEach((n, i) => place.set(n.id, { x: 0, y: BELOW + i * GAP }));
  if (centre) place.set(centre.id, { x: 0, y: 0 });
  return { nodes: view.nodes.map((n) => ({ ...n, position: place.get(n.id) ?? n.position })), edges: view.edges };
}

/**
 * Lay the view out with ELK's layered algorithm and return a NEW view whose nodes carry real positions. The
 * input node order and ids are preserved; only `position` changes. `direction` is DOWN (levels stack top → down,
 * the custodian/person above their agents) or RIGHT (levels flow left → right, better when a level is very wide).
 */
export async function layoutElk(view: GView, opts: { direction?: LayoutDirection } = {}): Promise<GView> {
  if (view.nodes.length === 0) return view;
  const direction = opts.direction ?? 'DOWN';
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      // Room between siblings in a layer and between layers — generous, because the labels sit ON the edges.
      'elk.layered.spacing.nodeNodeBetweenLayers': '110',
      'elk.spacing.nodeNode': '48',
      'elk.layered.spacing.edgeNodeBetweenLayers': '36',
      // Straighter edges and fewer crossings on a busy graph.
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.mergeEdges': 'true',
      'elk.edgeRouting': 'ORTHOGONAL',
    },
    children: view.nodes.map((n) => ({ id: n.id, width: NODE_W, height: NODE_H })),
    edges: view.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };
  let laid: ElkNode;
  try {
    laid = await elk.layout(graph);
  } catch {
    // ELK failed (never seen, but a layout must not blank the view): keep the view's own positions.
    return view;
  }
  const pos = new Map<string, { x: number; y: number }>();
  for (const c of laid.children ?? []) if (typeof c.x === 'number' && typeof c.y === 'number') pos.set(c.id, { x: c.x, y: c.y });
  return {
    nodes: view.nodes.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position })),
    edges: view.edges,
  };
}
