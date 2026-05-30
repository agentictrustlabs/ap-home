// HMAC envelope VERIFIER for the demo-sso-next ↔ demo-a2a custody bridge (SEC-010).
//
// Expects the request to carry:
//   X-Bridge-Timestamp: <unix-ms>
//   X-Bridge-Nonce:     <random-b64url>
//   X-Bridge-Audience:  <endpoint id; must match `expectedAudience` here>
//   X-Bridge-Signature: <hmac-sha256 hex>
//
// Verifies:
//   1. Timestamp is within ±BRIDGE_FRESHNESS_MS of server time (anti-replay window).
//   2. HMAC over `${ts}.${nonce}.${sha256(rawBody)}.${audience}` matches.
//   3. The nonce has not been seen recently — recorded in the supplied store with a
//      TTL of BRIDGE_FRESHNESS_MS so an intra-window replay is rejected.

import type { KVNamespace } from '@cloudflare/workers-types';

export const BRIDGE_FRESHNESS_MS = 60_000;

export interface NonceStore {
  has(nonce: string): Promise<boolean>;
  record(nonce: string, ttlSec: number): Promise<void>;
}

/** Adapt a KVNamespace to the NonceStore shape (records as a presence key). */
export function nonceStoreFromKv(kv: KVNamespace, prefix = 'bridge-nonce:'): NonceStore {
  return {
    has: async (nonce) => !!(await kv.get(prefix + nonce)),
    record: async (nonce, ttlSec) => { await kv.put(prefix + nonce, '1', { expirationTtl: ttlSec }); },
  };
}

export async function verifyBridgeCall(opts: {
  request: Request;
  rawBody: string;
  secret: string;
  expectedAudience: string;
  nonces: NonceStore;
  now?: number;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const ts = opts.request.headers.get('x-bridge-timestamp') ?? '';
  const nonce = opts.request.headers.get('x-bridge-nonce') ?? '';
  const audience = opts.request.headers.get('x-bridge-audience') ?? '';
  const signature = opts.request.headers.get('x-bridge-signature') ?? '';
  if (!ts || !nonce || !audience || !signature) return { ok: false, reason: 'bridge envelope missing' };

  // Audience-pin BEFORE any expensive check — wrong endpoint, fail-fast.
  if (audience !== opts.expectedAudience) return { ok: false, reason: 'bridge audience mismatch' };

  const now = opts.now ?? Date.now();
  const tsNum = Number.parseInt(ts, 10);
  if (!Number.isFinite(tsNum)) return { ok: false, reason: 'bridge timestamp malformed' };
  if (Math.abs(now - tsNum) > BRIDGE_FRESHNESS_MS) return { ok: false, reason: 'bridge timestamp outside freshness window' };

  // Single-use nonce — intra-window replay defense.
  if (await opts.nonces.has(nonce)) return { ok: false, reason: 'bridge nonce already used' };

  // Verify HMAC over the canonical input. Body hash uses the RAW received body
  // (no JSON.parse + re-serialize), so any byte tampering invalidates the sig.
  const bodyHash = await sha256Hex(new TextEncoder().encode(opts.rawBody));
  const expected = await hmacSha256Hex(opts.secret, `${ts}.${nonce}.${bodyHash}.${audience}`);
  if (!timingSafeStringEqual(expected, signature)) return { ok: false, reason: 'bridge signature invalid' };

  // Record the nonce with TTL = 2× the freshness window (covers clock skew).
  await opts.nonces.record(nonce, Math.ceil((BRIDGE_FRESHNESS_MS * 2) / 1000));
  return { ok: true };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  let hex = '0x';
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, '0');
  return hex;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message) as BufferSource);
  let hex = '';
  for (const b of new Uint8Array(sig)) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** Constant-time string equality (ASCII-safe for our hex inputs). */
function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
