// Session wires — signing as an identity whose key you do not hold.
//
// The property under test is the PIN: a wire minted for one rail must not authorize another. That
// used to be free, because the module hardcoded the consult selector and nothing else could use it.
// Now that a service agent signs `endeavor.request` the same way, the pin is a parameter — and a
// parameter that is silently dropped is a wire that authorizes every skill.
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, keccak256, toBytes, type Hex } from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import { A2A_ANY_SKILL, skillSelector } from '@agenticprimitives/a2a';
import { CONSULT_SKILL_ID } from '@agenticprimitives/fabric/messaging';
import {
  checkSessionWireShape,
  parseSessionWrappedSignature,
  verifySessionWrappedSignature,
  wrapSessionSignature,
  SESSION_WRAPPED_SIG_TYPE,
} from '../src/session-wire.js';

const TIMESTAMP = '0xbb8ff9c82417189c6efebbb369e9dd9d651aa0f3';
const ALLOWED_METHODS = '0xcc8ff9c82417189c6efebbb369e9dd9d651aa0f3';
const ENFORCERS = { timestamp: TIMESTAMP, allowedMethods: ALLOWED_METHODS };

const ORG = '0x00000000000000000000000000000000000000aa';
const SESSION_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const sessionKey = privateKeyToAccount(SESSION_PK);
const now = () => Math.floor(Date.now() / 1000);

function wire(opts: { skill?: string; selectors?: Hex[]; validUntil?: number; delegator?: string } = {}) {
  const selectors = opts.selectors ?? [skillSelector(opts.skill ?? CONSULT_SKILL_ID)];
  return {
    delegator: opts.delegator ?? ORG,
    delegate: sessionKey.address,
    authority: `0x${'0'.repeat(64)}`,
    salt: '0x1',
    signature: '0xsig',
    caveats: [
      { enforcer: TIMESTAMP, terms: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [0n, BigInt(opts.validUntil ?? now() + 3600)]), args: '0x' },
      { enforcer: ALLOWED_METHODS, terms: encodeAbiParameters([{ type: 'bytes4[]' }], [selectors]), args: '0x' },
    ],
  } as never;
}

describe('checkSessionWireShape', () => {
  it('accepts a wire pinned to the skill it is checked against', () => {
    expect(checkSessionWireShape(wire({ skill: CONSULT_SKILL_ID }), ENFORCERS, now(), { skill: CONSULT_SKILL_ID })).toBeNull();
    expect(checkSessionWireShape(wire({ skill: 'endeavor.request' }), ENFORCERS, now(), { skill: 'endeavor.request' })).toBeNull();
  });

  it('REFUSES a wire minted for another rail — the whole point of the pin', () => {
    // A consult wire must not sign an endeavor message, and an endeavor wire must not consult.
    expect(checkSessionWireShape(wire({ skill: CONSULT_SKILL_ID }), ENFORCERS, now(), { skill: 'endeavor.request' }))
      .toMatch(/does not name the endeavor\.request selector/);
    expect(checkSessionWireShape(wire({ skill: 'endeavor.request' }), ENFORCERS, now(), { skill: CONSULT_SKILL_ID }))
      .toMatch(/does not name the discussion\.consult selector/);
  });

  it('REFUSES the any-skill sentinel whether or not a skill is pinned', () => {
    for (const opts of [{ skill: CONSULT_SKILL_ID }, undefined]) {
      expect(checkSessionWireShape(wire({ selectors: [A2A_ANY_SKILL] }), ENFORCERS, now(), opts))
        .toMatch(/never carry the any-skill sentinel/);
    }
  });

  it('accepts a PINNED SET and pins against membership, not position', () => {
    // One approval can cover a rail (submit + read); what stays refused is the any-skill sentinel.
    const two = [skillSelector('endeavor.request'), skillSelector('endeavor.state')];
    expect(checkSessionWireShape(wire({ selectors: two }), ENFORCERS, now(), { skill: 'endeavor.state' })).toBeNull();
    expect(checkSessionWireShape(wire({ selectors: two }), ENFORCERS, now(), { skill: 'endeavor.request' })).toBeNull();
    // A skill outside the set is still refused — the set is the boundary.
    expect(checkSessionWireShape(wire({ selectors: two }), ENFORCERS, now(), { skill: CONSULT_SKILL_ID }))
      .toMatch(/does not name the discussion\.consult selector/);
  });

  it('REFUSES an empty selector list', () => {
    expect(checkSessionWireShape(wire({ selectors: [] }), ENFORCERS, now())).toMatch(/at least one selector/);
  });

  it('REFUSES a lapsed or unbounded wire', () => {
    expect(checkSessionWireShape(wire({ validUntil: now() - 1 }), ENFORCERS, now())).toMatch(/timestamp window/);
    const noTs = { ...(wire() as any), caveats: [(wire() as any).caveats[1]] };
    expect(checkSessionWireShape(noTs, ENFORCERS, now())).toMatch(/timestamp-bounded/);
  });

  it('without a pin, still requires ONE non-any-skill selector — the read/control path', () => {
    // tasks/get binds a method + taskId, never a skill, so there is no selector to pin. Everything
    // else still holds, and the package separately requires the caller to be a party to the task.
    expect(checkSessionWireShape(wire({ skill: 'endeavor.request' }), ENFORCERS, now())).toBeNull();
    expect(checkSessionWireShape(wire({ skill: CONSULT_SKILL_ID }), ENFORCERS, now())).toBeNull();
  });
});

