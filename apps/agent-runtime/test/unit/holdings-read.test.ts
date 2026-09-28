// Spec 419 — what an agent HOLDS, from the public chartered-under record: unnamed ⇒ the agent asked (the room), typed by
// suffix, filtered by type, and an honest refusal when it cannot read — never an empty list read as "holds nothing".
import { describe, expect, it } from 'vitest';
import { holdingsReadInvoker } from '../../src/holdings-read.js';

const ORG = '0x3b99f2b452766de5df0dbcdfc676f27257151333';
const rows = [{ agent: '0x' + '11'.repeat(20), name: 'mn-ops.treasury' }, { agent: '0x' + '22'.repeat(20), name: 'youth.team' }];

describe('holdingsReadInvoker', () => {
  it('unnamed ⇒ the room; each held agent typed by its suffix', async () => {
    const asked: string[] = [];
    const out = await holdingsReadInvoker({ charteredAgents: async (o, t) => { asked.push(`${o}|${t}`); return rows; }, nameOf: async () => 'missio-nexus.org' }, ORG as never)('agent.holdings.list', {}, {} as never) as Record<string, unknown>;
    expect(asked).toEqual([`${ORG}|*`]);
    expect(out).toMatchObject({ holder: ORG, count: 2, byType: { treasury: 1, team: 1 }, answer: 'missio-nexus.org holds mn-ops.treasury, youth.team.' });
  });
  it('a type narrows the read; an unknown type or an unreadable record refuses with the reason', async () => {
    const asked: string[] = [];
    await holdingsReadInvoker({ charteredAgents: async (o, t) => { asked.push(t); return rows.slice(0, 1); } }, ORG as never)('agent.holdings.list', { type: 'treasury' }, {} as never);
    expect(asked).toEqual(['treasury']);
    expect(await holdingsReadInvoker({ charteredAgents: async () => rows }, ORG as never)('agent.holdings.list', { type: 'spaceship' }, {} as never)).toMatchObject({ refused: expect.stringMatching(/not a kind/) });
    expect(await holdingsReadInvoker({ charteredAgents: async () => { throw new Error('rpc'); } }, ORG as never)('agent.holdings.list', {}, {} as never)).toMatchObject({ refused: expect.stringMatching(/could not be read/) });
  });
  it('none held is an answer, said as such', async () => {
    expect(await holdingsReadInvoker({ charteredAgents: async () => [], nameOf: async () => 'x.org' }, ORG as never)('agent.holdings.list', { type: 'treasury' }, {} as never)).toMatchObject({ count: 0, answer: 'x.org holds no treasury on the chartered-under record.' });
  });
});

describe('a partial scan is said, never read as "none"', () => {
  it('names how much of the record was read', async () => {
    const empty = Object.defineProperty([] as Array<{ agent: string; name?: string }>, 'scanned', { value: { read: 12, of: 30 }, enumerable: false });
    const out = await holdingsReadInvoker({ charteredAgents: async () => empty, nameOf: async () => 'x.org' }, ('0x' + '33'.repeat(20)) as never)('agent.holdings.list', { type: 'treasury' }, {} as never) as { answer: string };
    expect(out.answer).toBe('x.org holds no treasury among the first 12 of its 30 relationship edges — the rest were not read, so there may be some.');
  });
});
