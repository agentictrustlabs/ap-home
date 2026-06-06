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

// Trim surrounding whitespace from env values — pasted dashboard values often carry a trailing
// space/newline, and e.g. a GOOGLE_REDIRECT_URI with a trailing space no longer EXACTLY matches
// the registered Google redirect URI (Google rejects it as invalid_request / secure-response-handling).
const t = (v: string | undefined): string | undefined => (v == null ? v : v.trim());

export function makeEnv(): Env {
  // Don't throw here — only routes that actually mint/verify tokens need the key,
  // and `getServer()` throws on an empty key on demand (matching the original
  // Cloudflare broker). This lets key-free routes (e.g. openid-configuration
  // discovery) work without the signing secret.
  return {
    BROKER_PRIVATE_JWK: process.env.BROKER_PRIVATE_JWK ?? '',
    BROKER_KID: t(process.env.BROKER_KID),
    AUTH_CODES: kv,
    RPC_URL: t(process.env.RPC_URL),
    REDIRECT_URI_ALLOWLIST: t(process.env.REDIRECT_URI_ALLOWLIST),
    GOOGLE_CLIENT_ID: t(process.env.GOOGLE_CLIENT_ID),
    GOOGLE_CLIENT_SECRET: t(process.env.GOOGLE_CLIENT_SECRET),
    GOOGLE_REDIRECT_URI: t(process.env.GOOGLE_REDIRECT_URI),
    YOUVERSION_CLIENT_ID: t(process.env.YOUVERSION_CLIENT_ID),
    YOUVERSION_REDIRECT_URI: t(process.env.YOUVERSION_REDIRECT_URI),
    // Google × KMS custody (spec 235): the callback asks demo-a2a to derive the member's
    // KMS-custodied SA. Without these the callback degrades to login-grade (no custody).
    A2A_CUSTODY_URL: t(process.env.A2A_CUSTODY_URL),
    A2A_CUSTODY_BRIDGE_SECRET: t(process.env.A2A_CUSTODY_BRIDGE_SECRET),
    DEMO_SSO_AUD: t(process.env.DEMO_SSO_AUD),
    ALLOWED_ISSUER_HOSTS: t(process.env.ALLOWED_ISSUER_HOSTS),
  };
}