describe('wrap / parse', () => {
  it('round-trips, and any other signature shape parses as null', () => {
    const w = wire();
    const wrapped = wrapSessionSignature(w, '0xdeadbeef');
    expect(wrapped.startsWith(SESSION_WRAPPED_SIG_TYPE)).toBe(true);
    expect(parseSessionWrappedSignature(wrapped)?.sig).toBe('0xdeadbeef');
    // A plain ERC-1271 signature must take the unchanged path, not this one.
    expect(parseSessionWrappedSignature(`0x${'ab'.repeat(65)}`)).toBeNull();
    expect(parseSessionWrappedSignature('')).toBeNull();
  });
});

describe('verifySessionWrappedSignature', () => {
  const digest = keccak256(toBytes('a message digest'));
  const ok = { verifyDelegationSig: async () => true, isRevoked: async () => false };

  const wrappedFor = async (w: unknown, d: Hex = digest): Promise<Hex> =>
    wrapSessionSignature(w as never, await sign({ hash: d, privateKey: SESSION_PK, to: 'hex' }));

  it('accepts a signature by the wire\'s delegate for the pinned skill', async () => {
    const signature = await wrappedFor(wire({ skill: 'endeavor.request' }));
    expect(await verifySessionWrappedSignature({
      signer: ORG as never, digest, signature, enforcers: ENFORCERS, skill: 'endeavor.request', ...ok,
    })).toBe(true);
  });

  it('REFUSES it for a different skill, even though every other leg passes', async () => {
    const signature = await wrappedFor(wire({ skill: CONSULT_SKILL_ID }));
    expect(await verifySessionWrappedSignature({
      signer: ORG as never, digest, signature, enforcers: ENFORCERS, skill: 'endeavor.request', ...ok,
    })).toBe(false);
  });

  it('REFUSES when the wire was signed by someone other than the claimed signer', async () => {
    const signature = await wrappedFor(wire({ skill: 'endeavor.request', delegator: '0x00000000000000000000000000000000000000bb' }));
    expect(await verifySessionWrappedSignature({
      signer: ORG as never, digest, signature, enforcers: ENFORCERS, skill: 'endeavor.request', ...ok,
    })).toBe(false);
  });

  it('REFUSES a signature over a DIFFERENT digest', async () => {
    const signature = await wrappedFor(wire({ skill: 'endeavor.request' }), keccak256(toBytes('another digest')));
    expect(await verifySessionWrappedSignature({
      signer: ORG as never, digest, signature, enforcers: ENFORCERS, skill: 'endeavor.request', ...ok,
    })).toBe(false);
  });

  it('fails closed on revocation and on a chain-read error', async () => {
    const signature = await wrappedFor(wire({ skill: 'endeavor.request' }));
    const base = { signer: ORG as never, digest, signature, enforcers: ENFORCERS, skill: 'endeavor.request' };
    expect(await verifySessionWrappedSignature({ ...base, verifyDelegationSig: async () => true, isRevoked: async () => true })).toBe(false);
    expect(await verifySessionWrappedSignature({ ...base, verifyDelegationSig: async () => true, isRevoked: async () => { throw new Error('rpc down'); } })).toBe(false);
    expect(await verifySessionWrappedSignature({ ...base, verifyDelegationSig: async () => false, isRevoked: async () => false })).toBe(false);
  });
});
