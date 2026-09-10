// A TREASURY HOLDS MORE THAN ONE COIN, and this Home used to be able to see exactly one.
//
// The treasury views read `balanceOf` on the demo USDC and printed the answer as "Balance: N USDC".
// That is not the balance of the account; it is the balance of one asset in it. So a treasury holding
// ten thousand Sheqels — the card room's own currency, in the same Smart Agent, visible and correct in
// the app that uses it — read "Balance: 0.00 USDC" here, and its owner reasonably concluded their
// money was gone. The number was never wrong. The label was.
//
// WHAT THIS DOES NOT DO is teach Home about any particular app. A relying app's currency is a fact
// about a deployment, not about this codebase, so the extra coins are configuration:
//
//   NEXT_PUBLIC_APP_COINS  a JSON array of { address, symbol, decimals? }, decimals defaulting to 6
//                          (the rail's figure for every coin). Example, one line:
//                          [{"address":"0xa14E…6141","symbol":"SHQ"}]
//
// Bad entries are dropped rather than throwing: a malformed coin should cost that coin's row, not the
// whole Treasuries page. An unparseable list throws at build time, like every other NEXT_PUBLIC_ here,
// because that one is a typo somebody wants told about.

import type { Address } from '@agenticprimitives/types';
import { CONTRACTS } from './chain';

export interface Coin {
  address: Address;
  symbol: string;
  decimals: number;
  /**
   * The settlement asset this Home itself funds and mints. Shown even at zero, because "Fund with
   * USDC" is offered right beside it and a balance that vanishes when empty makes that button
   * look like it is for nothing.
   */
  primary?: boolean;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Read the configured extras. Exported for the test; `COINS` is what callers want. */
export function parseAppCoins(raw: string | undefined): Coin[] {
  if (!raw || !raw.trim()) return [];
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    throw new Error('NEXT_PUBLIC_APP_COINS is not valid JSON');
  }
  if (!Array.isArray(list)) throw new Error('NEXT_PUBLIC_APP_COINS must be a JSON array');
  const out: Coin[] = [];
  for (const item of list) {
    const c = item as { address?: unknown; symbol?: unknown; decimals?: unknown };
    const address = typeof c?.address === 'string' ? c.address : '';
    if (!ADDRESS_RE.test(address)) continue;
    const symbol = typeof c.symbol === 'string' ? c.symbol.trim().slice(0, 12) : '';
    if (!symbol) continue;
    const decimals = Number.isInteger(c.decimals) ? (c.decimals as number) : 6;
    if (decimals < 0 || decimals > 36) continue;
    // Never a second row for the coin this Home already shows.
    if (out.some((x) => x.address.toLowerCase() === address.toLowerCase())) continue;
    out.push({ address: address as Address, symbol, decimals });
  }
  return out;
}

/** Every coin this Home can show a balance for. The primary first, then whatever is configured. */
export const COINS: Coin[] = [
  { address: CONTRACTS.mockUsdc, symbol: 'USDC', decimals: 6, primary: true },
  ...parseAppCoins(process.env.NEXT_PUBLIC_APP_COINS).filter((c) => c.address.toLowerCase() !== CONTRACTS.mockUsdc.toLowerCase()),
];

/**
 * Which balances to PRINT for one account.
 *
 * The primary always, so the fund button beside it has something to refer to. Everything else only
 * when there is some — a treasury that has never touched the card room should not carry a row of
 * zeroes for a currency its owner has never heard of.
 */
export function shown(balances: readonly { coin: Coin; amount: bigint | null }[]): { coin: Coin; amount: bigint | null }[] {
  return balances.filter((b) => b.coin.primary || (b.amount !== null && b.amount > 0n));
}
