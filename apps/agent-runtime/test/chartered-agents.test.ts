/**
 * READING `ap:charteredUnder` FROM CHAIN — spec 355 W2.
 *
 * The edge that makes "send alice 20 USDC" routable by someone who is not Alice. Both parties signed it,
 * so it is public and chain-reproducible (ADR-0040) — unlike the same link in her vault, which is hers
 * alone (ADR-0025) and is why the payment used to dead-end.
 */
import { describe, it, expect, vi } from 'vitest';
import { charteredAgentsReader } from '../src/chartered-agents.js';
import { RELATIONSHIP_TYPE } from '@agenticprimitives/agent-relationships';
import type { Address } from 'viem';

const REL = '0x00000000000000000000000000000000000000e1' as Address;
const ALICE = '0x00000000000000000000000000000000000000a1';
const T2 = '0x00000000000000000000000000000000000000a2';
const OTHER = '0x00000000000000000000000000000000000000a3';
const ACTIVE = 3;

const edge = (over: Record<string, unknown> = {}) => ({
  subject: T2, object_: ALICE, relationshipType: RELATIONSHIP_TYPE.CHARTERED_UNDER, status: ACTIVE, ...over,
});
const reader = (edges: Array<Record<string, unknown>>, names: Record<string, string> = { [T2]: 'alice2.treasury' }) => {
  const ids = edges.map((_, i) => `0x${String(i + 1).padStart(64, '0')}`);
  const readContract = vi.fn(async (a: { functionName: string; args: unknown[] }) =>
    a.functionName === 'getEdgesByObject' ? ids : edges[ids.indexOf(a.args[0] as string)] ?? null);
  return {
    readContract: readContract as never,
    call: charteredAgentsReader({
      readContract: readContract as never, relationships: REL,
      relationshipType: RELATIONSHIP_TYPE.CHARTERED_UNDER,
      reverseName: async (agent: string) => names[agent.toLowerCase()] ?? null,
    }),
  };
};

describe('charteredAgentsReader', () => {
  it('finds the treasury chartered under a person — for anyone asking', async () => {
    expect(await reader([edge()]).call(ALICE, 'treasury')).toEqual([{ agent: T2, name: 'alice2.treasury' }]);
  });

  it('ignores an edge that is not ACTIVE — proposed is not agreed', async () => {
    for (const status of [1, 2, 4]) expect(await reader([edge({ status })]).call(ALICE, 'treasury')).toEqual([]);
  });

  it('ignores another relationship type over the same pair', async () => {
    expect(await reader([edge({ relationshipType: RELATIONSHIP_TYPE.HAS_MEMBER })]).call(ALICE, 'treasury')).toEqual([]);
  });

  it('filters by the TYPE asked for, not by whatever is chartered', async () => {
    const r = reader([edge({ subject: OTHER })], { [OTHER]: 'alice-team.team' });
    expect(await r.call(ALICE, 'treasury')).toEqual([]);
    expect(await r.call(ALICE, 'team')).toEqual([{ agent: OTHER, name: 'alice-team.team' }]);
  });

  it('skips a nameless agent — it cannot be offered to a person as a choice', async () => {
    expect(await reader([edge()], {}).call(ALICE, 'treasury')).toEqual([]);
  });

  it('answers nothing, rather than throwing, when the contract is unreachable', async () => {
    const call = charteredAgentsReader({
      readContract: (async () => { throw new Error('rpc down'); }) as never,
      relationships: REL, relationshipType: RELATIONSHIP_TYPE.CHARTERED_UNDER,
    });
    await expect(call(ALICE, 'treasury')).resolves.toEqual([]);
  });

  it('is inert when no relationship contract is configured', async () => {
    const readContract = vi.fn();
    const call = charteredAgentsReader({ readContract: readContract as never, relationshipType: RELATIONSHIP_TYPE.CHARTERED_UNDER });
    expect(await call(ALICE, 'treasury')).toEqual([]);
    expect(readContract, 'no chain read without an address to read from').not.toHaveBeenCalled();
  });
});
