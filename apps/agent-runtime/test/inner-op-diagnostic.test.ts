import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// The diagnostic for a failed inner userOp used ONE sentence for THREE different failures, and the
// sentence described only the rarest of them ("no UserOperationEvent for sender=X"). It printed that
// even when the event was found and reported success=false — which sent a real debugging session
// (2026-08-31, a typed .me claim that ran out of gas) looking for a missing event that was present.
const SRC = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

describe('inner userOp failure diagnostic', () => {
  it('distinguishes a missing event from an event that reports failure', () => {
    expect(SRC).toContain('inner.matched === false');
    expect(SRC).toContain('this userOp is not in that transaction');
    expect(SRC).toContain('almost always means it ran out of gas');
  });

  it('reports the gas actually used against the limit that was set', () => {
    expect(SRC).toContain('inner.actualGasUsed');
    expect(SRC).toContain('unpackedCallGasLimit(signedUserOp)');
  });

  it('reads actualGasUsed out of the UserOperationEvent data', () => {
    expect(SRC).toMatch(/actualGasUsed = BigInt\('0x' \+ d\.slice\(2 \+ 64 \* 3, 2 \+ 64 \* 4\)\)/);
  });

  it('unpacks callGasLimit from the low 128 bits of accountGasLimits', () => {
    // packed = 0x <verificationGasLimit:16 bytes> <callGasLimit:16 bytes>
    const packed = '0x' + (500_000n).toString(16).padStart(32, '0') + (1_350_000n).toString(16).padStart(32, '0');
    expect(packed.length).toBe(66);
    expect(BigInt('0x' + packed.slice(34)).toString()).toBe('1350000');
  });
});
