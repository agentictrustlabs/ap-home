'use client';
// Ending the server-side half of a Home sign-in (spec 445 §3.2). The session token and `ap_sso` are script's to clear;
// the recognition cookie is HttpOnly, so only the server can end it. `keepalive` because /logout navigates away at once.
//
// `everywhere` is a real sign-out: it also ends every app's silent renewal. "Not you?" and a forced chooser leave that alone: the
// person is choosing who to be here, not leaving their apps.
export function endRecognition(opts: { everywhere?: boolean; token?: string } = {}): Promise<void> {
  return fetch('/connect/logout', {
    method: 'POST',
    keepalive: true,
    headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: JSON.stringify({ everywhere: !!opts.everywhere }),
  })
    .then(() => undefined)
    .catch((e: unknown) => { console.warn('[recognition] could not be ended:', e instanceof Error ? e.message : String(e)); });
}
