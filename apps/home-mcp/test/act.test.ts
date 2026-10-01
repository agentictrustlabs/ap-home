// Spec 397 §11 — the act gate: who may request scope act, which wires this Worker accepts, what a parked reply yields.
import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverMessageAddress, type Address, type Hex } from 'viem';
import { buildStandingWire, hashDelegation, registerDefaultSubsetHandlers, type Delegation } from '@agenticprimitives/delegation';
import { acceptStandingWires, actKeyAddress, clientMayAct, deriveForParked, parkedOf, requestsAct } from '../src/act.js';
registerDefaultSubsetHandlers();

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const ADDR = privateKeyToAccount(KEY).address.toLowerCase();
const ALICE = '0x1111111111111111111111111111111111111111';
const wire = (over: Partial<Record<string, unknown>> = {}, cap = 'messaging.send', limits?: Record<string, unknown>) => ({ v: 1, template: 'act-as-me', capability: cap, wire: { delegator: ALICE, delegate: ADDR, caveats: [], salt: '1', signature: '0x03', ...over }, ref: '0xabc', requirement: { type: 'x', actions: [cap], validUntil: 1, ...(limits ? { limits } : {}) } });

describe('scope act', () => {
  it('is granted only by the operator: the registration flag or the allowlist — never the body alone', () => {
    expect(clientMayAct({}, 'claude-dcr', undefined)).toBe(false);
    expect(clientMayAct({}, 'claude-dcr', true)).toBe(true);
    expect(clientMayAct({ ACT_CLIENT_IDS: 'a, b' }, 'b', undefined)).toBe(true);
    // A host that re-registers every attempt is named by its redirect URI; a registration with any other URI is not.
    const env = { ACT_REDIRECT_URIS: 'https://agent.meta.ai/api/hatch/oauth/callback' };
    expect(clientMayAct(env, 'mcp_fresh', undefined, ['https://agent.meta.ai/api/hatch/oauth/callback'])).toBe(true);
    expect(clientMayAct(env, 'mcp_fresh', undefined, ['https://agent.meta.ai/api/hatch/oauth/callback', 'https://evil.example/cb'])).toBe(false);
    expect(clientMayAct(env, 'mcp_fresh', undefined, [])).toBe(false);
    expect(clientMayAct({}, 'mcp_fresh', undefined, ['https://agent.meta.ai/api/hatch/oauth/callback'])).toBe(false);
    expect(requestsAct(['ask'])).toBe(false);
    expect(requestsAct(['ask', 'act'])).toBe(true);
  });
  it('the act key is a second secret; no key ⇒ scope act is not served', () => {
    expect(actKeyAddress({})).toBeNull();
    expect(actKeyAddress({ HOME_MCP_ACT_KEY: KEY })).toBe(ADDR);
    expect(acceptStandingWires({}, ALICE, [wire()])).toMatchObject({ ok: false });
  });
  it('accepts only wires that name THIS act key; a capability wire must be hers; a payment wire must carry its bounds', () => {
    const env = { HOME_MCP_ACT_KEY: KEY };
    expect(acceptStandingWires(env, ALICE, [wire()])).toMatchObject({ ok: true });
    expect(acceptStandingWires(env, ALICE, [wire({ delegate: ALICE })])).toMatchObject({ ok: false, error: expect.stringMatching(/act key/) });
    expect(acceptStandingWires(env, ALICE, [wire({ delegator: '0x2222222222222222222222222222222222222222' })])).toMatchObject({ ok: false, error: expect.stringMatching(/connecting person/) });
    expect(acceptStandingWires(env, ALICE, [wire({ delegator: '0x2222222222222222222222222222222222222222' }, 'treasury.payment.execute')])).toMatchObject({ ok: false, error: expect.stringMatching(/payee, asset and cap/) });
    expect(acceptStandingWires(env, ALICE, [wire({ delegator: '0x2222222222222222222222222222222222222222' }, 'treasury.payment.execute', { payee: '0x3', asset: '0x4', maxAmount: '5' })])).toMatchObject({ ok: true });
    expect(acceptStandingWires(env, ALICE, [])).toMatchObject({ ok: false });
  });
  it('a parked reply yields its need only when the agent said everything a derivation needs', () => {
    expect(parkedOf({ kind: 'authority_required' }, 'run:1')).toBeNull();
    const need = { requirement: { type: 'urn:ap:rar:capability', actions: ['messaging.send'], validUntil: 9, intentDigest: '0x11' }, delegator: ALICE, delegate: '0x9999999999999999999999999999999999999999', capability: 'messaging.send' };
    expect(parkedOf(need, 'run:1')).toMatchObject({ runRef: 'run:1', capability: 'messaging.send' });
    expect(parkedOf(need, '')).toBeNull();
  });

  it('derives the child for a covered need and signs it the way the chain recovers an EOA delegator: EIP-191 over the child digest', async () => {
    const env = { HOME_MCP_ACT_KEY: KEY };
    const DM = '0x710cb1bF08C234Df397e0910331e0A29710EF4F7' as Address;
    const E = { delegationManager: DM, timestamp: '0x0000000000000000000000000000000000000011', value: '0x0000000000000000000000000000000000000012', allowedTargets: '0x0000000000000000000000000000000000000022', allowedMethods: '0x0000000000000000000000000000000000000033', payment: '0x0000000000000000000000000000000000000044', digestBinding: '0x00000000000000000000000000000000000000d1' } as const;
    const TREASURY = '0x5ef5360a41f31e55541117a854455c0da0fb67b3' as Address;
    const PAYEE = '0x2c471607fec409516ab6de6b7517bcf95f1f2edc' as Address;
    const USDC = '0xdae09066a2cc32f6203605619137dcf01a9b49ae' as Address;
    const { standing } = buildStandingWire({ template: 'act-as-me', delegator: TREASURY, delegate: ADDR as Address, capability: 'treasury.payment.execute', payment: { payee: PAYEE, asset: USDC, maxAmount: 2_000_000n }, validForSeconds: 3600, enforcers: E as never, chainId: 34348, delegationManager: DM, salt: 3n });
    const now = Math.floor(Date.now() / 1000);
    const need = { requirement: { type: 'urn:ap:rar:treasury.payment.execute', actions: ['treasury.payment.execute'], locations: [USDC], limits: { payee: PAYEE, asset: USDC, maxAmount: '1000000', maxAggregate: '1000000', maxRedemptionsPerWindow: 1, windowSeconds: 3600 }, intentDigest: '0x' + '11'.repeat(32), validAfter: now - 10, validUntil: now + 600 }, delegator: TREASURY, delegate: '0x9999999999999999999999999999999999999999', capability: 'treasury.payment.execute', kind: 'authority_required' };
    const parked = parkedOf(need, 'run:1')!;
    const r = await deriveForParked(env, { v: 1, client_id: 'c', standing: [standing], granted_at: 0 }, parked);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.parentRef).toBe(standing.ref);
    const child = r.presented[0] as Record<string, unknown>;
    expect(String(child.delegator).toLowerCase()).toBe(ADDR);
    const digest = hashDelegation({ ...child, salt: BigInt(String(child.salt)) } as unknown as Delegation, 34348, DM);
    expect(digest).toBe(r.childRef);
    expect((await recoverMessageAddress({ message: { raw: digest }, signature: child.signature as Hex })).toLowerCase()).toBe(ADDR);
    // Over the cap: nothing is derived; the run stays parked for her.
    const over = await deriveForParked(env, { v: 1, client_id: 'c', standing: [standing], granted_at: 0 }, parkedOf({ ...need, requirement: { ...need.requirement, limits: { ...need.requirement.limits, maxAmount: '5000000', maxAggregate: '5000000' } } }, 'run:2')!);
    expect(over.ok).toBe(false);
  });
});
