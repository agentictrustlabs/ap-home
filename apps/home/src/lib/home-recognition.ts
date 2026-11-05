'use client';
// Ending the server-side half of a Home sign-in (spec 445 §3.2). The session token and `ap_sso` are script's to clear;
// the recognition cookie is HttpOnly, so only the server can end it. `keepalive` because /logout navigates away at once.
export function endRecognition(): Promise<void> {
  return fetch('/connect/logout', { method: 'POST', keepalive: true })
    .then(() => undefined)
    .catch((e: unknown) => { console.warn('[recognition] could not be ended:', e instanceof Error ? e.message : String(e)); });
}
