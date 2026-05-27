// Build the broker `Env` (the shape the ported Pages-Function bodies expect)
// from Vercel's `process.env` + the Vercel KV adapter. This is the ONLY runtime
// seam that changes between the Cloudflare Pages broker and the Vercel one — the
// endpoint logic in `server/**` is ported verbatim (spec 232 §3).
//
// `PROXY_SHARED_SECRET` is intentionally NOT set: on Vercel the route handler
// sees the real Host, so `resolveOrigin` degrades to `new URL(request.url).origin`
// — the per-person OP issuer is correct natively (no proxy hop, no secret).
import type { Env } from '../../server/_lib/server-broker';
import { kv } from './kv';

export function makeEnv(): Env {
  // Don't throw here — only routes that actually mint/verify tokens need the key,
  // and `getServer()` throws on an empty key on demand (matching the original
  // Cloudflare broker). This lets key-free routes (e.g. openid-configuration
  // discovery) work without the signing secret.
  return {
    BROKER_PRIVATE_JWK: process.env.BROKER_PRIVATE_JWK ?? '',
    BROKER_KID: process.env.BROKER_KID,
    AUTH_CODES: kv,
    RPC_URL: process.env.RPC_URL,
    REDIRECT_URI_ALLOWLIST: process.env.REDIRECT_URI_ALLOWLIST,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI,
  };
}
