// Spec 397 §11 — the act-as-me set: one wire per capability, a payment wire from the treasury with its bounds, signed
// per digest or batched per delegator with the sentinel; the consent's capability list excludes reads and instructions.
import { describe, it, expect, vi } from 'vitest';
// The test env deploys no contracts; the builder refuses an estate without the digest-binding enforcer, so give it one.
vi.mock('./chain', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  CHAIN_ID: 34348,
  CONTRACTS: {
    delegationManager: '0x710cb1bF08C234Df397e0910331e0A29710EF4F7', timestampEnforcer: '0x73A7B878168b7DE48677617179A8bE894f0Dfe96',
    allowedTargetsEnforcer: '0x2156311097A936de1916a878bF53Bfd43c7b5715', allowedMethodsEnforcer: '0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41',
    valueEnforcer: '0x8759c1a6cEBF1D5069e9434EF46327Bf2ef69975', paymentEnforcer: '0x07fA0aE59FdE4B7ce8962d6fE7a1d648ec3DD5CE',
    digestBindingEnforcer: '0xA3bb9BCC9b2F6F2419E1aBe5ED6Fd5399b9E68e1', payloadClassesEnforcer: '0x0000000000000000000000000000000000000000',
    mockUsdc: '0xdaE09066A2cc32f6203605619137dcF01A9B49Ae', approvedHashRegistry: '0x0000000000000000000000000000000000000000',
  },
}));
import { registerDefaultSubsetHandlers, isStandingWire, hashDelegation } from '@agenticprimitives/delegation';
import type { Address, Hex } from '@agenticprimitives/types';
import { actCapabilitiesOf, buildActAsMeSet, signActAsMeSet, actWireWords, PAYMENT_CAPABILITY } from './act-as-me';
import { CHAIN_ID, CONTRACTS } from './chain';

registerDefaultSubsetHandlers();
const ALICE = '0x1111111111111111111111111111111111111111' as Address;
const TREAS = '0x2222222222222222222222222222222222222222' as Address;
const PAYEE = '0x3333333333333333333333333333333333333333' as Address;
const KEY = '0x4444444444444444444444444444444444444444' as Address;
const USDC = '0x5555555555555555555555555555555555555555' as Address;

describe('act-as-me set', () => {
  it('lists only acts: a read (informational) and an instruction are never offered', () => {
    const caps = actCapabilitiesOf({ tools: [
      { id: 'a', description: 'read', capability: { id: 'person.records.list', action: 'read' }, risk: 'informational' },
      { id: 'b', description: 'pay', capability: { id: PAYMENT_CAPABILITY, action: 'execute' }, risk: 'high' },
      { id: 'c', description: 'teach', capability: { id: 'person.instruction.set', action: 'set' }, risk: 'low', execution: 'instruction' },
      { id: 'd', description: 'send', capability: { id: 'messaging.send', action: 'send' }, risk: 'low' },
      { id: 'e', description: 'send again', capability: { id: 'messaging.send', action: 'send' }, risk: 'low' },
    ] } as never);
    expect(caps.map((c) => c.id)).toEqual(['messaging.send', PAYMENT_CAPABILITY]);
  });

  it('one wire per capability; the payment wire is the TREASURY\'s and carries payee, asset and cap; none is a mandate', () => {
    const set = buildActAsMeSet(ALICE, KEY, [
      { capability: 'messaging.send' },
      { capability: PAYMENT_CAPABILITY, payment: { treasury: TREAS, payee: PAYEE, asset: USDC, maxAmount: 5_000_000n } },
    ]);
    expect(set.standing).toHaveLength(2);
    const pay = set.standing.find((s) => s.capability === PAYMENT_CAPABILITY)!;
    expect(String(pay.wire.delegator)).toBe(TREAS);
    expect(String(pay.wire.delegate)).toBe(KEY);
    expect(pay.requirement.limits).toMatchObject({ payee: PAYEE.toLowerCase(), asset: USDC.toLowerCase(), maxAmount: '5000000' });
    expect(set.byDelegator.get(ALICE.toLowerCase())).toHaveLength(1);
    expect(set.byDelegator.get(TREAS.toLowerCase())).toHaveLength(1);
    for (const s of set.standing) expect(isStandingWire(s.wire as never, CONTRACTS.digestBindingEnforcer)).toBe(true);
    expect(actWireWords(pay)).toMatch(/up to 5 USDC per payment/);
  });

  it('refuses a duplicate capability and a payment without bounds', () => {
    expect(() => buildActAsMeSet(ALICE, KEY, [{ capability: 'x' }, { capability: 'x' }])).toThrow(/twice/);
    expect(() => buildActAsMeSet(ALICE, KEY, [{ capability: PAYMENT_CAPABILITY }])).toThrow(/treasury/);
    expect(() => buildActAsMeSet(ALICE, KEY, [])).toThrow(/at least one/);
  });

  it('signs per digest for a prompt-free custodian, and per delegator batch with the sentinel for a passkey', async () => {
    const set = buildActAsMeSet(ALICE, KEY, [{ capability: 'messaging.send' }, { capability: PAYMENT_CAPABILITY, payment: { treasury: TREAS, payee: PAYEE, asset: USDC, maxAmount: 1n } }]);
    const each = await signActAsMeSet(set, { mode: 'each', sign: async (d, h) => `0x${d.slice(2, 6)}${h.slice(2, 10)}` as Hex });
    expect(each.map((w) => String(w.wire.signature))).toEqual(set.standing.map((s) => `0x${String(s.wire.delegator).slice(2, 6)}${s.ref.slice(2, 10)}`));
    const approved: Array<[string, number]> = [];
    const batch = await signActAsMeSet(set, { mode: 'batch', approve: async (d, hs) => { approved.push([d.toLowerCase(), hs.length]); } });
    expect(approved.sort()).toEqual([[ALICE.toLowerCase(), 1], [TREAS.toLowerCase(), 1]]);
    for (const w of batch) expect(w.wire.signature).toBe('0x03');
    // The ref is the wire's own digest on this chain.
    const w0 = batch[0]!;
    expect(hashDelegation({ ...(w0.wire as never as Record<string, unknown>), salt: BigInt(String(w0.wire.salt)) } as never, CHAIN_ID, CONTRACTS.delegationManager)).toBe(w0.ref);
  });
});
