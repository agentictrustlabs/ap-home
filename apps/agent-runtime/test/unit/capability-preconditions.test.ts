// Spec 410 §7 — the Ask's HONESTY READ of the aggregate limit: `TreasurySpendPolicy.remaining()` before a payment is
// offered for signature. A window that cannot carry the payment refuses with the numbers, instead of a signature that
// fails at `BudgetExceeded`. Honesty, never authority: the hook decides at commit whatever this said.
import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { preconditionRefusal } from '../../src/capability-preconditions.js';

const PAYER = '0x0a60000000000000000000000000000000000001' as Address;
const USDC = '0x0000000000000000000000000000000000000ee0' as Address;
const POLICY = '0x0000000000000000000000000000000000000c0d' as Address;
const deps = (remaining: { left: bigint; ceiling: bigint } | null, balance = 1_000_000_000n) => ({
  readContract: async (a: { functionName: string; address: string }) => {
    if (a.functionName === 'remaining') { if (!remaining) throw new Error('rpc'); return remaining; }
    if (a.functionName === 'balanceOf') return balance;
    throw new Error(`unexpected read ${a.functionName}`);
  },
}) as never;
const ask = (env: Record<string, string>, d: unknown, usdc = '10') => preconditionRefusal({ capability: 'treasury.payment.execute', args: { payer: PAYER, payee: '0x0a60000000000000000000000000000000000002', usdc }, env: env as never, deps: d as never });

describe('the spend window, read before the signature', () => {
  it('a window that cannot carry the payment is refused with the numbers — the balance is not even consulted', async () => {
    const r = await ask({ MOCK_USDC: USDC, TREASURY_SPEND_POLICY: POLICY }, deps({ left: 4_000_000n, ceiling: 100_000_000n }));
    expect(r).toMatch(/may spend 4 more USDC in this window/); expect(r).toMatch(/ceiling is 100/); expect(r).toMatch(/needs 10/); expect(r).toMatch(/Nothing was authorized/);
  });
  it('a window with room passes to the balance check; enough balance ⇒ nothing to say', async () => {
    expect(await ask({ MOCK_USDC: USDC, TREASURY_SPEND_POLICY: POLICY }, deps({ left: 50_000_000n, ceiling: 100_000_000n }))).toBeNull();
    expect(await ask({ MOCK_USDC: USDC, TREASURY_SPEND_POLICY: POLICY }, deps({ left: 50_000_000n, ceiling: 100_000_000n }, 1_000_000n))).toMatch(/holds 1 USDC and this needs 10/);
  });
  it('no policy installed (remaining is the max, ceiling 0) or no policy on this estate ⇒ the window says nothing', async () => {
    expect(await ask({ MOCK_USDC: USDC, TREASURY_SPEND_POLICY: POLICY }, deps({ left: 2n ** 256n - 1n, ceiling: 0n }))).toBeNull();
    expect(await ask({ MOCK_USDC: USDC }, deps({ left: 0n, ceiling: 100_000_000n }))).toBeNull();
  });
  it('an unreadable policy never becomes a refusal — the chain still decides', async () => {
    expect(await ask({ MOCK_USDC: USDC, TREASURY_SPEND_POLICY: POLICY }, deps(null))).toBeNull();
  });
});

// The value rail read BEFORE the signature (spec 373): a payee that is not a treasury on THIS chain is refused with the
// counterparty and the chain named, instead of a mandate ceremony the invoker would refuse after the signature.
// (ap-federation gate:pay-outward, 2026-11-11: a hopechain payer, a faithchain treasury, and the run parked for authority.)
describe('the counterparty, read before the signature', () => {
  const PAYEE = '0x3165c8b2dd731bcea936be8156ff87871a9ed7ec';
  const zeroData = () => { const e = new Error('The contract function "entryPoint" returned no data ("0x").') as Error & { cause?: unknown }; e.cause = Object.assign(new Error('returned no data ("0x")'), { name: 'ContractFunctionZeroDataError' }); return e; };
  const withKind = (type: string | null, account: 'here' | 'absent' | 'unreadable', names: Record<string, string> = {}) => ({
    readContract: async (a: { functionName: string }) => {
      if (a.functionName === 'balanceOf') return 1_000_000_000n;
      if (a.functionName === 'entryPoint') { if (account === 'here') return '0x0000000000000000000000000000000000004337'; if (account === 'absent') throw zeroData(); throw new Error('fetch failed'); }
      throw new Error(`unexpected read ${a.functionName}`);
    },
    agentTypeOf: async () => type,
    nameOf: async (a: string) => names[a.toLowerCase()] ?? null,
    resolveName: async (n: string) => (n === 'alice2.treasury' ? PAYEE : null),
  });
  const pay = (d: unknown, payee: string = PAYEE) => preconditionRefusal({ capability: 'treasury.payment.execute', args: { payer: PAYER, payee, usdc: '3' }, env: { MOCK_USDC: USDC, CHAIN_ID: '34349' } as never, deps: d as never });

  it('an address that is nobody on this chain is refused — value does not cross chains — naming the address and the chain', async () => {
    const r = await pay(withKind(null, 'absent'));
    expect(r).toContain(PAYEE); expect(r).toMatch(/not an account on eip155:34349/); expect(r).toMatch(/value does not cross chains/); expect(r).toMatch(/Nothing was authorized/);
  });
  it('a treasury here passes to the balance check', async () => {
    expect(await pay(withKind('treasury', 'here'))).toBeNull();
  });
  it('a person or an organization here is refused with what it is', async () => {
    expect(await pay(withKind('person', 'here', { [PAYEE]: 'alice.me' }))).toMatch(/alice\.me is a person on eip155:34349/);
    expect(await pay(withKind('org', 'here'))).toMatch(/is an organization on eip155:34349/);
  });
  it('an account here with no type recorded is refused — it cannot be shown to be a treasury', async () => {
    expect(await pay(withKind(null, 'here'))).toMatch(/no agent type recorded on eip155:34349/);
  });
  it('a NAME is resolved first, and an unreadable chain never becomes a refusal', async () => {
    expect(await pay(withKind(null, 'absent'), 'alice2.treasury')).toMatch(/not an account on eip155:34349/);
    expect(await pay(withKind(null, 'unreadable'))).toBeNull();
  });
});
