// HANDOFF AS A CHILD DELEGATION — spec 376. The wire profile, and the door at the specialist: a hand-off is
// run only for the parent agent that calls with it, under the chain it carries; anything else is refused.
import { describe, expect, it } from 'vitest';
import { deriveMandate, paymentHandler, registerDefaultSubsetHandlers, hashDelegation, ROOT_AUTHORITY, PAYMENT_RAR_TYPE, buildDigestBindingCaveat, type Delegation, type MandateRequirementV1 } from '@agenticprimitives/delegation';
import { handoff, validateHandoff } from '@agenticprimitives/a2a';
import { handoffMessage, handoffOf } from '../../src/subject-hop.js';
import { standardServerFor } from '../../src/standard-a2a.js';
import type { AgentCardV1 } from '@agenticprimitives/a2a/standard';

registerDefaultSubsetHandlers();
const ALICE = '0xb0d11ce19b756a682e78b4904cd8d832303b3d11';
const RUNTIME = '0x309b2a566e93cc77aabe895d0ec2702c36856ebd';
const HARNESS = '0xd34c3fbc89706dd57d426546dcebd3ba926ede35';
const TREASURY = '0x5ef5360a41f31e55541117a854455c0da0fb67b3';
const E = { delegationManager: '0x710cb1bF08C234Df397e0910331e0A29710EF4F7', timestamp: '0x73A7B878168b7DE48677617179A8bE894f0Dfe96', allowedTargets: '0x2156311097A936de1916a878bF53Bfd43c7b5715', allowedMethods: '0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41', value: '0x8759c1a6cEBF1D5069e9434EF46327Bf2ef69975', payment: '0x07fA0aE59FdE4B7ce8962d6fE7a1d648ec3DD5CE', digestBinding: '0xA3bb9BCC9b2F6F2419E1aBe5ED6Fd5399b9E68e1' } as const;
const CHAIN = 34348;

const parentReq: MandateRequirementV1 = { type: PAYMENT_RAR_TYPE, actions: ['execute'], locations: [TREASURY], limits: { payee: '0x2c471607fec409516ab6de6b7517bcf95f1f2edc', asset: '0xdae09066a2cc32f6203605619137dcf01a9b49ae', maxAmount: '1000000', maxAggregate: '1000000', maxRedemptionsPerWindow: 1, windowSeconds: 3600 }, intentDigest: `0x${'11'.repeat(32)}`, validAfter: 0, validUntil: 4102444800 };
const parent: Delegation = { delegator: TREASURY, delegate: HARNESS, authority: ROOT_AUTHORITY, caveats: [...paymentHandler.toCaveats(parentReq, E as never), buildDigestBindingCaveat(E.digestBinding, 'intent', parentReq.intentDigest)], salt: 1n, signature: '0xparent' };

describe('the child is an attenuation, never a widening', () => {
  it('derives a child narrower in window, bound to the SAME intent, delegated onward by the parent\'s delegate', () => {
    const child = deriveMandate({ parent, parentRequirement: parentReq, requirement: { ...parentReq, validUntil: 1_800_000_000 }, grantee: HARNESS, enforcers: E as never, chainId: CHAIN, delegationManager: E.delegationManager, salt: 2n });
    expect(child.ok).toBe(true);
    if (!child.ok) return;
    expect(child.delegation.delegator).toBe(HARNESS);
    expect(child.delegation.authority).toBe(hashDelegation(parent, CHAIN, E.delegationManager));
  });
  it('REFUSES a child bound to another intent — authority attenuates within one intent, never onto a new one (spec 336)', () => {
    const other = deriveMandate({ parent, parentRequirement: parentReq, requirement: { ...parentReq, intentDigest: `0x${'22'.repeat(32)}` }, grantee: HARNESS, enforcers: E as never, chainId: CHAIN, delegationManager: E.delegationManager, salt: 2n });
    expect(other.ok).toBe(false);
  });
  it('REFUSES a child asking more than the parent — the gate the spec names', () => {
    const wider = deriveMandate({ parent, parentRequirement: parentReq, requirement: { ...parentReq, limits: { ...parentReq.limits!, maxAmount: '2000000', maxAggregate: '2000000' }, intentDigest: `0x${'22'.repeat(32)}` }, grantee: HARNESS, enforcers: E as never, chainId: CHAIN, delegationManager: E.delegationManager, salt: 2n });
    expect(wider.ok).toBe(false);
    if (!wider.ok) expect(wider.reason).toMatch(/not a subset/);
  });
});

