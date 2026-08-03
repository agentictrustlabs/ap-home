// spec 341 Wave 4 — the A2A delivery grant.
//
// The assertions that matter are the ones about SCOPE. A delivery grant is minted per send and signed
// with the person's own credential, so the failure that would hurt is not "it did not work" — it is a
// grant that quietly authorizes more than one delivery to one agent.

import { describe, it, expect } from 'vitest';
import type { Address, Hex } from '@agenticprimitives/types';
import { mintDeliveryGrant, MESSAGING_DELIVER_SKILL, DELIVERY_GRANT_WINDOW_SEC } from './delivery-grant';
import { CONTRACTS } from '../lib/chain';

const ALICE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
const BOB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Address;
const NOW = 1_780_000_000;
const sign = async (): Promise<Hex> => `0x${'11'.repeat(65)}` as Hex;

const mint = (over: Partial<Parameters<typeof mintDeliveryGrant>[0]> = {}) =>
  mintDeliveryGrant({
    senderSA: ALICE,
    delegate: ALICE,
    recipientAgentSA: BOB,
    sign,
    nowSec: NOW,
    salt: 1n,
    ...over,
  });

describe('the grant is scoped to one agent and one skill', () => {
  it('names the RECIPIENT as the allowed target', async () => {
    const { delegation } = await mint();
    const targets = delegation.caveats.find((c) => c.enforcer === CONTRACTS.allowedTargetsEnforcer);
    expect(targets).toBeDefined();
    // Encoded terms, but the recipient address must appear in them and the sender must not be the
    // target — the A2A reading is "the agent you are CALLING", the opposite of the discovery grant.
    expect(targets!.terms.toLowerCase()).toContain(BOB.slice(2).toLowerCase());
  });

  it('carries a timestamp window that starts now, not at zero', async () => {
    const { delegation } = await mint();
    const ts = delegation.caveats.find((c) => c.enforcer === CONTRACTS.timestampEnforcer);
    expect(ts).toBeDefined();
    // A grant valid before it existed is a grant whose window says nothing.
    expect(BigInt(ts!.terms.slice(0, 66))).toBeGreaterThan(0n);
  });

  it('carries an allowedMethods caveat', async () => {
    const { delegation, skill } = await mint();
    expect(skill).toBe(MESSAGING_DELIVER_SKILL);
    expect(delegation.caveats.some((c) => c.enforcer === CONTRACTS.allowedMethodsEnforcer)).toBe(true);
  });

  it('defaults to a short window', async () => {
    const { delegation } = await mint();
    const ts = delegation.caveats.find((c) => c.enforcer === CONTRACTS.timestampEnforcer)!;
    const validAfter = BigInt(`0x${ts.terms.slice(2, 66)}`);
    const validUntil = BigInt(`0x${ts.terms.slice(66, 130)}`);
    expect(validUntil - validAfter).toBe(BigInt(DELIVERY_GRANT_WINDOW_SEC));
  });
});

describe('it refuses the mistakes that would widen it', () => {
  // The wildcard exists in `buildA2aGrantCaveats` because some callers need it. A message delivery
  // never does, and accepting it here would turn a typo into a blanket grant on the recipient.
  it('refuses a wildcard skill', async () => {
    await expect(mint({ skill: '*' })).rejects.toThrow(/ONE skill/);
  });

  it('refuses a grant addressed to the sender', async () => {
    await expect(mint({ recipientAgentSA: ALICE })).rejects.toThrow(/authorizes nothing/);
  });

  it('refuses a non-positive window', async () => {
    await expect(mint({ windowSec: 0 })).rejects.toThrow(/window must be positive/);
  });

  // An unsigned delegation is not a weaker grant — it is not a grant. Failing at the mint keeps the
  // error next to its cause instead of one network hop away, as a recipient rejection.
  it('refuses to return an unsigned grant', async () => {
    await expect(mint({ sign: async () => '0x' as Hex })).rejects.toThrow(/not signed/);
  });
});

describe('the signature covers the grant', () => {
  it('signs the delegation digest and returns it', async () => {
    let signed: Hex | undefined;
    const { digest, delegation } = await mint({
      sign: async (d) => {
        signed = d;
        return `0x${'22'.repeat(65)}` as Hex;
      },
    });
    expect(signed).toBe(digest);
    expect(delegation.signature).toBe(`0x${'22'.repeat(65)}`);
  });

  // Same inputs must produce the same digest, or a caller cannot log/reference it meaningfully.
  it('is deterministic given the same salt and clock', async () => {
    expect((await mint()).digest).toBe((await mint()).digest);
  });

  it('a different recipient produces a different digest', async () => {
    const other = '0xcccccccccccccccccccccccccccccccccccccccc' as Address;
    expect((await mint()).digest).not.toBe((await mint({ recipientAgentSA: other })).digest);
  });
});
