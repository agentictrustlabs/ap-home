// spec 303 W2 — demo-mcp verification-receipt wiring.
//
// Builds the per-request ReceiptsConfig for withDelegation: durable D1 store
// (append-only `verification_receipts`, migration 0010) + a response holder so
// the /mcp/v2 endpoint can attach the PUBLIC receipt as `_meta.ap_receipt`,
// plus the two injected providers:
//   - signer: 'demo-hmac' over the canonical receiptHash under
//     VERIFICATION_RECEIPT_SECRET. Demo-grade (symmetric — only the host can
//     verify); the production target is the service-SA KMS EIP-712 signer
//     (spec 303 W2 follow-up). Secret unset ⇒ unsigned (integrity-only)
//     receipts — one mechanism, no fallback (ADR-0013).
//   - statusEvidence: latest block via eth_getBlockByNumber, memoized 12s per
//     isolate (matches chain-state's revocationFreshnessMs) so receipts carry
//     real duty-3 evidence without per-call RPC amplification.
import type { ReceiptsConfig } from '@agenticprimitives/mcp-runtime';
import type {
  MintedReceipt,
  ReceiptProof,
  Sha256,
  VerificationReceiptV1,
} from '@agenticprimitives/verification-receipts';

interface ReceiptsEnv {
  DB: D1Database;
  RPC_URL: string;
  MCP_AUDIENCE: string;
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
    const hex = Array.from(new Uint8Array(mac))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return { type: 'demo-hmac', signature: `hmac-sha256:${hex}` };
  };
}

// Latest-block evidence, memoized per isolate for 12s (the chain-state
// bounded-freshness window). A failed read yields undefined evidence — the
// mint point records blockNumber '0' rather than inventing a block.
let _blockEvidence: { at: number; value: { blockNumber: string; blockHash: `0x${string}` } } | undefined;
async function latestBlockEvidence(
  rpcUrl: string,
): Promise<{ blockNumber: string; blockHash: `0x${string}` }> {
  if (_blockEvidence && Date.now() - _blockEvidence.at < 12_000) return _blockEvidence.value;
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['latest', false] }),
  });
  const json = (await res.json()) as { result?: { number?: string; hash?: string } };
  if (!json.result?.number || !json.result?.hash) throw new Error('latest block unavailable');
  const value = {
    blockNumber: BigInt(json.result.number).toString(),
    blockHash: json.result.hash as `0x${string}`,
  };
  _blockEvidence = { at: Date.now(), value };
  return value;
}

async function storeReceipt(
  db: D1Database,
  minted: MintedReceipt,
  ctx: { outcome: 'allow' | 'deny'; correlationId: string; toolName: string },
): Promise<void> {
  // detail_json residency is INTERIM (vault-destined; see migration 0010's
  // header) — it leaks nothing beyond existing audit_events rows, but the
  // spec-303 target is the principal's vault.
  await db
    .prepare(
      `INSERT INTO verification_receipts
         (receipt_id, correlation_id, outcome, tool, created_at, receipt_json, detail_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      minted.receipt.receiptId,
      ctx.correlationId,
      ctx.outcome,
      ctx.toolName,
      new Date().toISOString(),
      JSON.stringify(minted.receipt),
      JSON.stringify(minted.detail),
    )
    .run();
}

/**
 * Per-request receipts wiring. `holder.receipt` carries the last-minted PUBLIC
 * receipt so the endpoint can return it in `_meta.ap_receipt`; the durable D1
 * write is fail-soft (the receipt is evidence, not the decision — the audit
 * trail's fail-closed classes are spec 291 §5's, not this demo path's).
 */
export function buildReceiptsConfig(
  env: ReceiptsEnv,
  ctx: { correlationId?: string },
): { receipts: ReceiptsConfig; holder: { receipt?: VerificationReceiptV1 } } {
  const holder: { receipt?: VerificationReceiptV1 } = {};
  const secret = env.VERIFICATION_RECEIPT_SECRET?.trim();
  const receipts: ReceiptsConfig = {
    // The verifying service identity. The demo host has no service SA wired
    // on this ingress yet, so the audience URN names the verifier; the
    // service-SA identity + KMS signature land together (spec 303 follow-up).
    verifier: env.MCP_AUDIENCE,
    policyVersion: 'demo-mcp/mcp-v2/1',
    ...(secret ? { sign: demoHmacSigner(secret) } : {}),
    statusEvidence: () => latestBlockEvidence(env.RPC_URL),
    onReceipt: async (minted, mctx) => {
      holder.receipt = minted.receipt;
      try {
        await storeReceipt(env.DB, minted, mctx);
      } catch (e) {
        console.error('[demo-mcp] receipt store failed (fail-soft):', e, ctx.correlationId);
      }
    },
  };
  return { receipts, holder };
}
