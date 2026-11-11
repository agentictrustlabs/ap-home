// Spec 445 (audit RUNC-1 / STEWARD-SHAPE-CONFUSION-1) — stewardship is recognised by what the wire IS.
//
// The negative test this file replaced ("an allowedTargets caveat and no record scope") also described the
// organization's PAYMENT mandate and its A2A MESSAGE grant, so a person holding either could invite and remove
// members. Each wire below is built by the SAME code that mints it in production, and signature + revocation are
// answered "valid, unrevoked" — so a `false` is the shape test refusing, and nothing else.
import { describe, it, expect, vi } from 'vitest';
import {
  buildCaveat, buildPaymentMandateCaveats, buildVaultRecordScopeCaveat, encodeAllowedMethodsTerms,
  encodeAllowedTargetsTerms, encodeTimestampTerms, encodeValueTerms,
} from '@agenticprimitives/delegation';

vi.mock('./verify-delegation', () => ({ verifyDelegation: async () => ({ ok: true, digest: `0x${'11'.repeat(32)}` }) }));
vi.mock('viem', async (orig) => ({ ...(await orig<typeof import('viem')>()), createPublicClient: () => ({ readContract: async () => false }) }));

import { verifyStewardship } from './verify-stewardship';
import { siteCaveats } from '../../src/lib/delegation';
import { CONTRACTS } from '../../src/lib/chain';
import type { IncomingDelegation } from './verify-delegation';

const ORG = '0x00000000000000000000000000000000000000a1' as const;
const PERSON = '0x00000000000000000000000000000000000000b2' as const;
const ASSET = '0x00000000000000000000000000000000000000c3' as const;
const UNTIL = Math.floor(Date.now() / 1000) + 3600;
const wire = (caveats: { enforcer: string; terms: string }[], over: Partial<IncomingDelegation> = {}): IncomingDelegation => ({
  delegator: ORG, delegate: PERSON, authority: `0x${'ff'.repeat(32)}`, salt: '1', signature: '0x03',
  caveats: caveats as IncomingDelegation['caveats'], ...over,
});
const check = (w: IncomingDelegation) => verifyStewardship({}, ORG, PERSON, w);

describe('verifyStewardship — positive identity (spec 445, RUNC-1)', () => {
  it('the oversight wire the Home mints IS stewardship', async () => {
    expect(await check(wire(siteCaveats(UNTIL)))).toBe(true);
  });

  it('an organization PAYMENT mandate is not stewardship', async () => {
    const caveats = buildPaymentMandateCaveats({
      enforcers: { payment: CONTRACTS.paymentEnforcer, timestamp: CONTRACTS.timestampEnforcer, allowedTargets: CONTRACTS.allowedTargetsEnforcer, allowedMethods: CONTRACTS.allowedMethodsEnforcer },
      payee: PERSON, asset: ASSET, maxAmountPerCharge: 10n, maxAggregate: 100n, maxRedemptionsPerWindow: 10, windowSeconds: 3600, validUntil: UNTIL,
    } as Parameters<typeof buildPaymentMandateCaveats>[0]);
    expect(await check(wire(caveats))).toBe(false);
  });

  it('an A2A MESSAGE grant is not stewardship — even one whose targets are the governance contracts', async () => {
    const grant = (targets: `0x${string}`[]) => [
      buildCaveat(CONTRACTS.timestampEnforcer, encodeTimestampTerms(0, UNTIL)),
      buildCaveat(CONTRACTS.allowedTargetsEnforcer, encodeAllowedTargetsTerms(targets)),
      buildCaveat(CONTRACTS.allowedMethodsEnforcer, encodeAllowedMethodsTerms(['0x12345678'])),
    ];
    expect(await check(wire(grant([PERSON])))).toBe(false);
    expect(await check(wire(grant([CONTRACTS.agentRelationship, CONTRACTS.agentNameRegistry])))).toBe(false);
  });

  it('a member data grant, a target outside the governance set, a missing registry, an expired window, a value: none is stewardship', async () => {
    const scope = buildVaultRecordScopeCaveat([{ server: 'vault', resources: ['vault:org.profile'], ops: ['read'] }] as never);
    expect(await check(wire([...siteCaveats(UNTIL), scope]))).toBe(false);
    const targets = (t: `0x${string}`[], until = UNTIL, value = 0n) => [
      buildCaveat(CONTRACTS.timestampEnforcer, encodeTimestampTerms(0, until)),
      buildCaveat(CONTRACTS.valueEnforcer, encodeValueTerms(value)),
      buildCaveat(CONTRACTS.allowedTargetsEnforcer, encodeAllowedTargetsTerms(t)),
    ];
    const gov = [CONTRACTS.agentRelationship, CONTRACTS.agentNameRegistry];
    expect(await check(wire(targets(gov)))).toBe(true);                 // the subregistry is optional
    expect(await check(wire(targets([...gov, ASSET])))).toBe(false);    // …and nothing else is permitted
    expect(await check(wire(targets([CONTRACTS.agentRelationship])))).toBe(false);
    expect(await check(wire(targets(gov, 1)))).toBe(false);
    expect(await check(wire(targets(gov, UNTIL, 1n)))).toBe(false);
    expect(await check(wire([]))).toBe(false);
  });

  it('the wire is bound to this organization and this person', async () => {
    expect(await check(wire(siteCaveats(UNTIL), { delegate: ORG }))).toBe(false);
    expect(await check(wire(siteCaveats(UNTIL), { delegator: PERSON }))).toBe(false);
  });
});
