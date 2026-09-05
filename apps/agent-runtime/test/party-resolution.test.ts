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

  it('every candidate is DISTINGUISHABLE — a list of identical labels is not a choice', async () => {
    const l = lookups({ 'alice.me': ALICE_ME, 'alice.org': ALICE_ORG });
    const r = await caught(resolveParty('alice', l, where));
    const field = (r.prompt as { fields: Array<{ choices?: Array<{ label: string; hint?: string }> }> }).fields[0]!;
    const choices = field.choices ?? [];
    // Each row carries something the others do not: the person is about to authorize an action against
    // ONE of these, and "the second Alice" is not a thing anyone knows about themselves.
    for (const c of choices) expect(c.hint, `no hint on ${c.label}`).toBeTruthy();
    expect(new Set(choices.map((c) => `${c.label}|${c.hint}`)).size).toBe(choices.length);
    // The address is part of it — a name alone can be claimed by two agents.
    for (const c of choices) expect(c.hint).toMatch(/0x[0-9a-f]{6}/);
  });

  it('reports what a CERTAIN resolution decided — nobody was asked, so it must be shown', async () => {
    const seen: Array<{ arg: string; raw: string; agent: string; label?: string }> = [];
    const l = { ...lookups({ 'alice.me': ALICE_ME }), onResolved: (r: typeof seen[number]) => seen.push(r) };
    expect(await caught(resolveParty('alice', l, where))).toEqual({ ok: true, v: ALICE_ME });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ arg: where.argName, raw: 'alice', agent: ALICE_ME, label: 'alice.me' });
  });

  it('an address given outright is reported with NO label — nothing was resolved to name', async () => {
    const seen: Array<{ agent: string; label?: string }> = [];
    const l = { ...lookups(), onResolved: (r: typeof seen[number]) => seen.push(r) };
    await caught(resolveParty(ALICE_ME, l, where));
    expect(seen[0]).toMatchObject({ agent: ALICE_ME });
    expect(seen[0]!.label).toBeUndefined();
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

describe('the typed suffix says WHICH nathan — the capability decides', () => {
  const NATHAN = {
    me: '0xnnnn000000000000000000000000000000000001'.replace('nnnn', '1111'),
    org: '0xnnnn000000000000000000000000000000000002'.replace('nnnn', '1111'),
    team: '0xnnnn000000000000000000000000000000000003'.replace('nnnn', '1111'),
    treasury: '0xnnnn000000000000000000000000000000000004'.replace('nnnn', '1111'),
  };
  const allFour = () => lookups({
    'nathan.me': NATHAN.me, 'nathan.org': NATHAN.org, 'nathan.team': NATHAN.team, 'nathan.treasury': NATHAN.treasury,
  });
  const at = (toolId: string, argName: string, types: readonly string[], what = 'the party') =>
    ({ stepRef: 's0', toolId, argName, what, subject: ME, types });

  it('“send money to nathan” means his TREASURY', async () => {
    const r = await caught(resolveParty('nathan', allFour(), at('treasury.payment.execute', 'payee', ['treasury', 'org', 'me'], 'being paid')));
    expect(r).toEqual({ ok: true, v: NATHAN.treasury });
  });

  it('“send nathan a message” means the PERSON', async () => {
    const r = await caught(resolveParty('nathan', allFour(), at('messaging.direct.send', 'recipient', ['me', 'org'], 'the person to message')));
    expect(r).toEqual({ ok: true, v: NATHAN.me });
  });

  it('the SAME word, four candidates, two capabilities, two different agents', async () => {
    const pay = await caught(resolveParty('nathan', allFour(), at('treasury.payment.execute', 'payee', ['treasury'])));
    const msg = await caught(resolveParty('nathan', allFour(), at('messaging.direct.send', 'recipient', ['me'])));
    expect(pay).not.toEqual(msg);
  });

  it('falls to the NEXT type in order — for anything that does not move value', async () => {
    // A message to someone with no personal agent reaches their organization. Same conversation, same
    // people; nothing to confirm.
    const l = lookups({ 'nathan.org': NATHAN.org, 'nathan.team': NATHAN.team });
    const r = await caught(resolveParty('nathan', l, at('messaging.direct.send', 'recipient', ['me', 'org'], 'the person to message')));
    expect(r).toEqual({ ok: true, v: NATHAN.org });
  });

  it('a MONEY argument does not settle for a different kind of agent — it asks', async () => {
    // The live case: "send alice 20 USDC" when nothing called alice is a treasury. Paying her PERSON
    // agent instead is a different destination, reached silently, and a payment cannot be taken back.
    const l = lookups({ 'nathan.org': NATHAN.org, 'nathan.me': NATHAN.me });
    const r = await caught(resolveParty('nathan', l, at('treasury.payment.execute', 'payee', ['treasury', 'org', 'me'], 'being paid')));
    expect(r.ok, 'a value substitution is a question').toBe(false);
    const prompt = (r as { prompt: { prompt: string; fields: Array<{ hint?: string; choices?: unknown[] }> } }).prompt;
    expect(prompt.prompt).toContain('is a treasury');
    // It says what it DID find, and how to reach the treasury if it exists under another name.
    expect(prompt.fields[0]!.choices).toHaveLength(2);
    expect(prompt.fields[0]!.hint).toMatch(/another name/);
  });

  it('a money argument resolved AT its first-choice type does not ask', async () => {
    const l = lookups({ 'nathan.treasury': NATHAN.treasury, 'nathan.me': NATHAN.me });
    const r = await caught(resolveParty('nathan', l, at('treasury.payment.execute', 'payee', ['treasury', 'org', 'me'], 'being paid')));
    expect(r).toEqual({ ok: true, v: NATHAN.treasury });
  });

  it('a lone match of the WRONG kind is still a question when money moves', async () => {
    // `certain` in the resolver's sense — exactly one agent answers — but it is a person, and the ask was
    // for a treasury. Silently paying the one thing that answered is the failure this closes.
    const l = lookups({ 'nathan.me': NATHAN.me });
    const r = await caught(resolveParty('nathan', l, at('treasury.payment.execute', 'payee', ['treasury', 'me'], 'being paid')));
    expect(r.ok).toBe(false);
  });

  it('NEVER picks through real ambiguity — two of the preferred type is still a question', async () => {
    // A treasury the person keeps a link to, and a DIFFERENT one the naming service resolves the same
    // name to. Both are `.treasury`, so the type says nothing about which; a stale row and a live name
    // disagreeing is precisely when picking either would be worst.
    const STALE = '0x2222000000000000000000000000000000000009';
    const l = lookups({ 'nathan.treasury': NATHAN.treasury }, [{ orgAgent: STALE, orgName: 'nathan.treasury' }]);
    const r = await caught(resolveParty('nathan', l, at('treasury.fund', 'treasury', ['treasury'], 'the treasury')));
    expect(r.ok, 'two of the same type is a question, not a pick').toBe(false);
    const field = (r as { prompt: { fields: Array<{ choices?: Array<{ value: string }> }> } }).prompt.fields[0]!;
    expect(field.choices?.map((c) => c.value).sort()).toEqual([NATHAN.treasury, STALE].sort());
  });

  it('nothing of the right KIND is an ANSWER, not a licence to pay some other Nathan', async () => {
    const l = lookups({ 'nathan.me': NATHAN.me, 'nathan.org': NATHAN.org });
    const r = await caught(resolveParty('nathan', l, at('treasury.fund', 'treasury', ['treasury'], 'the treasury')));
    expect(r.ok, 'it must ask rather than substitute').toBe(false);
    const field = (r as { prompt: { fields: Array<{ hint?: string }> } }).prompt.fields[0]!;
    expect(field.hint).toContain('is a treasury');
    expect(field.hint).toContain('nathan');
  });

  it('an undeclared capability narrows nothing — silence is not a preference', async () => {
    const r = await caught(resolveParty('nathan', allFour(), { stepRef: 's0', toolId: 'x.y', argName: 'p', what: 'the party', subject: ME }));
    expect(r.ok).toBe(false);
    expect((r as { prompt: { fields: Array<{ choices?: unknown[] }> } }).prompt.fields[0]!.choices).toHaveLength(4);
  });
});

describe('a person is not their treasury — follow the relationship (the user\'s rule)', () => {
  const ALICE = '0xaaaa000000000000000000000000000000000011';
  const T2 = '0xaaaa000000000000000000000000000000000012';
  const T3 = '0xaaaa000000000000000000000000000000000013';
  const pay = (types: readonly string[] = ['treasury', 'me']) =>
    ({ stepRef: 's0', toolId: 'treasury.payment.execute', argName: 'payee', what: 'being paid', subject: ME, types });

  /** The asker's tree: alice.me, and treasuries whose PARENT is alice — the ownership link. */
  const treeWith = (treasuries: string[]) => ({
    resolveName: vi.fn(async (n: string) => (n === 'alice.me' ? ALICE : null)),
    readSubjectRecord: vi.fn(async (_s: string, r: string) => r === 'relationships.data' ? {
      orgs: Object.fromEntries([
        [ALICE, { org: ALICE, orgName: 'alice.me', kind: 'person' }],
        ...treasuries.map((t, i) => [t, { org: t, orgName: `alice${i + 2}.treasury`, kind: 'person-treasury', parent: ALICE }]),
      ]),
    } : null),
  });

  it('“pay alice” finds the treasury she HOLDS, whatever it is called', async () => {
    // The name is alice2.treasury — nothing resembling "alice.treasury" exists, and guessing that name
    // was the old, wrong mechanism.
    const r = await caught(resolveParty('alice', treeWith([T2]), pay()));
    expect(r).toEqual({ ok: true, v: T2 });
  });

  it('asks WHICH when she holds more than one', async () => {
    const r = await caught(resolveParty('alice', treeWith([T2, T3]), pay()));
    expect(r.ok).toBe(false);
    const field = (r as { prompt: { fields: Array<{ choices?: Array<{ value: string }>; allowOther?: boolean }> } }).prompt.fields[0]!;
    expect(field.choices?.map((c) => c.value).sort()).toEqual([T2, T3].sort());
    expect(field.allowOther, 'and a name that is not listed is still a valid answer').toBe(true);
  });

  it('holds none ⇒ the honest question, never a silent substitution to the person', async () => {
    const r = await caught(resolveParty('alice', treeWith([]), pay()));
    expect(r.ok).toBe(false);
    expect((r as { prompt: { prompt: string } }).prompt.prompt).toMatch(/is a treasury/);
  });

  it('a MESSAGE still goes to the person — ownership is followed only for what the capability wants', async () => {
    const r = await caught(resolveParty('alice', treeWith([T2]), { ...pay(['me', 'org']), toolId: 'messaging.direct.send', argName: 'recipient', what: 'the person to message' }));
    expect(r).toEqual({ ok: true, v: ALICE });
  });
});
