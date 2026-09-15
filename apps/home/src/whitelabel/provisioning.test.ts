/**
 * The two sign-in opt-outs Gather 27 uses exist so that ONE client can skip legs it does not use.
 * This suite is the blast-radius proof: for every other client the answers are the defaults, which
 * is what the ceremony did before the fields existed. Remove either field from gather-app and the
 * matching test goes red; add either to any other client and the "every other client" tests do.
 */
import { describe, expect, it } from 'vitest';

import { whitelabel } from './config';
import { provisionsCommunityMessaging, reusesStandingGrantWithSelfVault, sharesEmailClaim } from './provisioning';

const others = whitelabel.relyingApps.filter((a) => a.client_id !== 'gather-app');

describe('community messaging on sign-in', () => {
  it('gather-app opts out — it registers no messaging capability and the leg cost 18 s', () => {
    expect(provisionsCommunityMessaging('gather-app')).toBe(false);
  });

  it('every other client still provisions it', () => {
    for (const app of others) {
      expect(provisionsCommunityMessaging(app.client_id), `${app.client_id} changed`).toBe(true);
    }
  });

  it('an unknown or absent client gets the default, never a narrower answer', () => {
    expect(provisionsCommunityMessaging('no-such-app')).toBe(true);
    expect(provisionsCommunityMessaging(undefined)).toBe(true);
  });

  it('the field can only turn the leg OFF', () => {
    // The type says `false`; this pins that a truthy value is not a way to widen anything.
    const declared = whitelabel.relyingApps.filter((a) => a.provisioning !== undefined);
    expect(declared.map((a) => a.client_id)).toEqual(['gather-app']);
    for (const a of declared) expect(a.provisioning?.communityMessaging).toBe(false);
  });
});

describe('standing-grant reuse with a self-vault grant', () => {
  it('gather-app opts in — its two approved digests are fixed, so the userOp was a repeat', () => {
    expect(reusesStandingGrantWithSelfVault('gather-app')).toBe(true);
    // The opt-in is meaningless without a self-vault grant to reuse alongside.
    expect(whitelabel.relyingApps.find((a) => a.client_id === 'gather-app')?.self_vault_grant).toBeDefined();
  });

  it('no other client reuses — their ceremonies are byte-for-byte what they were', () => {
    for (const app of others) {
      expect(reusesStandingGrantWithSelfVault(app.client_id), `${app.client_id} changed`).toBe(false);
    }
    expect(reusesStandingGrantWithSelfVault('no-such-app')).toBe(false);
    expect(reusesStandingGrantWithSelfVault(undefined)).toBe(false);
  });
});

/**
 * The email claim is the one flag here that turns something ON rather than off, so it gets the
 * hardest version of this suite: not just "every other client is unchanged" but "the token payload
 * for every other client is byte-identical", which is what an absent claim means.
 */
describe('the email claim on the id_token', () => {
  it('gather-app carries it — the listing form stops asking for an address sign-in already knows', () => {
    expect(sharesEmailClaim(whitelabel.relyingApps.find((a) => a.client_id === 'gather-app'))).toBe(true);
  });

  it('no other client carries it, so no other token gains a field', () => {
    for (const app of others) {
      expect(sharesEmailClaim(app), `${app.client_id} changed`).toBe(false);
    }
  });

  it('exactly one client declares the field, and declares only email', () => {
    const declared = whitelabel.relyingApps.filter((a) => a.idTokenClaims !== undefined);
    expect(declared.map((a) => a.client_id)).toEqual(['gather-app']);
    for (const a of declared) expect(a.idTokenClaims).toEqual(['email']);
  });

  it('an absent, empty or unknown declaration shares nothing', () => {
    expect(sharesEmailClaim(undefined)).toBe(false);
    expect(sharesEmailClaim(null)).toBe(false);
    expect(sharesEmailClaim({ idTokenClaims: undefined })).toBe(false);
    expect(sharesEmailClaim({ idTokenClaims: [] })).toBe(false);
  });

  it('a client the member registered themselves can never grant itself one', () => {
    // relying-clients.ts rebuilds a member registration field by field and idTokenClaims is not
    // among them, so the object simply has no such property. This pins the consequence.
    const selfRegistered = { client_id: 'made-up', name: 'Made Up', redirect_uris: [], allowed_scopes: ['openid'] };
    expect(sharesEmailClaim(selfRegistered as never)).toBe(false);
  });
});