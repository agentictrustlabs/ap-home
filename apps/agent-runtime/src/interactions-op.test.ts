import { describe, expect, it } from 'vitest';
import { isInteractionsOp } from './interactions-op.js';

const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
/** What the object parses from the URL the router builds (interactions-do.ts handleOp). */
const parsedPrincipal = (op: string): string => new URL(`https://do/interactions/${A}/${op}`).pathname.split('/').filter(Boolean)[1] ?? '';

describe('interactions op shape', () => {
  it('accepts every real op shape', () => {
    for (const op of ['status', 'grant', 'record.get', 'grant.delivery.put', 'directory.defaultOrg', 'internal.runtime.pairing.start', 'endeavor.list', 'internal.dm.body.put']) {
      expect(isInteractionsOp(op), op).toBe(true);
    }
  });

  it('refuses an op that would change the principal in the internal URL', () => {
    const crafted = [`../${B}/status`, `..\${B}\status`, `./../${B}/record.get`, `x/../../${B}/grant`, `..%2F${B}%2Fstatus`, `..%2f${B}%2fstatus`, `%2E%2E/${B}/status`];
    for (const op of crafted) expect(isInteractionsOp(op), op).toBe(false);
    // The premise, so this test fails loudly if URL parsing ever changes: the first one DOES collapse to B.
    expect(parsedPrincipal(`../${B}/status`)).toBe(B);
  });

  it('refuses anything that is not dot-separated words', () => {
    for (const op of ['', '.', '..', '.status', 'status.', 'a..b', 'a/b', 'a b', 'a?b=1', 'a#b', '1abc', 'a'.repeat(81), 'a\nb']) {
      expect(isInteractionsOp(op), JSON.stringify(op)).toBe(false);
    }
    for (const v of [undefined, null, 7, {}]) expect(isInteractionsOp(v)).toBe(false);
  });

  it('no accepted op changes the principal the object parses', () => {
    for (const op of ['status', 'a.b.c', 'a-b.c-d', 'internal.x']) expect(parsedPrincipal(op)).toBe(A);
  });
});
