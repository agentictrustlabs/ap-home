/**
 * WHOSE AGENT ACTS — the argument nobody says out loud, and the one most likely to be silently wrong.
 *
 * "Send alice 20 USDC" names neither the sender nor the payer. Both get defaulted, and both defaults were
 * wrong in a way that only showed up at the very end: the payment took the person's own SA (which holds no
 * money) and the message fell through to the RECIPIENT, so Nathan was asked to authorize sending a message
 * AS ALICE.
 */
import { describe, it, expect, vi } from 'vitest';
import { isInputRequired } from '@agenticprimitives/orchestration';
import { ownAgentsOfType } from '@agenticprimitives/context';
import { partyTypesFor, HARNESS_ACTION_TOOLS, NEVER_THE_ASKER, resolveStepArgs } from '../src/harness-run.js';

const NATHAN = '0x1dba4a27c53d7babda99513080223fb3bfc4bad1';
const NATHAN_TREASURY = '0x2c471607fec409516ab6de6b7517bcf95f1f2edc';
const NATHAN_ORG = '0x55b0c86b19812292bfe8a61bf609393c87955f30';

const tier = (rows: Array<Record<string, unknown>>) => ({
  readSubjectRecord: vi.fn(async (_s: string, r: string) => (r === 'relationships.data' ? { orgs: Object.fromEntries(rows.map((x) => [x.org as string, x])) } : null)),
});
const ROWS = [
  { org: NATHAN_TREASURY, orgName: 'nathan.treasury', relationship: 'steward', kind: 'person-treasury' },
  { org: NATHAN_ORG, orgName: 'nathan.org', relationship: 'steward', kind: 'organization' },
];

describe('the asker’s own agent of a type', () => {
  it('finds the treasury among their own agents, by suffix', async () => {
    const found = await ownAgentsOfType(NATHAN, 'treasury', tier(ROWS));
    expect(found.map((c) => c.agent)).toEqual([NATHAN_TREASURY]);
    expect(found[0]!.label).toBe('nathan.treasury');
  });

  it('reads the ASKER’s tier and nothing else — this is "which of YOUR agents", never a search', async () => {
    const t = tier(ROWS);
    await ownAgentsOfType(NATHAN, 'treasury', t);
    expect(t.readSubjectRecord).toHaveBeenCalledTimes(1);
    expect(t.readSubjectRecord).toHaveBeenCalledWith(NATHAN, 'relationships.data');
  });

  it('finds nothing rather than something close', async () => {
    expect(await ownAgentsOfType(NATHAN, 'treasury', tier([ROWS[1]!]))).toEqual([]);
  });

  it('finds an UNNAMED treasury by its kind — the name is not the only evidence', async () => {
    // The live failure: seven treasuries, every one created without a name, and the resolver reported the
    // person owned none — so a payment came out of their PERSON agent and reported success.
    const unnamed = [{ org: '0x00000000000000000000000000000000000000a9', orgName: '', relationship: 'steward', kind: 'person-treasury' }];
    const found = await ownAgentsOfType(NATHAN, 'treasury', tier(unnamed));
    expect(found.map((c) => c.agent)).toEqual(['0x00000000000000000000000000000000000000a9']);
    expect(found[0]!.label, 'and it is labelled by what it IS, having nothing else').toMatch(/unnamed treasury/);
  });

  it('matches an org treasury by kind too', async () => {
    const orgT = [{ org: '0x00000000000000000000000000000000000000aa', orgName: '', kind: 'org-treasury' }];
    expect(await ownAgentsOfType(NATHAN, 'treasury', tier(orgT))).toHaveLength(1);
  });

  it('does not match a different kind that merely ends in the same word', async () => {
    const notATreasury = [{ org: '0x00000000000000000000000000000000000000ab', orgName: '', kind: 'organization' }];
    expect(await ownAgentsOfType(NATHAN, 'treasury', tier(notATreasury))).toEqual([]);
  });

  it('without a private tier it answers nothing — it never widens to a public lookup', async () => {
    expect(await ownAgentsOfType(NATHAN, 'treasury', {})).toEqual([]);
  });
});

describe('the acting party is declared, not inferred', () => {
  it('a payment acts as a TREASURY or an ORG — never as the person standing there', () => {
    const types = partyTypesFor('treasury.payment.execute', 'payer');
    expect(types).toBeTruthy();
    expect(types).not.toContain('me');
  });

  it('messaging acts as the SENDER, and every capability that names an authority arg means it', () => {
    const msg = HARNESS_ACTION_TOOLS.find((t) => (t.capability?.id ?? t.id) === 'messaging.direct.send');
    expect(msg?.capability?.authorityArg).toBe('sender');
    // THE RULE, stated as narrowly as it is true: a step never spends the authority of the party it acts
    // TOWARD. Authority equal to the resource is fine and common — an organization authorizes an
    // invitation to itself — but authority equal to the RECIPIENT, PAYEE or INVITEE is the bug that
    // produced "authorize this as Alice", and no capability may declare it.
    for (const t of HARNESS_ACTION_TOOLS) {
      const cap = t.capability;
      if (!cap?.authorityArg) continue;
      expect(NEVER_THE_ASKER.has(cap.authorityArg), `${cap.id} would act as its own counterparty`).toBe(false);
    }
  });
});

