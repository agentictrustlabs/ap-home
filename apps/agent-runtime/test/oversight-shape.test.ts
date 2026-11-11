// Spec 445 (audit RUNC-1 / STEWARD-SHAPE-CONFUSION-1) — stewardship in the runtime is the package's POSITIVE
// definition, fed the target set the minter uses.
//
// Three recognisers, one definition: the standing reads (`chainStewardshipCheck` + `oversightCheckInputs`), the
// interactions object's `isSteward` (`oversightShapeCheck`, then its own `verifyWire`), and the Home server's
// `verifyStewardship` (apps/home/server/_lib/verify-stewardship.test.ts). Each wire below is built the way
// production builds it; the chain is answered "signed, unrevoked", so a `false` is the shape refusing.
import { describe, it, expect } from 'vitest';
import {
  buildCaveat, buildPaymentMandateCaveats, buildVaultRecordScopeCaveat, encodeAllowedMethodsTerms,
  encodeAllowedTargetsTerms, encodeTimestampTerms, encodeValueTerms, type Caveat,
} from '@agenticprimitives/delegation';
import { chainStewardshipCheck } from '@agenticprimitives/context';
import { oversightCheckInputs, oversightContractsFromEnv, oversightMintTargets } from '@ap-home/shared';
import { InteractionsDO } from '../src/interactions-do.js';

const ORG = '0x1111111111111111111111111111111111111111' as const;
const PERSON = '0x2222222222222222222222222222222222222222' as const;
const ASSET = '0x3333333333333333333333333333333333333333' as const;
const ENV = {
  CHAIN_ID: '84532',
  DELEGATION_MANAGER: '0x4444444444444444444444444444444444444444',
  TIMESTAMP_ENFORCER: '0xBb8fF9c82417189c6EfeBbB369e9dd9d651aa0f3',
  VALUE_ENFORCER: '0x3D2abD6c7C1319f2bbA96B3b76A7e0d92C620A39',
  ALLOWED_TARGETS_ENFORCER: '0xb06252FaD1D41B9943c73ec696Af70F268581625',
  ALLOWED_METHODS_ENFORCER: '0x5555555555555555555555555555555555555555',
  PAYMENT_ENFORCER: '0x6666666666666666666666666666666666666666',
  AGENT_RELATIONSHIP: '0x7777777777777777777777777777777777777777',
  AGENT_NAME_REGISTRY: '0x8888888888888888888888888888888888888888',
  PERMISSIONLESS_SUBREGISTRY: '0x9999999999999999999999999999999999999999',
};
const NOW = 1_800_000_000;
const UNTIL = NOW + 3600;
type A = `0x${string}`;

/** The site wire, exactly as `siteGrantCaveats` (index.ts) builds it: timestamp, value 0, the shared targets. */
const oversight = (env = ENV, until = UNTIL): Caveat[] => [
  buildCaveat(env.TIMESTAMP_ENFORCER as A, encodeTimestampTerms(0, until)),
  buildCaveat(env.VALUE_ENFORCER as A, encodeValueTerms(0n)),
  buildCaveat(env.ALLOWED_TARGETS_ENFORCER as A, encodeAllowedTargetsTerms(oversightMintTargets(oversightContractsFromEnv(env)) as A[])),
];
const paymentMandate = (): Caveat[] => buildPaymentMandateCaveats({
  enforcers: { payment: ENV.PAYMENT_ENFORCER as A, timestamp: ENV.TIMESTAMP_ENFORCER as A, allowedTargets: ENV.ALLOWED_TARGETS_ENFORCER as A, allowedMethods: ENV.ALLOWED_METHODS_ENFORCER as A },
  payee: PERSON, asset: ASSET, maxAmountPerCharge: 10n, maxAggregate: 100n, maxRedemptionsPerWindow: 10, windowSeconds: 3600, validUntil: UNTIL,
} as Parameters<typeof buildPaymentMandateCaveats>[0]);
const messageGrant = (targets: A[] = [PERSON]): Caveat[] => [
  buildCaveat(ENV.TIMESTAMP_ENFORCER as A, encodeTimestampTerms(0, UNTIL)),
  buildCaveat(ENV.ALLOWED_TARGETS_ENFORCER as A, encodeAllowedTargetsTerms(targets)),
  buildCaveat(ENV.ALLOWED_METHODS_ENFORCER as A, encodeAllowedMethodsTerms(['0x12345678'])),
];
const wire = (caveats: Caveat[], over: Record<string, unknown> = {}) => ({
  delegator: ORG, delegate: PERSON, authority: `0x${'ff'.repeat(32)}`, salt: '1', signature: '0x03', caveats, ...over,
});

