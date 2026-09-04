import { describe, it, expect } from 'vitest';
import { deriveStanding, standingNote, chainStewardshipCheck } from '../src/standing.js';
import type { Address } from 'viem';

const ALICE = '0x00000000000000000000000000000000000000a1' as Address;
const ORG = '0x00000000000000000000000000000000000000c1' as Address;
const TARGETS = '0x00000000000000000000000000000000000000e1';
const SCOPE = '0x00000000000000000000000000000000000000e2';

const tree = (rows: unknown[]) => async (subject: string, type: string) =>
  subject.toLowerCase() === ALICE && type === 'relationships.data' ? { rows } : null;

describe('standing — what a person is to an agent (spec 353 S5)', () => {
  it('self needs no evidence at all', async () => {
    const s = await deriveStanding({}, { principal: ALICE, subject: ALICE });
    expect(s.relation).toBe('self');
    expect(s.canGrant).toBe(true);
  });

  it('a held stewardship wire is STEWARD only once the chain agrees', async () => {
    const rows = [{ orgAgent: ORG, orgName: 'Calvary', relationship: 'steward', stewardshipDelegation: { any: 'wire' } }];
    const yes = await deriveStanding({ readSubjectRecord: tree(rows), verifyStewardship: async () => true }, { principal: ALICE, subject: ORG });
    expect(yes.relation).toBe('steward');
    expect(yes.canGrant).toBe(true);
    expect(yes.because).toContain('Calvary');

    // The SAME row, the same self-declared `relationship: 'steward'`, a wire that does not verify.
    const no = await deriveStanding({ readSubjectRecord: tree(rows), verifyStewardship: async () => false }, { principal: ALICE, subject: ORG });
    expect(no.relation).toBe('member');   // not "steward, unverified" — it is not stewardship
    expect(no.canGrant).toBe(false);
  });

  it('with no verifier, a wire is not taken on its word', async () => {
    const rows = [{ orgAgent: ORG, orgName: 'Calvary', relationship: 'steward', stewardshipDelegation: { any: 'wire' } }];
    const s = await deriveStanding({ readSubjectRecord: tree(rows) }, { principal: ALICE, subject: ORG });
    expect(s.canGrant).toBe(false);
  });

  it('a linked non-steward is a MEMBER, and the sentence says who must act', async () => {
    const s = await deriveStanding({ readSubjectRecord: tree([{ orgAgent: ORG, orgName: 'Calvary', relationship: 'member' }]) }, { principal: ALICE, subject: ORG });
    expect(s.relation).toBe('member');
    expect(standingNote(s, 'create teams')).toMatch(/steward has to authorize it/);
  });

  it('a member with no link of their own is found in the ROSTER', async () => {
    const read = async (subject: string, type: string) =>
      subject.toLowerCase() === ORG.toLowerCase() && type === 'directory.data'
        ? { listings: [{ smartAgent: ALICE }] } : { rows: [] };
    const s = await deriveStanding({ readSubjectRecord: read }, { principal: ALICE, subject: ORG });
    expect(s.relation).toBe('member');
  });

  it('an UNREADABLE tier is not `none` — it propagates, so the caller can say so', async () => {
    await expect(deriveStanding({ readSubjectRecord: async () => { throw new Error('vault unreachable'); } }, { principal: ALICE, subject: ORG }))
      .rejects.toThrow('vault unreachable');
  });

  it('no link anywhere is `none` — and canGrant is false without refusing the ask', async () => {
    const s = await deriveStanding({ readSubjectRecord: async () => null }, { principal: ALICE, subject: ORG });
    expect(s.relation).toBe('none');
    expect(s.canGrant).toBe(false);
    expect(standingNote(s, 'make payments')).toContain('no link');
  });

  it('a granting standing produces NO note — there is nothing to warn about', async () => {
    const s = await deriveStanding({}, { principal: ALICE, subject: ALICE });
    expect(standingNote(s, 'create teams')).toBe('');
  });
});

describe('chainStewardshipCheck — shape before signature', () => {
  const ROOT = `0x${'0'.repeat(64)}` as const;
  const wire = (enforcers: string[]) => ({
    delegator: ORG, delegate: ALICE, authority: ROOT, salt: '1', signature: '0xsig',
    caveats: enforcers.map((enforcer) => ({ enforcer, terms: '0x', args: '0x' })),
  });
  const check = (readContract: (a: never) => Promise<unknown>) => chainStewardshipCheck({
    readContract, chainId: 34348, delegationManager: '0x00000000000000000000000000000000000000d1' as Address,
    allowedTargetsEnforcer: TARGETS, vaultRecordScopeEnforcer: SCOPE,
    isRevokedAbi: [], validator: '0x00000000000000000000000000000000000000f1' as Address, validatorAbi: [],
  });
  const chainSaysYes = async (a: never) => ((a as { functionName: string }).functionName === 'isValidSig' ? true : false);

  it('accepts a governance wire the chain confirms', async () => {
    expect(await check(chainSaysYes)({ org: ORG, person: ALICE, wire: wire([TARGETS]) })).toBe(true);
  });

  it("REFUSES a member's vault-record grant — signed, valid, unrevoked, and not stewardship", async () => {
    const membersDataGrant = wire([TARGETS, SCOPE]);
    expect(await check(chainSaysYes)({ org: ORG, person: ALICE, wire: membersDataGrant })).toBe(false);
  });

  it('refuses a wire delegated to someone else, before reading any chain', async () => {
    let reads = 0;
    const counted = async (a: never) => { reads++; return chainSaysYes(a); };
    const other = { ...wire([TARGETS]), delegate: '0x00000000000000000000000000000000000000b2' };
    expect(await check(counted)({ org: ORG, person: ALICE, wire: other })).toBe(false);
    expect(reads).toBe(0);
  });

  it('a malformed record fails closed instead of throwing', async () => {
    const junk = { delegator: ORG, delegate: ALICE, caveats: [{ enforcer: TARGETS }], salt: 'not-a-number', signature: '0xsig' };
    await expect(check(chainSaysYes)({ org: ORG, person: ALICE, wire: junk })).resolves.toBe(false);
  });

  it('refuses a revoked wire, and an unreadable revocation state', async () => {
    const revoked = async (a: never) => ((a as { functionName: string }).functionName === 'isValidSig' ? true : true);
    expect(await check(revoked)({ org: ORG, person: ALICE, wire: wire([TARGETS]) })).toBe(false);
    const throws = async (a: never) => ((a as { functionName: string }).functionName === 'isValidSig' ? true : Promise.reject(new Error('rpc')));
    expect(await check(throws)({ org: ORG, person: ALICE, wire: wire([TARGETS]) })).toBe(false);
  });
});
