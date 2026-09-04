// Who did they mean? — resolved in the ASKER'S OWN TIER, with the two answers that must be a question.
import { describe, expect, it, vi } from 'vitest';
import { isInputRequired } from '@agenticprimitives/orchestration';
import { resolveParty, partyCandidates, partyProviders, PARTY_ROOTS } from '../src/party-resolution.js';

const ME = '0x1111111111111111111111111111111111111111';
const ALICE_ME = '0xaaaa000000000000000000000000000000000001';
const ALICE_ORG = '0xaaaa000000000000000000000000000000000002';
const where = { stepRef: 's0', toolId: 'treasury.payment.execute', argName: 'payee', what: 'being paid', subject: ME };

/** A private tier: the asker's own relationships doc, plus the naming service. */
const lookups = (names: Record<string, string> = {}, rows: Array<Record<string, unknown>> = []) => ({
  resolveName: vi.fn(async (n: string) => names[n] ?? null),
  readSubjectRecord: vi.fn(async (_s: string, r: string) => (r === 'relationships.data' ? { rows } : null)),
});
const caught = async (p: Promise<unknown>) => {
  try { return { ok: true as const, v: await p }; }
  catch (e) { return isInputRequired(e) ? { ok: false as const, prompt: e.request } : { ok: false as const, error: (e as Error).message }; }
};

describe('resolving who a person meant', () => {
  it('an address is who they meant, whatever the prefix case', async () => {
    expect(await caught(resolveParty(ALICE_ME.toUpperCase(), lookups(), where))).toEqual({ ok: true, v: ALICE_ME });
  });

  it('finds someone through the asker\'s OWN relationships — the tier where knowing them lives', async () => {
    const l = lookups({}, [{ orgAgent: ALICE_ME, orgName: 'alice.me', kind: 'person' }]);
    expect(await caught(resolveParty('alice', l, where))).toEqual({ ok: true, v: ALICE_ME });
    expect(l.readSubjectRecord).toHaveBeenCalledWith(ME, 'relationships.data');
  });

  it('a bare label is also tried against the typed roots this person could mean', async () => {
    const l = lookups({ 'alice.me': ALICE_ME });
    expect(await caught(resolveParty('alice', l, where))).toEqual({ ok: true, v: ALICE_ME });
    for (const root of PARTY_ROOTS) expect(l.resolveName).toHaveBeenCalledWith(`alice.${root}`);
  });

  it('a dotted NAME is resolved as given — no hunting for near-misses', async () => {
    const l = lookups({ 'alice2.treasury': ALICE_ME });
    expect(await caught(resolveParty('alice2.treasury', l, where))).toEqual({ ok: true, v: ALICE_ME });
    expect(l.resolveName).toHaveBeenCalledTimes(1);
  });

  it('SEVERAL answer to it ⇒ ask which, and never pick', async () => {
    const l = lookups({ 'alice.me': ALICE_ME, 'alice.org': ALICE_ORG });
    const r = await caught(resolveParty('alice', l, where));
    const field = (r.prompt as { fields: Array<{ type: string; choices?: Array<{ value: string }> }> })?.fields?.[0];
    expect(field?.type).toBe('choice');
    expect(field?.choices?.map((c) => c.value).sort()).toEqual([ALICE_ME, ALICE_ORG].sort());
  });

  it('NOTHING answers ⇒ ask, and say WHERE we looked', async () => {
    const r = await caught(resolveParty('alice', lookups(), where));
    expect(r.prompt).toMatchObject({ prompt: expect.stringContaining('could not find') });
    expect((r.prompt as { fields: Array<{ hint?: string }> }).fields[0]!.hint).toMatch(/agents you are linked to|naming service/);
  });

  it('the same agent from both private sources is ONE candidate', async () => {
    const l = lookups({ 'alice.me': ALICE_ME }, [{ orgAgent: ALICE_ME, orgName: 'alice.me' }]);
    expect(await caught(resolveParty('alice', l, where))).toEqual({ ok: true, v: ALICE_ME });
  });

  it('NO SUBJECT means no private read — and never a fall back to searching everyone', async () => {
    const l = lookups({ 'alice.me': ALICE_ME }, [{ orgAgent: ALICE_ORG, orgName: 'alice.me' }]);
    const r = await caught(resolveParty('alice', l, { ...where, subject: undefined }));
    expect(l.readSubjectRecord).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.prompt).toMatchObject({ prompt: expect.stringContaining('could not find') });
  });

  it('consults ONLY private providers — a public directory hit is not evidence this person knows them', () => {
    const providers = partyProviders(lookups({}, []));
    expect(providers.map((p) => p.tier)).toEqual(['private', 'private']);
    expect(providers.map((p) => p.source)).toEqual(['relationships', 'naming']);
  });

  it('an empty reference is a question, never a zero address', async () => {
    const r = await caught(resolveParty('', lookups(), where));
    expect(r.prompt).toMatchObject({ prompt: expect.stringContaining('Who is being paid') });
  });

  it('exposes the same candidates the resolver saw', async () => {
    const l = lookups({ 'alice.me': ALICE_ME, 'alice.org': ALICE_ORG });
    const found = await partyCandidates('alice', l, ME);
    expect(found.map((c) => c.agent).sort()).toEqual([ALICE_ME, ALICE_ORG].sort());
    for (const c of found) expect(c.provenance.tier).toBe('private');
  });
});
