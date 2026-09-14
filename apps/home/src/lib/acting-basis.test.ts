import { describe, it, expect } from 'vitest';
import { actingBasis } from './acting-basis';

const ME = '0x2222222222222222222222222222222222222222';
const ORG = '0x1111111111111111111111111111111111111111';
const classOf = (k: string) => (k === 'org' || k === 'team' ? 'org' as const : k === 'person' ? 'person' as const : 'service' as const);

describe('acting as / in (398 §4.4)', () => {
  it('your own workspace: one agent, your credential', () => {
    const b = actingBasis({ active: { kind: 'person' }, self: { address: ME, name: 'alice' }, agents: [], classOf });
    expect(b.same).toBe(true); expect(b.basis).toBe('self'); expect(b.caption).toBe('acting as you');
  });
  it('an org you steward: stewardship; one you belong to: membership — never a role name, never custody', () => {
    const steward = actingBasis({ active: { kind: 'org', org: ORG }, self: { address: ME }, agents: [{ agent: ORG, kind: 'org', name: 'missio-nexus.org', relationship: 'steward' }], classOf });
    expect(steward.basis).toBe('stewardship'); expect(steward.in.name).toBe('missio-nexus.org'); expect(steward.caption).toBe('acting for missio-nexus.org · steward');
    const member = actingBasis({ active: { kind: 'org', org: ORG }, self: { address: ME }, agents: [{ agent: ORG, kind: 'org', relationship: 'member' }], classOf });
    expect(member.basis).toBe('membership'); expect(member.caption).toBe('member · not a steward');
    expect(member.words).not.toMatch(/researcher|steward role/);
  });
  it('a delegation in hand is a basis; nothing in hand is none', () => {
    expect(actingBasis({ active: { kind: 'org', org: ORG }, self: { address: ME }, agents: [], classOf, delegationInHand: true }).basis).toBe('delegation');
    expect(actingBasis({ active: { kind: 'org', org: ORG }, self: { address: ME }, agents: [], classOf }).caption).toBe('visiting · no standing');
  });
});
