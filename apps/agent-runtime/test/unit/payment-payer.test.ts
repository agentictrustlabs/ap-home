// Act laboratory (spec 418) — the payer the person NAMES travels with the payment; a generic "my treasury" does not
// (the declared default decides that, and says why); the payee survives a from-clause in either order.
import { describe, expect, it } from 'vitest';
import { paymentAskOf } from '../../src/harness-run.js';

describe('paymentAskOf — the named payer', () => {
  it('keeps "from <account>" as the payer', () => {
    expect(paymentAskOf('Pay nathan.treasury 3 USDC from alice3.treasury for the soup supplies.')).toEqual({ payee: 'nathan.treasury', payer: 'alice3.treasury', usdc: '3', memo: 'the soup supplies' });
  });
  it('from before to: both parties kept', () => {
    expect(paymentAskOf('send 3 usdc from alice3.treasury to bob')).toEqual({ payee: 'bob', payer: 'alice3.treasury', usdc: '3' });
  });
  it('a generic "my treasury" names no payer', () => {
    expect(paymentAskOf('send 2 usdc from my treasury to bob')).toEqual({ payee: 'bob', usdc: '2' });
  });
  it('no from-clause: no payer', () => {
    expect(paymentAskOf('send bob 1.5 usdc')).toEqual({ payee: 'bob', usdc: '1.5' });
  });
});
