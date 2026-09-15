import { describe, it, expect } from 'vitest';
import { memoryFactsInvoker, memoryProposalFor, MEMORY_REMEMBER, MEMORY_LIST, MEMORY_FORGET } from '../src/memory-facts-tools.js';

const ALICE = '0x' + 'a'.repeat(40);
const store = () => { const m = new Map<string, unknown>(); return { readSubjectRecord: async (s: string, k: string) => m.get(`${s}:${k}`) ?? null, writeSubjectRecord: async (s: string, k: string, r: unknown) => { m.set(`${s}:${k}`, r); return { ok: true }; }, m }; };
const ctx = (goal: string) => ({ intent: { goal }, step: { id: 's0' }, index: 0, supplied: [] }) as never;

describe('memory that follows the person (spec 402 W1)', () => {
  it('remember → list → forget, as the person, in her own record', async () => {
    const deps = store();
    const inv = memoryFactsInvoker(deps, ALICE, 'run-1');
    const kept = await inv(MEMORY_REMEMBER, { fact: 'I lead the Thursday circle', tags: ['church'] }, ctx('remember that I lead the Thursday circle')) as { remembered: boolean; id: string; count: number };
    expect(kept.remembered).toBe(true); expect(kept.count).toBe(1);
    const again = await inv(MEMORY_REMEMBER, { fact: 'i lead the thursday circle' }, ctx('remember')) as { updated: boolean; count: number };
    expect(again.updated).toBe(true); expect(again.count).toBe(1);
    const listed = await inv(MEMORY_LIST, {}, ctx('what do you remember about me')) as { count: number; facts: Array<{ fact: string; source: string }>; answer: string };
    expect(listed.count).toBe(1); expect(listed.facts[0]!.source).toBe('you'); expect(listed.answer).toContain('you told me');
    const refused = await inv(MEMORY_FORGET, { words: 'canasta' }, ctx('forget')) as { forgotten: boolean; refused?: string };
    expect(refused.forgotten).toBe(false); expect(refused.refused).toMatch(/nothing I remember/);
    const gone = await inv(MEMORY_FORGET, { words: 'thursday' }, ctx('forget that')) as { forgotten: boolean; count: number };
    expect(gone.forgotten).toBe(true); expect(gone.count).toBe(0);
    const stored = deps.m.get(`${ALICE}:memory.facts`) as { type: string };
    expect(stored.type).toBe('ap.context.remembered-facts.v1');
  });
  it('in a room — an organization addressed — the memory is not read', async () => {
    const deps = store();
    const r = await memoryFactsInvoker(deps, ALICE, 'run', '0x' + 'c'.repeat(40))(MEMORY_LIST, {}, ctx('what do you remember')) as { refused?: string };
    expect(r.refused).toMatch(/own agent only/);
  });
  it('needs a signed-in person and a private tier; a non-fact is refused', async () => {
    await expect(memoryFactsInvoker(store(), undefined)(MEMORY_LIST, {}, ctx('x'))).rejects.toThrow(/signed-in person/);
    await expect(memoryFactsInvoker({}, ALICE)(MEMORY_LIST, {}, ctx('x'))).rejects.toThrow(/private tier/);
    await expect(memoryFactsInvoker(store(), ALICE)(MEMORY_REMEMBER, { fact: 'x' }, ctx('x'))).rejects.toThrow(/few words/);
  });
});

describe('a memory proposed from the conversation (spec 402 W1b)', () => {
  it('a first-person durable statement proposes; a question, a request, a known fact do not', () => {
    expect(memoryProposalFor("I lead the Thursday circle in Greeley, what's on my calendar?", [])).toBeNull(); // a question
    const p = memoryProposalFor('I lead the Thursday circle in Greeley. Who else is in it?', []);
    expect(p?.args.fact).toBe('I lead the Thursday circle in Greeley'); expect(p?.words).toBe('remember that I lead the Thursday circle in Greeley');
    expect(memoryProposalFor('my daughter is Ana and she starts school Monday', [])?.args.fact).toBe('my daughter is Ana and she starts school Monday');
    expect(memoryProposalFor('pay bob 10 usdc', [])).toBeNull();
    expect(memoryProposalFor('remember that I prefer mornings', [])).toBeNull();
    expect(memoryProposalFor('every Monday at 8 tell me the news', [])).toBeNull();
    expect(memoryProposalFor('I prefer morning meetings', [{ fact: 'I prefer morning meetings' }])).toBeNull();
    expect(memoryProposalFor('thanks, that helps', [])).toBeNull();
  });
});
