import { describe, it, expect } from 'vitest';
import { actingBasis } from './acting-basis';

const ME = '0x2222222222222222222222222222222222222222';
const ORG = '0x1111111111111111111111111111111111111111';
const PERSONA = '0x3333333333333333333333333333333333333333';
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
  /**
   * THE BUG THIS PINS: selecting another of your names put the DEFAULT person's name back in the switcher,
   * so the switch looked as though it had been refused. The principal under a persona is the PERSONA — there
   * is no second party between a person and themselves — and the caption must name WHICH of your names is
   * about to sign, because "acting as you" is equally true of every one of them and so says nothing.
   */
  it('a persona is you under another of your names: the principal is the persona, and the caption says which', () => {
    const b = actingBasis({
      active: { kind: 'persona', agent: PERSONA },
      self: { address: ME, name: 'elena' },
      agents: [{ agent: PERSONA, kind: 'person', name: 'emile-elena.me', relationship: 'self' }],
      classOf,
    });
    expect(b.basis).toBe('self');
    expect(b.same).toBe(true);
    // Not the connected person, and not "acting as you".
    expect(b.actingAs.address).toBe(PERSONA);
    expect(b.in.address).toBe(PERSONA);
    expect(b.caption).toBe('acting as emile-elena.me');
    expect(b.caption).not.toBe('acting as you');
    // A persona is never described as stewardship: there is nobody on the other side of it.
    expect(b.words).not.toMatch(/steward/);
  });
  it('an unnamed persona still says it is another name of yours, never the default', () => {
    const b = actingBasis({ active: { kind: 'persona', agent: PERSONA }, self: { address: ME, name: 'elena' }, agents: [], classOf });
    expect(b.caption).toBe('acting as another name of yours');
    expect(b.actingAs.address).toBe(PERSONA);
  });
  it('a delegation in hand is a basis; nothing in hand is none', () => {
    expect(actingBasis({ active: { kind: 'org', org: ORG }, self: { address: ME }, agents: [], classOf, delegationInHand: true }).basis).toBe('delegation');
    expect(actingBasis({ active: { kind: 'org', org: ORG }, self: { address: ME }, agents: [], classOf }).caption).toBe('visiting · no standing');
  });
});
