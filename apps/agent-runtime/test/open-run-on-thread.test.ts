// Spec 400 W2 (B3) — which run a mention on a thread continues: the newest unexpired run on THAT thread that waits
// for data; a run waiting on a signature is not resumable by words; another thread's run is not this thread's.
import { describe, it, expect } from 'vitest';
import { openRunOnThread, type SuspendedRunV1 } from '../src/harness-runs.js';

const now = 1_800_000_000_000;
const run = (over: Partial<SuspendedRunV1>): SuspendedRunV1 => ({ runRef: 'r', message: 'm', addressee: '0xaa' as never, supplied: [], createdAt: now - 60_000, updatedAt: now - 60_000, expiresAt: now + 60_000, ...over } as SuspendedRunV1);

describe('openRunOnThread', () => {
  it('finds the newest data-wait on the thread and ignores the rest', () => {
    const runs = [
      run({ runRef: 'old', thread: 't1', awaiting: { kind: 'data', prompt: 'which?', stepRef: 's0', expiresAt: now + 1000 }, updatedAt: now - 5000 }),
      run({ runRef: 'new', thread: 't1', awaiting: { kind: 'data', prompt: 'when?', stepRef: 's1', expiresAt: now + 1000 }, updatedAt: now - 1000 }),
      run({ runRef: 'sig', thread: 't1', awaiting: { kind: 'signature', prompt: 'sign', stepRef: 's0', expiresAt: now + 1000 }, updatedAt: now }),
      run({ runRef: 'other', thread: 't2', awaiting: { kind: 'data', prompt: 'x', stepRef: 's0', expiresAt: now + 1000 }, updatedAt: now }),
      run({ runRef: 'expired', thread: 't1', awaiting: { kind: 'data', prompt: 'x', stepRef: 's0', expiresAt: now - 1 }, updatedAt: now }),
    ];
    expect(openRunOnThread(runs, 't1', now)?.runRef).toBe('new');
    expect(openRunOnThread(runs, 't3', now)).toBeNull();
    expect(openRunOnThread(runs.filter((r) => r.runRef === 'sig'), 't1', now)).toBeNull();
  });
});
