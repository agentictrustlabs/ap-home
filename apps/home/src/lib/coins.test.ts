import { describe, expect, it } from 'vitest';
import { parseAppCoins, shown, type Coin } from './coins';

const usdc: Coin = { address: '0xdaE09066A2cc32f6203605619137dcF01A9B49Ae', symbol: 'USDC', decimals: 6, primary: true };
const shq: Coin = { address: '0xa14E4a9447607c1233DcE34dB6Ead47C094f6141', symbol: 'SHQ', decimals: 6 };

describe('the coins a Home can show', () => {
  it('reads a configured coin, defaulting to the rail’s six decimals', () => {
    expect(parseAppCoins('[{"address":"0xa14E4a9447607c1233DcE34dB6Ead47C094f6141","symbol":"SHQ"}]')).toEqual([
      { address: '0xa14E4a9447607c1233DcE34dB6Ead47C094f6141', symbol: 'SHQ', decimals: 6 },
    ]);
  });

  it('is empty when nothing is configured, which is the ordinary case', () => {
    expect(parseAppCoins(undefined)).toEqual([]);
    expect(parseAppCoins('   ')).toEqual([]);
  });

  it('drops a bad entry rather than losing the whole page', () => {
    // A malformed coin should cost that coin's row and nothing else.
    const got = parseAppCoins('[{"address":"nope","symbol":"X"},{"address":"0xa14E4a9447607c1233DcE34dB6Ead47C094f6141","symbol":"SHQ"},{"address":"0xa14E4a9447607c1233DcE34dB6Ead47C094f6142"}]');
    expect(got.map((c) => c.symbol)).toEqual(['SHQ']);
  });

  it('never lists the same coin twice', () => {
    const twice = '[{"address":"0xa14E4a9447607c1233DcE34dB6Ead47C094f6141","symbol":"SHQ"},{"address":"0xA14E4A9447607C1233DCE34DB6EAD47C094F6141","symbol":"SHQ2"}]';
    expect(parseAppCoins(twice)).toHaveLength(1);
  });

  it('says so loudly when the list itself is a typo', () => {
    // A dropped coin is a missing row; an unparseable list is something somebody wants told about.
    expect(() => parseAppCoins('{oops')).toThrow(/not valid JSON/);
    expect(() => parseAppCoins('"a string"')).toThrow(/must be a JSON array/);
  });
});

describe('which balances get printed', () => {
  it('always shows the coin this Home funds, even at nothing', () => {
    // "Fund with USDC" sits beside it; a balance that vanishes when empty makes that button look
    // like it is for nothing.
    expect(shown([{ coin: usdc, amount: 0n }]).map((b) => b.coin.symbol)).toEqual(['USDC']);
  });

  it('shows another coin only when there is some of it', () => {
    expect(shown([{ coin: usdc, amount: 0n }, { coin: shq, amount: 0n }]).map((b) => b.coin.symbol)).toEqual(['USDC']);
    expect(shown([{ coin: usdc, amount: 0n }, { coin: shq, amount: 10_000_000_000n }]).map((b) => b.coin.symbol)).toEqual(['USDC', 'SHQ']);
  });

  it('hides a coin whose balance could not be read, rather than printing a zero that is a guess', () => {
    expect(shown([{ coin: usdc, amount: null }, { coin: shq, amount: null }]).map((b) => b.coin.symbol)).toEqual(['USDC']);
  });
});
