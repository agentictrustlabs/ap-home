// The bell (B6a): one read of what is the person's to do — signatures, decisions, answers, and invitations not yet accepted.
import { describe, it, expect } from 'vitest';
import { assembleWaiting } from './waiting-on-me';

const NOW = Date.UTC(2026, 8, 29, 12);
const ORG = '0x3b99f2b452766de5df0dbcdfc676f27257151333';

describe('assembleWaiting', () => {
  it('a parked signature, an answer the agent waits for, and an invitation not yet accepted are all waiting on her — newest first', () => {
    const w = assembleWaiting({
      now: NOW, bundles: [],
      parked: [
        { runRef: 'r1', message: 'invite nathan to missio nexus', awaiting: { kind: 'signature', prompt: 'sign', stepRef: 's1' }, updatedAt: NOW - 60_000, state: 'awaiting-approval' },
        { runRef: 'r2', message: 'which David?', awaiting: { kind: 'data', prompt: 'which David', stepRef: 's0' }, updatedAt: NOW - 120_000, state: 'awaiting-input' },
      ] as never,
      invitations: [{ org: ORG, name: 'missio-nexus.org', invitedAt: new Date(NOW - 30_000).toISOString(), joined: false }],
    });
    expect(w.map((x) => x.kind)).toEqual(['invitation', 'signature', 'input']);
    expect(w[0]).toMatchObject({ title: 'Invitation to join missio-nexus.org', href: `/org/${ORG}/discussions` });
  });
  it('an invitation already accepted, and a run that is merely running, wait on nobody', () => {
    const w = assembleWaiting({
      now: NOW, bundles: [],
      parked: [{ runRef: 'r3', message: 'x', awaiting: null, updatedAt: NOW, state: 'running' }] as never,
      invitations: [{ org: ORG, name: 'missio-nexus.org', joined: true }],
    });
    expect(w).toEqual([]);
  });
});
