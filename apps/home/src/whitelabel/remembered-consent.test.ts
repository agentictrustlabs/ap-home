// Spec 445 W3/W4 — this turns something ON: which apps may skip the sheet is a reviewed list, one app at a time. An app
// added here that mints money authority at sign-in, or a change from 'shadow' to 'on', has to change this test too.
import { describe, expect, it } from 'vitest';
import { whitelabel } from './config';
import { mintsPaymentAtSignIn } from '../lib/consent-terms';

describe('remembered consent, by app', () => {
  it('is on for the reader, and nobody else yet', () => {
    const set = whitelabel.relyingApps.filter((a) => a.remembered_consent).map((a) => [a.client_id, a.remembered_consent]);
    expect(set).toEqual([['seed-bible-reader', 'on']]);
  });
  it('is never set on an app that mints money authority at sign-in', () => {
    for (const a of whitelabel.relyingApps.filter((x) => x.remembered_consent)) expect(mintsPaymentAtSignIn(a), a.client_id).toBe(false);
  });
});
