// A relying app's OWN consent wording, resolved (schema: `RelyingApp.consent`). The consent surfaces
// (RecognizedEnroll, OrgConsent, GoogleEnrollResume, the journey's grant step) and the sign-in card ask
// HERE instead of reading `delegationTemplates` / `copy` directly, so one client can speak plainly
// without rewording what every other app on this Home shows.
//
// Every helper returns the shared default — the SAME object, where it is an object — for a client that
// says nothing, so an app without `consent` renders byte-for-byte as before (client-consent.test.ts
// proves that over the whole registry). Presentation only: the caveats live in the template and the
// contract; nothing here changes what a grant can do.
import { fmt, whitelabel, type RelyingApp, type WhiteLabelCopy } from './config';

type ConsentClient = Pick<RelyingApp, 'consent'> | null | undefined;

/**
 * The can/cannot to show for `templateId`, preferring the client's own lines.
 *
 * `composed` is the shared template AFTER the email / name / currency helpers ran. A client override
 * replaces its `canDo` wholesale — those helpers' lines included — because the point is one plain list;
 * the override is therefore responsible for disclosing everything the app receives (the test pins the
 * email line for an email-claim client). `hideCannotDo` drops the "cannot" block (ConsentSheet honours it).
 */
export function withClientConsent<T extends { canDo: string[]; cannotDo: string[] }>(
  composed: T,
  app: ConsentClient,
  templateId: string | undefined,
): T & { hideCannotDo?: boolean } {
  const own = templateId ? app?.consent?.templates?.[templateId] : undefined;
  if (!own) return composed;
  return {
    ...composed,
    canDo: [...own.canDo],
    cannotDo: own.hideCannotDo ? [] : [...(own.cannotDo ?? composed.cannotDo)],
    ...(own.hideCannotDo ? { hideCannotDo: true } : {}),
  };
}

/** A shared copy string, unless this client overrides that key. */
export function clientCopy<K extends keyof WhiteLabelCopy>(app: ConsentClient, key: K): WhiteLabelCopy[K] {
  return app?.consent?.copy?.[key] ?? whitelabel.copy[key];
}

/** A ceremony progress label / hint, with the client's exact-string replacement when it has one. */
export function clientProgressText(app: ConsentClient, text: string): string;
export function clientProgressText(app: ConsentClient, text: string | undefined): string | undefined;
export function clientProgressText(app: ConsentClient, text: string | undefined): string | undefined {
  if (text === undefined) return text;
  return app?.consent?.progressText?.[text] ?? text;
}

/**
 * Who "Signed in as" names. A client that asked for `'email'` gets the member's verified email when one
 * was read; otherwise (and for every other client) the existing rule: name, then the short address.
 */
export function signedInLabel(
  app: ConsentClient,
  who: { email?: string; name?: string; address?: string },
): string {
  const email = app?.consent?.signedInAs === 'email' ? (who.email ?? '').trim() : '';
  if (email) return email;
  return who.name?.trim() || (who.address ? `${who.address.slice(0, 6)}…${who.address.slice(-4)}` : '');
}

/** The account-switch button on the recognized consent screen — same action for every client, the
 *  client's own words when it registered them. */
export function switchAccountLabel(app: ConsentClient, name: string | undefined): string {
  return app?.consent?.switchAccountLabel ?? `Not ${name?.trim() || 'you'}? Use a different custodian`;
}

/**
 * One sentence of the org-create sheet (OrgConsent): the client's own, interpolated with `{app}` /
 * `{org}`, or `fallback` — the shared sentence, passed in already built, so a client without
 * `consent.orgCreate` gets exactly the string it got before.
 */
export function orgCreateText(
  app: ConsentClient,
  key: 'explainer' | 'disconnect' | 'receipt',
  vars: { app: string; org: string },
  fallback: string,
): string {
  const own = app?.consent?.orgCreate?.[key];
  return own ? fmt(own, vars) : fallback;
}
