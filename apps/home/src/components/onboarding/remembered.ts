'use client';
// Asking the Home whether this sign-in may skip the sheet (spec 445 §6). The server decides, from the recognition cookie
// this page cannot read: this file only carries the request and the answer. Nothing here signs.
import type { Address } from '@agenticprimitives/types';
import { profileForConnect } from '../../lib/connect-profile-name';
import type { ConsentTermsV1 } from '../../lib/consent-terms';
import { knownRelyingClient } from '../../lib/relying-clients';
import { sharesProfileName } from '../../lib/new-member';
import { sharesEmailClaim } from '../../whitelabel/provisioning';
import type { EnrollReq } from './useEnrollReq';

export type RememberedAnswer =
  | { kind: 'code'; code: string }
  /** The person is known; show the sheet. Always says why. */
  | { kind: 'sheet'; reason: string; storedTerms?: ConsentTermsV1 }
  /** No live recognition. */
  | { kind: 'login' };

export async function askRemembered(enroll: EnrollReq, person: Address): Promise<RememberedAnswer> {
  try {
    const relying = knownRelyingClient(enroll.aud);
    // An app that cannot skip the sheet gets no vault read for it: the sheet's own path reads the profile when it needs to.
    const live = !!relying?.remembered_consent;
    const wantsName = live && sharesProfileName(relying);
    const wantsEmail = live && sharesEmailClaim(relying);
    // Read over the person's own session, as a sheet sign-in reads it: the server cannot open a sealed profile.
    const profile = wantsName || wantsEmail ? await profileForConnect() : null;
    const r = await fetch('/oidc/remembered', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: enroll.aud,
        redirect_uri: enroll.redirectUri,
        nonce: enroll.nonce,
        code_challenge: enroll.codeChallenge,
        code_challenge_method: 'S256',
        agent_name: enroll.name,
        delegation_template: enroll.template || 'site-login',
        person,
        ...(enroll.prompt ? { prompt: enroll.prompt } : {}),
        ...(enroll.sessionKey ? { session_key: enroll.sessionKey } : {}),
        ...(enroll.viaHost ? { via_host: enroll.viaHost } : {}),
        ...(enroll.loginHint ? { login_hint: enroll.loginHint } : {}),
        ...(wantsName ? { profile_name: profile?.name ?? '' } : {}),
        ...(wantsEmail ? { profile_email: profile?.email ?? '' } : {}),
      }),
    });
    const b = (await r.json().catch(() => ({}))) as { code?: string; consent_required?: string; stored_terms?: ConsentTermsV1; would?: string; error?: string };
    if (b.code) return { kind: 'code', code: b.code };
    if (r.status === 401) return { kind: 'login' };
    const reason = b.consent_required ?? `http_${r.status}`;
    console.info(`[remembered] ${enroll.aud}: the sheet, because ${reason}${b.would ? ` (would ${b.would})` : ''}`);
    return { kind: 'sheet', reason, ...(b.stored_terms ? { storedTerms: b.stored_terms } : {}) };
  } catch (e) {
    console.warn('[remembered] could not ask; the sheet is shown:', e instanceof Error ? e.message : String(e));
    return { kind: 'sheet', reason: 'unreachable' };
  }
}
