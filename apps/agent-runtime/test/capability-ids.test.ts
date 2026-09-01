/**
 * A capability id is the SAME string everywhere, or it is not an id.
 *
 * `atl:capabilities` holds ids; the A2A card advertises them as `skills[].id`; ARD lists them as
 * `capabilities[]`. Observed live before this fix: `registry.search` was written on chain and the card
 * advertised `registry-search`, because the mapper still slugified — correct when the chain held human
 * LABELS (`treasury management`), corrupting now that it holds ids. A matcher looking up the on-chain id
 * would not have found the card's.
 */
import { describe, it, expect } from 'vitest';
import { skillsFromLabels } from '../src/host-context';

describe('skillsFromLabels', () => {
  it('uses an id-shaped value VERBATIM — dots and colons survive', () => {
    expect(skillsFromLabels('registry.search,registry.explore').map((s) => s.id))
      .toEqual(['registry.search', 'registry.explore']);
    expect(skillsFromLabels('ap:cap:translate').map((s) => s.id)).toEqual(['ap:cap:translate']);
  });

  it('still slugifies a legacy human label, and keeps it whole as the name', () => {
    const [s] = skillsFromLabels('Treasury Management');
    expect(s).toMatchObject({ id: 'treasury-management', name: 'Treasury Management' });
  });

  it('decides on SHAPE, not on which predicate it came from', () => {
    // A legacy `atl:skills` agent that happened to store ids keeps them.
    expect(skillsFromLabels('vault.read').map((s) => s.id)).toEqual(['vault.read']);
  });

  it('tags the entry as a capability, which is what it is', () => {
    expect(skillsFromLabels('a.b')[0]!.tags).toEqual(['capability']);
  });

  it('is empty for empty input', () => {
    expect(skillsFromLabels('')).toEqual([]);
    expect(skillsFromLabels(null)).toEqual([]);
  });
});
