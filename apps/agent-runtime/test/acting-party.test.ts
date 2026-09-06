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
import { partyTypesFor, HARNESS_ACTION_TOOLS, NEVER_THE_ASKER } from '../src/harness-run.js';

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
