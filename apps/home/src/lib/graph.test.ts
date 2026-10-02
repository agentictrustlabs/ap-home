// The trust graph centred on an agent (owner, 2026-10-01): the centre in the middle, its own agents around it, who
// holds it small and above, and a "+N more" node when the ring is long.
import { describe, it, expect } from 'vitest';
import { buildAgentGraphLive, buildCenteredGraph, CUSTODIAN_ID, MORE_ID, EDGE_CLASS, EDGE_KIND_STYLE, type LivePerson } from './graph';

const ALICE = '0xa000000000000000000000000000000000000001';
const GRACE = '0xa000000000000000000000000000000000000002';
const live: LivePerson = {
  name: 'alice', agentName: 'alice.me', personSA: ALICE,
  agents: [
    { agent: GRACE, name: 'grace-alice', cls: 'person', kindWord: 'person', relationship: 'self', parent: ALICE },
    { agent: '0xb000000000000000000000000000000000000001', name: 'grace-treasury', cls: 'service', kindWord: 'treasury', relationship: 'steward', parent: GRACE },
    { agent: '0xb000000000000000000000000000000000000002', name: 'grace-circle', cls: 'org', kindWord: 'circle', relationship: 'steward', parent: GRACE },
    ...Array.from({ length: 20 }, (_, i) => ({ agent: `0xc0000000000000000000000000000000000000${String(i).padStart(2, '0')}`, name: `org-${String(i).padStart(2, '0')}`, cls: 'org' as const, relationship: (i % 3 ? 'steward' : 'member') as 'steward' | 'member', parent: ALICE })),
  ],
};

describe('the graph centred on an agent', () => {
  it('centres the persona: it is the focus, its own two agents ring it, alice and the custodian are a faded chain above', () => {
    const g = buildAgentGraphLive(live, { center: GRACE });
    const center = g.nodes.find((n) => n.data.focus)!;
    expect(center.id).toBe(GRACE);
    expect(center.position).toEqual({ x: 0, y: 0 });
    const ring = g.nodes.filter((n) => !n.data.focus && n.id !== CUSTODIAN_ID && n.id !== ALICE);
    expect(ring.map((n) => n.data.name).sort()).toEqual(['grace-circle', 'grace-treasury']);
    const alice = g.nodes.find((n) => n.id === ALICE)!;
    expect(alice.data.dim).toBe(true);
    expect(alice.position.y).toBeLessThan(0);
    expect(g.edges.find((e) => e.source === ALICE && e.target === GRACE)).toMatchObject({ kind: 'control', label: 'same custodian', dim: true });
    expect(g.nodes.some((n) => n.data.name === 'org-01')).toBe(false);
  });
  it('centres the person: the custodian above, every direct agent in the ring, stewards before members; a long ring ends in +N more', () => {
    const g = buildAgentGraphLive(live, { center: ALICE });
    expect(g.nodes.find((n) => n.data.focus)!.id).toBe(ALICE);
    expect(g.nodes.find((n) => n.id === CUSTODIAN_ID)!.position.y).toBeLessThan(0);
    const more = g.nodes.find((n) => n.id === MORE_ID)!;
    expect(more.data.kind).toBe('more');
    expect(more.data.name).toBe('+10 more'); // 21 direct agents, 11 drawn + the door
    const drawn = g.nodes.filter((n) => n.id !== ALICE && n.id !== CUSTODIAN_ID && n.id !== MORE_ID);
    expect(drawn).toHaveLength(11);
    expect(drawn.every((n) => !n.data.sub.includes('member'))).toBe(true); // stewards fill the ring first
    expect(g.nodes.some((n) => n.data.name === 'grace-treasury')).toBe(false); // grace's own agents are hers, not alice's ring
  });
  it('show all removes the door and draws the whole ring', () => {
    const g = buildAgentGraphLive(live, { center: ALICE, showAll: true });
    expect(g.nodes.some((n) => n.id === MORE_ID)).toBe(false);
    expect(g.nodes.filter((n) => n.id !== ALICE && n.id !== CUSTODIAN_ID)).toHaveLength(21);
  });

  it('a roster-built organization: its stewards above with arrows INTO it, members and what it holds around it', () => {
    const TEAM = '0xd000000000000000000000000000000000000001';
    const g = buildCenteredGraph({
      center: { id: TEAM, kind: 'org', name: 'Weld Corridor Team', sub: 'team' },
      above: [{ id: '0xd000000000000000000000000000000000000009', kind: 'person', name: 'jenna-alice', sub: 'steward', dim: true, edge: { kind: 'stewardship', label: 'stewards', toCenter: true } }],
      ring: [
        { id: '0xd000000000000000000000000000000000000002', kind: 'person', name: 'mark-bob', sub: 'member', edge: { kind: 'membership', label: 'member of', toCenter: true } },
        { id: '0xd000000000000000000000000000000000000003', kind: 'org', name: 'Circle 2', sub: 'circle', edge: { kind: 'stewardship', label: 'holds' } },
      ],
    });
    expect(g.nodes.find((n) => n.data.focus)!.id).toBe(TEAM);
    const stew = g.edges.find((e) => e.label === 'stewards')!;
    expect([stew.source, stew.target]).toEqual(['0xd000000000000000000000000000000000000009', TEAM]);
    const mem = g.edges.find((e) => e.label === 'member of')!;
    expect([mem.source, mem.target]).toEqual(['0xd000000000000000000000000000000000000002', TEAM]);
    const holds = g.edges.find((e) => e.label === 'holds')!;
    expect([holds.source, holds.target]).toEqual([TEAM, '0xd000000000000000000000000000000000000003']);
    expect(g.nodes.find((n) => n.data.name === 'jenna-alice')!.position.y).toBeLessThan(0);
    expect(g.nodes.some((n) => n.id === MORE_ID)).toBe(false);
  });
});

