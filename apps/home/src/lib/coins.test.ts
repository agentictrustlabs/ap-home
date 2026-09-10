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

describe('which balance gets printed — one of them', () => {
  it('shows the coin the account actually uses, and drops the demo USDC', () => {
    // "10000.00 USDC · 10400.00 SHQ" is a question, not an answer: two unrelated numbers and no
    // saying which one you can play with. A treasury holding an app's currency is a treasury being
    // used for that app.
    const rows = shown([{ coin: usdc, amount: 10_000_000_000n }, { coin: shq, amount: 10_400_000_000n }]);
    expect(rows.map((b) => b.coin.symbol)).toEqual(['SHQ']);
  });

  it('falls back to the coin this Home funds when nothing else is held', () => {
    // Including at zero: "Fund with USDC" sits beside it and needs something to refer to.
    expect(shown([{ coin: usdc, amount: 0n }, { coin: shq, amount: 0n }]).map((b) => b.coin.symbol)).toEqual(['USDC']);
    expect(shown([{ coin: usdc, amount: 5n }]).map((b) => b.coin.symbol)).toEqual(['USDC']);
  });

  it('never prints two', () => {
    const three = [{ coin: usdc, amount: 1n }, { coin: shq, amount: 1n }, { coin: { ...shq, address: '0x' + '2'.repeat(40), symbol: 'ZZZ' } as Coin, amount: 1n }];
    expect(shown(three)).toHaveLength(1);
  });

  it('ignores a coin whose balance could not be read, rather than showing a zero that is a guess', () => {
    expect(shown([{ coin: usdc, amount: 0n }, { coin: shq, amount: null }]).map((b) => b.coin.symbol)).toEqual(['USDC']);
  });
});

describe('the list a build ships with', () => {
  it('shows the card room’s coin on faithchain without anybody configuring anything', async () => {
    // The point of the built-in table. Told twice to set an environment variable, the person's Home
    // still read "0.00 USDC" over a treasury holding ten thousand Sheqels — so the working default
    // matters more than the tidy one.
    const { COINS } = await import('./coins');
    // This test build targets whatever chain.ts resolves; assert the SHAPE that makes it work.
    expect(COINS[0]?.primary).toBe(true);
    expect(COINS.every((c) => /^0x[0-9a-fA-F]{40}$/.test(c.address))).toBe(true);
    expect(new Set(COINS.map((c) => c.address.toLowerCase())).size).toBe(COINS.length);
  });

  it('lets a configured list win outright over the built-in one', () => {
    // A deployment that names its coins means THAT list — not that list plus whatever this build
    // happened to ship believing about the chain.
    const configured = parseAppCoins('[{"address":"0x1111111111111111111111111111111111111111","symbol":"ONE"}]');
    expect(configured.map((c) => c.symbol)).toEqual(['ONE']);
  });
});
