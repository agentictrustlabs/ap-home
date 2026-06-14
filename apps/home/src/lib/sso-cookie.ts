'use client';
// Parent-domain SSO session cookie (spec 232): scoped to `.<CONNECT_DOMAIN>` so ONE sign-in at any
// Impact page is shared across ALL `*.impact-agent.me` subdomains — "authenticated once, recognized
// everywhere under Impact." It mirrors the AgentSession (the same token already in per-origin
// localStorage); it only sticks on impact-agent.me hosts (dev / Vercel default hosts skip it, and
// localStorage covers those). Carries `via` too so credential-specific UI (e.g. the Google
// rotation action) survives a cross-subdomain restore.
//
// HARDENING TODO: a server-set HttpOnly `.impact-agent.me` cookie would shrink the XSS surface vs
// this JS-managed one (today it's the same exposure as the localStorage token). Tracked as a
// follow-up; the token itself (short-lived, aud/iss-pinned AgentSession) is unchanged.
import { CONNECT_DOMAIN } from './domain';

const NAME = 'ap_sso';
const PARENT = `.${CONNECT_DOMAIN}`;

/** A `.impact-agent.me` cookie only sticks on impact-agent.me hosts (apex or subdomain). */
function onImpactHost(): boolean {
  try {
    const h = window.location.hostname.toLowerCase();
    return h === CONNECT_DOMAIN || h.endsWith(`.${CONNECT_DOMAIN}`);
  } catch {
    return false;
  }
}

/** Default SSO-session lifetime: 30 days — "authenticated once, recognized for weeks." A returning
 *  member is recognized for the whole window (no fresh login), so a relying app's later step (e.g. an
 *  x402 charge) is one-tap + the per-action credential signature, not a re-connect. The cookie only
 *  CARRIES the (short-lived) session token; for passkey/wallet members recognition doesn't re-use that
 *  token (they re-sign per action), so the long recognition window is safe. (KMS/social custody sessions
 *  still expire on the token's own TTL — those re-auth when the underlying token lapses.) */
const SSO_MAX_AGE_SEC = 60 * 60 * 24 * 30;

export function setSsoCookie(token: string, via: string, maxAgeSec = SSO_MAX_AGE_SEC): void {
  if (!onImpactHost()) return;
  try {
    const value = encodeURIComponent(JSON.stringify({ t: token, v: via }));
    // SameSite=None (with Secure) so the cookie rides on FedCM's credentialed cross-site fetches
    // (`/fedcm/accounts` + `/fedcm/assertion`), which are initiated for the relying app and therefore
    // cross-site — a Lax cookie would NOT be sent → the IdP couldn't see the session (401). The token is
    // short-lived + aud/iss-pinned + ERC-1271/JWKS-verified, so the relaxed SameSite is low-risk.
    document.cookie = `${NAME}=${value}; Domain=${PARENT}; Path=/; Max-Age=${maxAgeSec}; Secure; SameSite=None`;
  } catch {
    /* ignore */
  }
}

export function readSsoCookie(): { token: string; via: string } | null {
  try {
    const m = document.cookie.match(new RegExp(`(?:^|; )${NAME}=([^;]*)`));
    if (!m || !m[1]) return null;
    const o = JSON.parse(decodeURIComponent(m[1])) as { t?: string; v?: string };
    return o?.t ? { token: o.t, via: o.v ?? 'sso' } : null;
  } catch {
    return null;
  }
}

export function clearSsoCookie(): void {
  if (!onImpactHost()) return;
  try {
    document.cookie = `${NAME}=; Domain=${PARENT}; Path=/; Max-Age=0; Secure; SameSite=Lax`;
  } catch {
    /* ignore */
  }
}
