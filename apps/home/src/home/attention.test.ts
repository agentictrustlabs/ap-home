// Spec 398 §5.5 — six filters, each a different thing; a decision is one card wherever it came from.
import { describe, it, expect } from 'vitest';
import { assembleAttention, attentionCounts, type AttentionInputs } from './attention';

const NOW = Date.UTC(2026, 8, 12, 12);
const ME = 'eip155:34348:0x2222222222222222222222222222222222222222';
const base = (): AttentionInputs => ({ now: NOW, parked: [], bundles: [], artifacts: [], triggers: [], vocabulary: [], cases: [], dms: [], me: ME });

describe('attention (398 §5.5)', () => {
  it('unread ≠ decision ≠ exception ≠ artifact', () => {
    const a = assembleAttention({ ...base(),
      parked: [
        { runRef: 'r1', message: 'pay the rent', awaiting: { kind: 'signature', prompt: 'sign', stepRef: 's0' }, updatedAt: NOW, state: 'awaiting-approval' },
        { runRef: 'r2', message: 'which David?', awaiting: { kind: 'data', prompt: 'which', stepRef: 's0' }, updatedAt: NOW, state: 'awaiting-input' },
        { runRef: 'r3', message: 'ask the treasury', awaiting: { kind: 'commitment', prompt: 'waiting', stepRef: 's0' }, updatedAt: NOW, state: 'blocked' },
      ],
      triggers: [{ triggerId: 't1', ask: 'digest', lastOutcome: 'failed', lastAt: NOW }],
      artifacts: [{ id: 'a1', name: 'report', createdAt: NOW - 1000 }],
      dms: [{ key: 'dm1', title: 'Bob', unread: 2, lastEventAt: new Date(NOW).toISOString() }, { key: 'dm2', title: 'Carol', unread: 0, lastEventAt: new Date(NOW).toISOString() }],
    });
    expect(attentionCounts(a).map((c) => `${c.id}=${c.count}`)).toEqual(['decision=1', 'input=1', 'blocked=1', 'failed-routine=1', 'artifact=1', 'unread=1']);
    expect(a.unread[0]!.dmKey).toBe('dm1');
  });

  it('an inbox case pending on ME is a decision; one I requested is not', () => {
    const at = new Date(NOW).toISOString();
    const a = assembleAttention({ ...base(), cases: [
      { id: 'c1', kind: 'access-request', subject: 'read my records', state: 'submitted', requester: 'eip155:34348:0x3333333333333333333333333333333333333333', responder: ME, updatedAt: at },
      { id: 'c2', kind: 'access-request', subject: 'i asked bob', state: 'submitted', requester: ME, responder: 'eip155:34348:0x3333333333333333333333333333333333333333', updatedAt: at },
      { id: 'c3', kind: 'access-request', subject: 'done', state: 'approved', requester: 'eip155:34348:0x3333333333333333333333333333333333333333', responder: ME, updatedAt: at },
    ] });
    expect(a.decision.map((d) => d.caseId)).toEqual(['c1']);
    expect(a.decision[0]!.state?.state).toBe('awaiting-approval');
  });
});
