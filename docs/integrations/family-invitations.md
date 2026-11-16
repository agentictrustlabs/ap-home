Family Field currently sends people to the general Home member page when they try to invite someone. Add a focused organization invitation/acceptance page so the app can collect the recipient and Home can approve the exact operation. Keep email friendship acceptance separate from organization membership.

Register Family Field’s dedicated ask-as-me delegate for the native friends view. Preserve optional organization navigation context on email friend invitations; this context grants no authority. For approved invitations, scope shared-plan access to the registered client’s exact Library artifact, plus the family profile and Library index. Preserve the native membership offer and the invitee’s own acceptance ceremony.

Fix member data reads to select an org→member access wire rather than member→org consent. Preserve household classification from the steward’s link on the organization’s invitation record, so joining members can discover their household in the app.

Validation: 114 targeted tests pass, including invitation ownership, wrong-email rejection, per-family context, scoped grants, consent, token exchange and focused request routing. Home typecheck passes. Production build checked with faithchain explicitly selected. Family app has 16 Playwright tests and 31 unit tests passing. Live integration checks follow deployment; no real recipients were emailed during tests.