// A GOVERNED WORKSPACE (the owner's rule, 2026-10-02): the organization that governs a workspace is drawn with a
// `governs` edge org → workspace, and the workspace says "governed by …" under its name. The port adapts the
// apps/home test (which targeted the pre-refactor flat `buildPersonGraphLive`) to this app's centred graph: the
// workspace sits in the governor's ring, so the pairing is asserted on the organization-centred view.
describe('a governed workspace (the owner’s rule, 2026-10-02)', () => {
  const ORG = '0xd000000000000000000000000000000000000aa1';
  const WS = '0xd000000000000000000000000000000000000bb2';
  const governed: LivePerson = {
    name: 'alice', agentName: 'alice.me', personSA: ALICE,
    agents: [
      { agent: ORG, name: 'Northern Colorado Field (organization)', cls: 'org', kindWord: 'organization', relationship: 'member', parent: ALICE },
      { agent: WS, name: 'Northern Colorado Field', cls: 'service', kindWord: 'workspace', relationship: 'member', parent: ORG, governedBy: ORG },
    ],
  };
  it('draws the governs edge org → workspace and says "governed by" under the workspace, centred on the organization', () => {
    const g = buildAgentGraphLive(governed, { center: ORG });
    expect(g.edges.find((e) => e.kind === 'governance')).toMatchObject({ source: ORG, target: WS, label: 'governs' });
    expect(g.nodes.find((n) => n.id === WS)!.data.sub).toContain('governed by Northern Colorado Field (organization)');
  });
  it('governance is an authority-class edge with its own legend entry', () => {
    expect(EDGE_CLASS.governance).toBe('authority');
    expect(EDGE_KIND_STYLE.governance.label).toContain('Governs');
  });
  it('a workspace with no governor draws no governance edge', () => {
    const legacy: LivePerson = { name: 'alice', agentName: 'alice.me', personSA: ALICE, agents: [{ agent: WS, name: 'Legacy', cls: 'service', kindWord: 'workspace', relationship: 'steward', parent: ALICE }] };
    const g = buildAgentGraphLive(legacy, { center: ALICE });
    expect(g.edges.some((e) => e.kind === 'governance')).toBe(false);
  });
});
