// A TREASURY HOLDS MORE THAN ONE COIN, and this Home used to be able to see exactly one.
//
// The treasury views read `balanceOf` on the demo USDC and printed the answer as "Balance: N USDC".
// That is not the balance of the account; it is the balance of one asset in it. So a treasury holding
// ten thousand Sheqels — the card room's own currency, in the same Smart Agent, visible and correct in
// the app that uses it — read "Balance: 0.00 USDC" here, and its owner reasonably concluded their
// money was gone. The number was never wrong. The label was.
//
// WHERE THE LIST COMES FROM. An ERC-20 balance is not enumerable from an address — you cannot ask an
// account what it holds — so a candidate list is unavoidable. Two sources, in order:
//
//   NEXT_PUBLIC_APP_COINS  a JSON array of { address, symbol, decimals? }, decimals defaulting to 6
//                          (the rail's figure for every coin). Set, it is the whole answer.
//                          Example, one line: [{"address":"0xa14E…6141","symbol":"SHQ"}]
//
//   KNOWN_APP_COINS        otherwise, what this build already knows exists on the chain it targets.
//
// The built-in table is here deliberately, and it is the same KIND of fact this app already keeps:
// `chain.ts` holds a per-chain contract table and a per-chain RPC default, because THIS APP IS A
// DEPLOYMENT rather than a reusable package. "On faithchain there is also a coin called SHQ" belongs
// beside "on faithchain the name registry is at 0x…". It stays out of `packages/`, where hardcoding a
// relying app's address genuinely would be wrong.
//
// A stale entry costs nothing visible: an address that no longer holds anything reads zero, and a
// non-primary coin at zero is not shown at all.
//
// Bad entries are dropped rather than throwing: a malformed coin should cost that coin's row, not the
// whole Treasuries page. An unparseable list throws at build time, like every other NEXT_PUBLIC_ here,
// because that one is a typo somebody wants told about.

import type { Address } from '@agenticprimitives/types';
import { CHAIN_ID, CONTRACTS } from './chain';

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

/**
 * Coins this build knows exist on a given chain, beside the one this Home itself funds.
 *
 * Keyed by chain id, so a build pointed at another chain gets none of them rather than a list of
 * addresses that mean nothing there.
 */
const KNOWN_APP_COINS: Record<number, Coin[]> = {
  // faithchain — Sheqel, the Poker Night card room's own currency (`AppCurrency`). A treasury that has
  // played there holds these, and a Home that could not see them told its owner their money was gone.
  34348: [{ address: '0xa14E4a9447607c1233DcE34dB6Ead47C094f6141' as Address, symbol: 'SHQ', decimals: 6 }],
};

/** Every coin this Home can show a balance for. The primary first, then the rest. */
export const COINS: Coin[] = (() => {
  const configured = parseAppCoins(process.env.NEXT_PUBLIC_APP_COINS);
  // Configured wins outright when present — a deployment that names its coins means that list, not
  // that list plus whatever this build happened to ship believing.
  const extra = configured.length > 0 ? configured : (KNOWN_APP_COINS[CHAIN_ID] ?? []);
  return [
    { address: CONTRACTS.mockUsdc, symbol: 'USDC', decimals: 6, primary: true },
    ...extra.filter((c) => c.address.toLowerCase() !== CONTRACTS.mockUsdc.toLowerCase()),
  ];
})();

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
