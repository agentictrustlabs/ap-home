// WHAT THE PUBLIC `/rpc` ROUTE WILL FORWARD.
//
// `POST /rpc` takes no session — it is the chain reader for a web page — so it forwards only what a page needs and
// keeps the server's own chain credential for the server.
//
// Two layers:
//   1. `RPC_URL_BROWSER`, when the estate sets it, is where `/rpc` forwards: the gateway's BROWSER-scoped token,
//      with its own rate bucket, no write budget, and the gateway's full browser rules (listing selectors, state
//      overrides, block transaction lists).
//   2. This file, always: the route itself refuses anything that writes or lists, and caps the batch. It holds even
//      on an estate with no browser URL, where the forward still goes under the server's token.
// A web page needs single reads (eth_call, code, balance, block number, its own transaction's receipt); none of
// those is refused here.

/** Methods a session-less caller is never given: writes, signing, and everything that LISTS the chain. */
export const RPC_PROXY_REFUSED: ReadonlySet<string> = new Set([
  'eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sign', 'eth_signTransaction', 'eth_accounts',
  'eth_getLogs', 'eth_getBlockReceipts', 'eth_getStorageAt', 'eth_getProof',
  'eth_newFilter', 'eth_newBlockFilter', 'eth_newPendingTransactionFilter', 'eth_getFilterLogs', 'eth_getFilterChanges', 'eth_uninstallFilter',
  'eth_subscribe', 'eth_unsubscribe',
]);
/** Only the standard read namespaces. `debug_`, `trace_`, `admin_`, `txpool_`, `personal_`, `miner_` and the rest
 *  are node-operator surfaces. */
const ALLOWED_NAMESPACE = /^(eth|net|web3)_[A-Za-z0-9]+$/;
export const RPC_PROXY_MAX_BATCH = 25;
export const RPC_PROXY_MAX_BYTES = 64 * 1024;

/** Calls whose params can still read storage or list the chain: a state override on a simulated call (third param),
 *  or a block with its full transaction list. */
function refusedParams(method: string, params: unknown): string | null {
  const p = Array.isArray(params) ? params : [];
  if ((method === 'eth_call' || method === 'eth_estimateGas') && p.length > 2) return `${method} with a state override is not available here`;
  if ((method === 'eth_getBlockByNumber' || method === 'eth_getBlockByHash') && p[1] === true) return `${method} with full transactions is not available here`;
  return null;
}

/** The body to forward — re-serialized from what was checked, so the upstream sees exactly that — or why not. Pure. */
export function rpcProxyCheck(body: string): { refused: string } | { forward: string } {
  if (new TextEncoder().encode(body).length > RPC_PROXY_MAX_BYTES) return { refused: 'request too large' };
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return { refused: 'not JSON' }; }
  const calls = Array.isArray(parsed) ? parsed : [parsed];
  if (calls.length === 0) return { refused: 'empty batch' };
  if (calls.length > RPC_PROXY_MAX_BATCH) return { refused: `batch of ${calls.length} exceeds ${RPC_PROXY_MAX_BATCH}` };
  for (const call of calls) {
    const method = (call as { method?: unknown } | null)?.method;
    if (typeof method !== 'string') return { refused: 'a call has no method' };
    if (!ALLOWED_NAMESPACE.test(method)) return { refused: `${method.slice(0, 60)} is not available here` };
    const m = method.toLowerCase();
    for (const r of RPC_PROXY_REFUSED) if (r.toLowerCase() === m) return { refused: `${method} is not available here` };
    const why = refusedParams(method, (call as { params?: unknown }).params);
    if (why) return { refused: why };
  }
  return { forward: JSON.stringify(parsed) };
}

/** Why this body may not be forwarded, or null when it may. Pure. */
export function rpcProxyRefusal(body: string): string | null {
  const r = rpcProxyCheck(body);
  return 'refused' in r ? r.refused : null;
}
