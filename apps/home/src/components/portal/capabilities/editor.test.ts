/**
 * An agent may not invent a capability id.
 *
 * The old editor slugged free text into an id, so "Treasury Management", "treasury management" and
 * "Treasury mgmt" were three ids for one ability and no matcher could reconcile them. The picker offers
 * catalog definitions and nothing else — there is deliberately no field for typing an id.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCapabilityDefinition, isKnownCapabilityId, listCapabilityDefinitions } from '@agenticprimitives/capability-claims';

const SRC = readFileSync(join(__dirname, 'AgentCapabilitiesEditor.tsx'), 'utf8');

describe('the editor offers the catalog and nothing else', () => {
  it('adds only from a CatalogCapabilityDefinition', () => {
    // `add` takes a definition, not a string — the type is the gate.
    expect(SRC).toMatch(/const add = useCallback\(\(d: CatalogCapabilityDefinition\)/);
  });

  it('has no free-text id input', () => {
    // A placeholder inviting a label is exactly what produced divergent ids.
    expect(SRC).not.toMatch(/placeholder=["'`][^"'`]*e\.g\./i);
    expect(SRC).toContain('there is deliberately no way to invent one here');
  });

  it('shows a published id the catalog does not define, rather than dropping it', () => {
    // It is live on chain; hiding it would leave the agent advertising something its owner cannot see.
    expect(SRC).toContain('not in catalog');
    expect(SRC).toMatch(/\{!def &&/);
  });

  it('defaults an entry to the definition’s own words', () => {
    expect(SRC).toContain('description: d.description');
    expect(SRC).toContain('capabilityId: d.id');
  });
});

describe('the catalog backs the picker', () => {
  it('every substrate id a live card advertises is selectable', () => {
    for (const id of ['messaging.deliver', 'interactions.respond', 'org.apply', 'interactions.deliverCredential']) {
      expect(isKnownCapabilityId(id)).toBe(true);
    }
  });

  it('search reaches the advisory rows', () => {
    expect(listCapabilityDefinitions({ query: 'tax residency' }).map((d) => d.id))
      .toContain('adv:tax-residency-and-domicile-analysis');
  });

  it('an unknown id is null, which is what the "not in catalog" badge renders from', () => {
    expect(getCapabilityDefinition('treasury-management')).toBeNull();
  });
});
