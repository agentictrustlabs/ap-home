/**
 * WHAT A RESOLVER CHECKS BEFORE IT TELLS ANYONE AN ADDRESS — spec 338 §4.
 *
 * The holder does not hold the address. They hold a REFERENCE, and ask each time. That is what makes
 * these checks bite: before the gate existed, a withdrawn grant meant the resolver would not cooperate
 * while the address sat in the holder's own vault, which is not withholding anything.
 */
import { describe, it, expect, vi } from 'vitest';
import { grantAllows, verifiedGrants } from '../src/resolution-invitation.js';

const CHAIN = 34348;
const ALICE = '0x00000000000000000000000000000000000000a1';
const NATHAN = '0x00000000000000000000000000000000000000b1';
const MALLORY = '0x00000000000000000000000000000000000000c1';
const TARGET = '0x00000000000000000000000000000000000000d1';
const HERE = 'a2a.faithnet.io';
const caip = (a: string) => `eip155:${CHAIN}:${a}`;

const grant = (over: Record<string, unknown> = {}, constraints: Record<string, unknown> = {}) => ({
  issuer: caip(ALICE), subject: caip(NATHAN), targetAgent: caip(TARGET),
  proof: { signature: '0xsig' },
  constraints: { audience: HERE, notBefore: '2020-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', ...constraints },
  ...over,
});
const ctx = { caller: NATHAN, owner: ALICE, audience: HERE };

describe('grantAllows — the rules that decide whether someone learns an address', () => {
  it('allows one issued to this caller, by this owner, for this resolver, in date, signed', () => {
    expect(grantAllows(grant(), ctx)).toBeNull();
  });

  it('REFUSES one issued to somebody else — it is recipient-bound', () => {
    expect(grantAllows(grant(), { ...ctx, caller: MALLORY })).toBe('not-issued-to-you');
  });

  it('REFUSES one whose issuer is not the owner it is being read from', () => {
    expect(grantAllows(grant({ issuer: caip(MALLORY) }), ctx)).toBe('not-issued-by-them');
  });

  it('REFUSES one minted for a DIFFERENT resolver — the confused-deputy defence', () => {
    // Alice grants Nathan discovery through resolver A; he must not redeem it at resolver B, which would
    // let B answer questions Alice never agreed it could answer.
    expect(grantAllows(grant({}, { audience: 'someone-elses-resolver' }), ctx)).toBe('wrong-resolver');
  });

  it('REFUSES an expired one, and one not yet valid — the owner set the window', () => {
    expect(grantAllows(grant({}, { expiresAt: '2020-01-01T00:00:00Z' }), ctx)).toBe('expired');
    expect(grantAllows(grant({}, { notBefore: '2099-01-01T00:00:00Z' }), ctx)).toBe('not-yet-valid');
  });

  it('REFUSES an unsigned one — a grant nobody signed is a claim by whoever stored it', () => {
    expect(grantAllows(grant({ proof: undefined }), ctx)).toBe('unsigned');
  });
});

describe('verifiedGrants — a reference is worth what the gate says it is', () => {
  const held = { grants: [{ v: 1, kind: 'resolution.grant.held', grantId: 'apd1_x', owner: ALICE, targetType: 'treasury', expiresAt: '2099-01-01T00:00:00Z' }] };

  it('uses the address the gate projects, and never one of its own', async () => {
    const resolve = vi.fn(async () => TARGET);
    const out = await verifiedGrants(held, 'treasury', { asker: NATHAN, resolve });
    expect(out).toHaveLength(1);
    expect(out[0]!.targetAgent).toBe(TARGET);
    expect(resolve).toHaveBeenCalledWith({ owner: ALICE, grantId: 'apd1_x' });
  });

  it('drops a reference the gate refuses — withdrawn, expired, or not theirs', async () => {
    expect(await verifiedGrants(held, 'treasury', { asker: NATHAN, resolve: async () => null })).toHaveLength(0);
  });

  it('drops it when the gate cannot be reached — an unanswered question is not a yes', async () => {
    const resolve = async () => { throw new Error('resolver unreachable'); };
    expect(await verifiedGrants(held, 'treasury', { asker: NATHAN, resolve })).toHaveLength(0);
  });

  it('holds nothing of the wrong type, and asks about nothing', async () => {
    const resolve = vi.fn(async () => TARGET);
    expect(await verifiedGrants(held, 'org', { asker: NATHAN, resolve })).toHaveLength(0);
    expect(resolve).not.toHaveBeenCalled();
  });
});
