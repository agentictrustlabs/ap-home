import { describe, expect, it } from 'vitest';
import { cacheKey } from '../src/index';

describe('cacheKey', () => {
  it('differs between two origins for the same call — caches.default is zone-wide', () => {
    const a = cacheKey('https://chain-rpc.gcid.io', 'eth_chainId', 'h');
    const b = cacheKey('https://chain-rpc-staging.gcid.io', 'eth_chainId', 'h');
    expect(a).not.toBe(b);
  });
  it('is stable for one origin, method and params', () => {
    expect(cacheKey('https://chain-rpc.gcid.io/', 'eth_getBlockByNumber', 'x')).toBe(cacheKey('https://chain-rpc.gcid.io', 'eth_getBlockByNumber', 'x'));
  });
  it('separates methods and params', () => {
    expect(cacheKey('https://o.example', 'eth_chainId', 'x')).not.toBe(cacheKey('https://o.example', 'net_version', 'x'));
    expect(cacheKey('https://o.example', 'eth_call', 'x')).not.toBe(cacheKey('https://o.example', 'eth_call', 'y'));
  });
});
