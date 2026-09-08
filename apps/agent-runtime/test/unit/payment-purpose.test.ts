import { describe, expect, it } from 'vitest';
import { paymentAskOf, splitPurpose } from '../../src/harness-run.js';

// The reason is not the payee: "to cover poker night" is why, carried as memo, never looked up as an agent.
describe('a payment sentence with a reason', () => {
  it('splits the purpose clause and keeps the payee', () => {
    expect(paymentAskOf('Send bob 0.2 USDC to cover poker night last night')).toEqual({ payee: 'bob', usdc: '0.2', memo: 'poker night last night' });
    expect(paymentAskOf('pay carol 20 usdc for the tickets')).toEqual({ payee: 'carol', usdc: '20', memo: 'the tickets' });
    expect(paymentAskOf('send 5 usdc to nathan.me because he bought lunch')).toEqual({ payee: 'nathan.me', usdc: '5', memo: 'he bought lunch' });
    expect(paymentAskOf('send bob 1 usdc')).toEqual({ payee: 'bob', usdc: '1' });
  });
  it('a lone name after "for" is not a reason', () => {
    expect(splitPurpose('send 5 usdc for bob')).toEqual({ body: 'send 5 usdc for bob' });
    expect(splitPurpose('send bob 5 usdc for the retreat')).toEqual({ body: 'send bob 5 usdc', memo: 'the retreat' });
  });
});
