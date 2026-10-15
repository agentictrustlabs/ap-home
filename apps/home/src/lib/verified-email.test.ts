// The Allow screen names the person by the email they verified (Paul, 2026-10-15: it said only "Signed in" when
// it opened in a different tab than the code step).
import { beforeEach, describe, expect, it } from 'vitest';
import { rememberVerifiedEmail, verifiedEmailFor } from './verified-email';

function store(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';

describe('verified email', () => {
  beforeEach(() => {
    Object.assign(globalThis, { sessionStorage: store(), localStorage: store() });
  });

  it('is read back in the same tab', () => {
    rememberVerifiedEmail(A, 'Host@Church.org');
    expect(verifiedEmailFor(A)).toBe('host@church.org');
  });

  it('is read back in ANOTHER tab of the same browser', () => {
    rememberVerifiedEmail(A, 'host@church.org');
    Object.assign(globalThis, { sessionStorage: store() }); // a new tab: empty sessionStorage, same localStorage
    expect(verifiedEmailFor(A)).toBe('host@church.org');
  });

  it('never names one account with another account’s email', () => {
    rememberVerifiedEmail(A, 'a@church.org');
    rememberVerifiedEmail(B, 'b@church.org');
    expect(verifiedEmailFor(A)).toBe('a@church.org');
    expect(verifiedEmailFor(B)).toBe('b@church.org');
    expect(verifiedEmailFor('0x3333333333333333333333333333333333333333')).toBe('');
  });
});
