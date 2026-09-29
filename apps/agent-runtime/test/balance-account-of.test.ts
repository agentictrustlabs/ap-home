// The account a balance question names — or none (the asker's own treasuries). Live 2026-09-29: "how much money do i have
// in my treasury" was asked back 'I could not find "i have in my"'.
import { describe, expect, it } from 'vitest';
import { balanceAccountOf } from '../src/harness-run.js';

describe('balanceAccountOf', () => {
  it.each([
    'how much money do i have in my treasury',
    'How much money do I have in my treasury account?',
    'what is my balance',
    'how much is in my treasury?',
    'how much do we have in our treasury',
    'how much money do I have',
    'what are my funds',
  ])('%s → her own treasuries (no account)', (q) => expect(balanceAccountOf(q)).toBeUndefined());
  it.each([
    ['how much does alice2.treasury hold', 'alice2.treasury'],
    ['how much money does missio nexus have', 'missio nexus'],
    ["what's the balance of missio nexus treasury", 'missio nexus'],
    ['how much is in the missio nexus treasury?', 'missio nexus'],
  ])('%s → %s', (q, want) => expect(balanceAccountOf(q)).toBe(want));
});
