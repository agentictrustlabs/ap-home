import { describe, it, expect } from 'vitest';
import { routineInvoker, compiledRoutine, ROUTINE_DECLARE, ROUTINE_LIST, ROUTINE_REMOVE } from '../src/routine-tools.js';
import type { TriggerScheduleV1 } from '../src/triggers.js';

const ALICE = '0x' + 'a'.repeat(40);
const store = () => { const rows: TriggerScheduleV1[] = []; return { rows, listTriggers: async () => rows, declareTrigger: async (_a: string, r: TriggerScheduleV1) => { rows.push(r); return r; }, removeTrigger: async (_a: string, id: string) => { const i = rows.findIndex((r) => r.triggerId === id); if (i >= 0) rows.splice(i, 1); } }; };
class Asked extends Error { constructor(public input: { prompt: string; fields: Array<{ name: string }> }) { super('asked'); } }
const ask = (i: never) => { throw new Asked(i); };
const ctx = (goal: string, supplied: Array<{ stepRef: string; data: Record<string, unknown> }> = []) => ({ intent: { goal, context: { tz: 'America/Denver' } }, step: { id: 's0' }, index: 0, supplied }) as never;
const supplied = (c: unknown, ref: string) => ((c as { supplied: Array<{ stepRef: string; data: Record<string, unknown> }> }).supplied.find((x) => x.stepRef === ref)?.data ?? {});

describe('routines from a sentence (spec 402 W3)', () => {
  it('a sentence with a clock compiles; a question or a memory does not', () => {
    expect(compiledRoutine("every Monday at 8, tell me what's on my calendar")?.steps[0]!.toolId).toBe(ROUTINE_DECLARE);
    expect(compiledRoutine('what do I have every Monday')).toBeNull();
    expect(compiledRoutine('remember that every Monday I lead the circle')).toBeNull();
    expect(compiledRoutine('pay bob 10 usdc')).toBeNull();
  });
  it('read back, kept only on yes, listed, removed; a room is refused', async () => {
    const st = store();
    const inv = routineInvoker(st, ALICE, ALICE, ask, supplied);
    const sentence = "every Monday at 8, tell me what's on my calendar";
    await expect(inv(ROUTINE_DECLARE, { sentence }, ctx(sentence))).rejects.toMatchObject({ input: { fields: [{ name: 'keep' }] } });
    await expect(inv(ROUTINE_DECLARE, { sentence: 'tell me the news' }, ctx('x'))).rejects.toMatchObject({ input: { fields: [{ name: 'sentence' }] } });
    const no = await inv(ROUTINE_DECLARE, { sentence }, ctx(sentence, [{ stepRef: 's0', data: { keep: 'no' } }])) as { kept: boolean };
    expect(no.kept).toBe(false); expect(st.rows).toHaveLength(0);
    const yes = await inv(ROUTINE_DECLARE, { sentence, name: 'Monday brief' }, ctx(sentence, [{ stepRef: 's0', data: { keep: 'yes' } }])) as { kept: boolean; id: string; every: string; tz: string };
    expect(yes.kept).toBe(true); expect(yes.every).toBe('7d'); expect(yes.tz).toBe('America/Denver');
    expect(st.rows[0]!.declared?.saidAs).toBe(sentence); expect(st.rows[0]!.playbookDigest).toBe('declared'); expect(st.rows[0]!.ask).toBe("what's on my calendar");
    const l = await inv(ROUTINE_LIST, {}, ctx('my routines')) as { count: number; answer: string };
    expect(l.count).toBe(1); expect(l.answer).toContain("what's on my calendar");
    const room = await routineInvoker(st, ALICE, '0x' + 'c'.repeat(40), ask, supplied)(ROUTINE_LIST, {}, ctx('x')) as { refused?: string };
    expect(room.refused).toMatch(/your own agent/);
    const rm = await inv(ROUTINE_REMOVE, { words: 'calendar' }, ctx('stop it')) as { removed: boolean };
    expect(rm.removed).toBe(true); expect(st.rows).toHaveLength(0);
  });
});
