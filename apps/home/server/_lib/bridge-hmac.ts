// HMAC envelope for the demo-sso-next ↔ demo-a2a custody bridge (SEC-010).
//
// Replaces `Authorization: Bearer ${A2A_CUSTODY_BRIDGE_SECRET}` with a per-call
// signed envelope:
//   X-Bridge-Timestamp: <unix-ms>
//   X-Bridge-Nonce:     <random-b64url>
//   X-Bridge-Audience:  <endpoint-id, e.g. "custody.google.resolve">
//   X-Bridge-Signature: <hmac-sha256 hex>
//
// Signature input bytes: `${ts}.${nonce}.${sha256-hex(body)}.${audience}`. The
// shared secret continues to live in env on both sides (A2A_CUSTODY_BRIDGE_SECRET),
// but a compromise now yields short-window replay only — the freshness window
// (FRESHNESS_MS) bounds the blast radius, and nonces are single-use at the receiver.
//
// This sender file ONLY builds envelopes; the receiver verifies + records the nonce.

import type { Hex } from '@agenticprimitives/types';

/** Window during which the receiver will accept a signed envelope (anti-replay). */
export const BRIDGE_FRESHNESS_MS = 60_000;

export interface BridgeEnvelope {
  headers: Record<string, string>;
  body: string;
}

/** Sign the call. Returns the headers to attach + the canonical body string to send.
 *  The CALLER must send EXACTLY the returned `body` string (no re-serialization) so
 *  the body-hash matches at the receiver. */
export async function signBridgeCall(
  opts: {
    secret: string;
    audience: string;
    payload: unknown;
  },
): Promise<BridgeEnvelope> {
  const body = JSON.stringify(opts.payload);
  const timestamp = String(Date.now());
  const nonce = randomB64url(16);
  const bodyHash = await sha256Hex(new TextEncoder().encode(body));
  const input = `${timestamp}.${nonce}.${bodyHash}.${opts.audience}`;
  const signature = await hmacSha256Hex(opts.secret, input);
  return {
    headers: {
      'content-type': 'application/json',
      'X-Bridge-Timestamp': timestamp,
      'X-Bridge-Nonce': nonce,
      'X-Bridge-Audience': opts.audience,
      'X-Bridge-Signature': signature,
    },
    body,
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<Hex> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  let hex = '0x';
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, '0');
  return hex as Hex;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const keyBytes = enc.encode(secret) as Uint8Array;
  const key = await crypto.subtle.importKey(
    'raw', keyBytes as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message) as BufferSource);
  let hex = '';
  for (const b of new Uint8Array(sig)) hex += b.toString(16).padStart(2, '0');
  return hex;
}

function randomB64url(n: number): string {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
