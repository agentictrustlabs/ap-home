// Who did they mean? — and the two answers that must be a question (spec 350 §3.5).
import { describe, expect, it, vi } from 'vitest';
import { isInputRequired } from '@agenticprimitives/orchestration';
import { resolveParty, partyCandidates, PARTY_ROOTS } from '../src/party-resolution.js';

const ALICE_ME = '0xaaaa000000000000000000000000000000000001';
const ALICE_ORG = '0xaaaa000000000000000000000000000000000002';
const where = { stepRef: 's0', toolId: 'treasury.payment.execute', argName: 'payee', what: 'being paid' };
const lookups = (names: Record<string, string>, hits: Array<{ name?: string; smartAgent?: string; displayName?: string }> = []) => ({
  resolveName: vi.fn(async (n: string) => names[n] ?? null),
  findAgents: vi.fn(async () => hits),
});
const caught = async (p: Promise<unknown>) => {
  try { return { ok: true as const, v: await p }; }
  catch (e) { return isInputRequired(e) ? { ok: false as const, prompt: e.request } : { ok: false as const, error: (e as Error).message }; }
};

describe('resolving who a person meant', () => {
  it('an address is who they meant', async () => {
    const r = await caught(resolveParty(ALICE_ME.toUpperCase(), lookups({}), where));
    expect(r).toEqual({ ok: true, v: ALICE_ME });
  });

  it('a dotted NAME is resolved as given — no hunting for near-misses', async () => {
    const l = lookups({ 'alice2.treasury': ALICE_ME });
    expect(await caught(resolveParty('alice2.treasury', l, where))).toEqual({ ok: true, v: ALICE_ME });
    expect(l.resolveName).toHaveBeenCalledTimes(1);
    expect(l.findAgents).not.toHaveBeenCalled();
  });

  it('a bare label is tried against every typed root — "alice" is not a name, it is a reference', async () => {
    const l = lookups({ 'alice.me': ALICE_ME });
    expect(await caught(resolveParty('alice', l, where))).toEqual({ ok: true, v: ALICE_ME });
    for (const root of PARTY_ROOTS) expect(l.resolveName).toHaveBeenCalledWith(`alice.${root}`);
  });

  it('SEVERAL agents answer to it ⇒ ask which, and never pick', async () => {
    const l = lookups({ 'alice.me': ALICE_ME, 'alice.org': ALICE_ORG });
    const r = await caught(resolveParty('alice', l, where));
    expect(r.ok).toBe(false);
    expect(r.prompt).toMatchObject({ kind: 'data', prompt: expect.stringContaining('Which') });
    const field = (r.prompt as { fields: Array<{ type: string; choices?: Array<{ value: string }> }> }).fields[0]!;
    expect(field.type).toBe('choice');
    expect(field.choices?.map((c) => c.value).sort()).toEqual([ALICE_ME, ALICE_ORG].sort());
  });

  it('NOTHING answers to it ⇒ ask, and say what was looked in', async () => {
    const r = await caught(resolveParty('alice', lookups({}), where));
    expect(r.ok).toBe(false);
    expect(r.prompt).toMatchObject({ kind: 'data', prompt: expect.stringContaining('could not find') });
    expect((r.prompt as { fields: Array<{ hint?: string }> }).fields[0]!.hint).toContain('alice.me');
  });

  it('an empty reference is a question, never a zero address', async () => {
    const r = await caught(resolveParty('', lookups({}), where));
    expect(r.prompt).toMatchObject({ prompt: expect.stringContaining('Who is being paid') });
  });

  it('a directory hit that does not actually contain the words is not a candidate — search may fuzz; we do not', async () => {
    const l = lookups({}, [{ name: 'bob.me', smartAgent: ALICE_ORG, displayName: 'Bob' }]);
    expect((await partyCandidates('alice', l)).length).toBe(0);
  });

  it('the same agent found twice is one candidate', async () => {
    const l = lookups({ 'alice.me': ALICE_ME }, [{ name: 'alice.me', smartAgent: ALICE_ME }]);
    expect(await caught(resolveParty('alice', l, where))).toEqual({ ok: true, v: ALICE_ME });
  });
});
