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
