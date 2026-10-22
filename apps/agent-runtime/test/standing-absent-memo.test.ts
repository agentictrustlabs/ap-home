// "NO STANDING INSTRUCTIONS" IS REMEMBERED BRIEFLY; A FAILED READ NEVER IS. Before every act the resolver read the person's
// standing-instructions record for the unspoken acting party — a vault round trip (~0.9 s) on every save an app makes,
// for a record most people do not keep.
import { describe, expect, it } from 'vitest';
import { standingRecordOf } from '../src/harness-run.js';

const person = () => `0x${crypto.randomUUID().replace(/-/g, '').padEnd(40, '0').slice(0, 40)}`;

describe('reading standing instructions for an act', () => {
  it('reads an absent record once, then answers from memory', async () => {
    let calls = 0;
    const deps = { readSubjectRecordStatus: async () => { calls++; return { ok: true, data: null }; } } as never;
    const p = person();
    expect(await standingRecordOf(deps, p)).toBeNull();
    expect(await standingRecordOf(deps, p)).toBeNull();
    expect(calls).toBe(1);
  });

  it('reads a present record every time, and never remembers a failure', async () => {
    let calls = 0;
    const present = { readSubjectRecordStatus: async () => { calls++; return { ok: true, data: { entries: [] } }; } } as never;
    const p = person();
    expect(await standingRecordOf(present, p)).toEqual({ entries: [] });
    await standingRecordOf(present, p);
    expect(calls).toBe(2);
    let failed = 0;
    const failing = { readSubjectRecordStatus: async () => { failed++; return { ok: false, data: null, error: 'cold' }; } } as never;
    const q = person();
    expect(await standingRecordOf(failing, q)).toBeNull();
    await standingRecordOf(failing, q);
    expect(failed).toBe(2);
  });
});
