import { describe, expect, it } from 'vitest';
import { RPC_PROXY_MAX_BATCH, rpcProxyRefusal } from './rpc-proxy.js';

const call = (method: string, params: unknown[] = []) => ({ jsonrpc: '2.0', id: 1, method, params });

describe('/rpc forwards single reads only', () => {
  it('lets through what a web page reads', () => {
    for (const m of ['eth_call', 'eth_chainId', 'eth_blockNumber', 'eth_getCode', 'eth_getBalance', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getBlockByNumber', 'eth_estimateGas', 'eth_getTransactionCount', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'net_version']) {
      expect(rpcProxyRefusal(JSON.stringify(call(m))), m).toBeNull();
    }
    expect(rpcProxyRefusal(JSON.stringify([call('eth_call'), call('eth_getCode')]))).toBeNull();
  });
  it('refuses writes, signing and everything that lists the chain', () => {
    for (const m of ['eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sign', 'eth_getLogs', 'eth_getBlockReceipts', 'eth_getStorageAt', 'eth_getProof', 'eth_newFilter', 'eth_getFilterLogs', 'eth_subscribe']) {
      expect(rpcProxyRefusal(JSON.stringify(call(m))), m).toMatch(/not available/);
    }
  });
  it('refuses a refused method hidden inside a batch', () => {
    expect(rpcProxyRefusal(JSON.stringify([call('eth_call'), call('eth_sendRawTransaction')]))).toMatch(/eth_sendRawTransaction/);
  });
  it('refuses node-operator namespaces and odd method names', () => {
    for (const m of ['debug_traceTransaction', 'trace_block', 'admin_peers', 'txpool_content', 'personal_sign', 'miner_start', 'ETH_getLogs', 'eth_get Logs', '']) {
      expect(rpcProxyRefusal(JSON.stringify(call(m))), JSON.stringify(m)).not.toBeNull();
    }
  });
  it('refuses junk, an empty batch, an oversized batch and an oversized body', () => {
    expect(rpcProxyRefusal('not json')).toBe('not JSON');
    expect(rpcProxyRefusal('[]')).toBe('empty batch');
    expect(rpcProxyRefusal('null')).toMatch(/no method/);
    expect(rpcProxyRefusal(JSON.stringify(Array.from({ length: RPC_PROXY_MAX_BATCH + 1 }, () => call('eth_call'))))).toMatch(/exceeds/);
    expect(rpcProxyRefusal(JSON.stringify(call('eth_call', ['x'.repeat(70_000)])))).toBe('request too large');
  });
});
