/**
 * A HELD GRANT IS CHECKED BEFORE IT IS USED — spec 338 §4.
 *
 * The record lives in the HOLDER'S OWN VAULT, which the holder can write. So the record is not the
 * evidence and never was: the issuer's signature inside it is. Until this check existed, "I hold a grant
 * from Alice" was a sentence anyone could write about themselves, and the privacy of an unlisted agent
 * rested entirely on its address not being in a public place — which is true, and is not the same thing
 * as being enforced.
 */
import { describe, it, expect, vi } from 'vitest';
import { verifiedGrants } from '../src/resolution-invitation.js';

const CHAIN = 34348;
const ALICE = '0x00000000000000000000000000000000000000a1';
const NATHAN = '0x00000000000000000000000000000000000000b1';
const MALLORY = '0x00000000000000000000000000000000000000c1';
const TARGET = '0x00000000000000000000000000000000000000d1';
const caip = (a: string) => `eip155:${CHAIN}:${a}`;

const held = (over: Record<string, unknown> = {}, grantOver: Record<string, unknown> = {}) => ({
  grants: [{
    v: 1, kind: 'resolution.grant.held', grantId: 'apd1_x', targetAgent: TARGET, owner: ALICE,
    targetType: 'treasury', issuedAt: '2026-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z',
    grant: { issuer: caip(ALICE), subject: caip(NATHAN), targetAgent: caip(TARGET), proof: { signature: '0xsig' }, ...grantOver },
    ...over,
  }],
});
const ctx = (verify = true, asker = NATHAN) => ({
  asker, chainId: CHAIN,
  digestOf: () => '0xdigest',
  verifySignature: vi.fn(async () => verify),
});

describe('using a resolution grant', () => {
  it('accepts one the issuer signed, bound to this asker, for this target', async () => {
    expect(await verifiedGrants(held(), 'treasury', ctx())).toHaveLength(1);
  });

  it('REFUSES a self-written record — the holder can write their own vault', async () => {
    // Mallory writes herself a grant naming Alice's treasury. The shape is perfect; nobody signed it.
    expect(await verifiedGrants(held(), 'treasury', ctx(false))).toHaveLength(0);
  });

  it('REFUSES one issued to somebody else — it is recipient-bound', async () => {
    expect(await verifiedGrants(held(), 'treasury', ctx(true, MALLORY))).toHaveLength(0);
  });

  it('REFUSES a grant re-pointed at another agent', async () => {
    const other = '0x00000000000000000000000000000000000000d2';
    expect(await verifiedGrants(held({ targetAgent: other }), 'treasury', ctx())).toHaveLength(0);
  });

  it('REFUSES one whose issuer is not the owner it claims', async () => {
    expect(await verifiedGrants(held({}, { issuer: caip(MALLORY) }), 'treasury', ctx())).toHaveLength(0);
  });

  it('REFUSES one with no proof at all', async () => {
    expect(await verifiedGrants(held({}, { proof: undefined }), 'treasury', ctx())).toHaveLength(0);
  });

  it('REFUSES an expired one — the owner set the window', async () => {
    expect(await verifiedGrants(held({ expiresAt: '2020-01-01T00:00:00Z' }), 'treasury', ctx())).toHaveLength(0);
  });

  it('checks the signature against the ISSUER, over the canonical body', async () => {
    const c = ctx();
    await verifiedGrants(held(), 'treasury', c);
    expect(c.verifySignature).toHaveBeenCalledWith({ signer: ALICE, digest: '0xdigest', signature: '0xsig' });
  });
});
