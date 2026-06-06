// Client for the SERVER broker (the Pages Functions). Used by the "real Google
// OIDC" UI mode. These call the relative function routes, so they work when the
// app is served by Pages (`wrangler pages dev dist` or a deploy) — NOT under plain
// `vite dev` (which has no /oidc, /token, /jwks routes).
//
// Verification is done client-side against the published JWKS (importJwks +
// verifyAgentSession from connect — both browser-safe Web Crypto), proving the
// full loop: the server signs with its private key, the client verifies with the
// public key it fetched from /jwks.

import { importJwks, verifyAgentSession, type VerifyResult } from '@agenticprimitives/connect';

/** Redirect the browser to the Connect origin to begin Google OIDC. When
 *  `linkToken` (a custody-grade AgentSession) is given, the callback LINKS the
 *  Google subject to that agent instead of logging in/bootstrapping (P0-C). */
export function startGoogleSignIn(aud: string, redirectUri: string, linkToken?: string): void {
  const u = new URL('/oidc/google/start', window.location.origin);
  u.searchParams.set('aud', aud);
  u.searchParams.set('redirect_uri', redirectUri);
  if (linkToken) u.searchParams.set('link_token', linkToken);
  window.location.assign(u.toString());
}

/** Redirect the browser to the Connect origin to begin YouVersion OIDC. Mirrors {@link startGoogleSignIn}
 *  (YouVersion is a public PKCE client; the callback returns `?code&via=youversion`). */
export function startYouVersionSignIn(aud: string, redirectUri: string, linkToken?: string): void {
  const u = new URL('/oidc/youversion/start', window.location.origin);
  u.searchParams.set('aud', aud);
  u.searchParams.set('redirect_uri', redirectUri);
  if (linkToken) u.searchParams.set('link_token', linkToken);
  window.location.assign(u.toString());
}

/** Exchange a single-use code (delivered to the redirect_uri) for the AgentSession. */
export async function exchangeCode(code: string, aud: string): Promise<string> {
  const res = await fetch('/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, aud }),
  });
  const body = (await res.json().catch(() => ({}))) as { agentSession?: string; error?: string };
  if (!res.ok || !body.agentSession) throw new Error(body.error ?? `/token returned ${res.status}`);
  return body.agentSession;
}

/** "Use Google for a new home" (spec 235 §5b): bump the per-subject rotation, authorized by the
 *  current Google custody session. After this, sign out + sign back in with Google → a fresh home. */
export async function rotateGoogleHome(token: string): Promise<void> {
  const res = await fetch('/oidc/google/rotate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: token }),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok || !body.ok) throw new Error(body.error ?? `rotate failed (${res.status})`);
}

/** Verify a server-issued AgentSession against the broker's published JWKS. */
export async function verifyServerSession(token: string, aud: string): Promise<VerifyResult> {
  const res = await fetch('/jwks');
  if (!res.ok) throw new Error(`/jwks returned ${res.status} — is the server broker running (wrangler pages dev)?`);
  const jwks = (await res.json()) as Parameters<typeof importJwks>[0];
  const keys = await importJwks(jwks);
  // The broker (served from this same origin) minted iss = its request origin.
  return verifyAgentSession(token, { keys, expectedIss: window.location.origin, expectedAud: aud });
}
