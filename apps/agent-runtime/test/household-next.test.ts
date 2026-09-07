// Spec 368 §3 — recording a family member proposes putting them in the SHARED household: the agent.
import { describe, expect, it } from 'vitest';
import { householdNextFor } from '../src/harness-run.js';

const ALICE = '0xa11ce00000000000000000000000000000000001' as `0x${string}`;
const BOB = '0xb0b0000000000000000000000000000000000002';
const HOUSE = '0x1111100000000000000000000000000000000003';

describe('what follows a household note', () => {
  it('with a household agent: the next act is the invitation INTO it, kinship carried', async () => {
    const next = await householdNextFor(
      { charteredAgents: async () => [{ agent: HOUSE, name: 'pedersen.household' }] },
      ALICE, BOB, 'Bob', { kin: 'spouse', role: 'member' },
    );
    expect(next?.householdAgent).toEqual({ agent: HOUSE, name: 'pedersen.household' });
    expect(next?.next.capability).toBe('organization.membership.invite');
    expect(next?.next.args).toEqual({ org: HOUSE, invitee: BOB, kin: 'spouse', role: 'member' });
    expect(next?.next.words).toBe('invite Bob to pedersen as your spouse');
  });

  it('with several: the one the person NAMED, by its label', async () => {
    const next = await householdNextFor(
      { charteredAgents: async () => [{ agent: HOUSE, name: 'pedersen.household' }, { agent: BOB, name: 'farm.household' }] },
      ALICE, BOB, 'Bob', { household: 'farm' },
    );
    expect(next?.householdAgent?.agent).toBe(BOB);
    expect(next?.next.words).toBe('invite Bob to farm');
  });

  it('with none: the next act is to CREATE the household agent — until then there is nothing shared to be in', async () => {
    const next = await householdNextFor({ charteredAgents: async () => [] }, ALICE, BOB, 'Bob', {});
    expect(next?.householdAgent).toBeUndefined();
    expect(next?.next.capability).toBe('household.create');
    expect(next?.next.words).toContain('Bob can be in the same household');
  });

  it('a reader that cannot answer proposes creation rather than failing the note', async () => {
    const next = await householdNextFor({ charteredAgents: async () => { throw new Error('rpc down'); } }, ALICE, BOB, 'Bob', {});
    expect(next?.next.capability).toBe('household.create');
  });
});
