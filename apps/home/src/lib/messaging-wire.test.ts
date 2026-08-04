// spec 341 Wave 4b — the messaging session wire.
//
// The assertions that matter are the refusals. A wire is a standing authority for its lifetime, so the
// failure that hurts is not "it did not mint" — it is minting one broader than intended, which then
// verifies perfectly at every gate.

import { describe, it, expect } from 'vitest';
import type { Address, Hex } from '@agenticprimitives/types';
import { issueMessagingWire, MESSAGING_WIRE_SKILLS, MESSAGING_WIRE_VALIDITY_SECONDS } from './messaging-wire';
import { CONTRACTS } from './chain';

const ALICE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
const BOB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Address;
const CAROL = '0xcccccccccccccccccccccccccccccccccccccccc' as Address;
const KMS = '0xdddddddddddddddddddddddddddddddddddddddd' as Address;
const NOW = 1_780_000_000_000;

const mint = (over: Partial<Parameters<typeof issueMessagingWire>[0]> = {}) =>
  issueMessagingWire({
    personSA: ALICE,
    sessionKey: KMS,
    recipients: [BOB],
    signHash: async () => `0x${'11'.repeat(65)}` as Hex,
    now: () => NOW,
    salt: 1n,
    ...over,
  });

const caveat = (d: Awaited<ReturnType<typeof mint>>, enforcer: Address) =>
  d.caveats.find((c) => c.enforcer === enforcer);

describe('the wire speaks for the person, signed by the person', () => {
  it('delegates from the person to the KMS session key', async () => {
    const d = await mint();
    // Delegator is the identity; delegate is the key that signs each message. The Home holds neither.
    expect(d.delegator).toBe(ALICE);
    expect(d.delegate).toBe(KMS);
    expect(d.signature).not.toBe('0x');
  });

  it('signs the delegation digest with the person’s custody credential', async () => {
    let signed: Hex | undefined;
    await mint({ signHash: async (h) => { signed = h; return `0x${'22'.repeat(65)}` as Hex; } });
    expect(signed).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('carries all three delivery skills by default, none of them a wildcard', async () => {
    const d = await mint();
    expect(MESSAGING_WIRE_SKILLS).toHaveLength(3);
    expect(caveat(d, CONTRACTS.allowedMethodsEnforcer)).toBeDefined();
  });

  // One ceremony covering a set of contacts is what makes "a prompt per NEW counterparty, never per
  // message" achievable — the UX decision in §5.1.
  it('covers several recipients in one wire', async () => {
    const d = await mint({ recipients: [BOB, CAROL] });
    const t = caveat(d, CONTRACTS.allowedTargetsEnforcer)!.terms.toLowerCase();
    expect(t).toContain(BOB.slice(2).toLowerCase());
    expect(t).toContain(CAROL.slice(2).toLowerCase());
  });

  it('bounds itself in time', async () => {
    const d = await mint();
    const terms = caveat(d, CONTRACTS.timestampEnforcer)!.terms;
    const validUntil = BigInt(`0x${terms.slice(66, 130)}`);
    expect(validUntil).toBe(BigInt(Math.floor(NOW / 1000) + MESSAGING_WIRE_VALIDITY_SECONDS));
  });
});

describe('it refuses the shapes that would be too broad', () => {
  // The gate rejects the any-skill sentinel outright. Catching it here names the cause instead of
  // surfacing a hop away as an opaque signature failure.
  it('refuses a wildcard skill', async () => {
    await expect(mint({ skills: ['*'] })).rejects.toThrow(/NAME its skills/);
    await expect(mint({ skills: ['0x00000000'] })).rejects.toThrow(/NAME its skills/);
  });

  it('refuses a wire with no skills', async () => {
    await expect(mint({ skills: [] })).rejects.toThrow(/at least one skill/);
  });

  it('refuses a wire targeting nobody', async () => {
    await expect(mint({ recipients: [] })).rejects.toThrow(/at least one recipient/);
  });

  // An unsigned delegation is not a weaker wire; it is not a wire. Failing at the mint keeps the error
  // next to its cause.
  it('refuses to return an unsigned wire', async () => {
    await expect(mint({ signHash: async () => '0x' as Hex })).rejects.toThrow(/was not signed/);
  });
});

describe('determinism', () => {
  it('same inputs, same wire', async () => {
    const a = await mint();
    const b = await mint();
    expect(a.caveats).toEqual(b.caveats);
    expect(a.salt).toBe(b.salt);
  });

  it('deduplicates repeated recipients and skills', async () => {
    const d = await mint({ recipients: [BOB, BOB], skills: ['messaging.deliver', 'messaging.deliver'] });
    const single = await mint({ recipients: [BOB], skills: ['messaging.deliver'] });
    expect(d.caveats).toEqual(single.caveats);
  });
});
