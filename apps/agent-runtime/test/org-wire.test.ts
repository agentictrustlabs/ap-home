// The org-wire verification tail, extracted from four copies in interactions-do (SEC-H1 / SEC-C1).
//
// These wires had NO unit tests before — they lived inside a Durable Object, so the only way to
// exercise them was a live request. That is why the tail could be copied four times without anyone
// noticing, and why the extraction is worth more than the line count suggests.
//
// The tests below use the ACTUAL caveat shapes production wires carry:
//   member access — VAULT_RECORD_SCOPE + timestamp
//   stewardship   — timestamp + value + allowedTargets (the site-delegation shape)
// If either shape newly failed caveat evaluation, this is where it shows up rather than in prod.

import { describe, expect, it, vi } from 'vitest';
import { VAULT_RECORD_SCOPE_ENFORCER, buildCaveat, encodeTimestampTerms, encodeValueTerms, encodeAllowedTargetsTerms } from '@agenticprimitives/delegation';
import { verifyDelegationWire, delegationOfWire, type DelegationWireLike } from '@agenticprimitives/a2a';
import { enforcersFromEnv } from '../src/org-wire.js';

const ORG = '0x1111111111111111111111111111111111111111';
const SESSION = '0x2222222222222222222222222222222222222222';
const OUTSIDER = '0x3333333333333333333333333333333333333333';
const NOW = 1_800_000_000;

const ENV = {
  DELEGATION_MANAGER: '0x9eD1dC0FD2284fcd4967beeF3317129fee7a92e5',
  TIMESTAMP_ENFORCER: '0xBb8fF9c82417189c6EfeBbB369e9dd9d651aa0f3',
  ALLOWED_TARGETS_ENFORCER: '0xb06252FaD1D41B9943c73ec696Af70F268581625',
  ALLOWED_METHODS_ENFORCER: '0xa076b759D6785bA5E67016e399Af651fC2ABC811',
  VALUE_ENFORCER: '0x3D2abD6c7C1319f2bbA96B3b76A7e0d92C620A39',
};
const enforcers = enforcersFromEnv(ENV);

const window = () => buildCaveat(ENV.TIMESTAMP_ENFORCER as never, encodeTimestampTerms(NOW - 3600, NOW + 3600));

/** The real member-access shape: a vault-record-scope grant. */
const memberWire = (over: Partial<DelegationWireLike> = {}): DelegationWireLike => ({
  delegator: ORG,
  delegate: SESSION,
  authority: `0x${'00'.repeat(32)}`,
  caveats: [window(), { enforcer: VAULT_RECORD_SCOPE_ENFORCER, terms: '0x' }],
  salt: '7',
  signature: `0x${'ab'.repeat(65)}`,
  ...over,
});

/** The real stewardship shape: the site delegation — timestamp + value + allowedTargets, no methods. */
const stewardWire = (over: Partial<DelegationWireLike> = {}): DelegationWireLike => ({
  delegator: ORG,
  delegate: SESSION,
  authority: `0x${'00'.repeat(32)}`,
  caveats: [
    window(),
    buildCaveat(ENV.VALUE_ENFORCER as never, encodeValueTerms(0n)),
    buildCaveat(ENV.ALLOWED_TARGETS_ENFORCER as never, encodeAllowedTargetsTerms([ORG as never])),
  ],
  salt: '9',
  signature: `0x${'cd'.repeat(65)}`,
  ...over,
});

const checks = (o: { revoked?: boolean; valid?: boolean } = {}) => ({
  digest: () => `0x${'11'.repeat(32)}` as `0x${string}`,
  erc1271: vi.fn(async () => o.valid ?? true),
  isRevoked: vi.fn(async () => o.revoked ?? false),
});

const verify = (wire: DelegationWireLike | undefined, over: Record<string, unknown> = {}) =>
  verifyDelegationWire({
    wire,
    expectedDelegator: ORG,
    expectedDelegate: SESSION as never,
    enforcers,
    checks: checks(),
    now: NOW,
    ...over,
  });

describe('the caveat shapes production actually sends still pass', () => {
  // The live-breakage risk of this refactor: caveat evaluation is NEW here — the four copies did not
  // do it — so an enforcer the evaluator does not recognise would newly DENY a legitimate wire.
  it('a member-access wire (record-scope + window) verifies', async () => {
    expect(await verify(memberWire())).toBe(true);
  });

  it('a stewardship wire (window + value + allowedTargets) verifies', async () => {
    expect(await verify(stewardWire())).toBe(true);
  });

  it('every enforcer the Worker configures is mapped, so none reads as UNKNOWN', () => {
    expect(enforcers.timestamp).toBe(ENV.TIMESTAMP_ENFORCER.toLowerCase());
    expect(enforcers.value).toBe(ENV.VALUE_ENFORCER.toLowerCase());
    expect(enforcers.allowedTargets).toBe(ENV.ALLOWED_TARGETS_ENFORCER.toLowerCase());
    expect(enforcers.allowedMethods).toBe(ENV.ALLOWED_METHODS_ENFORCER.toLowerCase());
  });

  it('an UNKNOWN enforcer denies — the fail-closed behaviour this newly adds', async () => {
    const rogue = memberWire({
      caveats: [window(), { enforcer: '0x00000000000000000000000000000000000000ff', terms: '0x' }],
    });
    expect(await verify(rogue)).toBe(false);
  });
});

describe('what the four copies each checked, now checked once', () => {
  it('REFUSES a wire from the wrong delegator', async () => {
    expect(await verify(memberWire({ delegator: OUTSIDER }))).toBe(false);
  });

  it('REFUSES a wire to the wrong delegate — a grant for someone else', async () => {
    expect(await verify(memberWire({ delegate: OUTSIDER }))).toBe(false);
  });

  it('REFUSES a revoked wire', async () => {
    expect(await verify(memberWire(), { checks: checks({ revoked: true }) })).toBe(false);
  });

  it('REFUSES an unverifiable signature', async () => {
    expect(await verify(memberWire(), { checks: checks({ valid: false }) })).toBe(false);
  });

  it('REFUSES an expired wire — NEW: the copies never evaluated the window', async () => {
    expect(await verify(memberWire(), { now: NOW + 7200 })).toBe(false);
  });

  it('a THROWING chain read denies, never passes (ADR-0013)', async () => {
    const boom = { ...checks(), isRevoked: async () => { throw new Error('rpc down'); } };
    expect(await verify(memberWire(), { checks: boom })).toBe(false);
  });
});

describe('malformed input never reaches the chain', () => {
  for (const [label, wire] of [
    ['undefined', undefined],
    ['no signature', memberWire({ signature: undefined as never })],
    ['no delegator', memberWire({ delegator: '' })],
    ['garbage salt', memberWire({ salt: 'not-a-number' })],
  ] as const) {
    it(`REFUSES ${label}`, async () => {
      const c = checks();
      expect(await verify(wire as never, { checks: c })).toBe(false);
      expect(c.erc1271).not.toHaveBeenCalled();
    });
  }
});

describe('delegationOfWire', () => {
  it('defaults absent caveat args to 0x — the cast all four copies wrote by hand', () => {
    const d = delegationOfWire(memberWire());
    expect(d.caveats.every((c) => c.args === '0x')).toBe(true);
    expect(d.salt).toBe(7n);
  });
});
