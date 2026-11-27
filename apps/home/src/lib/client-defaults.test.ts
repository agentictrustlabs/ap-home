import { it, expect } from 'vitest';
import { CLIENT_DEFAULTS } from './client-defaults';

it('only the Family Field founder client starts its household on the Family Field playbook', () => {
  expect(CLIENT_DEFAULTS['family-field'].householdArchetype).toEqual({ context: 'wanderwell', archetype: 'wanderwell-household' });
  // the join client founds no household; every other client keeps the estate default
  for (const [id, d] of Object.entries(CLIENT_DEFAULTS)) if (id !== 'family-field') expect(d.householdArchetype, id).toBeUndefined();
});
