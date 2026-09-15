// What Home sets up for a person on a plain sign-in, per relying app — the OPT-OUT side of the
// registry. Every helper here answers "the default" for a client that says nothing, so an app that
// never touches these fields behaves exactly as it did before they existed. Measured on Gather 27
// (2026-09-15): the legs these gate were 29 of the 31 seconds between Allow and the popup closing.
import { whitelabel, type RelyingApp } from './config';

function client(aud: string | undefined) {
  return aud ? whitelabel.relyingApps.find((a) => a.client_id === aud) : undefined;
}

/** Whether a plain sign-in for this client provisions the community-messaging wire (and, upstream of
 *  it, reads the person's managed orgs). True unless the client set `provisioning.communityMessaging`
 *  to false. Unknown clients get the default, never a narrower answer. */
export function provisionsCommunityMessaging(aud: string | undefined): boolean {
  return client(aud)?.provisioning?.communityMessaging !== false;
}

/** Whether the plain sign-in may reuse a standing grant even though the client declares a self-vault
 *  grant. False unless the client set `standingGrant: 'with-self-vault'`. */
export function reusesStandingGrantWithSelfVault(aud: string | undefined): boolean {
  return client(aud)?.standingGrant === 'with-self-vault';
}

/**
 * Whether this client's id_token may carry the member's email.
 *
 * Takes the RESOLVED client rather than an aud, unlike its neighbours above, because both gates that
 * need it already hold one — the server's `resolveClient` and the browser's `knownRelyingClient` —
 * and because `resolveClient` also answers for member-registered clients that are not in
 * `whitelabel.relyingApps` at all. Looking those up by aud here would silently miss them; taking the
 * object means a self-registered client answers `false` for the right reason, that it does not carry
 * the field. Same signature shape as `sharesProfileName`, which solves the same problem.
 */
export function sharesEmailClaim(app?: Pick<RelyingApp, 'idTokenClaims'> | null): boolean {
  return Array.isArray(app?.idTokenClaims) && app.idTokenClaims.includes('email');
}