// ── AMOUNTS, AS PEOPLE WRITE THEM (the live loop: "keeps asking me how much should I send") ──
//
// Asked "how much?", a person answered "10 usdc" and the strict number test read it as no answer, so the
// same question came back with nothing said about why. Two rules now: read the figure out of what they
// wrote, and when it genuinely cannot be read, SAY what could not be read rather than asking again in
// the identical words.
describe('an amount a person typed', () => {
  const env = { CHAIN_ID: '34348', DELEGATION_MANAGER: '0x'.padEnd(42, '1'), MOCK_USDC: '0x'.padEnd(42, '2') } as never;
  const where = { stepRef: 's0', toolId: 'treasury.payment.execute', capabilityId: 'treasury.payment.execute', required: ['amount'] };

  const norm = async (usdc: string) => resolveStepArgs({ usdc }, env, {}, where);

  it.each([
    ['10 usdc', '10000000'],
    ['$10', '10000000'],
    ['10 dollars', '10000000'],
    ['  12.50  ', '12500000'],
    ['1,000', '1000000000'],
  ])('reads %s', async (typed, expected) => {
    const out = await norm(typed);
    expect(out.amount).toBe(expected);
  });

  it('names what it could not read instead of asking the same question again', async () => {
    let raised: unknown = null;
    try { await norm('a tenner'); } catch (e) { raised = e; }
    expect(isInputRequired(raised)).toBe(true);
    expect((raised as { request: { prompt: string } }).request.prompt).toContain('a tenner');
  });
});

// ── A PLACEHOLDER IS AN OMISSION (the live report: "I could not find <UNKNOWN>") ──
describe('a planner placeholder in a party argument', () => {
  const env = { CHAIN_ID: '34348', DELEGATION_MANAGER: '0x'.padEnd(42, '1'), MOCK_USDC: '0x'.padEnd(42, '2') } as never;

  it('is never looked up as a name — the argument is absent, and the question is the right one', async () => {
    const seen: string[] = [];
    const lookups = {
      resolveName: async (n: string) => { seen.push(n); return null; },
      // One treasury of theirs, so the acting-party branch can answer rather than ask.
      readSubjectRecord: async (_s: string, r: string) => (r === 'relationships.data'
        ? { orgs: { '0xaaa': { org: '0xaaa', agent: '0xaaa', name: 'mine.treasury', kind: 'person-treasury', parent: '0xb0b', relationship: 'steward', updatedAt: '' } } }
        : null),
    } as never;
    const out = await resolveStepArgs(
      { payer: '<UNKNOWN>', payee: 'bob', usdc: '2' },
      env, lookups,
      { stepRef: 's0', toolId: 'treasury.payment.execute', capabilityId: 'treasury.payment.execute', authorityArg: 'payer', subject: '0xb0b' },
    ).catch((e) => e);
    // Whatever else happened, nobody went looking for an agent called "<UNKNOWN>".
    expect(seen.some((n) => /unknown/i.test(n))).toBe(false);
  });
});

// ── A UNIT THE PLANNER COMPUTED IS NOT A UNIT (the live incident: 0.00002 USDC) ──
//
// Asked to send 20 USDC the planner wrote `amount: "20"` — the base-unit field — and twenty smallest
// units settled on chain under a mandate every gate approved. The receipt read "0.00002 USDC", which is
// the only reason anyone noticed.
describe('an amount the planner wrote in the wrong unit', () => {
  const env = { CHAIN_ID: '34348', DELEGATION_MANAGER: '0x'.padEnd(42, '1'), MOCK_USDC: '0x'.padEnd(42, '2') } as never;
  const where = { stepRef: 's0', toolId: 'treasury.payment.execute', capabilityId: 'treasury.payment.execute' };

  it('is never converted for them — it is named back, and the person says what it is in', async () => {
    let raised: unknown = null;
    try { await resolveStepArgs({ amount: '20' }, env, {}, where); } catch (e) { raised = e; }
    expect(isInputRequired(raised)).toBe(true);
    const req = (raised as { request: { prompt: string; fields: Array<{ name: string }> } }).request;
    expect(req.prompt).toContain('20');
    expect(req.fields[0]!.name).toBe('usdc');
  });

  it('a SCREEN\'s supplied plan may still state base units — it computed them', async () => {
    const out = await resolveStepArgs({ amount: '20000000' }, env, {}, { ...where, computedUnits: true });
    expect(out.amount).toBe('20000000');
  });

  it('the human figure still converts, exactly once', async () => {
    const out = await resolveStepArgs({ usdc: '20' }, env, {}, where);
    expect(out.amount).toBe('20000000');
    expect(out.usdc).toBeUndefined();
  });
});

