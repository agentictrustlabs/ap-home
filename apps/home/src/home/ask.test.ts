// The Ask's authority step: what the person signs is what this surface built from what it showed them.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/chain', () => ({
  CHAIN_ID: 34348,
  CONTRACTS: {
    delegationManager: '0x710cb1bf08c234df397e0910331e0a29710ef4f7',
    timestampEnforcer: '0x73a7b878168b7de48677617179a8be894f0dfe96',
    allowedTargetsEnforcer: '0x2156311097a936de1916a878bf53bfd43c7b5715',
    allowedMethodsEnforcer: '0xdbb2e47793393c499efb0f3fcbf6ca8669791a41',
    valueEnforcer: '0x8759c1a6cebf1d5069e9434ef46327bf2ef69975',
    paymentEnforcer: '0x07fa0ae59fde4b7ce8962d6fe7a1d648ec3dd5ce',
    digestBindingEnforcer: '0xa3bb9bcc9b2f6f2419e1abe5ed6fd5399b9e68e1',
  },
}));
vi.mock('../csrf', () => ({ ensureCsrfToken: async () => 't', csrfHeaders: () => ({}) }));

const { mintMandate, describeRequirement } = await import('./ask');
const { decodeAllowedMethodsTerms, decodeAllowedTargetsTerms, decodeTimestampTerms, readDigestBindings, hashDelegation, methodSelector, capabilityHandler } =
  await import('@agenticprimitives/delegation');

const WORKSPACE = '0xee11dfb02e4a02630be512886305df5c68fd682c' as const;
const HARNESS = '0xd34c3fbc89706dd57d426546dcebd3ba926ede35' as const;
const NOW = Math.floor(Date.now() / 1000);
const reply = {
  kind: 'authority_required' as const, runRef: 'r', delegate: HARNESS, delegator: WORKSPACE,
  capability: 'organization.team.create', stepRef: 's0', summary: '',
  requirement: {
    type: 'urn:ap:rar:capability', actions: ['organization.team.create'], locations: [WORKSPACE],
    intentDigest: `0x${'ab'.repeat(32)}` as const, validAfter: NOW - 60, validUntil: NOW + 3600,
  },
};

describe('granting the authority an Ask says it needs', () => {
  it('builds the caveats HERE from the requirement, and signs the hash of what it built', async () => {
    const signed: string[] = [];
    const wire = await mintMandate(reply, async (d) => { signed.push(d); return `0x${'cd'.repeat(65)}`; });

    expect(wire.delegator).toBe(WORKSPACE);
    expect(wire.delegate).toBe(HARNESS);
    // The caveats say exactly what the person was shown: this capability, this parent, this ask, one hour.
    const by = (a: string) => wire.caveats.find((c) => c.enforcer.toLowerCase() === a)!;
    expect(decodeAllowedMethodsTerms(by('0xdbb2e47793393c499efb0f3fcbf6ca8669791a41').terms).map((s) => s.toLowerCase()))
      .toEqual([methodSelector('organization.team.create').toLowerCase()]);
    expect(decodeAllowedTargetsTerms(by('0x2156311097a936de1916a878bf53bfd43c7b5715').terms).map((t) => t.toLowerCase())).toEqual([WORKSPACE]);
    expect(Number(decodeTimestampTerms(by('0x73a7b878168b7de48677617179a8be894f0dfe96').terms).validUntil)).toBe(NOW + 3600);
    expect(readDigestBindings(wire.caveats as never, '0xa3bb9bcc9b2f6f2419e1abe5ed6fd5399b9e68e1'))
      .toEqual({ intent: reply.requirement.intentDigest });

    // …and the digest handed to the credential is the hash of THAT delegation, not something asserted.
    expect(signed).toEqual([hashDelegation({ ...wire, salt: BigInt(wire.salt) } as never, 34348, '0x710cb1bf08c234df397e0910331e0a29710ef4f7')]);
  });

  it('produces the same caveats the verifier will read back', async () => {
    const wire = await mintMandate(reply, async () => `0x${'cd'.repeat(65)}`);
    const built = capabilityHandler.toCaveats(reply.requirement as never, {
      delegationManager: '0x710cb1bf08c234df397e0910331e0a29710ef4f7', timestamp: '0x73a7b878168b7de48677617179a8be894f0dfe96',
      allowedTargets: '0x2156311097a936de1916a878bf53bfd43c7b5715', allowedMethods: '0xdbb2e47793393c499efb0f3fcbf6ca8669791a41',
      value: '0x8759c1a6cebf1d5069e9434ef46327bf2ef69975',
    } as never);
    expect(wire.caveats.slice(0, built.length)).toEqual(built.map((c) => ({ ...c })));
  });

  it('says what is being granted in the words the panel shows', () => {
    const d = describeRequirement(reply);
    expect(d).toMatchObject({ capability: 'organization.team.create', delegator: WORKSPACE });
    expect(d.expiresInMinutes).toBeGreaterThan(50);
    expect(d.expiresInMinutes).toBeLessThanOrEqual(60);
  });
});
