// The trust graph centred on an agent (owner, 2026-10-01): the centre in the middle, its own agents around it, who
// holds it small and above, and a "+N more" node when the ring is long.
import { describe, it, expect } from 'vitest';
import { buildAgentGraphLive, CUSTODIAN_ID, MORE_ID, type LivePerson } from './graph';

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
});
