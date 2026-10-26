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

import { submitUntilRun } from '../src/chain-settle.js';

describe('a userOp that is not in its receipt', () => {
  const OURS = { ok: true }; const NOT_IN_IT = { ok: false, matched: false };
  it('is sent again while the account nonce says it never ran — and is ours once it does', async () => {
    let sends = 0;
    const out = await submitUntilRun({ submit: async () => ++sends, judge: (n) => (n < 2 ? NOT_IN_IT : OURS), nonceNow: async () => 7n, opNonce: 7n });
    expect(out.ran).toBe('here'); expect(sends).toBe(2);
  });
  it('ran in another transaction (the nonce moved): success, not sent twice', async () => {
    let sends = 0;
    const out = await submitUntilRun({ submit: async () => ++sends, judge: () => NOT_IN_IT, nonceNow: async () => 8n, opNonce: 7n });
    expect(out.ran).toBe('elsewhere'); expect(sends).toBe(1);
  });
  it('never runs: said so after a bounded number of sends — never reported as done', async () => {
    let sends = 0;
    const out = await submitUntilRun({ submit: async () => ++sends, judge: () => NOT_IN_IT, nonceNow: async () => 7n, opNonce: 7n, tries: 3 });
    expect(out.ran).toBe('not-run'); expect(sends).toBe(3);
  });
  it('a receipt that names our op (ok or reverted) is judged by the caller, not sent again', async () => {
    let sends = 0;
    const out = await submitUntilRun({ submit: async () => ++sends, judge: () => ({ ok: false, matched: true }), nonceNow: async () => 7n, opNonce: 7n });
    expect(out.ran).toBe('here'); expect(sends).toBe(1);
  });
});
