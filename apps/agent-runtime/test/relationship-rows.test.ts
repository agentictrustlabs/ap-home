import { describe, it, expect } from 'vitest';
import { relationshipRows } from '../src/relationship-rows.js';

const ORG = '0x00000000000000000000000000000000000000c1';

describe('relationshipRows — the one place that knows the record shape', () => {
  it('reads the CANONICAL map keyed by address (the shape the Home writes)', () => {
    const rows = relationshipRows({ orgs: { [ORG]: { org: ORG, orgName: 'Calvary', relationship: 'steward', delegations: [{ wire: 1 }] } } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agent: ORG, name: 'Calvary', relationship: 'steward' });
    expect(rows[0]!.stewardshipDelegation).toEqual({ wire: 1 });
  });

  it('takes the agent from the KEY when the entry omits it', () => {
    expect(relationshipRows({ orgs: { [ORG]: { orgName: 'Calvary', relationship: 'member' } } })[0]!.agent).toBe(ORG);
  });

  it('still reads the list shapes, and a bare array', () => {
    for (const doc of [{ rows: [{ orgAgent: ORG, orgName: 'C' }] }, { orgs: [{ agent: ORG, name: 'C' }] }, [{ smartAgent: ORG }]]) {
      expect(relationshipRows(doc)[0]!.agent).toBe(ORG);
    }
  });

  it('a missing relationship reads as MEMBER, never as steward', () => {
    expect(relationshipRows({ orgs: { [ORG]: { org: ORG } } })[0]!.relationship).toBe('member');
  });

  it('never throws on junk — and yields nothing rather than something wrong', () => {
    for (const junk of [null, undefined, 'a string', 42, { orgs: 'not a map' }, { orgs: { x: null } }, { orgs: { notanaddress: { relationship: 'steward' } } }]) {
      expect(relationshipRows(junk)).toEqual([]);
    }
  });
});
