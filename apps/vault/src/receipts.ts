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
import { hashMessage, hexToBytes } from 'viem';
import {
  addressFromSpkiPem,
  createGcpKmsTransport,
  gcpSignDigest,
  parseServiceAccountJson,
  type GcpKmsTransport,
  type ServiceAccount,
} from '@agenticprimitives/key-custody/kms-core';
import { resolvePersonVault, type VaultKeyEnv } from './vault-key';

interface ReceiptsEnv extends VaultKeyEnv {
  DB: D1Database;
  RPC_URL: string;
  MCP_AUDIENCE: string;
  VERIFICATION_RECEIPT_SECRET?: string;
  /** spec 303 — Cloud KMS secp256k1 cryptoKeyVersion for the ASYMMETRIC receipt
   *  signer (EIP-191 over the canonical receiptHash; offline-verifiable via
   *  ecrecover). Takes precedence over the demo-hmac secret — one mechanism,
   *  selected by configuration (ADR-0013). Requires GCP_SERVICE_ACCOUNT_JSON. */
  VERIFICATION_RECEIPT_KMS_KEY?: string;
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

// spec 303 — the ASYMMETRIC signer: Cloud KMS secp256k1, EIP-191 over the
// canonical receiptHash string. Any counterparty verifies OFFLINE with
// standard tooling: recoverMessageAddress({ message: receiptHash, signature })
// === proof.signer. Transport + signer address memoized per isolate.
let _kms: { transport: GcpKmsTransport; signer: `0x${string}` } | undefined;
function kmsEip191Signer(
  serviceAccountJson: string,
  keyName: string,
): (receiptHash: Sha256) => Promise<ReceiptProof> {
  const sa: ServiceAccount = parseServiceAccountJson(serviceAccountJson);
  return async (receiptHash) => {
    if (!_kms) {
      const transport = createGcpKmsTransport(sa);
      const pem = await transport.getPublicKeyPem(keyName);
      _kms = { transport, signer: addressFromSpkiPem(pem) as `0x${string}` };
    }
    const digest = hexToBytes(hashMessage(receiptHash));
    const signature = await gcpSignDigest({
      serviceAccount: sa,
      cryptoKeyVersionName: keyName,
      digest,
      transport: _kms.transport,
    });
    return { type: 'eip191-kms-secp256k1', signature, signer: _kms.signer };
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
  env: ReceiptsEnv,
  minted: MintedReceipt,
  ctx: { outcome: 'allow' | 'deny'; correlationId: string; toolName: string },
): Promise<void> {
  // spec 303 — detail residency. When the principal has a live per-person
  // vault-key binding (spec 278), the PRIVATE detail (raw values + the
  // receiptKey opening the commitments) is sealed into THEIR vault under
  // their own KEK, classification `receipt.private`; the D1 row keeps only a
  // pointer. Principals without a binding (and pre-verify denies, where the
  // principal is 'unknown') keep the documented D1 interim — no worse than
  // the audit rows, and the erasure path (delete the row) still holds.
  let detailColumn = JSON.stringify(minted.detail);
  const principal = minted.detail.principal;
  if (ctx.outcome === 'allow' && principal && principal !== 'unknown') {
    try {
      const pv = await resolvePersonVault(env, principal);
      if (pv) {
        const resource = `verification-receipt:${minted.receipt.receiptId}`;
        await pv.vault.write({
          owner: principal,
          resource,
          classification: 'receipt.private',
          data: minted.detail,
        });
        detailColumn = JSON.stringify({ vaultResource: resource, owner: principal });
      }
    } catch (e) {
      console.error('[demo-mcp] receipt detail vault write failed (D1 interim kept):', e);
    }
  }
  await env.DB
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
      detailColumn,
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
  const kmsKey = env.VERIFICATION_RECEIPT_KMS_KEY?.trim();
  // ONE signer, selected by configuration (ADR-0013): the asymmetric KMS
  // EIP-191 signer when a key is configured (counterparty-verifiable offline
  // via ecrecover); else demo-hmac (host-verifiable only, demo-grade); else
  // unsigned (integrity-only). Never a runtime fallback between them.
  const sign =
    kmsKey && env.GCP_SERVICE_ACCOUNT_JSON
      ? kmsEip191Signer(env.GCP_SERVICE_ACCOUNT_JSON, kmsKey)
      : secret
        ? demoHmacSigner(secret)
        : undefined;
  const receipts: ReceiptsConfig = {
    // The verifying service identity. The demo host has no service SA wired
    // on this ingress yet, so the audience URN names the verifier; with the
    // KMS signer configured, proof.signer carries the recoverable KMS key
    // address (the service-SA facet binding is G-5's territory).
    verifier: env.MCP_AUDIENCE,
    policyVersion: 'demo-mcp/mcp-v2/1',
    ...(sign ? { sign } : {}),
    statusEvidence: () => latestBlockEvidence(env.RPC_URL),
    onReceipt: async (minted, mctx) => {
      holder.receipt = minted.receipt;
      try {
        await storeReceipt(env, minted, mctx);
      } catch (e) {
        console.error('[demo-mcp] receipt store failed (fail-soft):', e, ctx.correlationId);
      }
    },
  };
  return { receipts, holder };
}
