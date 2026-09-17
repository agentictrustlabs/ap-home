import { describe, it, expect } from 'vitest';
import { decodeFunctionData } from 'viem';
import { stableStringify, bundleDigest, anchorCallData, ANCHOR_ABI, ZERO32 } from '../../src/receipt-anchor.js';

describe('the receipt anchor (spec 406 W2)', () => {
  it('stable JSON: the same bytes from any holder — key order and undefineds do not matter; a changed value does', () => {
    const a = { b: 1, a: { y: [1, { z: 2, x: 1 }], x: undefined }, c: 'w' };
    const b = { c: 'w', a: { y: [1, { x: 1, z: 2 }] }, b: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(bundleDigest(a)).toBe(bundleDigest(b));
    expect(bundleDigest({ ...a, c: 'W' })).not.toBe(bundleDigest(a));
    expect(bundleDigest(a)).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it('the call is execute(registry, 0, anchor(digest, intent, mandate)) — three digests, nothing else', () => {
    const registry = '0x0e339334B4438F7546FD53837FDC8943cB3Cf54C';
    const d = bundleDigest({ run: 1 });
    const call = anchorCallData(registry, d, ZERO32, ZERO32);
    const outer = decodeFunctionData({ abi: [{ type: 'function', name: 'execute', stateMutability: 'nonpayable', inputs: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }], outputs: [] }] as const, data: call });
    expect(outer.args[0]).toBe(registry); expect(outer.args[1]).toBe(0n);
    const inner = decodeFunctionData({ abi: ANCHOR_ABI, data: outer.args[2] as `0x${string}` });
    expect(inner.functionName).toBe('anchor'); expect(inner.args).toEqual([d, ZERO32, ZERO32]);
  });
});
