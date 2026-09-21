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
