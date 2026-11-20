// Bodies the route must not forward as sent.
import { describe, it, expect } from 'vitest';
import { rpcProxyCheck, rpcProxyRefusal } from './rpc-proxy';

describe('rpc-proxy bypasses', () => {
  it('refuses eth_call with a state override (reads any storage slot, arbitrary code)', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: '0x' + '11'.repeat(20), data: '0x' }, 'latest', { ['0x' + '11'.repeat(20)]: { code: '0x60005460005260206000f3' } }] });
    expect(rpcProxyRefusal(body)).not.toBeNull();
  });
  it('refuses eth_getBlockByNumber with full transactions (lists the chain)', () => {
    expect(rpcProxyRefusal(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['0x1', true] }))).not.toBeNull();
  });
  it('refuses a case variant of a denied method', () => {
    expect(rpcProxyRefusal(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_GetLogs', params: [{}] }))).not.toBeNull();
  });
  it('forwards only what it checked when a method key is duplicated', () => {
    const r = rpcProxyCheck('{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","method":"eth_chainId","params":["0x02"]}');
    expect(r).toEqual({ forward: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: ['0x02'] }) });
  });
  it('caps bytes, not UTF-16 units', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: ['€'.repeat(30000)] });
    expect(new TextEncoder().encode(body).length).toBeGreaterThan(64 * 1024);
    expect(rpcProxyRefusal(body)).not.toBeNull();
  });
});
