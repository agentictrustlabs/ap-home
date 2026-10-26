// An approval made a moment ago is given a few seconds to reach the node a read lands on; nothing else waits.
import { describe, it, expect } from 'vitest';
import { verifyAllowingSettle } from '../src/chain-settle.js';

const noSleep = async () => {};
/** A chain whose reads say false `lag` times, then true. */
const lagging = (lag: number) => { let n = 0; return { read: async () => n++ >= lag, reads: () => n }; };

describe('a just-approved hash (0x03)', () => {
  it('verifies once the node catches up — not refused on the first stale read', async () => {
    const c = lagging(2);
    expect(await verifyAllowingSettle(c.read, '0x03', { sleep: noSleep })).toBe(true);
    expect(c.reads()).toBe(3);
  });
  it('is refused when it never lands, after a bounded number of reads', async () => {
    const c = lagging(99);
    expect(await verifyAllowingSettle(c.read, '0x03', { sleep: noSleep, tries: 5 })).toBe(false);
    expect(c.reads()).toBe(5);
  });
  it('a read that throws counts as not yet', async () => {
    let n = 0;
    const read = async () => { if (n++ === 0) throw new Error('rpc'); return true; };
    expect(await verifyAllowingSettle(read, '0x03', { sleep: noSleep })).toBe(true);
  });
});

describe('any other signature', () => {
  it('is answered by its first read — a key signature does not become valid later', async () => {
    const c = lagging(1);
    expect(await verifyAllowingSettle(c.read, '0xabcdef', { sleep: noSleep })).toBe(false);
    expect(c.reads()).toBe(1);
  });
});
