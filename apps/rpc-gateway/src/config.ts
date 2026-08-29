// Copied as-is from the live gateway (allow-list + cache TTLs). Behaviour-bearing constants — change
// with a test.
export const READ_METHODS = new Set(['eth_chainId','net_version','web3_clientVersion','eth_blockNumber','eth_gasPrice','eth_maxPriorityFeePerGas','eth_feeHistory','eth_getBalance','eth_getCode','eth_getStorageAt','eth_getTransactionCount','eth_call','eth_estimateGas','eth_getLogs','eth_getBlockByNumber','eth_getBlockByHash','eth_getTransactionByHash','eth_getTransactionReceipt','eth_getBlockReceipts']);
export const WRITE_METHODS = new Set(['eth_sendRawTransaction']);
export const isAllowed = (m: string) => READ_METHODS.has(m) || WRITE_METHODS.has(m);
export const isWrite = (m: string) => WRITE_METHODS.has(m);
export const CACHE_TTL_S = (method: string, params: unknown[]): number => {
  if (method === 'eth_chainId' || method === 'net_version' || method === 'web3_clientVersion') return 3600;
  const tag = typeof params?.[params.length - 1] === 'string' ? String(params[params.length - 1]) : '';
  if (tag === 'pending') return 0;
  const byKey = /^0x[0-9a-fA-F]+$/.test(tag) || method === 'eth_getBlockByHash' || method === 'eth_getTransactionReceipt';
  if (['eth_getLogs','eth_call','eth_getBlockByNumber','eth_getBalance','eth_getTransactionReceipt','eth_getBlockByHash','eth_getCode'].includes(method)) return byKey ? 30 : 2;
  return 0;
};

export type Rpc = { jsonrpc: string; id: unknown; method: string; params?: unknown[] };

/**
 * Inject a `gas` bound into every `eth_estimateGas` call that does not set one. Some chains (Besu)
 * return an empty 200 without a bound on heavy calls and error when the bound equals the block gas
 * limit. `cap` comes from env `ESTIMATE_GAS_CAP`; empty/undefined = no-op (non-Besu chains). Mutates
 * in place (the batch is forwarded as-is) and returns the number of calls changed.
 */
export function injectEstimateGasCap(calls: Rpc[], cap: string | undefined): number {
  const c = (cap ?? '').trim();
  if (!c) return 0;
  if (!/^0x[0-9a-fA-F]+$/.test(c)) throw new Error(`ESTIMATE_GAS_CAP must be a hex quantity (got "${cap}")`);
  let n = 0;
  for (const call of calls) {
    const p0 = Array.isArray(call?.params) ? call.params[0] : undefined;
    if (call?.method === 'eth_estimateGas' && p0 && typeof p0 === 'object' && !(p0 as Record<string, unknown>).gas) {
      (p0 as Record<string, unknown>).gas = c;
      n++;
    }
  }
  return n;
}
