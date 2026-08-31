/**
 * The three navs ask the same discovery questions.
 *
 * A person, an organization and a service agent are all Smart Agents (ADR-0046), and "is this registered /
 * what is it named / what can it do / who trusts it / is the substrate up" does not change with the class.
 * The navs disagreed anyway: only the person had a Discovery band at all, and the org kept Trust graph in
 * Manage — so the same question lived in a different place depending on which workspace you were in.
 *
 * This pins the shape, not the wording: if a future band gains an item for one class it must gain it for
 * all three, or this fails and the disagreement has to be a decision rather than an accident.
 */
import { describe, it, expect } from 'vitest';
import { buildNav } from './nav';
import { whitelabel } from '../../whitelabel/config';

const ORG = '0xe26157068af46629691e2ab19726bf61476e6b6c';
const SVC = '0x3d653cbab0c99b1513439758eb2eac2039caa6e1';

const discoveryOf = (groups: ReturnType<typeof buildNav>): string[] =>
  groups.find((g) => g.heading === 'Discovery')?.items.map((i) => i.label) ?? [];

const EXPECTED = ['Registry', 'Naming', 'Capabilities', 'Trust graph', 'Network'];

describe('every workspace asks the same discovery questions', () => {
  it('the person has the Discovery band', () => {
    expect(discoveryOf(buildNav(whitelabel))).toEqual(EXPECTED);
  });

  it('an organization has the SAME band, in the same order', () => {
    expect(discoveryOf(buildNav(whitelabel, {}, { kind: 'org', org: ORG }))).toEqual(EXPECTED);
  });

  it('a service agent has the SAME band, in the same order', () => {
    expect(discoveryOf(buildNav(whitelabel, {}, { kind: 'service', agent: SVC }))).toEqual(EXPECTED);
  });

  it('Trust graph is a discovery question everywhere — never back in org Manage', () => {
    const org = buildNav(whitelabel, {}, { kind: 'org', org: ORG });
    const manage = org.find((g) => g.heading === 'Manage')?.items.map((i) => i.label) ?? [];
    expect(manage).not.toContain('Trust graph');
  });

  it('org and service both reach the shared Manage surfaces a person has', () => {
    for (const scope of [{ kind: 'org', org: ORG } as const, { kind: 'service', agent: SVC } as const]) {
      const manage = buildNav(whitelabel, {}, scope).find((g) => g.heading === 'Manage')?.items.map((i) => i.label) ?? [];
      expect(manage).toContain('Card & Projections');
      expect(manage).toContain('Metadata');
      expect(manage).toContain('Records');
    }
  });

  it('a MEMBER of an org still sees no custody surfaces — discovery is not a way in', () => {
    // spec 318: membership grants the participation surfaces only. Adding a band must not widen that.
    const member = buildNav(whitelabel, {}, { kind: 'org', org: ORG }, 'member');
    expect(discoveryOf(member)).toEqual([]);
    expect(member.some((g) => g.heading === 'Manage')).toBe(false);
  });
});
