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
    expect(providers.every((p) => p.tier === 'private')).toBe(true);
    expect(providers.map((p) => p.source)).toEqual(['relationships', 'roster', 'naming']);
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

describe('reach through what you are both in (spec 353 S3, second half)', () => {
  const ORG = '0xbbbb000000000000000000000000000000000001';
  const ALICE = '0xaaaa000000000000000000000000000000000009';
  /** The asker's tree holds the org; the ORG's directory holds its members. Two subjects, two reads. */
  const shared = (listings: Array<Record<string, unknown>>, kind = 'org') => ({
    resolveName: vi.fn(async () => null),
    readSubjectRecord: vi.fn(async (subject: string, record: string) => {
      if (subject === ME && record === 'relationships.data') return { rows: [{ orgAgent: ORG, orgName: 'Northern Colorado Field', kind }] };
      if (subject === ORG && record === 'directory.data') return { listings };
      return null;
    }),
  });

  it('finds someone through an organization they are BOTH in, and says where', async () => {
    const l = shared([{ smartAgent: ALICE, name: 'alice.me', displayName: 'Alice Okoro' }]);
    const r = await caught(resolveParty('alice', l, where));
    expect(r).toEqual({ ok: true, v: ALICE });
    const found = await partyCandidates('alice', l, ME);
    expect(found[0]!.label).toBe('Alice Okoro — in Northern Colorado Field');
    expect(found[0]!.provenance).toMatchObject({ tier: 'private', source: 'roster', subject: ORG });
  });

  it('reads a roster ONLY for an organization in the asker\'s own tree — the link IS the standing', async () => {
    const l = shared([{ smartAgent: ALICE, name: 'alice.me' }]);
    await caught(resolveParty('alice', l, where));
    const subjects = l.readSubjectRecord.mock.calls.map((c) => c[0]);
    expect(new Set(subjects)).toEqual(new Set([ME, ORG])); // never an org they are not in
  });

  it('never returns the asker themselves from a roster', async () => {
    const l = shared([{ smartAgent: ME, name: 'alice.me', displayName: 'Alice Okoro' }]);
    expect((await caught(resolveParty('alice', l, where))).ok).toBe(false);
  });

  it('an organization with no directory yet is simply empty — one failure is not the search\'s', async () => {
    const l = {
      resolveName: vi.fn(async () => null),
      readSubjectRecord: vi.fn(async (subject: string, record: string) => {
        if (subject === ME && record === 'relationships.data') return { rows: [{ orgAgent: ORG, orgName: 'NCF', kind: 'org' }] };
        throw new Error('storage not enabled');
      }),
    };
    const r = await caught(resolveParty('alice', l, where));
    expect(r.prompt).toMatchObject({ prompt: expect.stringContaining('could not find') });
  });

  it('a treasury has no roster to read', async () => {
    const l = shared([{ smartAgent: ALICE, name: 'alice.me' }], 'person-treasury');
    await caught(resolveParty('alice', l, where));
    expect(l.readSubjectRecord.mock.calls.map((c) => c[0])).not.toContain(ORG);
  });

  it('says it looked in the members of your organizations when nothing is found', async () => {
    const l = shared([]);
    const r = await caught(resolveParty('nobody', l, where));
    expect((r.prompt as { fields: Array<{ hint?: string }> }).fields[0]!.hint).toContain('members of your organizations');
  });
});
