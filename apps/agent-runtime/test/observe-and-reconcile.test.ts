// Spec 410 §2 + §3 in the runtime — what each adapter family says it saw, and the reconcile bindings.
import { describe, it, expect } from 'vitest';
import { isToolInvocationResult } from '@agenticprimitives/orchestration';
import { ROOT_AUTHORITY, intentDigest, hashDelegation } from '@agenticprimitives/delegation';
import { keccak256, toBytes, type Address, type Hex } from 'viem';
import { observeResult, harnessReconcilePort, STANDING_INSTRUCTION_CAPABILITY } from '../src/harness-run.js';

const obs = (v: unknown) => { const r = observeResult('t', v); if (!isToolInvocationResult(r)) throw new Error('expected an observation'); return r.observation; };

describe('observeResult — each family says what it can vouch for', () => {
  it('a chain effect with a tx hash is confirmed: the bundler client read the receipt', () => {
    const o = obs({ txHash: '0xabc', asset: '0x1', payee: '0x2' });
    expect(o.outcome).toBe('confirmed'); expect(o.providerRef).toBe('0xabc'); expect(o.evidence[0]?.kind).toBe('chain-read');
  });
  it('an already-settled payment is confirmed by the enforcer read', () => {
    const o = obs({ alreadySettled: true, effectIdentity: '0xd:0xn' });
    expect(o.outcome).toBe('confirmed'); expect(o.providerRef).toBe('0xd:0xn'); expect(o.evidence[0]?.kind).toBe('reconcile');
  });
  it('a delivered message is committed by the sender\'s object, not read back', () => {
    const o = obs({ sent: true, recipient: '0x2', messageId: 'm-1' });
    expect(o.outcome).toBe('committed'); expect(o.providerRef).toBe('m-1');
    expect(obs({ posted: true, org: '0x3', messageId: 'm-2' }).outcome).toBe('committed');
  });
  it('a vault write is committed under its record type', () => {
    const o = obs({ kept: true, record: 'standing.instructions', capability: 'x' });
    expect(o.outcome).toBe('committed'); expect(o.providerRef).toBe('standing.instructions');
    expect(obs({ remembered: true, record: 'memory.facts', id: 'f1' }).outcome).toBe('committed');
  });
  it('an invitation is accepted — a submission, never a membership', () => {
    const o = obs({ invited: true, grantDigest: '0xg' });
    expect(o.outcome).toBe('accepted'); expect(o.providerRef).toBe('0xg');
  });
  it('outside providers: a created object is committed, a draft accepted, an unknown MCP server at most accepted', () => {
    expect(obs({ opened: true, url: 'https://github.com/o/r/pull/1' }).providerRef).toBe('https://github.com/o/r/pull/1');
    expect(obs({ created: true, event: { id: 'ev1' } }).outcome).toBe('committed');
    expect(obs({ drafted: true, draftId: 'd1' }).outcome).toBe('accepted');
    expect(obs({ called: true, connector: 'acme', text: 'ok' }).outcome).toBe('accepted');
  });
  it('a routed step is committed when the receiver\'s receipts came back, accepted while it holds the step', () => {
    expect(obs({ via: { runRef: 'run-9', receipts: [{ stepRef: 's0', status: 'executed' }] } }).outcome).toBe('committed');
    expect(obs({ via: { runRef: 'run-9' } }).outcome).toBe('accepted');
  });
  it('a value that proves nothing stays raw, so the loop records attempted', () => {
    expect(isToolInvocationResult(observeResult('t', { ok: true }))).toBe(false);
    expect(isToolInvocationResult(observeResult('t', 'a string'))).toBe(false);
    const already = { output: 1, observation: { outcome: 'committed', observedAt: 't', evidence: [] } };
    expect(observeResult('t', already)).toBe(already);
  });
});