const h = handoff({ intent: { goal: 'pay: payee nathan.treasury, usdc 1', context: { parent: { agent: ALICE, runRef: 'run-a', stepRef: 's0' } } }, plan: { steps: [{ toolId: 'treasury.payment.execute', args: { payee: 'nathan.treasury', usdc: '1' }, id: 's0' }] }, presented: [{ ...parent, salt: '1' }], parent: { agent: ALICE, runRef: 'run-a', stepRef: 's0', operationId: 'run-a:s0', childRef: `0x${'33'.repeat(32)}` } });

describe('the profile', () => {
  it('validates, rides as message metadata, and reads back', () => {
    expect(validateHandoff(h).ok).toBe(true);
    expect(validateHandoff({ ...h, plan: { steps: [] } }).ok).toBe(false);
    expect(validateHandoff({ ...h, presented: [] }).ok).toBe(false);
    const back = handoffOf(handoffMessage(h));
    expect(back && 'handoff' in back ? back.handoff.parent.operationId : null).toBe('run-a:s0');
    expect(handoffOf({ metadata: {} })).toBeNull();
  });
});

describe('the door at the specialist', () => {
  const MARKER = 'test-marker-0123456789abcdef0123456789abcdef';
  const card: AgentCardV1 = { name: 'runtime-c3s0.svc', description: '', version: '1', supportedInterfaces: [{ url: 'https://runtime-c3s0-svc.faithnet.ai/api/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }], capabilities: {}, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [] };
  const build = (calls: unknown[]) => standardServerFor(RUNTIME, card, 'runtime-c3s0-svc.faithnet.ai', {
    env: { A2A_INTERNAL_MARKER: MARKER } as never,
    appFetch: async () => new Response('{}'),
    verifySession: async () => ({ ok: false, status: 401, error: 'no' }),
    runHandoff: async (input) => { calls.push(input); return { ok: true, reply: { kind: 'done', result: { txHash: '0xtx' }, text: 'paid' } }; },
  });
  const send = (server: ReturnType<typeof build>, headers: Record<string, string>) => server.handle(new Request('https://runtime-c3s0-svc.faithnet.ai/api/a2a', {
    method: 'POST', headers: { 'content-type': 'application/json', 'a2a-version': '1.0', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: handoffMessage(h) } }),
  })).then((r) => r.json() as Promise<{ result?: { task?: { status: { state: string; message?: { parts: Array<{ text?: string }> } }; artifacts?: Array<{ name?: string }> } }; error?: { code: number } }>);

  it('runs the step for the parent agent that calls, and answers with the subject-answer artifact', async () => {
    const calls: unknown[] = [];
    const out = await send(build(calls), { 'x-ap-internal': MARKER, 'x-ap-internal-agent': ALICE });
    expect(out.result?.task?.status.state).toBe('TASK_STATE_COMPLETED');
    expect(out.result?.task?.artifacts?.[0]?.name).toBe('subject-answer');
    expect((calls[0] as { parent: string; executor: string }).parent).toBe(ALICE);
    expect((calls[0] as { executor: string }).executor).toBe(RUNTIME);
  });
  it('REFUSES a caller that is not the parent the hand-off names, and admits nobody without the marker', async () => {
    const calls: unknown[] = [];
    const other = await send(build(calls), { 'x-ap-internal': MARKER, 'x-ap-internal-agent': TREASURY });
    expect(other.result?.task?.status.state).toBe('TASK_STATE_REJECTED');
    expect(other.result?.task?.status.message?.parts[0]?.text).toMatch(/parent other than its caller/);
    const shut = await send(build(calls), { 'x-ap-internal-agent': ALICE });
    expect(shut.error?.code ?? 0).not.toBe(0);
    expect(calls.length).toBe(0);
  });
});
