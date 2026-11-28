// THE APPROVAL WINDOWS KEEP THEIR OPENER. Home's approval pages for apps (/household-setup, /household-steward-invitation,
// /organization-invitation, /enable-messaging) open as a small window from the app; when the approval is done the page tells
// the app and closes itself (`finishApprovalWindow`, approval-window.ts), and the app closes the window it opened once its
// read confirms. Both need the opener relationship. The baseline COOP `same-origin-allow-popups` SEVERS it for a document
// opened by another origin (the popup is put in a new browsing-context group: `window.opener` is null there and the app's
// handle reads `closed`), so neither side could close the window and the person was left with it (live walk 2026-11-28:
// "You can close this window" on every approval). These routes, and only with an app's `return` address in the query,
// answer `unsafe-none` — the precedent is the remote-signer arrival in next.config.mjs. The page still talks to exactly
// one origin: it validates `return` against the app's registered redirect URIs before it posts anything.
export const APPROVAL_WINDOW_ROUTES = ['/household-setup', '/household-steward-invitation', '/organization-invitation', '/enable-messaging'];

/** Next `headers()` entries; they come AFTER the baseline so their COOP is the one sent. */
export const approvalWindowHeaders = APPROVAL_WINDOW_ROUTES.map((source) => ({
  source,
  has: [{ type: 'query', key: 'return' }],
  headers: [{ key: 'Cross-Origin-Opener-Policy', value: 'unsafe-none' }],
}));
