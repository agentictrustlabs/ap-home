// Spec 445 §8 — the Home's own audience is not an app, and a member-registered app never remembers consent.
import { describe, expect, it } from 'vitest';
import { isHomeAudience, resolveClient, toOidcClient } from './oidc-registry';
import { whitelabel } from '../../src/whitelabel/config';

const kv = (rows: Record<string, unknown>) => ({ AUTH_CODES: { get: async (k: string) => (k.endsWith('demo-sso') ? JSON.stringify(rows) : null), put: async () => undefined, delete: async () => undefined } });

describe('the Home audience', () => {
  it('no curated client is registered under it', () => {
    for (const a of whitelabel.relyingApps) expect(isHomeAudience(a.client_id), a.client_id).toBe(false);
  });
  it('resolves to no client, even with a registration under that name', async () => {
    expect(await resolveClient(kv({ client_id: 'demo-sso', redirect_uris: ['https://x.test/'], delegate: '0x1' }) as never, 'demo-sso')).toBeNull();
  });
});

describe('a member-registered app', () => {
  it('cannot carry remembered consent, whatever its record says: its owner can change the delegate at any time', () => {
    const client = toOidcClient({ client_id: 'mine', name: 'Mine', redirect_uris: [], allowed_scopes: [], allowed_delegation_templates: ['site-login'], delegate: '0x1', remembered_consent: 'on' } as never);
    expect(client.remembered_consent).toBeUndefined();
  });
});
