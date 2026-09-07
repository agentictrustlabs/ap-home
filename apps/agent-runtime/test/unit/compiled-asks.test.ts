import { describe, it, expect } from 'vitest';
import { affiliationAskOf, paymentAskOf } from '../../src/harness-run.js';

describe('affiliationAskOf — what am I part of, by type', () => {
  it('reads the type word onto the ontology suffix', () => {
    expect(affiliationAskOf('what teams am i a part of')).toEqual({ type: 'team' });
    expect(affiliationAskOf('which organizations do I belong to?')).toEqual({ type: 'org' });
    expect(affiliationAskOf('what circles am I in')).toEqual({ type: 'circle' });
    expect(affiliationAskOf('do I have a treasury')).toEqual({ type: 'treasury' });
  });
  it('no type word lists everything; a roster question is not this', () => {
    expect(affiliationAskOf('what am I a part of')).toEqual({ type: null });
    expect(affiliationAskOf('who are the members of missio nexus')).toBeNull();
    expect(affiliationAskOf('send bob 2 usdc')).toBeNull();
  });
});

describe('paymentAskOf — one payment, the words and the amount', () => {
  it('carries the payee’s WORDS and the amount as said', () => {
    expect(paymentAskOf('send 10 usdc to David')).toEqual({ payee: 'David', usdc: '10' });
    expect(paymentAskOf('pay david 10 usdc')).toEqual({ payee: 'david', usdc: '10' });
    expect(paymentAskOf('send bob.me 2.5 USDC')).toEqual({ payee: 'bob.me', usdc: '2.5' });
    expect(paymentAskOf('send 3 usdc to alice from my treasury')).toEqual({ payee: 'alice', usdc: '3' });
  });
  it('omits what was not said, and is not the fan-out or a message', () => {
    expect(paymentAskOf('send 10 usdc')).toEqual({ usdc: '10' });
    expect(paymentAskOf('pay every member 1 usdc')).toBeNull();
    expect(paymentAskOf('send bob a message')).toBeNull();
  });
});