describe('harnessReconcilePort', () => {
  const ME = '0x0a60000000000000000000000000000000000001' as Address;
  const env = { CHAIN_ID: '34348', DELEGATION_MANAGER: '0x0000000000000000000000000000000000000010', PAYMENT_ENFORCER: '0x0000000000000000000000000000000000000044', TIMESTAMP_ENFORCER: '0x0000000000000000000000000000000000000011', VALUE_ENFORCER: '0x0000000000000000000000000000000000000012', ALLOWED_TARGETS_ENFORCER: '0x0000000000000000000000000000000000000022', ALLOWED_METHODS_ENFORCER: '0x0000000000000000000000000000000000000033', DIGEST_BINDING_ENFORCER: '0x00000000000000000000000000000000000000d1' } as never;
  const intent = { goal: 'pay bob 10', context: {} };
  const wire = { delegator: ME, delegate: '0x0a60000000000000000000000000000000000002' as Address, authority: ROOT_AUTHORITY, caveats: [], salt: 1n, signature: '0x03' as Hex };
  const req = (toolId: string, args: Record<string, unknown> = {}, operationId = 'run-1:s0') => ({ operationId, runRef: 'run-1', stepRef: 's0', step: { toolId, args }, tool: { id: toolId, description: '', capability: { id: toolId, action: 'x' } }, args }) as never;

  it('a write the subject\'s object recorded is found; nothing recorded is absent; a store that cannot answer is indeterminate', async () => {
    const port = harnessReconcilePort({ lookupOperation: async (_s, op) => (op === 'run-1:s0' ? { kind: 'write', ref: 'standing.instructions', at: '2026-09-20T12:00:00Z' } : null), readContract: async () => false } as never, env, [], intent, ME);
    const a = await port.reconcile(req(STANDING_INSTRUCTION_CAPABILITY));
    expect(a.status).toBe('found');
    if (a.status === 'found') { expect(a.observation.outcome).toBe('confirmed'); expect(a.observation.providerRef).toBe('standing.instructions'); expect((a.output as { reconciled?: boolean }).reconciled).toBe(true); }
    expect((await port.reconcile(req(STANDING_INSTRUCTION_CAPABILITY, {}, 'run-1:s1'))).status).toBe('absent');
    const down = harnessReconcilePort({ lookupOperation: async () => { throw new Error('DO unreachable'); }, readContract: async () => false } as never, env, [], intent, ME);
    const d = await down.reconcile(req(STANDING_INSTRUCTION_CAPABILITY));
    expect(d.status).toBe('indeterminate');
  });
  it('a send is found only as a send: a write ledger row for the same id does not count', async () => {
    const port = harnessReconcilePort({ lookupOperation: async () => ({ kind: 'write', ref: 'x', at: 't' }) } as never, env, [], intent, ME);
    expect((await port.reconcile(req('messaging.direct.send'))).status).toBe('absent');
    const sent = harnessReconcilePort({ lookupOperation: async () => ({ kind: 'send', ref: 'm-7', at: 't' }) } as never, env, [], intent, ME);
    const a = await sent.reconcile(req('messaging.direct.send'));
    expect(a.status).toBe('found'); if (a.status === 'found') expect(a.observation.providerRef).toBe('m-7');
  });
  it('a payment is found when the enforcer\'s nonce slot for (delegator, delegation hash, intent-derived nonce) is used', async () => {
    const seen: unknown[] = [];
    const port = harnessReconcilePort({ readContract: async (c: { functionName: string; args: unknown[] }) => { seen.push(c.args); return c.functionName === 'isNonceUsed'; } } as never, env, [{ ref: 'm', wire }], intent, ME);
    const a = await port.reconcile(req('treasury.payment.execute', { payee: '0x0a60000000000000000000000000000000000009', amount: '10' }));
    expect(a.status).toBe('found');
    const nonce = keccak256(toBytes(`${intentDigest(intent)}:s0`));
    const dHash = hashDelegation(wire, 34348, env.DELEGATION_MANAGER);
    expect(seen[0]).toEqual([ME, dHash, nonce]);
    if (a.status === 'found') { expect(a.observation.outcome).toBe('confirmed'); expect(a.observation.evidence[0]?.kind).toBe('chain-read'); expect(a.observation.providerRef).toBe(`${dHash}:${nonce}`); }
    const fresh = harnessReconcilePort({ readContract: async () => false } as never, env, [{ ref: 'm', wire }], intent, ME);
    expect((await fresh.reconcile(req('treasury.payment.execute', { payee: '0x0a60000000000000000000000000000000000009' }))).status).toBe('absent');
    const rpcDown = harnessReconcilePort({ readContract: async () => { throw new Error('rpc'); } } as never, env, [{ ref: 'm', wire }], intent, ME);
    expect((await rpcDown.reconcile(req('treasury.payment.execute'))).status).toBe('indeterminate');
  });
  it('a declared idempotency key is the nonce\'s second half — two identical payments under different keys are two operations', async () => {
    const seen: Hex[][] = [];
    const port = harnessReconcilePort({ readContract: async (c: { args: Hex[] }) => { seen.push(c.args); return false; } } as never, env, [{ ref: 'm', wire }], intent, ME);
    await port.reconcile({ ...req('treasury.payment.execute'), step: { toolId: 'treasury.payment.execute', args: {}, idempotencyKey: 'rent-2026-09' } } as never);
    await port.reconcile({ ...req('treasury.payment.execute'), step: { toolId: 'treasury.payment.execute', args: {}, idempotencyKey: 'rent-2026-10' } } as never);
    expect(seen[0]![2]).not.toBe(seen[1]![2]);
    expect(seen[0]![2]).toBe(keccak256(toBytes(`${intentDigest(intent)}:rent-2026-09`)));
  });
});
