// spec 303 W3 — demo-a2a verification-receipt wiring for the A2aTaskDO.
//
// Builds the A2aReceiptsConfig the a2a agent mints through at its
// message/send + resubmit terminals: durable D1 store (append-only
// `verification_receipts`, migration 0002) + the two injected providers —
// the 'demo-hmac' signer under VERIFICATION_RECEIPT_SECRET (demo-grade,
// symmetric; the production target is the agent-SA KMS EIP-712 signer) and
// latest-block duty-3 evidence memoized 12s per isolate (the chain-state
// bounded-freshness window). Secret unset ⇒ unsigned (integrity-only)
// receipts; DB unbound ⇒ receipts still ride the send result, nothing
// persists (fail-soft, mirroring the audit-sink posture).
import type { A2aReceiptsConfig } from '@agenticprimitives/a2a';
import type { ReceiptProof, Sha256 } from '@agenticprimitives/verification-receipts';

interface ReceiptsEnv {
  DB?: D1Database;
  RPC_URL?: string;
  VERIFICATION_RECEIPT_SECRET?: string;
}

const enc = new TextEncoder();

function demoHmacSigner(secret: string): (receiptHash: Sha256) => Promise<ReceiptProof> {
  return async (receiptHash) => {
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret) as unknown as ArrayBuffer,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', key, enc.encode(receiptHash) as unknown as ArrayBuffer);
    const hex = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, '0')).join('');
    return { type: 'demo-hmac', signature: `hmac-sha256:${hex}` };
  };
}

let _blockEvidence: { at: number; value: { blockNumber: string; blockHash: `0x${string}` } } | undefined;
async function latestBlockEvidence(rpcUrl: string): Promise<{ blockNumber: string; blockHash: `0x${string}` }> {
  if (_blockEvidence && Date.now() - _blockEvidence.at < 12_000) return _blockEvidence.value;
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['latest', false] }),
  });
  const json = (await res.json()) as { result?: { number?: string; hash?: string } };
  if (!json.result?.number || !json.result?.hash) throw new Error('latest block unavailable');
  const value = { blockNumber: BigInt(json.result.number).toString(), blockHash: json.result.hash as `0x${string}` };
  _blockEvidence = { at: Date.now(), value };
  return value;
}

/** The A2aTaskDO's receipts wiring: the serving agent's SA is the verifier identity. */
export function buildA2aReceiptsConfig(env: ReceiptsEnv, agentSA: `0x${string}`): A2aReceiptsConfig {
  const secret = env.VERIFICATION_RECEIPT_SECRET?.trim();
  return {
    verifier: agentSA,
    policyVersion: 'demo-a2a/task-do/1',
    ...(secret ? { sign: demoHmacSigner(secret) } : {}),
    ...(env.RPC_URL ? { statusEvidence: () => latestBlockEvidence(env.RPC_URL!) } : {}),
    onReceipt: async (minted, ctx) => {
      if (!env.DB) return;
      try {
        await env.DB.prepare(
          `INSERT INTO verification_receipts
             (receipt_id, correlation_id, outcome, tool, created_at, receipt_json, detail_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            minted.receipt.receiptId,
            ctx.messageId,
            ctx.outcome,
            `a2a.${ctx.skill}`,
            new Date().toISOString(),
            JSON.stringify(minted.receipt),
            JSON.stringify(minted.detail),
          )
          .run();
      } catch (e) {
        console.error('[demo-a2a] receipt store failed (fail-soft):', e);
      }
    },
  };
}
