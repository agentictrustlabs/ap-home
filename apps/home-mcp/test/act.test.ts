// Spec 397 §11 — the act gate: who may request scope act, which wires this Worker accepts, what a parked reply yields.
import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { acceptStandingWires, actKeyAddress, clientMayAct, parkedOf, requestsAct } from '../src/act.js';

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const ADDR = privateKeyToAccount(KEY).address.toLowerCase();
const ALICE = '0x1111111111111111111111111111111111111111';
const wire = (over: Partial<Record<string, unknown>> = {}, cap = 'messaging.send', limits?: Record<string, unknown>) => ({ v: 1, template: 'act-as-me', capability: cap, wire: { delegator: ALICE, delegate: ADDR, caveats: [], salt: '1', signature: '0x03', ...over }, ref: '0xabc', requirement: { type: 'x', actions: [cap], validUntil: 1, ...(limits ? { limits } : {}) } });

describe('scope act', () => {
  it('is granted only by the operator: the registration flag or the allowlist — never the body alone', () => {
    expect(clientMayAct({}, 'claude-dcr', undefined)).toBe(false);
    expect(clientMayAct({}, 'claude-dcr', true)).toBe(true);
    expect(clientMayAct({ ACT_CLIENT_IDS: 'a, b' }, 'b', undefined)).toBe(true);
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
});
