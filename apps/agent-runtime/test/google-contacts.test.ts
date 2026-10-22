import { describe, it, expect } from 'vitest';
process.env.A2A_SESSION_SECRET ??= 'ab'.repeat(32);
import { storeFederatedToken } from '../src/fed-token.js';
import { CONTACTS_SCOPE_READ } from '../src/connectors/google-contacts.js';
import { contactsGoogleInvoker, CONTACTS_CONNECTIONS_LIST } from '../src/connectors/contacts-google-tools.js';

const kv = () => { const m = new Map<string, string>(); return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); }, delete: async (k: string) => { m.delete(k); } } as unknown as KVNamespace; };
const ALICE = '0x' + 'a'.repeat(40) as `0x${string}`;
const env = () => ({ FED_TOKENS: kv(), GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec' });

describe('Google Contacts as a read (invite source, never stored as friends)', () => {
  it('lists connections that have an email; skips nameless-no-mail; not connected says so', async () => {
    const e = env();
    const people = [
      { names: [{ displayName: 'Pat Elder' }], emailAddresses: [{ value: 'pat@x.org', metadata: { primary: true } }] },
      { names: [{ displayName: 'No Mail' }] },
      { emailAddresses: [{ value: 'solo@x.org' }] },
    ];
    const f = (async (url: string | URL | Request) => {
      expect(String(url)).toContain('people/me/connections');
      expect(String(url)).toContain('personFields=names%2CemailAddresses');
      return new Response(JSON.stringify({ connections: people }));
    }) as unknown as typeof fetch;
    await storeFederatedToken(e, ALICE, { access: 'a', refresh: 'r' }, 3600, CONTACTS_SCOPE_READ, 'alice@x.org', 'google-contacts');
    const inv = contactsGoogleInvoker({ env: e, fetch: f }, ALICE);
    const r = await inv(CONTACTS_CONNECTIONS_LIST, {}, {} as never) as { count: number; people: Array<{ name: string | null; email: string }>; connected: boolean; note: string };
    expect(r.connected).toBe(true);
    expect(r.count).toBe(2);
    expect(r.people.map((p) => p.email).sort()).toEqual(['pat@x.org', 'solo@x.org']);
    expect(r.people.find((p) => p.email === 'pat@x.org')!.name).toBe('Pat Elder');
    expect(r.note).toMatch(/not stored as a friend|add you back/i);
    const none = await contactsGoogleInvoker({ env: e, fetch: f }, '0x' + 'b'.repeat(40))(CONTACTS_CONNECTIONS_LIST, {}, {} as never) as { refused?: string };
    expect(none.refused).toMatch(/not connected/);
  });
  it('query filters by name or email', async () => {
    const e = env();
    await storeFederatedToken(e, ALICE, { access: 'a', refresh: 'r' }, 3600, CONTACTS_SCOPE_READ, 'alice@x.org', 'google-contacts');
    const f = (async () => new Response(JSON.stringify({ connections: [
      { names: [{ displayName: 'Pat Elder' }], emailAddresses: [{ value: 'pat@x.org' }] },
      { names: [{ displayName: 'Sam' }], emailAddresses: [{ value: 'sam@x.org' }] },
    ] }))) as unknown as typeof fetch;
    const r = await contactsGoogleInvoker({ env: e, fetch: f }, ALICE)(CONTACTS_CONNECTIONS_LIST, { query: 'pat' }, {} as never) as { count: number; people: Array<{ email: string }> };
    expect(r.count).toBe(1);
    expect(r.people[0]!.email).toBe('pat@x.org');
  });
});
