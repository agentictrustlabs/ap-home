import { describe, it, expect } from 'vitest';
import { rosterRows, participantType, permissionWords } from './roster-contract';
import { buildVaultRecordScopeCaveat } from '@agenticprimitives/delegation';
describe('the roster contract (398 §4.5)', () => {
  it('type from the typed suffix (ADR-0061); nameless is unknown, never guessed', () => {
    expect(participantType('mara.me')).toBe('person'); expect(participantType('missio-nexus.org')).toBe('organization');
    expect(participantType('alice2.treasury')).toBe('service'); expect(participantType(null)).toBe('unknown');
  });
  it('sponsor · responsibility · permissions in words · active work', () => {
    const c = buildVaultRecordScopeCaveat([{ server: 'demo-mcp', resources: ['vault:org.profile'], ops: ['read'] }]);
    const rows = rosterRows({ orgName: 'Missio Nexus', executors: new Map([['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 2]]), members: [
      { address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', displayName: 'Mara', publicName: 'mara.me', admittedVia: 'invite', grantCaveats: [{ enforcer: c.enforcer, terms: c.terms }] },
      { address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', displayName: 'Theo', publicName: 'theo.me', admittedVia: 'listing', role: 'treasurer' },
    ] });
    expect(rows[0]!.sponsor).toMatch(/admitted by Missio Nexus on an invitation/); expect(rows[0]!.permissions).toBe('read org profile'); expect(rows[0]!.activeWork).toBe(2);
    expect(rows[1]!.sponsor).toMatch(/own signed listing/); expect(rows[1]!.responsibility).toBe('treasurer'); expect(rows[1]!.activeWork).toBe(0);
    expect(permissionWords(undefined)).toMatch(/no record scope named/);
    const scoped = buildVaultRecordScopeCaveat([{ server: 'demo-mcp', resources: ['vault:member.profile:0x3b99f2b452766de5df0dbcdfc676f27257151333', 'vault:message.body:*'], ops: ['read'] }]);
    expect(permissionWords([{ enforcer: scoped.enforcer, terms: scoped.terms }])).toBe('read the member profile for this organization · read message body');
  });
});
