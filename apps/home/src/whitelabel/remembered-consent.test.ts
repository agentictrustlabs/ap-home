// Spec 445 W3/W4 — this turns something ON: which apps may skip the sheet is a deliberate list, and a test.
import { describe, expect, it } from 'vitest';
import { whitelabel } from './config';
import { mintsPaymentAtSignIn } from '../lib/consent-terms';

describe('remembered consent, by app', () => {
  // Owner's decision, 2026-11-05: on for every eligible curated app. A new app fails here until someone decides for it.
  it('is on for every curated app that can use it', () => {
    for (const a of whitelabel.relyingApps) {
      const eligible = (a.allowed_delegation_templates ?? []).includes('site-login') && !mintsPaymentAtSignIn(a);
      expect(a.remembered_consent, a.client_id).toBe(eligible ? 'on' : undefined);
    }
  });
  it('is never set on an app that mints money authority at sign-in', () => {
    for (const a of whitelabel.relyingApps.filter((x) => x.remembered_consent)) expect(mintsPaymentAtSignIn(a), a.client_id).toBe(false);
  });
});
