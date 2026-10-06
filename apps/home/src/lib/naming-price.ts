// What a name costs here, and which coin pays it (ap-town spec 431). The PRICE is the package's pure function —
// the same numbers the naming service shows and `PricedSubregistry.priceOf` enforces — so this Home never quotes a
// number the chain would refuse. The COIN is the estate's app coin (Sheqel on faithchain).
import { priceOf as packagePriceOf, toCoinUnits } from '@agenticprimitives/agent-naming';
import type { Address } from '@agenticprimitives/types';
import { COINS, type Coin } from './coins';
import { PRICED_SUBREGISTRIES } from './chain';

/** The coin names are bought with: the estate's app coin (SHQ), never the funding stablecoin. */
export const NAMING_COIN: Coin | null = COINS.find((c) => c.symbol === 'SHQ') ?? null;

/** Is `tld` a purchased ending on this chain? */
export const isPricedTld = (tld: string): boolean => !!PRICED_SUBREGISTRIES[tld];
export const pricedSubregistryFor = (tld: string): Address | null => (PRICED_SUBREGISTRIES[tld] as Address | undefined) ?? null;

/** Whole coins, or null when the ending is not priced (legacy; not on this chain). */
export function namePrice(label: string, tld: string): number | null {
  if (!isPricedTld(tld)) return null;
  try { return packagePriceOf(label, tld); } catch { return null; }
}

export function namePriceUnits(label: string, tld: string): bigint | null {
  const p = namePrice(label, tld);
  return p === null ? null : toCoinUnits(p, NAMING_COIN?.decimals ?? 6);
}

/** 1,000 coins: what every person's treasury is born with (spec 431 D2). */
export const TREASURY_BIRTHRIGHT_COINS = 1000;
