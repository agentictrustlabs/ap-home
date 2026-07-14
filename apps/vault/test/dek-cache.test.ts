import { describe, it, expect } from 'vitest';
import type { DekWrapper } from '@agenticprimitives/vault';
import { cachingDekWrapper } from '../src/dek-cache';

// A stub DekWrapper that counts unwrap calls and returns a deterministic DEK derived from its inputs,
// so a cache HIT (inner not called) vs MISS (inner called) is observable.
function stub() {
  let unwraps = 0;
  let generates = 0;
  const inner: DekWrapper = {
    async generateSessionDataKey(input) {
      generates++;
      void input;
      return { plaintextDataKey: new Uint8Array([9, 9]), encryptedDataKey: new Uint8Array([9]), keyId: 'k', keyVersion: '1' };
    },
    async decryptSessionDataKey(input) {
      unwraps++;
      // DEK bytes = first wrapped byte + a marker, so identical inputs yield identical output.
      return new Uint8Array([input.encryptedDataKey[0] ?? 0, 0xaa]);
    },
  };
  return { inner, get unwraps() { return unwraps; }, get generates() { return generates; } };
}

const req = (edk: number[], keyId = 'kek-A', keyVersion = '1', aad: Record<string, string> = { owner: '0xabc', resource: 'vault:x' }) => ({
  encryptedDataKey: new Uint8Array(edk),
  aadContext: aad,
  keyId,
  keyVersion,
});

describe('cachingDekWrapper', () => {
  it('memoizes an identical unwrap (2nd call is a cache hit — inner NOT called again)', async () => {
    const s = stub();
    const w = cachingDekWrapper(s.inner);
    const a = await w.decryptSessionDataKey(req([1, 2, 3]));
    const b = await w.decryptSessionDataKey(req([1, 2, 3]));
    expect(s.unwraps).toBe(1);
    expect([...a]).toEqual([...b]);
  });

  it('misses on a different wrapped DEK, keyId, keyVersion, or aad (each re-calls KMS)', async () => {
    const s = stub();
    const w = cachingDekWrapper(s.inner);
    await w.decryptSessionDataKey(req([4, 0, 0]));                                   // 1
    await w.decryptSessionDataKey(req([5, 0, 0]));                                   // 2 — different DEK
    await w.decryptSessionDataKey(req([4, 0, 0], 'kek-B'));                          // 3 — different KEK (owner)
    await w.decryptSessionDataKey(req([4, 0, 0], 'kek-A', '2'));                     // 4 — rotated KEK version
    await w.decryptSessionDataKey(req([4, 0, 0], 'kek-A', '1', { owner: '0xZ', resource: 'vault:x' })); // 5 — different aad
    expect(s.unwraps).toBe(5);
  });

  it('returns a COPY — mutating the result never corrupts a later cache hit', async () => {
    const s = stub();
    const w = cachingDekWrapper(s.inner);
    const first = await w.decryptSessionDataKey(req([7, 7, 7]));
    first.fill(0); // caller scribbles on its DEK buffer
    const second = await w.decryptSessionDataKey(req([7, 7, 7]));
    expect(s.unwraps).toBe(1);            // still a hit
    expect([...second]).toEqual([7, 0xaa]); // uncorrupted
  });

  it('never caches generateSessionDataKey (a fresh DEK per write)', async () => {
    const s = stub();
    const w = cachingDekWrapper(s.inner);
    await w.generateSessionDataKey({ aadContext: { owner: '0xabc', resource: 'vault:x' } });
    await w.generateSessionDataKey({ aadContext: { owner: '0xabc', resource: 'vault:x' } });
    expect(s.generates).toBe(2);
  });
});
