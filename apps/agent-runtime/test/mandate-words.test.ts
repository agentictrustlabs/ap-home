/**
 * WHAT THE MANDATE IS FOR, read from the mandate.
 *
 * The planner is told which capability a person has already authorized, so the turn after a grant uses it
 * instead of re-planning into something else ("Authority granted: messaging.direct.send" followed by
 * "I can't help with that"). The first version searched the caveat terms for the capability id's own
 * bytes — but `capabilityHandler` reduces the id to a 4-byte METHOD SELECTOR, so it matched nothing, the
 * guidance was never added, and the bug it was written to fix carried on looking unfixed.
 *
 * So this builds a REAL mandate with the REAL handler and asserts the words come back.
 */
import { describe, it, expect } from 'vitest';
import { capabilityHandler, CAPABILITY_RAR_TYPE, type MandateRequirementV1 } from '@agenticprimitives/delegation';
import { mandateCapabilityWords } from '../src/harness-run.js';

const E = {
  delegationManager: '0x00000000000000000000000000000000000000d1',
  timestamp: '0x00000000000000000000000000000000000000e1',
  allowedTargets: '0x00000000000000000000000000000000000000e2',
  allowedMethods: '0x00000000000000000000000000000000000000e3',
  value: '0x00000000000000000000000000000000000000e4',
  payment: '0x00000000000000000000000000000000000000e5',
  digestBinding: '0x00000000000000000000000000000000000000e6',
} as const;

const wireFor = (capabilityId: string) => {
  const req: MandateRequirementV1 = {
    type: CAPABILITY_RAR_TYPE, actions: [capabilityId],
    locations: ['0x00000000000000000000000000000000000000c1'],
    intentDigest: `0x${'11'.repeat(32)}`, validAfter: 1, validUntil: 2,
  };
  return { caveats: capabilityHandler.toCaveats(req, E as never).map((c) => ({ enforcer: c.enforcer, terms: c.terms })) };
};

describe('mandateCapabilityWords', () => {
  it('names the capability a REAL mandate covers', () => {
    expect(mandateCapabilityWords(wireFor('messaging.direct.send'))).toBe('send direct messages');
    expect(mandateCapabilityWords(wireFor('organization.team.create'))).toBe('create teams');
    expect(mandateCapabilityWords(wireFor('treasury.payment.execute'))).toBe('make payments');
  });

  it('distinguishes two capabilities rather than matching the first', () => {
    expect(mandateCapabilityWords(wireFor('treasury.fund'))).not.toBe(mandateCapabilityWords(wireFor('treasury.create')));
  });

  it('is null for no mandate and for one covering nothing it knows', () => {
    expect(mandateCapabilityWords(null)).toBeNull();
    expect(mandateCapabilityWords({ caveats: [] })).toBeNull();
    expect(mandateCapabilityWords(wireFor('something.else.entirely'))).toBeNull();
  });
});
