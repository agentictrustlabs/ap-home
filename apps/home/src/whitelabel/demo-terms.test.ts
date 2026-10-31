/**
 * demo-terms — the client whose only authority is `site-login` plus a self-vault grant on the person's own
 * acceptance family. This pins that shape: widen any of it and a test goes red.
 */
import { describe, expect, it } from 'vitest';

import { whitelabel } from './config';

const app = whitelabel.relyingApps.find((a) => a.client_id === 'demo-terms');

describe('the demo-terms client', () => {
  it('is registered', () => {
    expect(app).toBeDefined();
    expect(app?.name).toBe('Terms demo');
  });

  it('may write and read only the person\'s own acceptance records', () => {
    expect(app?.self_vault_grant?.resources).toEqual(['vault:agreement-acceptance:*']);
    expect([...(app?.self_vault_grant?.ops ?? [])].sort()).toEqual(['read', 'write']);
  });

  it('asks for who someone is and nothing more', () => {
    expect(app?.allowed_delegation_templates).toEqual(['site-login']);
    expect(app?.allowed_scopes).toEqual(['openid', 'agent']);
    expect(app?.standingGrant).toBeUndefined();
    expect(app?.idTokenClaims).toBeUndefined();
    expect(app?.read_grant).toBeUndefined();
  });

  it('redirects to the client origin root, so every URI ends in /', () => {
    expect(app?.redirect_uris.length).toBeGreaterThan(0);
    for (const u of app?.redirect_uris ?? []) expect(u.endsWith('/'), u).toBe(true);
  });
});