describe('standing reads — chainStewardshipCheck with the shared inputs', () => {
  const reads: string[] = [];
  const check = (env = ENV) => chainStewardshipCheck({
    ...oversightCheckInputs(oversightContractsFromEnv(env)),
    now: () => NOW,
    chainId: 84532, delegationManager: ENV.DELEGATION_MANAGER as A,
    validator: '0x000000000000000000000000000000000000dEaD', validatorAbi: [], isRevokedAbi: [],
    readContract: (async (a: { functionName: string }) => { reads.push(a.functionName); return a.functionName === 'isValidSig'; }) as never,
  });
  const is = (caveats: Caveat[], env = ENV) => check(env)({ org: ORG, person: PERSON, wire: wire(caveats) });

  it('the oversight wire the runtime mints is stewardship', async () => {
    expect(await is(oversight())).toBe(true);
  });
  it('a wire minted after the legacy subregistry is retired (two targets) is still stewardship', async () => {
    const { PERMISSIONLESS_SUBREGISTRY: _gone, ...without } = ENV;
    expect(oversightMintTargets(oversightContractsFromEnv(without))).toEqual([ENV.AGENT_RELATIONSHIP, ENV.AGENT_NAME_REGISTRY]);
    expect(await is(oversight(without as typeof ENV), without as typeof ENV)).toBe(true);
    expect(await is(oversight(without as typeof ENV))).toBe(true);     // …and under a deployment that still configures it
  });
  it('a wire minted BEFORE the retirement names a target the deployment no longer declares — refused until it is listed as retired', async () => {
    const { PERMISSIONLESS_SUBREGISTRY: gone, ...without } = ENV;
    expect(await is(oversight(), without as typeof ENV)).toBe(false);
    const listed = chainStewardshipCheck({
      ...oversightCheckInputs({ ...oversightContractsFromEnv(without), retiredTargets: [gone] }),
      now: () => NOW, chainId: 84532, delegationManager: ENV.DELEGATION_MANAGER as A,
      validator: '0x000000000000000000000000000000000000dEaD', validatorAbi: [], isRevokedAbi: [],
      readContract: (async (a: { functionName: string }) => a.functionName === 'isValidSig') as never,
    });
    expect(await listed({ org: ORG, person: PERSON, wire: wire(oversight()) })).toBe(true);
  });
  it('an organization PAYMENT mandate is not stewardship, and no chain read is spent on it', async () => {
    reads.length = 0;
    expect(await is(paymentMandate())).toBe(false);
    expect(reads).toEqual([]);
  });
  it('an A2A MESSAGE grant is not stewardship — even one aimed at the governance contracts', async () => {
    expect(await is(messageGrant())).toBe(false);
    expect(await is(messageGrant([ENV.AGENT_RELATIONSHIP as A, ENV.AGENT_NAME_REGISTRY as A]))).toBe(false);
  });
  it('a data grant, an expired window, an unconfigured enforcer or registry: not stewardship', async () => {
    expect(await is([...oversight(), buildVaultRecordScopeCaveat([{ server: 'vault', resources: ['vault:org.profile'], ops: ['read'] }] as never)])).toBe(false);
    expect(await is(oversight(ENV, NOW - 1))).toBe(false);
    expect(await is(oversight(), { ...ENV, VALUE_ENFORCER: '' })).toBe(false);
    expect(await is(oversight(), { ...ENV, AGENT_NAME_REGISTRY: '' })).toBe(false);
  });
});

describe('InteractionsDO.isSteward — the same definition, then its own liveness check', () => {
  const steward = (env: Record<string, string> = ENV) => {
    const m = new Map<string, unknown>();
    const storage = { async get(k: string) { return m.get(k); }, async put(k: string, v: unknown) { m.set(k, v); }, async delete(k: string) { m.delete(k); } };
    const d = new InteractionsDO({ storage } as unknown as DurableObjectState, env as unknown as ConstructorParameters<typeof InteractionsDO>[1]);
    let verified = 0;
    // Signature + revocation answered "live": what is under test is which wires ever REACH that check.
    (d as unknown as { verifyWire: () => Promise<boolean> }).verifyWire = async () => { verified += 1; return true; };
    const ask = (caveats: Caveat[], over: Record<string, unknown> = {}) =>
      (d as unknown as { isSteward: (p: string, s: string, w: unknown) => Promise<boolean> }).isSteward(ORG, PERSON, wire(caveats, over));
    return { ask, verified: () => verified };
  };
  // The site wire's window is checked against the clock; mint one that is current now.
  const live = () => oversight(ENV, Math.floor(Date.now() / 1000) + 3600);

  it('admits the oversight wire and only then asks the chain', async () => {
    const s = steward();
    expect(await s.ask(live())).toBe(true);
    expect(s.verified()).toBe(1);
  });
  it('refuses a payment mandate and a message grant before any chain read', async () => {
    const s = steward();
    expect(await s.ask(paymentMandate())).toBe(false);
    expect(await s.ask(messageGrant())).toBe(false);
    expect(await s.ask(messageGrant([ENV.AGENT_RELATIONSHIP as A, ENV.AGENT_NAME_REGISTRY as A]))).toBe(false);
    expect(s.verified()).toBe(0);
  });
  it('refuses a wire carrying an enforcer this estate has never seen (no exclusion list to keep current)', async () => {
    const s = steward();
    expect(await s.ask([...live(), buildCaveat('0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa', '0x')])).toBe(false);
    expect(s.verified()).toBe(0);
  });
  it('fails closed when an enforcer or a governance registry is not configured', async () => {
    expect(await steward({ ...ENV, ALLOWED_TARGETS_ENFORCER: '' }).ask(live())).toBe(false);
    expect(await steward({ ...ENV, TIMESTAMP_ENFORCER: '' }).ask(live())).toBe(false);
    expect(await steward({ ...ENV, AGENT_RELATIONSHIP: '' }).ask(live())).toBe(false);
  });
  it('is bound to this principal and this session', async () => {
    const s = steward();
    expect(await s.ask(live(), { delegate: ORG })).toBe(false);
    expect(await s.ask(live(), { delegator: PERSON })).toBe(false);
  });
});
