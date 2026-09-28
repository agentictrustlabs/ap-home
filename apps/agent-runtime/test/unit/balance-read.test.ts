import { describe, expect, it } from 'vitest';
import { balanceReadInvoker, renderAnswer, BALANCE_READ_TOOL } from '../../src/balance-read.js';

// Spec 371 — the balance is the chain's figure now, in the person's unit, rendered from the author's sentence.
const ALICE = '0x0000000000000000000000000000000000000a11' as const;
const T1 = '0x0000000000000000000000000000000000000001', T2 = '0x0000000000000000000000000000000000000002';
const ORG = '0x0000000000000000000000000000000000000b0b';
const TYPES: Record<string, string> = { [ALICE]: 'person', [T1]: 'treasury', [T2]: 'treasury', [ORG]: 'org' };
const deps = {
  agentTypeOf: async (a: string) => TYPES[a] ?? null,
  valueHeld: async (a: string) => (a === T1 ? { amount: 12_000_000n, display: '12 USDC' } : a === T2 ? { amount: 0n, display: 'empty' } : null),
  charteredAgents: async () => [{ agent: T1, name: 'alice2.treasury', primary: true }, { agent: T2, name: 'alice3.treasury' }],
};

describe('the balance read', () => {
  it('unnamed: every treasury the person holds, one line each, in USDC — never a base figure', async () => {
    const r = await balanceReadInvoker(deps, ALICE, ALICE)('treasury.balance.read', {}, { intent: { goal: 'what is my balance' }, step: { toolId: 'treasury.balance.read', args: {} }, index: 0, operationId: 'op-0' }) as { items: Array<{ label: string; display: string; usdc: string }>; count: number };
    expect(r.count).toBe(2);
    expect(r.items.map((i) => [i.label, i.display, i.usdc])).toEqual([['alice2.treasury', '12 USDC', '12'], ['alice3.treasury', '0 USDC', '0']]);
    expect(JSON.stringify(r)).not.toMatch(/12000000/);
    expect(renderAnswer(BALANCE_READ_TOOL.answer!, r)).toBe('alice2.treasury holds 12 USDC. alice3.treasury holds 0 USDC.');
  });
  it('inside a treasury or an organization, an unnamed question is about THAT realm — never the asker\'s other accounts', async () => {
    const r = await balanceReadInvoker({ ...deps, nameOf: async () => 'alice3.treasury' }, T2 as never, ALICE)('treasury.balance.read', {}, { intent: { goal: 'what is the balance' }, step: { toolId: 'x', args: {} }, index: 0, operationId: 'op-0' }) as { items: Array<{ label: string }> };
    expect(r.items.map((i) => i.label)).toEqual(['alice3.treasury']);
  });
  it('named: that account; a name that did not resolve is refused by name, never guessed', async () => {
    const one = await balanceReadInvoker({ ...deps, nameOf: async () => 'alice2.treasury' }, ALICE, ALICE)('treasury.balance.read', { account: T1 }, { intent: { goal: 'x' }, step: { toolId: 'x', args: {} }, index: 0, operationId: 'op-0' }) as { items: Array<{ label: string }> };
    expect(one.items.map((i) => i.label)).toEqual(['alice2.treasury']);
    const bad = await balanceReadInvoker(deps, ALICE, ALICE)('treasury.balance.read', { account: 'bobs money' }, { intent: { goal: 'x' }, step: { toolId: 'x', args: {} }, index: 0, operationId: 'op-0' }) as { count: number; reason: string };
    expect(bad.count).toBe(0);
    expect(bad.reason).toMatch(/does not know an account called/);
  });
  it('a template with a missing field renders nothing — the composer takes over rather than printing undefined', () => {
    expect(renderAnswer('{{label}} holds {{display}}.', { items: [{ label: 'x' }] })).toBeNull();
    expect(renderAnswer('{{label}} holds {{display}}.', { items: [], reason: 'no treasury is chartered under you' })).toBe('no treasury is chartered under you');
    expect(renderAnswer('{{a.b}}!', { a: { b: 'deep' } })).toBe('deep!');
  });

  // The value rail (user mandate, 2026-09-28): assets live only in treasuries; a balance on an organization or a person is ignored.
  it('an organization means the treasuries it charters — its own balance is never read', async () => {
    const read: string[] = [];
    const r = await balanceReadInvoker({ ...deps, valueHeld: async (a: string) => { read.push(a); return deps.valueHeld(a); }, charteredAgents: async (o: string) => (o === ORG ? [{ agent: T1, name: 'mn-ops.treasury' }] : []) }, ORG as never, ALICE)('treasury.balance.read', {}, { intent: { goal: 'x' }, step: { toolId: 'x', args: {} }, index: 0, operationId: 'op-0' }) as { items: Array<{ label: string }> };
    expect(r.items.map((i) => i.label)).toEqual(['mn-ops.treasury']);
    expect(read).toEqual([T1]);
  });
  it('an organization with no treasury reports none — even when USDC sits on the organization itself', async () => {
    const read: string[] = [];
    const r = await balanceReadInvoker({ ...deps, nameOf: async () => 'missio-nexus.org', valueHeld: async (a: string) => { read.push(a); return { amount: 51_000_000n, display: '51 USDC' }; }, charteredAgents: async () => [] }, ORG as never, ALICE)('treasury.balance.read', {}, { intent: { goal: 'x' }, step: { toolId: 'x', args: {} }, index: 0, operationId: 'op-0' }) as { count: number; reason: string };
    expect(read).toEqual([]);
    expect(r.count).toBe(0);
    expect(renderAnswer(BALANCE_READ_TOOL.answer!, r)).toBe('missio-nexus.org holds no treasury, and balances are kept only in treasuries — there is nothing to report.');
  });
  it('a named person means their treasuries; with no type reader nothing is read', async () => {
    const r = await balanceReadInvoker(deps, ORG as never, ALICE)('treasury.balance.read', { account: ALICE }, { intent: { goal: 'x' }, step: { toolId: 'x', args: {} }, index: 0, operationId: 'op-0' }) as { items: Array<{ label: string }> };
    expect(r.items.map((i) => i.label)).toEqual(['alice2.treasury', 'alice3.treasury']);
    const { agentTypeOf: _a, ...noType } = deps;
    expect(await balanceReadInvoker(noType, ALICE, ALICE)('treasury.balance.read', {}, { intent: { goal: 'x' }, step: { toolId: 'x', args: {} }, index: 0, operationId: 'op-0' })).toMatchObject({ count: 0, reason: expect.stringMatching(/only from treasuries/) });
  });
});
