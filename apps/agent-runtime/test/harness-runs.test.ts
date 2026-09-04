// Spec 350 W3 — what a durable run may carry between turns, and what it must never.
import { describe, expect, it } from 'vitest';
import { mergeTurn, type HarnessRunCheckpointV1 } from '../src/harness-runs.js';

const ADDRESSEE = '0xee11dfb02e4a02630be512886305df5c68fd682c' as const;
const ASKER = '0xb0d11ce19b756a682e78b4904cd8d832303b3d11' as const;
const wire = { delegator: ADDRESSEE, delegate: '0xd34c', authority: '0x', caveats: [], salt: '1', signature: '0xsig' } as never;
const stored: HarnessRunCheckpointV1 = {
  runRef: 'r1', message: 'create a team called outreach', addressee: ADDRESSEE, asker: ASKER,
  presented: wire, supplied: [{ stepRef: 's0', data: { label: 'outreach' } }], createdAt: 1, updatedAt: 1,
};

describe('resuming a run', () => {
  it('carries the question, the mandate and every answer — so the browser need not', () => {
    const t = mergeTurn(stored, {});
    expect(t).toMatchObject({ message: stored.message, presented: wire });
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
    expect(mergeTurn(null, { message: 'hello' })).toMatchObject({ message: 'hello', presented: null, supplied: [] });
  });

  it('a mandate presented THIS turn wins over the stored one — a person may re-grant', () => {
    const fresher = { ...wire, signature: '0xnewer' } as never;
    expect(mergeTurn(stored, { presented: fresher })).toMatchObject({ presented: fresher });
  });
});
