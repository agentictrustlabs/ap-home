// A CLEAN CHAIN ANSWER IS REMEMBERED BRIEFLY; A REFUSAL NEVER IS. Every vault call re-proved the same delegation on
// chain (not revoked, root and leaf; the session accepted) — a few hundred ms on each read and write. "Not revoked" and
// "accepted" are now remembered for 15 s per isolate; "revoked", "not accepted" and an unconfirmable read are asked anew
// every time, so a revocation is never hidden for longer than the window and a refusal is never served from memory.
import { describe, expect, it } from 'vitest';
import { withAuthorityMemo } from '../src/index';

function chain(revoked: boolean, source = 'rpc') {
  const calls = { revoked: 0, accepted: 0 };
  const base = {
    isDelegationRevoked: async () => { calls.revoked++; return { revoked, evidence: { source } }; },
    isSessionDelegationAccepted: async () => { calls.accepted++; return { accepted: !revoked, evidence: { source } }; },
    verifySmartAgentSignature: async () => ({ valid: true, deployed: true }),
  };
  return { reader: withAuthorityMemo(base as never), calls };
}
const hash = () => `0x${crypto.randomUUID().replace(/-/g, '').padEnd(64, '0')}` as `0x${string}`;

describe('the vault remembers a clean chain answer', () => {
  it('asks the chain once for a delegation that is not revoked and is accepted', async () => {
    const { reader, calls } = chain(false);
    const h = hash();
    await reader.isDelegationRevoked(h, 'high' as never);
    await reader.isDelegationRevoked(h, 'high' as never);
    await reader.isSessionDelegationAccepted('0xAbC', h, 'high' as never);
    await reader.isSessionDelegationAccepted('0xabc', h, 'high' as never);
    expect(calls).toEqual({ revoked: 1, accepted: 1 });
  });

  it('asks every time when the answer is revoked, not accepted, or unconfirmable', async () => {
    const r1 = chain(true);
    const h = hash();
    expect((await r1.reader.isDelegationRevoked(h, 'high' as never)).revoked).toBe(true);
    await r1.reader.isDelegationRevoked(h, 'high' as never);
    await r1.reader.isSessionDelegationAccepted('0xabc', h, 'high' as never);
    await r1.reader.isSessionDelegationAccepted('0xabc', h, 'high' as never);
    expect(r1.calls).toEqual({ revoked: 2, accepted: 2 });
    const r2 = chain(false, 'fail-closed:no-provider');
    const h2 = hash();
    await r2.reader.isDelegationRevoked(h2, 'high' as never);
    await r2.reader.isDelegationRevoked(h2, 'high' as never);
    expect(r2.calls.revoked).toBe(2);
  });
});
