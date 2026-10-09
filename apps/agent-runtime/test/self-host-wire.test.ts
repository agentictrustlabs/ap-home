// Spec 433 W2 — a self-hosted agent's read wire: kept only when it verifies the way the host will; the forward rides it,
// and only for a caller the runtime would let read here.
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters } from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import { skillSelector } from '@agenticprimitives/a2a';
import { HARNESS_READ_SKILL } from '@agenticprimitives/service-host';
import { verifySelfHostReadWire, isDelegationWire, signedSelfHostRead, type SelfHostWireChain } from '../src/self-host-wire.js';
import { forwardToSelfHost } from '../src/self-hosted-read.js';

const TIMESTAMP = '0xbb8ff9c82417189c6efebbb369e9dd9d651aa0f3';
const ALLOWED = '0xcc8ff9c82417189c6efebbb369e9dd9d651aa0f3';
const AGENT = '0x00000000000000000000000000000000000000aa' as const;
const RUTH = '0x00000000000000000000000000000000000000cc' as const;
const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const key = privateKeyToAccount(PK);
const wireOf = (skill = HARNESS_READ_SKILL, over: Record<string, unknown> = {}) => ({
  delegator: AGENT, delegate: key.address, authority: `0x${'0'.repeat(64)}`, salt: '0x1', signature: '0xsig',
  caveats: [
    { enforcer: TIMESTAMP, terms: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [0n, BigInt(Math.floor(Date.now() / 1000) + 3600)]), args: '0x' },
    { enforcer: ALLOWED, terms: encodeAbiParameters([{ type: 'bytes4[]' }], [[skillSelector(skill)]]), args: '0x' },
  ],
  ...over,
}) as never;
const chain = (over: Partial<SelfHostWireChain> = {}): SelfHostWireChain => ({
  chainId: 1, delegationManager: '0x00000000000000000000000000000000000000d0', validator: '0x00000000000000000000000000000000000000e0',
  enforcers: { timestamp: TIMESTAMP, allowedMethods: ALLOWED }, validatorAbi: [], isRevokedAbi: [],
  readContract: async (a) => (a.functionName === 'isRevoked' ? false : true), ...over,
});

describe('verifySelfHostReadWire — every leg the host checks, checked before the wire is kept', () => {
  it('holds for the agent\'s own wire to our key, pinned harness.read, valid on chain', async () => {
    expect(await verifySelfHostReadWire(chain(), AGENT, key.address, wireOf())).toBeNull();
  });
  it('names the failing leg', async () => {
    expect(await verifySelfHostReadWire(chain(), RUTH, key.address, wireOf())).toContain('delegator');
    expect(await verifySelfHostReadWire(chain(), AGENT, RUTH, wireOf())).toContain('delegate');
    expect(await verifySelfHostReadWire(chain(), AGENT, key.address, wireOf('harness.ask'))).toContain('harness.read');
    expect(await verifySelfHostReadWire(chain({ readContract: async (a) => a.functionName === 'isRevoked' }), AGENT, key.address, wireOf())).toContain('revoked');
    expect(await verifySelfHostReadWire(chain({ readContract: async () => false }), AGENT, key.address, wireOf())).toContain('ERC-1271');
    expect(isDelegationWire(wireOf())).toBe(true);
    expect(isDelegationWire({ delegator: AGENT })).toBe(false);
  });
});

describe('forwardToSelfHost — under the agent\'s wire, for a steward only', () => {
  const env = { RPC_URL: '', A2A_PUBLIC_BASE_DOMAIN: 'example.test' } as never;
  const req = (body: Record<string, unknown>) => new Request('https://a2a.example.test/harness/records', { method: 'POST', body: JSON.stringify(body) });
  const signDigest = (d: `0x${string}`) => sign({ hash: d, privateKey: PK, to: 'hex' });
  it('answers nothing for an agent served here', async () => {
    expect(await forwardToSelfHost(env, req({ addressee: AGENT }), AGENT, '{}', { caller: RUTH, mayOversee: async () => true, wire: async () => wireOf(), signDigest })).toBeNull();
  });
  it('signs the read with the wire, the session stripped from the body', async () => {
    const { raw, headers } = await signedSelfHostRead(wireOf(), { session: 'tok', addressee: AGENT, runRef: 'r1' }, 'https://svc.example', signDigest);
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(body.session).toBeUndefined();
    expect(body).toMatchObject({ method: HARNESS_READ_SKILL, addressee: AGENT, runRef: 'r1' });
    expect(headers.authorization).toMatch(/^A2A-Session /);
  });
});
