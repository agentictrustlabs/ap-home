// Spec 422 §1 principle 2 — a session's GRADE is a fact the SERVER graded (ADR-0017), read from `/me/profile`,
// never inferred from the sign-in word. The page gate this replaces keyed on `via === 'Google'` and forced a
// step-up on every Google session, while spec 235 makes a Personal-Home Google session custody-grade (C_sub is
// the custodian). `access` is what `basicProfile` reports: "full (confirmed with device)" iff the session's
// principal is custody-grade (`canReadSensitivePii`).
import type { CredentialRole } from '@agenticprimitives/types';
import type { BasicProfile } from '../connect-client';

export function sessionGrade(profile: Pick<BasicProfile, 'access'> | null | undefined): CredentialRole | null {
  if (!profile) return null;
  return profile.access.startsWith('full') ? 'custody-grade' : 'login-grade';
}

/** The words a row shows for the credential kind the session was opened with (`profile.credential` = principal kind). */
export function credentialWords(kind: string | undefined, via: string | undefined): string {
  const v = (via ?? '').toLowerCase();
  if (v === 'passkey') return 'Passkey';
  if (v === 'wallet') return 'Wallet';
  if (v === 'google') return 'Google';
  if (v === 'youversion') return 'YouVersion';
  if (v === 'email') return 'Email';
  if (v === 'phone') return 'Phone (SMS)';
  switch ((kind ?? '').toLowerCase()) {
    case 'passkey': return 'Passkey';
    case 'siwe-eoa': return 'Wallet';
    case 'oidc': return 'Sign-in provider';
    default: return 'Sign-in';
  }
}
