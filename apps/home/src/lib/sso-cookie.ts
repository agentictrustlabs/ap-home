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

export function setSsoCookie(token: string, via: string, maxAgeSec = 3600): void {
  if (!onImpactHost()) return;
  try {
    const value = encodeURIComponent(JSON.stringify({ t: token, v: via }));
    document.cookie = `${NAME}=${value}; Domain=${PARENT}; Path=/; Max-Age=${maxAgeSec}; Secure; SameSite=Lax`;
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
