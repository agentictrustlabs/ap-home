// Gap register B6a — "what's waiting on me?" answered from the same two sources as the Home's bell.
import { describe, it, expect } from 'vitest';
import { waitingItems } from '../../src/waiting-on-me.js';

const ME = '0x1dba000000000000000000000000000000000001';
const OTHER = '0x2222222222222222222222222222222222222222';
const ORG = '0x3b99f2b452766de5df0dbcdfc676f27257151333';
const NOW = Date.UTC(2026, 8, 29, 12);
const run = (o: Record<string, unknown>) => ({ runRef: 'r', message: 'invite nathan to missio nexus', addressee: ME, asker: ME, supplied: [], createdAt: NOW - 60_000, updatedAt: NOW - 60_000, ...o }) as never;

describe('waitingItems', () => {
  it('her parked signature and an invitation she has not accepted are waiting on her, newest first', () => {
    const w = waitingItems(ME, [run({ awaiting: { kind: 'authority', prompt: 'grant invite members', stepRef: 's0', expiresAt: NOW + 600_000 } })],
      [{ org: ORG, name: 'missio-nexus.org', invitedAt: new Date(NOW - 1_000).toISOString(), joined: false }], NOW);
    expect(w.map((x) => x.kind)).toEqual(['invitation', 'signature']);
    expect(w[0]!.title).toBe('Invitation to join missio-nexus.org');
  });
  it('an expired run, a run someone else started, a commitment owed by another agent, and a joined invitation wait on nobody', () => {
    const w = waitingItems(ME, [
      run({ awaiting: { kind: 'signature', prompt: 'sign', stepRef: 's0', expiresAt: NOW - 1 } }),
      run({ asker: OTHER, awaiting: { kind: 'data', prompt: 'which?', stepRef: 's0' } }),
      run({ awaiting: { kind: 'commitment', prompt: 'the org owes', stepRef: 's0', expiresAt: NOW + 1_000 } }),
    ], [{ org: ORG, name: 'missio-nexus.org', joined: true }], NOW);
    expect(w).toEqual([]);
  });
});
