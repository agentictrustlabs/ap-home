// Spec 445 (audit RUNC-2) — membership is two-sided in this app's own gates.
//
// The asker's own `relationships.data` row used to read as `member`, and three call sites admitted anything that
// was "not none": anyone could write `{ orgs: { <any org>: {} } }` into their own vault and be shown that
// organization's work. The row now yields `claimed`, which `belongs()` refuses; `member` needs the
// organization's OWN record of them.
import { describe, expect, it } from 'vitest';
import { deriveStanding } from '@agenticprimitives/context';
import { endeavorReadInvoker, ENDEAVOR_LIST_CAPABILITY } from '../../src/coordination-bindings.js';
import { routedStepsOf } from '../../src/harness-run.js';

const ORG = '0x1111111111111111111111111111111111111111' as const;
const ASKER = '0x2222222222222222222222222222222222222222' as const;
const ctx = { step: { id: 's0', toolId: ENDEAVOR_LIST_CAPABILITY, args: {} } } as never;

/** A vault per subject. The asker's own tier holds a row naming the org; the org's side is what varies. */
const vaults = (orgSide: Record<string, unknown>) => async (subject: string, record: string): Promise<unknown> => {
  if (subject.toLowerCase() === ASKER && record === 'relationships.data') return { v: 1, orgs: { [ORG]: { name: 'calvary.org', relationship: 'member' } } };
  if (subject.toLowerCase() === ORG) return orgSide[record] ?? null;
  return null;
};

describe('RUNC-2 — the asker\'s own row is a claim, not membership', () => {
  it('deriveStanding answers `claimed` when only the asker\'s vault names the organization', async () => {
    const st = await deriveStanding({ readSubjectRecord: vaults({}) }, { principal: ASKER, subject: ORG });
    expect(st.relation).toBe('claimed');
    expect(st.canGrant).toBe(false);
  });

  it('coordination.endeavor.list refuses a claimed asker — the organization\'s work is not read', async () => {
    const reads: string[] = [];
    const read = vaults({ 'coordination.index': { v: 1, endeavors: { e1: { id: 'e1', title: 'secret plan' } } } });
    const out = await endeavorReadInvoker({ readSubjectRecord: async (s, r) => { reads.push(`${s.toLowerCase()}:${r}`); return read(s, r); } }, ORG, ASKER)(ENDEAVOR_LIST_CAPABILITY, { org: ORG }, ctx) as { endeavors: unknown[]; refused?: string };
    expect(out.endeavors).toEqual([]);
    expect(out.refused).toMatch(/only someone who belongs there can see it/);
    expect(out.refused).toMatch(/holds no record of you as a member/);
    expect(JSON.stringify(out)).not.toContain('secret plan');
  });

  it('…and admits the same asker once the ORGANIZATION lists them', async () => {
    const read = vaults({ 'directory.data': { v: 1, listings: [{ smartAgent: ASKER, displayName: 'Asker' }] } });
    const st = await deriveStanding({ readSubjectRecord: read }, { principal: ASKER, subject: ORG });
    expect(st.relation).toBe('member');
    const out = await endeavorReadInvoker({ readSubjectRecord: read }, ORG, ASKER)(ENDEAVOR_LIST_CAPABILITY, { org: ORG }, ctx) as { refused?: string };
    expect(out.refused).toBeUndefined();
  });

  it('a routed hop\'s receipt that says `claimed` is not lifted as standing; `member` is', () => {
    const hop = (relation: string) => routedStepsOf([{ stepRef: 's0', step: { toolId: 't' }, result: { via: { agent: ORG, receipts: [{ binding: { standing: { relation, subject: ORG, principal: ASKER, because: 'x' } } }] } } }])[0]!;
    expect(hop('claimed').standing).toBeUndefined();
    expect(hop('none').standing).toBeUndefined();
    expect(hop('some-future-relation').standing).toBeUndefined();
    expect(hop('member').standing?.relation).toBe('member');
  });
});
