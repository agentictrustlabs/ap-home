// Discovery-authority appointments (spec 338 W6-c).
//
// The minting tests assert the appointment says what the UI claims it says — an appointment whose
// caveats disagreed with the label would let an operator hand out authority they did not intend.
//
// The validation tests are the more important half. They run on a PASTED document, which is the one
// input here an attacker controls, and every one of them describes a bundle the operator would
// otherwise send to the resolver only to get back an opaque `authority_invalid`.

import { describe, expect, it } from 'vitest';
import {
  DISCOVERY_ISSUE_ACTION,
  mintDiscoveryAuthority,
  parseDiscoveryAuthorityBundle,
  validateDiscoveryAuthorityBundle,
  type DiscoveryAuthorityBundle,
} from '../home/discovery-authority';
import { CHAIN_ID } from './chain';
import type { Address } from '@agenticprimitives/types';

const AGENT = '0x1111111111111111111111111111111111111111' as Address;
const STEWARD = '0x2222222222222222222222222222222222222222' as Address;
const SIG = `0x${'ab'.repeat(65)}` as const;

const sign = async () => SIG;
const inDays = (n: number) => new Date(Date.now() + n * 24 * 3600_000);

const mint = () =>
  mintDiscoveryAuthority({
    agentAddress: AGENT,
    stewardAddress: STEWARD,
    expiresAt: inDays(90),
    sign,
  });

describe('minting an appointment', () => {
  it('delegates FROM the agent TO the named party', async () => {
    const b = await mint();
    expect(b.delegation.delegator.toLowerCase()).toBe(AGENT);
    expect(b.delegation.delegate.toLowerCase()).toBe(STEWARD);
    expect(b.targetAgent.toLowerCase()).toBe(AGENT);
    expect(b.steward.toLowerCase()).toBe(STEWARD);
  });

  it('authorizes exactly one action', async () => {
    expect((await mint()).action).toBe(DISCOVERY_ISSUE_ACTION);
    // Pinned: the resolver stores this string's SELECTOR in ALLOWED_METHODS, so renaming it here
    // without renaming it there silently stops authorizing anything.
    expect(DISCOVERY_ISSUE_ACTION).toBe('agent.discovery.grant.issue');
  });

  it('always carries caveats — the resolver refuses an unbounded authority', async () => {
    // Timestamp window, allowed target, allowed method.
    expect((await mint()).delegation.caveats).toHaveLength(3);
  });

  it('commits to the delegation it carries', async () => {
    const b = await mint();
    expect(b.authorityRef).toMatch(/^apdel1:0x[0-9a-f]{64}$/);
  });

  it('two appointments are never the same delegation', async () => {
    // Salt is random, so re-appointing the same party does not collide with — or silently reuse —
    // the previous appointment's hash.
    const [a, b] = [await mint(), await mint()];
    expect(a.authorityRef).not.toBe(b.authorityRef);
  });

  it('the signature is over the delegation digest, from the caller’s own custody path', async () => {
    let signedDigest: string | null = null;
    const b = await mintDiscoveryAuthority({
      agentAddress: AGENT,
      stewardAddress: STEWARD,
      expiresAt: inDays(1),
      sign: async (d) => {
        signedDigest = d;
        return SIG;
      },
    });
    // What was signed IS what the ref commits to. If these could diverge, the resolver would verify a
    // signature over one delegation while honouring a different one.
    expect(`apdel1:${signedDigest}`).toBe(b.authorityRef);
    expect(b.delegation.signature).toBe(SIG);
  });

  it('REFUSES an expiry in the past', async () => {
    await expect(
      mintDiscoveryAuthority({ agentAddress: AGENT, stewardAddress: STEWARD, expiresAt: inDays(-1), sign }),
    ).rejects.toThrow(/future/);
  });

  it('REFUSES appointing an agent over itself', async () => {
    // Not dangerous, but meaningless — and it would quietly add an expiry to authority the agent
    // already holds unconditionally.
    await expect(
      mintDiscoveryAuthority({ agentAddress: AGENT, stewardAddress: AGENT, expiresAt: inDays(30), sign }),
    ).rejects.toThrow(/itself/);
  });
});

describe('validating a pasted appointment', () => {
  const good = async (): Promise<DiscoveryAuthorityBundle> => mint();

  it('accepts one we just minted', async () => {
    expect(validateDiscoveryAuthorityBundle(await good())).toEqual([]);
  });

  it('rejects a document that is not an appointment at all', () => {
    expect(validateDiscoveryAuthorityBundle({ hello: 'world' })[0].field).toBe('bundleVersion');
    expect(validateDiscoveryAuthorityBundle(null)[0].field).toBe('bundle');
  });

  it('rejects an expired appointment', async () => {
    const b = { ...(await good()), expiresAt: new Date(Date.now() - 1000).toISOString() };
    expect(validateDiscoveryAuthorityBundle(b).map((p) => p.field)).toContain('expiresAt');
  });

  it('rejects an appointment for another chain', async () => {
    // The same address on another chain is a different principal.
    const b = { ...(await good()), chainId: CHAIN_ID + 1 };
    expect(validateDiscoveryAuthorityBundle(b).map((p) => p.field)).toContain('chainId');
  });

  it('rejects an appointment for a different action', async () => {
    const b = { ...(await good()), action: 'agent.discovery.export' as never };
    expect(validateDiscoveryAuthorityBundle(b).map((p) => p.field)).toContain('action');
  });

  it('rejects an unscoped delegation', async () => {
    const src = await good();
    const b = { ...src, delegation: { ...src.delegation, caveats: [] } };
    expect(validateDiscoveryAuthorityBundle(b).map((p) => p.field)).toContain('delegation.caveats');
  });

  it('rejects an unsigned delegation', async () => {
    const src = await good();
    const b = { ...src, delegation: { ...src.delegation, signature: '0x' as never } };
    expect(validateDiscoveryAuthorityBundle(b).map((p) => p.field)).toContain('delegation.signature');
  });

  describe('the labels must match the delegation they describe', () => {
    // This is the check that matters most: the operator READS the labels and signs a grant based on
    // them. An edited label would describe an authority different from the one that travels — and
    // the resolver, which reads the delegation, would be deciding something else entirely.
    it('rejects a relabelled target', async () => {
      const src = await good();
      const b = { ...src, targetAgent: STEWARD };
      expect(validateDiscoveryAuthorityBundle(b).map((p) => p.field)).toContain('targetAgent');
    });

    it('rejects a relabelled appointee', async () => {
      const src = await good();
      const b = { ...src, steward: AGENT };
      expect(validateDiscoveryAuthorityBundle(b).map((p) => p.field)).toContain('steward');
    });
  });

  it('reports EVERY problem, not just the first', async () => {
    const src = await good();
    const b = { ...src, chainId: 1, action: 'nope' as never, expiresAt: '1999-01-01T00:00:00.000Z' };
    const fields = validateDiscoveryAuthorityBundle(b).map((p) => p.field);
    expect(fields).toEqual(expect.arrayContaining(['chainId', 'action', 'expiresAt']));
  });
});

describe('parsing', () => {
  it('round-trips a minted appointment through JSON', async () => {
    const b = await mint();
    const out = parseDiscoveryAuthorityBundle(JSON.stringify(b));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.bundle.authorityRef).toBe(b.authorityRef);
  });

  it('says so plainly when it is not JSON', () => {
    const out = parseDiscoveryAuthorityBundle('paste went wrong {{{');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.problems[0].message).toMatch(/JSON/);
  });
});
