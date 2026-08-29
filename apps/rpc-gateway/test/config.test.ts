import { describe, it, expect } from 'vitest';
import { READ_METHODS, WRITE_METHODS, isAllowed, isWrite, CACHE_TTL_S, injectEstimateGasCap, type Rpc } from '../src/config';

describe('method allow-list', () => {
  it('reads + the single write are allowed; everything else is not', () => {
    expect(isAllowed('eth_call')).toBe(true);
    expect(isAllowed('eth_sendRawTransaction')).toBe(true);
    expect(isWrite('eth_sendRawTransaction')).toBe(true);
    expect(isWrite('eth_call')).toBe(false);
    for (const m of ['admin_peers', 'debug_traceTransaction', 'qbft_getValidatorsByBlockNumber', 'eth_sendTransaction', 'eth_accounts', 'personal_sign', 'txpool_content']) {
      expect(isAllowed(m)).toBe(false);
    }
    expect(WRITE_METHODS.size).toBe(1);
    expect(READ_METHODS.has('eth_getLogs')).toBe(true);
  });
});

describe('cache TTL', () => {
  it('chain identity is cached for an hour', () => {
    expect(CACHE_TTL_S('eth_chainId', [])).toBe(3600);
    expect(CACHE_TTL_S('net_version', [])).toBe(3600);
  });
  it('pending-tagged reads are never cached; keyed reads 30s; tip reads 2s', () => {
    expect(CACHE_TTL_S('eth_call', [{}, 'pending'])).toBe(0);
    expect(CACHE_TTL_S('eth_call', [{}, '0x10'])).toBe(30);
    expect(CACHE_TTL_S('eth_getBlockByHash', ['0xabc', false])).toBe(30);
    expect(CACHE_TTL_S('eth_getTransactionReceipt', ['0xabc'])).toBe(30);
    expect(CACHE_TTL_S('eth_call', [{}, 'latest'])).toBe(2);
    expect(CACHE_TTL_S('eth_getLogs', [{}])).toBe(2);
  });
  it('writes and uncached reads are 0', () => {
    expect(CACHE_TTL_S('eth_sendRawTransaction', ['0x'])).toBe(0);
    expect(CACHE_TTL_S('eth_blockNumber', [])).toBe(0);
    expect(CACHE_TTL_S('eth_getTransactionCount', ['0xabc', 'latest'])).toBe(0);
  });
});

describe('injectEstimateGasCap', () => {
  const batch = (): Rpc[] => [
    { jsonrpc: '2.0', id: 1, method: 'eth_estimateGas', params: [{ to: '0x1' }] },
    { jsonrpc: '2.0', id: 2, method: 'eth_estimateGas', params: [{ to: '0x1', gas: '0x1000' }] },
    { jsonrpc: '2.0', id: 3, method: 'eth_call', params: [{ to: '0x1' }, 'latest'] },
  ];
  it('injects the cap only into eth_estimateGas calls without gas', () => {
    const calls = batch();
    expect(injectEstimateGasCap(calls, '0x2dc6c0')).toBe(1);
    expect((calls[0]!.params![0] as { gas?: string }).gas).toBe('0x2dc6c0');
    expect((calls[1]!.params![0] as { gas?: string }).gas).toBe('0x1000');
    expect((calls[2]!.params![0] as { gas?: string }).gas).toBeUndefined();
  });
  it('is a no-op when the cap is empty or unset', () => {
    for (const cap of ['', '  ', undefined]) {
      const calls = batch();
      expect(injectEstimateGasCap(calls, cap)).toBe(0);
      expect((calls[0]!.params![0] as { gas?: string }).gas).toBeUndefined();
    }
  });
  it('refuses a non-hex cap', () => {
    expect(() => injectEstimateGasCap(batch(), '3000000')).toThrow(/hex/);
  });
});
