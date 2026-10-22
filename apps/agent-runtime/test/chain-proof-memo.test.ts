// A CHAIN PROOF IS REMEMBERED BRIEFLY. Before every act the runtime re-proved the presented wire on chain (not revoked,
// signature valid); a positive answer is now remembered for 20 s per isolate — the bound on how long a revocation can go
// unnoticed — and never past it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chainProofRemembered, rememberChainProof } from '../src/harness-run.js';

afterEach(() => vi.useRealTimers());

describe('the chain proof memo', () => {
  it('remembers a positive proof for 20 seconds and no longer', () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });
    const k = `live:${crypto.randomUUID()}`;
    expect(chainProofRemembered(k)).toBe(false);
    rememberChainProof(k);
    expect(chainProofRemembered(k)).toBe(true);
    vi.setSystemTime(1_000_000 + 19_999);
    expect(chainProofRemembered(k)).toBe(true);
    vi.setSystemTime(1_000_000 + 20_001);
    expect(chainProofRemembered(k)).toBe(false);
  });
});
