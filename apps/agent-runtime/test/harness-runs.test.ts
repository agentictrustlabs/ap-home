// Spec 350 W3 — what a durable run may carry between turns, and what it must never.
import { describe, expect, it } from 'vitest';
import { mergeTurn, type HarnessRunCheckpointV1 } from '../src/harness-runs.js';
import { claimableBy } from '../src/endeavor-authority-steps.js';

const ADDRESSEE = '0xee11dfb02e4a02630be512886305df5c68fd682c' as const;
const ASKER = '0xb0d11ce19b756a682e78b4904cd8d832303b3d11' as const;
const wire = { delegator: ADDRESSEE, delegate: '0xd34c', authority: '0x', caveats: [], salt: '1', signature: '0xsig' } as never;
const stored: HarnessRunCheckpointV1 = {
  runRef: 'r1', message: 'create a team called outreach', addressee: ADDRESSEE, asker: ASKER,
  presented: [wire], supplied: [{ stepRef: 's0', data: { label: 'outreach' } }], createdAt: 1, updatedAt: 1,
};

describe('resuming a run', () => {
  it('carries the question, the mandate and every answer — so the browser need not', () => {
    const t = mergeTurn(stored, {});
    expect(t).toMatchObject({ message: stored.message, presented: [wire] });
    expect('supplied' in t ? t.supplied : []).toEqual(stored.supplied);
  });

  it('adds this turn\'s answers to the ones already given, in order', () => {
    const sig = { stepRef: 's0', signature: { digest: '0xd', signer: ASKER, signature: '0xs' } };
    const t = mergeTurn(stored, { supplied: [sig] });
    expect('supplied' in t ? t.supplied : []).toEqual([...stored.supplied, sig]);
  });

  it('refuses a different question on the same run — an ask is ONE thing, and its mandate is bound to it', () => {
    const t = mergeTurn(stored, { message: 'pay someone instead' });
    expect('error' in t ? t.error : '').toMatch(/different question/);
  });

  it('accepts the same question restated (a surface that re-sends what it has is not changing the ask)', () => {
    expect(mergeTurn(stored, { message: `  ${stored.message}  ` })).toMatchObject({ message: stored.message });
  });

  it('a fresh ask needs a question; a resume of nothing is not a run', () => {
    expect(mergeTurn(null, {})).toMatchObject({ error: expect.stringContaining('no question') });
    expect(mergeTurn(null, { message: 'hello' })).toMatchObject({ message: 'hello', presented: [], supplied: [] });
  });

  it('a mandate presented THIS turn is reached FIRST — a person may re-grant, and the fresh key wins', () => {
    // A re-grant carries a fresh salt, so it is a distinct key: both are held and the new one leads.
    // Selection reads the list in order, so "this turn wins" survives the move to a keyring.
    const fresher = { ...(wire as object), salt: '2', signature: '0xnewer' } as never;
    const t = mergeTurn(stored, { presented: fresher });
    expect('presented' in t ? t.presented : []).toEqual([fresher, wire]);
  });

  // ── spec 350 W3 — THE KEYRING (the 4-payment fan-out's 13 turns) ──────────────────────────────────
  it('ACCUMULATES mandates across turns — a fan-out holds a key per item, not just the newest', () => {
    const k2 = { ...(wire as object), salt: '2' } as never;
    const k3 = { ...(wire as object), salt: '3' } as never;
    const afterTwo = mergeTurn(stored, { presented: k2 });
    const t = mergeTurn({ ...stored, presented: 'presented' in afterTwo ? afterTwo.presented : [] }, { presented: k3 });
    expect('presented' in t ? t.presented : []).toEqual([k3, k2, wire]);
  });

  it('does not hold the same wire twice when a client re-sends what the server already has', () => {
    const t = mergeTurn(stored, { presented: wire });
    expect('presented' in t ? t.presented : []).toEqual([wire]);
  });

  it('accepts a whole keyring in one turn (a client MAY send several; it need not)', () => {
    const k2 = { ...(wire as object), salt: '2' } as never;
    const t = mergeTurn(null, { message: 'pay each member', presented: [wire, k2] });
    expect('presented' in t ? t.presented : []).toEqual([wire, k2]);
  });
});

// ── spec 350 W3 — WHAT A LISTING MAY SHOW. The same rule that gates a resume decides what is listed, so
//    a run a person could not pick up is a run they are not shown (ADR-0013: one mechanism).
describe('the runs waiting on a person', () => {
  const OTHER = '0x1111111111111111111111111111111111111111' as const;

  it('shows a person their OWN suspended run', () => {
    expect(claimableBy(stored, ASKER)).toBe(true);
  });

  it('hides someone else\'s half-answered run — their answers and their authority', () => {
    expect(claimableBy(stored, OTHER)).toBe(false);
  });

  it('shows an UNCLAIMED work item to whoever could mint its mandate', () => {
    const workItem = { ...stored, asker: ADDRESSEE, openToStewards: true, supplied: [] };
    expect(claimableBy(workItem, OTHER)).toBe(true);
  });

  it('stops showing a work item once someone has started answering it', () => {
    const started = { ...stored, asker: ADDRESSEE, openToStewards: true };
    expect(claimableBy(started, OTHER)).toBe(false);
  });

  it('the listing shape has no keyring — a list says what is waiting, never hands out mandates', () => {
    // The DO strips `presented`; `claimableBy` must judge without it, or the listing could not use the
    // same rule as the resume.
    const { presented: _p, ...listed } = stored;
    expect(claimableBy(listed, ASKER)).toBe(true);
  });
});