// ── THE TOKEN IS A DEPLOYMENT FACT (it was lost in a refactor and the mandate carried asset: "") ──
describe('the asset a payment is in', () => {
  const env = { CHAIN_ID: '34348', DELEGATION_MANAGER: '0x'.padEnd(42, '1'), MOCK_USDC: '0xdae09066a2cc32f6203605619137dcf01a9b49ae' } as never;

  it('is pinned from the deployment, whatever the planner wrote', async () => {
    for (const wrote of [{}, { asset: 'usdc' }, { asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e' }]) {
      const out = await resolveStepArgs({ ...wrote, usdc: '1' }, env, {}, {
        stepRef: 's0', toolId: 'treasury.payment.execute', capabilityId: 'treasury.payment.execute',
      });
      expect(out.asset, `planner wrote ${JSON.stringify(wrote)}`).toBe('0xdae09066a2cc32f6203605619137dcf01a9b49ae');
    }
  });
});

// ── A STANDING INSTRUCTION FILLS THE UNSPOKEN ACTING PARTY (spec 394) ──
describe('a standing instruction for the acting party', () => {
  const env = { CHAIN_ID: '34348', DELEGATION_MANAGER: '0x'.padEnd(42, '1'), MOCK_USDC: '0x'.padEnd(42, '2') } as never;
  const T2 = '0x00000000000000000000000000000000000000a2';
  const T3 = '0x00000000000000000000000000000000000000a3';
  const ORG = '0x00000000000000000000000000000000000000c1';
  const rows = { orgs: { [T2]: { org: T2, agent: T2, name: 'alice2.treasury', kind: 'person-treasury', parent: '0xb0b', relationship: 'steward', updatedAt: '' }, [T3]: { org: T3, agent: T3, name: 'alice3.treasury', kind: 'person-treasury', parent: '0xb0b', relationship: 'steward', updatedAt: '' } } };
  const where = { stepRef: 's0', toolId: 'treasury.payment.execute', capabilityId: 'treasury.payment.execute', authorityArg: 'payer', subject: '0xb0b' };
  const lookupsWith = (standing: (scope: { capability: string; arg: string; context?: string }) => Promise<{ value: string; saidAs?: string } | null>, resolved: Array<Record<string, unknown>> = []) => ({
    readSubjectRecord: async (_s: string, r: string) => (r === 'relationships.data' ? rows : null),
    standingInstruction: standing,
    onResolved: (r: Record<string, unknown>) => { resolved.push(r); },
  }) as never;

  it('fills the payer the person did not speak, and cites it as standing', async () => {
    const resolved: Array<Record<string, unknown>> = [];
    const asked: unknown[] = [];
    const out = await resolveStepArgs({ payee: T2, usdc: '1' }, env, lookupsWith(async (scope) => { asked.push(scope); return { value: T3, saidAs: 'pay from alice3' }; }, resolved), where);
    expect(out.payer).toBe(T3);
    expect(asked).toEqual([{ capability: 'treasury.payment.execute', arg: 'payer' }]);
    expect(resolved.find((r) => r.arg === 'payer')).toMatchObject({ agent: T3, via: 'standing' });
  });

  it('never overrides a spoken payer', async () => {
    const out = await resolveStepArgs({ payer: T2, payee: '0x00000000000000000000000000000000000000d1', usdc: '1' }, env, lookupsWith(async () => ({ value: T3 })), where);
    expect(out.payer).toBe(T2);
  });

  it('ignores a default that is no longer one of the person’s own treasuries (revalidated)', async () => {
    const resolved: Array<Record<string, unknown>> = [];
    const out = await resolveStepArgs({ payee: '0x00000000000000000000000000000000000000d1', usdc: '1' }, env, lookupsWith(async () => ({ value: '0x00000000000000000000000000000000000000ee' }), resolved), where).catch((e) => e);
    // whatever the branch did next (a choice between her two treasuries), the stale default was not used
    expect(out?.payer).not.toBe('0x00000000000000000000000000000000000000ee');
    expect(resolved.some((r) => r.via === 'standing')).toBe(false);
  });

  it('asks for the ROOM it is standing in — the organization addressed — so a default for another room is never read', async () => {
    const asked: Array<{ context?: string }> = [];
    await resolveStepArgs({ payee: T2, usdc: '1' }, env, lookupsWith(async (scope) => { asked.push(scope); return null; }), { ...where, addressee: ORG }).catch(() => undefined);
    expect(asked[0]?.context).toBe(ORG);
  });
});
